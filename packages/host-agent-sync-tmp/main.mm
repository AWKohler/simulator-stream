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
  const char *kit = "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit";
  if (!dlopen(core, RTLD_NOW | RTLD_GLOBAL)) {
    if (error) *error = [NSString stringWithFormat:@"dlopen CoreSimulator failed: %s", dlerror()];
    return NO;
  }
  if (!dlopen(kit, RTLD_NOW | RTLD_GLOBAL)) {
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

static FramebufferSource *FindFramebuffer(NSString *udid, NSString **error) {
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
    CFRelease(surface);
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
  return candidates.firstObject;
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
@end

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
  VTSessionSetProperty(_session, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef)@(keyInterval));
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
  CMTime pts = CMTimeMake(self.frameNumber, self.fps);
  VTEncodeInfoFlags flags = 0;
  VTCompressionSessionEncodeFrame(_session, pixelBuffer, pts, kCMTimeInvalid, NULL, NULL, &flags);
  self.frameNumber++;
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

    NSString *loadError = nil;
    if (!LoadPrivateFrameworks(&loadError)) {
      WriteError(loadError);
      return 2;
    }

    NSString *fbError = nil;
    FramebufferSource *source = FindFramebuffer(udid, &fbError);
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

    H264Encoder *encoder = [H264Encoder new];
    NSString *encError = nil;
    if (![encoder startWithWidth:(int)CVPixelBufferGetWidth(pixelBuffer) height:(int)CVPixelBufferGetHeight(pixelBuffer) fps:fps bitrate:bitrate keyInterval:keyInterval error:&encError]) {
      CVPixelBufferRelease(pixelBuffer);
      WriteError(encError);
      return 6;
    }

    uint64_t intervalNs = (uint64_t)(1000000000.0 / MAX(1, fps));
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), intervalNs, intervalNs / 5);
    dispatch_source_set_event_handler(timer, ^{
      [encoder encodePixelBuffer:pixelBuffer];
    });
    dispatch_resume(timer);
    [[NSRunLoop mainRunLoop] run];
    CVPixelBufferRelease(pixelBuffer);
  }
  return 0;
}
