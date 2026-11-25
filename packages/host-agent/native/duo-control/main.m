// duo-control — input for the iPhone Duo simulator that CoreSimulator's own
// input path (and so idb) cannot carry: the hinge angle, touches on either of
// the two panels, and the side buttons.
//
// It runs INSIDE the simulator (`xcrun simctl spawn <udid> duo-control`), where
// it is a client of the simulated device's HID event system, and reads one
// JSON command per line on stdin:
//
//   {"id":"1","type":"hinge","angle":120}              fold angle, 0 (shut) … 180 (flat)
//   {"id":"2","type":"hinge","angle":0,"instant":true} jump there without easing
//   {"id":"3","type":"touch","display":"<UUID>","finger":0,"phase":"down","x":0.5,"y":0.5}
//   {"id":"4","type":"release","display":"<UUID>"}     lift every finger on a panel
//   {"id":"5","type":"button","button":"lock","down":true}
//   {"id":"6","type":"keys","keys":[[4,true],[4,false]]} keyboard usages, down then up
//   {"id":"8","type":"orientation","orientation":"landscape-left"}  how the device is held
//   {"id":"7","type":"displays"}                        list the panels that take touches
//
// and answers each with {"id":…,"ok":true} or {"id":…,"ok":false,"error":"…"}.
// It also reports the angle it has actually sent as that changes:
//   {"type":"hinge","angle":118.5,"moving":true}
//
// Touch coordinates are fractions of the panel's framebuffer (0…1, origin top
// left), the same frame the capturer streams. `display` is the panel's unique
// id from `simctl io <udid> enumerate`.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

typedef CFTypeRef HIDEvent;
typedef CFTypeRef HIDClient;
typedef CFTypeRef HIDService;

static CFDataRef (*SerializeFn)(CFTypeRef, CFOptionFlags);
static HIDEvent (*VendorEventFn)(CFAllocatorRef, uint64_t, uint16_t, uint16_t, uint32_t, const uint8_t *, CFIndex, uint32_t);
static HIDClient (*ClientCreateFn)(CFAllocatorRef);
static void (*DispatchFn)(HIDClient, HIDEvent);
static HIDClient (*ClientCreateWithTypeFn)(CFAllocatorRef, int, CFDictionaryRef);
static CFArrayRef (*CopyServicesFn)(HIDClient);
static CFTypeRef (*CopyPropertyFn)(HIDService, CFStringRef);
static CFTypeRef (*RegistryIDFn)(HIDService);
static HIDEvent (*DigitizerEventFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                                    double, double, double, double, double, Boolean, Boolean, uint32_t);
static HIDEvent (*FingerEventFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                 double, double, double, double, double, Boolean, Boolean, uint32_t);
static void (*AppendEventFn)(HIDEvent, HIDEvent, uint32_t);
static void (*SetIntegerFn)(HIDEvent, uint32_t, long);
static void (*SetSenderFn)(HIDEvent, uint64_t);
static HIDEvent (*KeyboardEventFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t);

static HIDClient gClient;

// Digitizer event masks (IOHIDEventTypes.h).
enum { kRange = 1, kTouch = 2, kPosition = 4 };
// kIOHIDEventFieldDigitizerIsDisplayIntegrated
static const uint32_t kDisplayIntegratedField = (11u << 16) | 25u;
// Vendor usage the simulated hinge sensor listens on.
static const uint16_t kHingeUsagePage = 0xFF61;
static const uint16_t kHingeUsage = 0x5B;

static const int kMaxFingers = 2;

static void Reply(NSDictionary *record) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
  if (!json) return;
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void ReplyOK(id commandID) {
  if (commandID) Reply(@{@"id": commandID, @"ok": @YES});
}

static void ReplyError(id commandID, NSString *message) {
  Reply(@{@"id": commandID ?: [NSNull null], @"ok": @NO, @"error": message});
}

static BOOL LoadHID(void) {
  void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
  if (!iokit) return NO;
#define LOAD(var, name) var = dlsym(iokit, name)
  LOAD(SerializeFn, "IOCFSerialize");
  LOAD(VendorEventFn, "IOHIDEventCreateVendorDefinedEvent");
  LOAD(ClientCreateFn, "IOHIDEventSystemClientCreate");
  LOAD(DispatchFn, "IOHIDEventSystemClientDispatchEvent");
  LOAD(ClientCreateWithTypeFn, "IOHIDEventSystemClientCreateWithType");
  LOAD(CopyServicesFn, "IOHIDEventSystemClientCopyServices");
  LOAD(CopyPropertyFn, "IOHIDServiceClientCopyProperty");
  LOAD(RegistryIDFn, "IOHIDServiceClientGetRegistryID");
  LOAD(DigitizerEventFn, "IOHIDEventCreateDigitizerEvent");
  LOAD(FingerEventFn, "IOHIDEventCreateDigitizerFingerEvent");
  LOAD(AppendEventFn, "IOHIDEventAppendEvent");
  LOAD(SetIntegerFn, "IOHIDEventSetIntegerValue");
  LOAD(SetSenderFn, "IOHIDEventSetSenderID");
  LOAD(KeyboardEventFn, "IOHIDEventCreateKeyboardEvent");
#undef LOAD
  return SerializeFn && VendorEventFn && ClientCreateFn && DispatchFn;
}

// ── Hinge ───────────────────────────────────────────────────────────────────
// The simulated hinge takes an angle as a vendor-defined HID event whose
// payload is a serialized dictionary — the same event Device Hub's hinge slider
// sends. iOS decides which panel to light from how the angle MOVES, not from
// its value alone, so a jump from shut to flat leaves it confused; the angle is
// therefore eased toward its target here, at the display's frame rate.

static double gHingeSent = -1;      // last angle dispatched; -1 = none yet
static double gHingeTarget = 180;
static BOOL gHingeMoving = NO;
static dispatch_source_t gHingeTimer;
static const double kHingeDegreesPerSecond = 420;   // shut → flat in under half a second
static const double kHingeTickSeconds = 1.0 / 60.0;

// A simulated-sensor control, as Device Hub's own controls send it: a
// vendor-defined event whose payload is a serialized dictionary naming the
// control (`source`) and its new value.
static BOOL SendSensorControl(NSString *source, NSString *type, id value) {
  NSDictionary *payload = @{
    @"provider": @"com.apple.Virtualization.VirtualMachines",
    @"source": source,
    @"type": type,
    @"value": value,
  };
  CFDataRef data = SerializeFn((__bridge CFTypeRef)payload, 1 /* binary */);
  if (!data) return NO;
  HIDEvent event = VendorEventFn(kCFAllocatorDefault, mach_absolute_time(), kHingeUsagePage, kHingeUsage, 0,
                                 CFDataGetBytePtr(data), CFDataGetLength(data), 0);
  BOOL ok = event != NULL;
  if (event) {
    DispatchFn(gClient, event);
    CFRelease(event);
  }
  CFRelease(data);
  return ok;
}

static BOOL SendHingeAngle(double angle) {
  return SendSensorControl(@"hinge-slider-control", @"range", @(angle));
}

// How the device is held. iOS turns its interface to match, as it does when a
// real device is turned. The values are Device Hub's own.
static NSString *SetOrientation(NSDictionary *command) {
  NSString *name = [command[@"orientation"] isKindOfClass:NSString.class] ? command[@"orientation"] : nil;
  NSDictionary<NSString *, NSString *> *values = @{
    @"portrait": @"portrait",
    @"portrait-upside-down": @"pud",
    @"landscape-left": @"landscape-left",
    @"landscape-right": @"landscape-right",
  };
  NSString *value = name ? values[name] : nil;
  if (!value) return @"Expected orientation: portrait, portrait-upside-down, landscape-left or landscape-right";
  return SendSensorControl(@"orientation-picker-control", @"enum", value) ? nil : @"Orientation dispatch failed";
}

static void ReportHinge(void) {
  // One decimal, exactly (a double would print as 167.69999999999999).
  NSDecimalNumber *angle = [NSDecimalNumber decimalNumberWithMantissa:(unsigned long long)llround(gHingeSent * 10) exponent:-1 isNegative:NO];
  Reply(@{@"type": @"hinge", @"angle": angle, @"moving": @(gHingeMoving)});
}

static void StopHingeTimer(void) {
  if (gHingeTimer) {
    dispatch_source_cancel(gHingeTimer);
    gHingeTimer = nil;
  }
  gHingeMoving = NO;
}

static void HingeTick(void) {
  double remaining = gHingeTarget - gHingeSent;
  double step = kHingeDegreesPerSecond * kHingeTickSeconds;
  // Ease out over the last stretch so it settles instead of stopping dead.
  double eased = MAX(step * 0.12, MIN(step, fabs(remaining) * 0.35));
  if (fabs(remaining) <= 0.05 || fabs(remaining) <= eased) {
    gHingeSent = gHingeTarget;
    SendHingeAngle(gHingeSent);
    StopHingeTimer();
    ReportHinge();
    return;
  }
  gHingeSent += remaining > 0 ? eased : -eased;
  SendHingeAngle(gHingeSent);
  ReportHinge();
}

static void SetHinge(double angle, BOOL instant) {
  gHingeTarget = angle;
  if (instant || gHingeSent < 0) {
    StopHingeTimer();
    gHingeSent = angle;
    SendHingeAngle(angle);
    ReportHinge();
    return;
  }
  if (gHingeTimer) return;   // already moving: it now heads for the new target
  if (fabs(gHingeTarget - gHingeSent) <= 0.05) return;
  gHingeMoving = YES;
  gHingeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  uint64_t interval = (uint64_t)(kHingeTickSeconds * NSEC_PER_SEC);
  dispatch_source_set_timer(gHingeTimer, dispatch_time(DISPATCH_TIME_NOW, 0), interval, interval / 8);
  dispatch_source_set_event_handler(gHingeTimer, ^{ HingeTick(); });
  dispatch_resume(gHingeTimer);
}

// ── Touch ───────────────────────────────────────────────────────────────────
// Each panel has its own touchscreen HID service. A digitizer event stamped
// with a service's registry id is delivered as a touch on that service's panel.

@interface Finger : NSObject
@property (nonatomic) BOOL down;
@property (nonatomic) double x;
@property (nonatomic) double y;
@end
@implementation Finger
@end

@interface Panel : NSObject
@property (nonatomic, copy) NSString *displayUUID;
@property (nonatomic) uint64_t registryID;
@property (nonatomic, strong) NSArray<Finger *> *fingers;
@end
@implementation Panel
@end

static NSMutableDictionary<NSString *, Panel *> *gPanels;

static void ResolvePanels(void) {
  gPanels = [NSMutableDictionary dictionary];
  if (!ClientCreateWithTypeFn || !CopyServicesFn || !CopyPropertyFn || !RegistryIDFn) return;
  HIDClient monitor = ClientCreateWithTypeFn(kCFAllocatorDefault, 1 /* monitor */, NULL);
  if (!monitor) return;
  NSArray *services = CFBridgingRelease(CopyServicesFn(monitor));
  for (id service in services) {
    HIDService ref = (__bridge HIDService)service;
    NSNumber *page = CFBridgingRelease(CopyPropertyFn(ref, CFSTR("PrimaryUsagePage")));
    NSNumber *usage = CFBridgingRelease(CopyPropertyFn(ref, CFSTR("PrimaryUsage")));
    // Digitizer page, touch-screen usage.
    if (![page isKindOfClass:NSNumber.class] || page.intValue != 0x0D) continue;
    if (![usage isKindOfClass:NSNumber.class] || usage.intValue != 0x04) continue;
    id uuid = CFBridgingRelease(CopyPropertyFn(ref, CFSTR("displayUUID")));
    if (![uuid isKindOfClass:NSString.class]) continue;
    id registry = (__bridge id)RegistryIDFn(ref);
    if (![registry isKindOfClass:NSNumber.class]) continue;
    Panel *panel = [Panel new];
    panel.displayUUID = [(NSString *)uuid uppercaseString];
    panel.registryID = [(NSNumber *)registry unsignedLongLongValue];
    NSMutableArray *fingers = [NSMutableArray array];
    for (int i = 0; i < kMaxFingers; i++) [fingers addObject:[Finger new]];
    panel.fingers = fingers;
    gPanels[panel.displayUUID] = panel;
  }
  CFRelease(monitor);
}

// One hand event carrying every finger involved: those on the glass, plus the
// one in `changed` when it is lifting (`changedMask` says what happened to it).
static BOOL DispatchHand(Panel *panel, int changed, uint32_t changedMask) {
  if (!DigitizerEventFn || !FingerEventFn || !AppendEventFn || !SetIntegerFn || !SetSenderFn) return NO;
  uint64_t now = mach_absolute_time();
  BOOL anyDown = NO;
  double sumX = 0, sumY = 0;
  int count = 0;
  for (Finger *finger in panel.fingers) {
    if (!finger.down) continue;
    anyDown = YES;
    sumX += finger.x;
    sumY += finger.y;
    count++;
  }
  Finger *subject = panel.fingers[changed];
  double handX = count ? sumX / count : subject.x;
  double handY = count ? sumY / count : subject.y;
  HIDEvent hand = DigitizerEventFn(kCFAllocatorDefault, now, 2 /* finger transducer */, 0, 1, changedMask, 0,
                                   handX, handY, 0, 0, 0, anyDown, anyDown, 0);
  if (!hand) return NO;
  SetIntegerFn(hand, kDisplayIntegratedField, 1);
  for (int i = 0; i < (int)panel.fingers.count; i++) {
    Finger *finger = panel.fingers[i];
    BOOL isChanged = i == changed;
    if (!finger.down && !isChanged) continue;
    uint32_t mask = isChanged ? changedMask : kPosition;
    HIDEvent child = FingerEventFn(kCFAllocatorDefault, now, (uint32_t)(i + 1), (uint32_t)(i + 1), mask,
                                   finger.x, finger.y, 0, finger.down ? 1.0 : 0.0, 0, finger.down, finger.down, 0);
    if (!child) continue;
    SetIntegerFn(child, kDisplayIntegratedField, 1);
    AppendEventFn(hand, child, 0);
    CFRelease(child);
  }
  SetSenderFn(hand, panel.registryID);
  DispatchFn(gClient, hand);
  CFRelease(hand);
  return YES;
}

static NSString *Touch(NSDictionary *command) {
  NSString *display = [command[@"display"] isKindOfClass:NSString.class] ? [command[@"display"] uppercaseString] : nil;
  NSString *phase = [command[@"phase"] isKindOfClass:NSString.class] ? command[@"phase"] : nil;
  NSNumber *x = [command[@"x"] isKindOfClass:NSNumber.class] ? command[@"x"] : nil;
  NSNumber *y = [command[@"y"] isKindOfClass:NSNumber.class] ? command[@"y"] : nil;
  int index = [command[@"finger"] isKindOfClass:NSNumber.class] ? [command[@"finger"] intValue] : 0;
  if (!display || !phase || !x || !y || index < 0 || index >= kMaxFingers) {
    return @"Expected touch with display, phase, finger 0 or 1, and x/y from 0 to 1";
  }
  Panel *panel = gPanels[display];
  if (!panel) {
    ResolvePanels();   // services can appear after boot
    panel = gPanels[display];
  }
  if (!panel) return @"No touchscreen for that display";
  Finger *finger = panel.fingers[index];
  double fx = MIN(1, MAX(0, x.doubleValue)), fy = MIN(1, MAX(0, y.doubleValue));
  uint32_t mask;
  if ([phase isEqual:@"down"]) {
    if (finger.down) {   // a repeated down is a move
      mask = kPosition;
    } else {
      mask = kRange | kTouch | kPosition;
      finger.down = YES;
    }
    finger.x = fx;
    finger.y = fy;
  } else if ([phase isEqual:@"move"]) {
    if (!finger.down) return nil;   // a move with no finger down: nothing to do
    mask = kPosition;
    finger.x = fx;
    finger.y = fy;
  } else if ([phase isEqual:@"up"]) {
    if (!finger.down) return nil;
    mask = kRange | kTouch;
    finger.x = fx;
    finger.y = fy;
    finger.down = NO;
  } else {
    return @"Unknown touch phase";
  }
  return DispatchHand(panel, index, mask) ? nil : @"Simulator touch API is unavailable";
}

static void ReleasePanel(Panel *panel) {
  for (int i = 0; i < (int)panel.fingers.count; i++) {
    Finger *finger = panel.fingers[i];
    if (!finger.down) continue;
    finger.down = NO;
    DispatchHand(panel, i, kRange | kTouch);
  }
}

// ── Buttons ─────────────────────────────────────────────────────────────────

static NSString *Button(NSDictionary *command) {
  if (!KeyboardEventFn) return @"Simulator button API is unavailable";
  NSString *name = [command[@"button"] isKindOfClass:NSString.class] ? command[@"button"] : nil;
  NSNumber *down = [command[@"down"] isKindOfClass:NSNumber.class] ? command[@"down"] : nil;
  // Consumer-page usages, as a hardware button sends them.
  NSDictionary<NSString *, NSNumber *> *usages = @{
    @"lock": @0x30,          // Power
    @"volumeUp": @0xE9,
    @"volumeDown": @0xEA,
    @"home": @0x40,          // Menu
  };
  NSNumber *usage = name ? usages[name] : nil;
  if (!usage || !down) return @"Expected button (lock, volumeUp, volumeDown, home) with down true or false";
  HIDEvent event = KeyboardEventFn(kCFAllocatorDefault, mach_absolute_time(), 0x0C, usage.unsignedIntValue, down.boolValue, 0);
  if (!event) return @"Button dispatch failed";
  DispatchFn(gClient, event);
  CFRelease(event);
  return nil;
}

// ── Keyboard ────────────────────────────────────────────────────────────────
// `keys` is a list of [usage, down] pairs from the keyboard usage page, sent in
// order with a short gap so each stroke is seen as its own event.

static NSString *Keys(NSDictionary *command) {
  if (!KeyboardEventFn) return @"Simulator keyboard API is unavailable";
  NSArray *keys = [command[@"keys"] isKindOfClass:NSArray.class] ? command[@"keys"] : nil;
  if (!keys || keys.count > 4096) return @"Expected keys: a list of [usage, down] pairs";
  for (id pair in keys) {
    if (![pair isKindOfClass:NSArray.class] || [pair count] != 2 ||
        ![pair[0] isKindOfClass:NSNumber.class] || ![pair[1] isKindOfClass:NSNumber.class]) {
      return @"Expected keys: a list of [usage, down] pairs";
    }
    int usage = [pair[0] intValue];
    if (usage < 0 || usage > 0xE7) return @"Keyboard usage out of range";
  }
  for (NSArray *pair in keys) {
    HIDEvent event = KeyboardEventFn(kCFAllocatorDefault, mach_absolute_time(), 0x07,
                                     (uint32_t)[pair[0] intValue], [pair[1] boolValue], 0);
    if (!event) return @"Key dispatch failed";
    DispatchFn(gClient, event);
    CFRelease(event);
    usleep(1500);
  }
  return nil;
}

// ── Commands ────────────────────────────────────────────────────────────────

static void HandleCommand(NSDictionary *command) {
  id commandID = command[@"id"];
  NSString *type = [command[@"type"] isKindOfClass:NSString.class] ? command[@"type"] : nil;
  if ([type isEqual:@"hinge"]) {
    NSNumber *angle = [command[@"angle"] isKindOfClass:NSNumber.class] ? command[@"angle"] : nil;
    if (!angle || !isfinite(angle.doubleValue) || angle.doubleValue < 0 || angle.doubleValue > 180) {
      ReplyError(commandID, @"Expected hinge command with angle from 0 to 180");
      return;
    }
    SetHinge(angle.doubleValue, [command[@"instant"] isKindOfClass:NSNumber.class] && [command[@"instant"] boolValue]);
    ReplyOK(commandID);
  } else if ([type isEqual:@"touch"]) {
    NSString *error = Touch(command);
    if (error) ReplyError(commandID, error); else ReplyOK(commandID);
  } else if ([type isEqual:@"release"]) {
    NSString *display = [command[@"display"] isKindOfClass:NSString.class] ? [command[@"display"] uppercaseString] : nil;
    if (display) {
      Panel *panel = gPanels[display];
      if (panel) ReleasePanel(panel);
    } else {
      for (Panel *panel in gPanels.allValues) ReleasePanel(panel);
    }
    ReplyOK(commandID);
  } else if ([type isEqual:@"button"]) {
    NSString *error = Button(command);
    if (error) ReplyError(commandID, error); else ReplyOK(commandID);
  } else if ([type isEqual:@"orientation"]) {
    NSString *error = SetOrientation(command);
    if (error) ReplyError(commandID, error); else ReplyOK(commandID);
  } else if ([type isEqual:@"keys"]) {
    NSString *error = Keys(command);
    if (error) ReplyError(commandID, error); else ReplyOK(commandID);
  } else if ([type isEqual:@"displays"]) {
    ResolvePanels();
    NSMutableArray *list = [NSMutableArray array];
    for (Panel *panel in gPanels.allValues) {
      [list addObject:@{@"display": panel.displayUUID, @"registryID": @(panel.registryID)}];
    }
    Reply(@{@"id": commandID ?: [NSNull null], @"ok": @YES, @"displays": list});
  } else {
    ReplyError(commandID, @"Unknown command");
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    (void)argc;
    (void)argv;
    if (!LoadHID()) {
      ReplyError(nil, @"Required simulator HID API is unavailable");
      return 1;
    }
    gClient = ClientCreateFn(kCFAllocatorDefault);
    if (!gClient) {
      ReplyError(nil, @"Could not create simulator HID client");
      return 1;
    }
    ResolvePanels();
    Reply(@{@"type": @"ready", @"displays": gPanels.allKeys});

    // Lines are read off the main thread and handled on it, so the hinge timer
    // and the commands never run at once.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      char *line = NULL;
      size_t capacity = 0;
      ssize_t length;
      while ((length = getline(&line, &capacity, stdin)) > 0) {
        if (length > 4096) {
          dispatch_async(dispatch_get_main_queue(), ^{ ReplyError(nil, @"Command is too large"); });
          continue;
        }
        NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
        dispatch_async(dispatch_get_main_queue(), ^{
          id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
          if ([parsed isKindOfClass:NSDictionary.class]) HandleCommand(parsed);
          else ReplyError(nil, @"Command is not a JSON object");
        });
      }
      free(line);
      // stdin closed: the host agent is gone. Lift any finger still down.
      dispatch_async(dispatch_get_main_queue(), ^{
        for (Panel *panel in gPanels.allValues) ReleasePanel(panel);
        exit(0);
      });
    });
    dispatch_main();
  }
  return 0;
}
