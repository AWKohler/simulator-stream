// Introspection probe: find a programmatic way to rotate the simulator via
// CoreSimulator/SimulatorKit IPC (no Accessibility needed). Dumps candidate
// methods on SimDevice, its IO client, and any "bridge" object.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>

static id SendId(id t, SEL s){ return ((id(*)(id,SEL))objc_msgSend)(t,s); }
static id SendId2Err(id t, SEL s, id a, NSError**e){ return ((id(*)(id,SEL,id,NSError**))objc_msgSend)(t,s,a,e); }
static BOOL Responds(id t, SEL s){ return t && [t respondsToSelector:s]; }

static void DumpMethods(const char *label, id obj, NSArray<NSString*> *keywords) {
  if (!obj) { printf("  [%s] nil\n", label); return; }
  Class cls = object_getClass(obj);
  printf("  [%s] class=%s\n", label, class_getName(cls));
  // walk class + superclasses
  for (Class c = cls; c && c != [NSObject class]; c = class_getSuperclass(c)) {
    unsigned int n = 0;
    Method *ms = class_copyMethodList(c, &n);
    for (unsigned int i = 0; i < n; i++) {
      NSString *name = NSStringFromSelector(method_getName(ms[i]));
      for (NSString *kw in keywords) {
        if ([name rangeOfString:kw options:NSCaseInsensitiveSearch].location != NSNotFound) {
          printf("    %s :: %s\n", class_getName(c), name.UTF8String);
          break;
        }
      }
    }
    free(ms);
  }
}

static id FindDevice(NSString *udid) {
  Class SimServiceContext = NSClassFromString(@"SimServiceContext");
  Class SimDeviceSet = NSClassFromString(@"SimDeviceSet");
  if (!SimServiceContext || !SimDeviceSet) { printf("CoreSimulator classes missing\n"); return nil; }
  NSError *err = nil;
  id ctx = ((id(*)(id,SEL,id,NSError**))objc_msgSend)(SimServiceContext, @selector(sharedServiceContextForDeveloperDir:error:), @"/Applications/Xcode.app/Contents/Developer", &err);
  if (!ctx) { printf("ctx fail: %s\n", err.description.UTF8String); return nil; }
  id setPath = SendId(SimDeviceSet, @selector(defaultSetPath));
  id set = SendId2Err(ctx, @selector(deviceSetWithPath:error:), setPath, &err);
  NSDictionary *byUDID = SendId(set, @selector(devicesByUDID));
  for (id k in byUDID) if ([[k description] caseInsensitiveCompare:udid]==NSOrderedSame) return byUDID[k];
  return nil;
}

int main(int argc, char**argv){
  @autoreleasepool {
    if (argc < 2) { printf("usage: probe <udid>\n"); return 2; }
    NSString *udid = @(argv[1]);
    dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW|RTLD_GLOBAL);
    dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW|RTLD_GLOBAL);
    id device = FindDevice(udid);
    if (!device) { printf("device not found\n"); return 3; }
    NSArray *kw = @[@"orient", @"rotat", @"bridge", @"post", @"send", @"notif"];
    DumpMethods("SimDevice", device, kw);

    // try to get a bridge a few common ways
    for (NSString *sel in @[@"bridge", @"deviceBridge", @"simulatorBridge"]) {
      SEL s = NSSelectorFromString(sel);
      if (Responds(device, s)) {
        id b = SendId(device, s);
        printf("  device.%s -> %p\n", sel.UTF8String, (__bridge void*)b);
        DumpMethods([sel UTF8String], b, @[@"orient", @"rotat", @"set"]);
      }
    }
    // io client
    if (Responds(device, @selector(io))) {
      id io = SendId(device, @selector(io));
      DumpMethods("io", io, kw);
    }
    // does device take portForServiceNamed / lookupForServiceNamed?
    for (NSString *sel in @[@"portForServiceNamed:error:", @"lookupForServiceNamed:error:"]) {
      printf("  device responds %s = %d\n", sel.UTF8String, [device respondsToSelector:NSSelectorFromString(sel)]);
    }
    printf("DONE\n");
  }
  return 0;
}
