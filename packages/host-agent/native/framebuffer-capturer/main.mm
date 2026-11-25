#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>
#import <IOSurface/IOSurface.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>

static id SendId(id target, SEL sel) {
  return ((id (*)(id, SEL))objc_msgSend)(target, sel);
}

static id SendId1(id target, SEL sel, id a) {
  return ((id (*)(id, SEL, id))objc_msgSend)(target, sel, a);
}

static id SendId2Err(id target, SEL sel, id a, NSError **err) {
  return ((id (*)(id, SEL, id, NSError **))objc_msgSend)(target, sel, a, err);
}

static BOOL Responds(id target, SEL sel) {
  return target && [target respondsToSelector:sel];
}

static void WriteJSONRecord(NSDictionary *dict) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:dict options:0 error:nil];
  uint32_t len = htonl((uint32_t)json.length);
  fwrite(&len, 1, sizeof(len), stdout);
  fwrite(json.bytes, 1, json.length, stdout);
  fflush(stdout);
}

static void WriteError(NSString *message) {
  WriteJSONRecord(@{@"type": @"error", @"message": message ?: @"unknown error"});
}

static NSString *ArgValue(NSArray<NSString *> *args, NSString *name, NSString *fallback) {
  NSUInteger idx = [args indexOfObject:name];
  if (idx == NSNotFound || idx + 1 >= args.count) return fallback;
  return args[idx + 1];
}

static BOOL HasArg(NSArray<NSString *> *args, NSString *name) {
  return [args containsObject:name];
}

@interface FramebufferSource : NSObject
@property (nonatomic, strong) id device;
@property (nonatomic, strong) id descriptor;
@property (nonatomic) IOSurfaceRef surface;
@property (nonatomic, assign) int displayClass;
@property (nonatomic, assign) uint32_t screenID;
@property (nonatomic, assign) size_t width;
@property (nonatomic, assign) size_t height;
@end

@implementation FramebufferSource
- (void)dealloc {
  if (_surface) CFRelease(_surface);
}
@end

static BOOL LoadPrivateFrameworks(NSString **error) {
  const char *core = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator";
  // SimulatorKit lives in Developer/Library/PrivateFrameworks up to Xcode 26
  // and in Contents/SharedFrameworks from Xcode 27.
  const char *kits[] = {
    "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
    "/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
  };
  if (!dlopen(core, RTLD_NOW | RTLD_GLOBAL)) {
    if (error) *error = [NSString stringWithFormat:@"dlopen CoreSimulator failed: %s", dlerror()];
    return NO;
  }
  BOOL kitLoaded = NO;
  for (const char *kit : kits) {
    if (dlopen(kit, RTLD_NOW | RTLD_GLOBAL)) {
      kitLoaded = YES;
      break;
    }
  }
  if (!kitLoaded) {
    if (error) *error = [NSString stringWithFormat:@"dlopen SimulatorKit failed: %s", dlerror()];
    return NO;
  }
  return YES;
}

static id FindDevice(NSString *udid, NSString **error) {
  Class SimServiceContext = NSClassFromString(@"SimServiceContext");
  Class SimDeviceSet = NSClassFromString(@"SimDeviceSet");
  if (!SimServiceContext || !SimDeviceSet) {
    if (error) *error = @"CoreSimulator classes are unavailable";
    return nil;
  }

  NSError *err = nil;
  NSString *developerDir = @"/Applications/Xcode.app/Contents/Developer";
  SEL sharedSel = @selector(sharedServiceContextForDeveloperDir:error:);
  id context = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(SimServiceContext, sharedSel, developerDir, &err);
  if (!context) {
    if (error) *error = [NSString stringWithFormat:@"sharedServiceContext failed: %@", err];
    return nil;
  }

  id setPath = SendId(SimDeviceSet, @selector(defaultSetPath));
  id deviceSet = SendId2Err(context, @selector(deviceSetWithPath:error:), setPath, &err);
  if (!deviceSet) {
    if (error) *error = [NSString stringWithFormat:@"deviceSetWithPath failed: %@", err];
    return nil;
  }

  NSDictionary *byUDID = SendId(deviceSet, @selector(devicesByUDID));
  id device = byUDID[udid];
  if (!device) {
    NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:udid];
    if (uuid) device = byUDID[uuid];
  }
  if (!device) {
    for (id key in byUDID) {
      if ([[key description] caseInsensitiveCompare:udid] == NSOrderedSame) {
        device = byUDID[key];
        break;
      }
    }
  }
  if (!device) {
    if (error) *error = [NSString stringWithFormat:@"device %@ not found", udid];
    return nil;
  }
  return device;
}

static unsigned short DescriptorDisplayClass(id descriptor) {
  @try {
    if (Responds(descriptor, @selector(state))) {
      id state = SendId(descriptor, @selector(state));
      if (Responds(state, @selector(displayClass))) {
        return ((unsigned short (*)(id, SEL))objc_msgSend)(state, @selector(displayClass));
      }
    }
  } @catch (__unused NSException *e) {}
  return USHRT_MAX;
}

static uint32_t DescriptorScreenID(id descriptor) {
  @try {
    if (Responds(descriptor, @selector(screenID))) {
      return ((uint32_t (*)(id, SEL))objc_msgSend)(descriptor, @selector(screenID));
    }
    // Xcode 27 puts the screen identity on screenProperties, not descriptor.state.
    if (Responds(descriptor, @selector(screenProperties))) {
      id properties = SendId(descriptor, @selector(screenProperties));
      if (Responds(properties, @selector(screenID))) {
        return ((uint32_t (*)(id, SEL))objc_msgSend)(properties, @selector(screenID));
      }
    }
    if (Responds(descriptor, @selector(state))) {
      id state = SendId(descriptor, @selector(state));
      if (Responds(state, @selector(screenID))) {
        return ((uint32_t (*)(id, SEL))objc_msgSend)(state, @selector(screenID));
      }
    }
  } @catch (__unused NSException *e) {}
  return 0;
}

static IOSurfaceRef CopySurfaceFromDescriptor(id descriptor) {
  NSArray<NSString *> *selectors = @[
    @"maskedFramebufferSurface",
    @"framebufferSurface",
    @"ioSurface"
  ];
  for (NSString *name in selectors) {
    SEL sel = NSSelectorFromString(name);
    if (!Responds(descriptor, sel)) continue;
    @try {
      id surface = SendId(descriptor, sel);
      if (surface) return (IOSurfaceRef)CFRetain((__bridge CFTypeRef)surface);
    } @catch (__unused NSException *e) {}
  }
  return nil;
}

// Every display of the device that has a framebuffer surface, largest first.
static NSArray<FramebufferSource *> *ListFramebuffers(NSString *udid, NSString **error) {
  id device = FindDevice(udid, error);
  if (!device) return nil;
  id io = Responds(device, @selector(io)) ? SendId(device, @selector(io)) : nil;
  if (!io) {
    if (error) *error = @"device.io is nil; device must be booted";
    return nil;
  }
  NSArray *ports = Responds(io, @selector(ioPorts)) ? SendId(io, @selector(ioPorts)) : nil;
  if (ports.count == 0) {
    if (error) *error = @"device has no IO ports";
    return nil;
  }

  NSMutableArray<FramebufferSource *> *candidates = [NSMutableArray array];
  for (id port in ports) {
    id descriptor = Responds(port, @selector(descriptor)) ? SendId(port, @selector(descriptor)) : port;
    IOSurfaceRef surface = CopySurfaceFromDescriptor(descriptor);
    if (!surface) continue;
    FramebufferSource *src = [FramebufferSource new];
    src.device = device;
    src.descriptor = descriptor;
    src.surface = surface;
    src.displayClass = DescriptorDisplayClass(descriptor);
    src.screenID = DescriptorScreenID(descriptor);
    src.width = IOSurfaceGetWidth(surface);
    src.height = IOSurfaceGetHeight(surface);
    [candidates addObject:src];
  }

  if (candidates.count == 0) {
    if (error) *error = [NSString stringWithFormat:@"no IOSurface framebuffer found in %lu IO ports", (unsigned long)ports.count];
    return nil;
  }

  [candidates sortUsingComparator:^NSComparisonResult(FramebufferSource *a, FramebufferSource *b) {
    if (a.width * a.height != b.width * b.height) {
      return (a.width * a.height > b.width * b.height) ? NSOrderedAscending : NSOrderedDescending;
    }
    if (a.displayClass != b.displayClass) return a.displayClass < b.displayClass ? NSOrderedAscending : NSOrderedDescending;
    return NSOrderedSame;
  }];
  return candidates;
}

// The display to capture: the one with `screenID` when given (a device with
// more than one built-in panel, such as the iPhone Duo), else the largest.
static FramebufferSource *FindFramebuffer(NSString *udid, NSNumber *screenID, NSString **error) {
  NSArray<FramebufferSource *> *candidates = ListFramebuffers(udid, error);
  if (!candidates) return nil;
  if (!screenID) return candidates.firstObject;
  for (FramebufferSource *src in candidates) {
    if (src.screenID == screenID.unsignedIntValue) return src;
  }
  if (error) *error = [NSString stringWithFormat:@"no IOSurface framebuffer for screen %@", screenID];
  return nil;
}

static BOOL DumpSurfacePNG(IOSurfaceRef surface, NSString *path, NSString **error) {
  CIImage *image = [CIImage imageWithIOSurface:surface];
  if (!image) {
    if (error) *error = @"CIImage imageWithIOSurface failed";
    return NO;
  }
  CIContext *ctx = [CIContext contextWithOptions:nil];
  CGImageRef cg = [ctx createCGImage:image fromRect:image.extent];
  if (!cg) {
    if (error) *error = @"CIContext createCGImage failed";
    return NO;
  }
  NSURL *url = [NSURL fileURLWithPath:path];
  CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, (__bridge CFStringRef)UTTypePNG.identifier, 1, nil);
  if (!dest) {
    CGImageRelease(cg);
    if (error) *error = @"CGImageDestinationCreateWithURL failed";
    return NO;
  }
  CGImageDestinationAddImage(dest, cg, nil);
  BOOL ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  CGImageRelease(cg);
  if (!ok && error) *error = @"CGImageDestinationFinalize failed";
  return ok;
}

@interface H264Encoder : NSObject
@property (nonatomic, assign) VTCompressionSessionRef session;
@property (nonatomic, assign) int frameNumber;
@property (nonatomic, assign) int fps;
@property (nonatomic, assign) int bitrate;
@property (nonatomic, assign) int keyInterval;
// Frames are stamped with the time they were captured instead of a frame
// count, and keyframes are placed by time as well as by count. For a stream
// that only sends a frame when the picture changes (--skip-unchanged).
@property (nonatomic, assign) BOOL wallClock;
@property (nonatomic, assign) uint64_t startedAt;
@property (nonatomic, assign) uint64_t lastKeyframeAt;
@property (nonatomic, assign) int framesSinceKeyframe;
@end

static uint64_t NowMs(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000000ull;
}

static void WriteAnnexB(CMSampleBufferRef sampleBuffer) {
  if (!sampleBuffer || !CMSampleBufferDataIsReady(sampleBuffer)) return;
  BOOL keyframe = NO;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef att = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    keyframe = !CFDictionaryContainsKey(att, kCMSampleAttachmentKey_NotSync);
  }
  NSMutableData *out = [NSMutableData data];
  static const uint8_t startCode[] = {0, 0, 0, 1};
  if (keyframe) {
    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sampleBuffer);
    for (size_t i = 0; i < 2; i++) {
      const uint8_t *param = NULL;
      size_t paramSize = 0, count = 0;
      OSStatus status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, i, &param, &paramSize, &count, NULL);
      if (status == noErr && param && paramSize > 0) {
        [out appendBytes:startCode length:sizeof(startCode)];
        [out appendBytes:param length:paramSize];
      }
    }
  }
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sampleBuffer);
  if (!block) return;
  size_t length = 0;
  char *data = NULL;
  if (CMBlockBufferGetDataPointer(block, 0, NULL, &length, &data) != kCMBlockBufferNoErr) return;
  size_t offset = 0;
  while (offset + 4 <= length) {
    uint32_t naluLen = 0;
    memcpy(&naluLen, data + offset, 4);
    naluLen = CFSwapInt32BigToHost(naluLen);
    offset += 4;
    if (offset + naluLen > length) break;
    [out appendBytes:startCode length:sizeof(startCode)];
    [out appendBytes:data + offset length:naluLen];
    offset += naluLen;
  }
  if (out.length == 0) return;
  NSString *b64 = [out base64EncodedStringWithOptions:0];
  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  uint64_t ts = CMTIME_IS_VALID(pts) ? (uint64_t)(CMTimeGetSeconds(pts) * 1000.0) : 0;
  WriteJSONRecord(@{
    @"type": @"chunk",
    @"data": b64,
    @"timestampMs": @(ts),
    @"keyframe": @(keyframe),
  });
}

static void CompressionCallback(void *outputCallbackRefCon, void *sourceFrameRefCon, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sampleBuffer) {
  (void)sourceFrameRefCon;
  (void)flags;
  if (status != noErr) {
    WriteError([NSString stringWithFormat:@"VideoToolbox encode failed: %d", status]);
    return;
  }
  H264Encoder *encoder = (__bridge H264Encoder *)outputCallbackRefCon;
  (void)encoder;
  WriteAnnexB(sampleBuffer);
}

@implementation H264Encoder
- (BOOL)startWithWidth:(int)width height:(int)height fps:(int)fps bitrate:(int)bitrate keyInterval:(int)keyInterval error:(NSString **)error {
  self.fps = fps;
  self.bitrate = bitrate;
  self.keyInterval = keyInterval;
  NSDictionary *spec = nil;
  if (@available(macOS 12.1, *)) {
    spec = @{
      (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
      (__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES,
    };
  } else {
    spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES};
  }
  OSStatus status = VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264, (__bridge CFDictionaryRef)spec, NULL, NULL, CompressionCallback, (__bridge void *)self, &_session);
  if (status != noErr || !_session) {
    if (error) *error = [NSString stringWithFormat:@"VTCompressionSessionCreate failed: %d", status];
    return NO;
  }
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel);
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef)@(bitrate));
  // With wall-clock stamps the keyframes are forced from encodePixelBuffer:
  // (a count alone would leave an unchanging panel without one for minutes).
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef)@(self.wallClock ? keyInterval * 30 : keyInterval));
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef)@(fps));
  VTCompressionSessionPrepareToEncodeFrames(_session);
  WriteJSONRecord(@{
    @"type": @"config",
    @"codec": @"h264",
    @"format": @"annexb",
    @"width": @(width),
    @"height": @(height),
    @"fps": @(fps),
    @"bitrate": @(bitrate),
  });
  return YES;
}

- (void)encodePixelBuffer:(CVPixelBufferRef)pixelBuffer {
  if (!_session || !pixelBuffer) return;
  VTEncodeInfoFlags flags = 0;
  if (!self.wallClock) {
    CMTime pts = CMTimeMake(self.frameNumber, self.fps);
    VTCompressionSessionEncodeFrame(_session, pixelBuffer, pts, kCMTimeInvalid, NULL, NULL, &flags);
    self.frameNumber++;
    return;
  }
  uint64_t now = NowMs();
  if (self.startedAt == 0) self.startedAt = now;
  // A keyframe every `keyInterval` frames while the picture is moving, and at
  // least every five seconds while it is still.
  BOOL key = self.frameNumber == 0 || self.framesSinceKeyframe >= self.keyInterval || now - self.lastKeyframeAt >= 5000;
  NSDictionary *frameProperties = key ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
  if (key) {
    self.lastKeyframeAt = now;
    self.framesSinceKeyframe = 0;
  }
  CMTime pts = CMTimeMake((int64_t)(now - self.startedAt), 1000);
  VTCompressionSessionEncodeFrame(_session, pixelBuffer, pts, kCMTimeInvalid, (__bridge CFDictionaryRef)frameProperties, NULL, &flags);
  self.frameNumber++;
  self.framesSinceKeyframe++;
}

- (void)stop {
  if (_session) {
    VTCompressionSessionCompleteFrames(_session, kCMTimeInvalid);
    VTCompressionSessionInvalidate(_session);
    CFRelease(_session);
    _session = NULL;
  }
}

- (void)dealloc {
  [self stop];
}
@end

static CVPixelBufferRef CreatePixelBuffer(IOSurfaceRef surface) {
  CVPixelBufferRef pixelBuffer = NULL;
  NSDictionary *attrs = @{(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{}};
  CVPixelBufferCreateWithIOSurface(NULL, surface, (__bridge CFDictionaryRef)attrs, &pixelBuffer);
  return pixelBuffer;
}

// True when the panel shows anything at all. A panel iOS has switched off
// (the Duo's cover while it is open, its inner screen while it is closed)
// keeps a framebuffer of pure black, so any non-zero sample means it is lit.
// Samples a sparse grid plus two dense rows where the status bar sits, since a
// dark app screen may have nothing else that is not black.
// BGRA. Outside the panel's rounded corners the masked surface is transparent
// (and not black), so only opaque pixels count.
static inline BOOL PixelIsLit(const uint8_t *px) {
  return px[3] > 200 && (px[0] > 6 || px[1] > 6 || px[2] > 6);
}

static BOOL SurfaceIsLit(IOSurfaceRef surface) {
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return YES;
  const uint8_t *base = (const uint8_t *)IOSurfaceGetBaseAddress(surface);
  size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface);
  size_t rowBytes = IOSurfaceGetBytesPerRow(surface);
  BOOL lit = NO;
  if (base && width > 0 && height > 0) {
    const size_t grid = 48;
    for (size_t gy = 0; gy < grid && !lit; gy++) {
      const uint8_t *row = base + ((gy * 2 + 1) * height / (grid * 2)) * rowBytes;
      for (size_t gx = 0; gx < grid; gx++) {
        const uint8_t *px = row + ((gx * 2 + 1) * width / (grid * 2)) * 4;
        if (PixelIsLit(px)) { lit = YES; break; }
      }
    }
    // Dense bands near each edge: wherever the status bar ends up.
    const double bands[] = {0.012, 0.02, 0.03, 0.97, 0.98, 0.988};
    for (size_t b = 0; b < sizeof(bands) / sizeof(bands[0]) && !lit; b++) {
      const uint8_t *row = base + (size_t)(bands[b] * (double)(height - 1)) * rowBytes;
      for (size_t x = 0; x < width; x += 3) {
        const uint8_t *px = row + x * 4;
        if (PixelIsLit(px)) { lit = YES; break; }
      }
      size_t col = (size_t)(bands[b] * (double)(width - 1));
      for (size_t y = 0; y < height && !lit; y += 3) {
        const uint8_t *px = base + y * rowBytes + col * 4;
        if (PixelIsLit(px)) { lit = YES; break; }
      }
    }
  }
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
  return lit;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    NSMutableArray<NSString *> *args = [NSMutableArray array];
    for (int i = 1; i < argc; i++) [args addObject:@(argv[i])];

    NSString *udid = ArgValue(args, @"--udid", nil);
    if (!udid) {
      WriteError(@"--udid is required");
      return 2;
    }
    int fps = [ArgValue(args, @"--fps", @"60") intValue];
    int bitrate = [ArgValue(args, @"--bitrate", @"6000000") intValue];
    int keyInterval = [ArgValue(args, @"--keyframe-interval", [NSString stringWithFormat:@"%d", fps]) intValue];
    // Which display to capture, for a device with more than one panel.
    NSNumber *screenID = nil;
    NSString *screenArg = ArgValue(args, @"--screen-id", nil);
    if (screenArg) {
      NSScanner *scanner = [NSScanner scannerWithString:screenArg];
      long long parsed = 0;
      if (![scanner scanLongLong:&parsed] || !scanner.isAtEnd || parsed < 0 || parsed > UINT32_MAX) {
        WriteError(@"--screen-id must be an unsigned integer");
        return 2;
      }
      screenID = @((uint32_t)parsed);
    }
    // Encode at this fraction of the panel's size (0 < scale <= 1).
    double scale = [ArgValue(args, @"--scale", @"1") doubleValue];
    if (!(scale > 0.1 && scale <= 1)) scale = 1;
    // Encode a frame only when the panel changed, plus one every `idle` seconds
    // so a client that joins late is never without a picture for long.
    BOOL skipUnchanged = HasArg(args, @"--skip-unchanged");
    // Report whether the panel is lit (see SurfaceIsLit) whenever that changes.
    BOOL reportLit = HasArg(args, @"--report-lit");

    NSString *loadError = nil;
    if (!LoadPrivateFrameworks(&loadError)) {
      WriteError(loadError);
      return 2;
    }

    if (HasArg(args, @"--list")) {
      NSString *listError = nil;
      NSArray<FramebufferSource *> *all = ListFramebuffers(udid, &listError);
      if (!all) {
        WriteError(listError ?: @"framebuffer not found");
        return 3;
      }
      NSMutableArray *displays = [NSMutableArray array];
      for (FramebufferSource *src in all) {
        [displays addObject:@{
          @"screenID": @(src.screenID),
          @"width": @(src.width),
          @"height": @(src.height),
          @"displayClass": @(src.displayClass),
          @"lit": @(SurfaceIsLit(src.surface)),
        }];
      }
      WriteJSONRecord(@{@"type": @"displays", @"displays": displays});
      return 0;
    }

    NSString *fbError = nil;
    FramebufferSource *source = FindFramebuffer(udid, screenID, &fbError);
    if (!source) {
      WriteError(fbError ?: @"framebuffer not found");
      return 3;
    }

    if (HasArg(args, @"--probe")) {
      WriteJSONRecord(@{
        @"type": @"probe",
        @"width": @(source.width),
        @"height": @(source.height),
        @"displayClass": @(source.displayClass),
        @"screenID": @(source.screenID),
        @"lit": @(SurfaceIsLit(source.surface)),
      });
      return 0;
    }

    NSString *dump = ArgValue(args, @"--dump-frame", nil);
    if (dump) {
      NSString *dumpError = nil;
      if (!DumpSurfacePNG(source.surface, dump, &dumpError)) {
        WriteError(dumpError);
        return 4;
      }
      WriteJSONRecord(@{@"type": @"dumped", @"path": dump});
      return 0;
    }

    CVPixelBufferRef pixelBuffer = CreatePixelBuffer(source.surface);
    if (!pixelBuffer) {
      WriteError(@"CVPixelBufferCreateWithIOSurface failed");
      return 5;
    }

    // H.264 wants even dimensions; a scaled size is rounded down to them.
    int encWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
    int encHeight = (int)CVPixelBufferGetHeight(pixelBuffer);
    if (scale < 1) {
      encWidth = MAX(2, ((int)(encWidth * scale)) & ~1);
      encHeight = MAX(2, ((int)(encHeight * scale)) & ~1);
    }

    H264Encoder *encoder = [H264Encoder new];
    encoder.wallClock = skipUnchanged;
    NSString *encError = nil;
    if (![encoder startWithWidth:encWidth height:encHeight fps:fps bitrate:bitrate keyInterval:keyInterval error:&encError]) {
      CVPixelBufferRelease(pixelBuffer);
      WriteError(encError);
      return 6;
    }

    IOSurfaceRef surface = source.surface;
    __block uint32_t lastSeed = IOSurfaceGetSeed(surface) - 1;
    __block int ticksSinceEncode = 0;
    __block int ticksSinceLitCheck = 1 << 20;
    __block int litState = -1;
    const int idleTicks = MAX(1, fps / 2);       // an unchanged panel still sends two frames a second
    const int litTicks = MAX(1, fps / 6);        // lit state checked about six times a second

    uint64_t intervalNs = (uint64_t)(1000000000.0 / MAX(1, fps));
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), intervalNs, intervalNs / 5);
    dispatch_source_set_event_handler(timer, ^{
      if (reportLit && ++ticksSinceLitCheck >= litTicks) {
        ticksSinceLitCheck = 0;
        int lit = SurfaceIsLit(surface) ? 1 : 0;
        if (lit != litState) {
          litState = lit;
          WriteJSONRecord(@{@"type": @"lit", @"lit": @(lit == 1)});
        }
      }
      if (skipUnchanged) {
        uint32_t seed = IOSurfaceGetSeed(surface);
        ticksSinceEncode++;
        if (seed == lastSeed && ticksSinceEncode < idleTicks) return;
        lastSeed = seed;
        ticksSinceEncode = 0;
      }
      [encoder encodePixelBuffer:pixelBuffer];
    });
    dispatch_resume(timer);
    [[NSRunLoop mainRunLoop] run];
    CVPixelBufferRelease(pixelBuffer);
  }
  return 0;
}
