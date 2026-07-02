// Try to rotate the simulator via CoreSimulator's SimulatorBridge IPC
// (_sendBridgeRequest:), with NO Accessibility/GUI. Confirms the protocol has
// setOrientation: and attempts a live rotate, verifying via screenshot aspect.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>

static id SendId(id t, SEL s){ return ((id(*)(id,SEL))objc_msgSend)(t,s); }
static id SendId2Err(id t, SEL s, id a, NSError**e){ return ((id(*)(id,SEL,id,NSError**))objc_msgSend)(t,s,a,e); }

static id FindDevice(NSString *udid) {
  Class SSC = NSClassFromString(@"SimServiceContext");
  Class SDS = NSClassFromString(@"SimDeviceSet");
  NSError *err=nil;
  id ctx = ((id(*)(id,SEL,id,NSError**))objc_msgSend)(SSC, @selector(sharedServiceContextForDeveloperDir:error:), @"/Applications/Xcode.app/Contents/Developer", &err);
  id setPath = SendId(SDS, @selector(defaultSetPath));
  id set = SendId2Err(ctx, @selector(deviceSetWithPath:error:), setPath, &err);
  NSDictionary *byUDID = SendId(set, @selector(devicesByUDID));
  for (id k in byUDID) if ([[k description] caseInsensitiveCompare:udid]==NSOrderedSame) return byUDID[k];
  return nil;
}

static void DumpProtocol(const char *name) {
  Protocol *p = objc_getProtocol(name);
  if (!p) { printf("protocol %s NOT found\n", name); return; }
  printf("protocol %s methods:\n", name);
  for (int req = 0; req < 2; req++) {
    for (int inst = 0; inst < 2; inst++) {
      unsigned int n=0;
      struct objc_method_description *d = protocol_copyMethodDescriptionList(p, req==0, inst==1, &n);
      for (unsigned int i=0;i<n;i++){
        NSString *s = NSStringFromSelector(d[i].name);
        if ([s rangeOfString:@"orient" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [s rangeOfString:@"rotat" options:NSCaseInsensitiveSearch].location != NSNotFound)
          printf("   %s  types=%s\n", s.UTF8String, d[i].types);
      }
      if (d) free(d);
    }
  }
}

int main(int argc, char**argv){
  @autoreleasepool {
    NSString *udid = @(argv[1]);
    long long orient = argc > 2 ? atoll(argv[2]) : 3; // try value
    dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW|RTLD_GLOBAL);
    dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW|RTLD_GLOBAL);
    DumpProtocol("SimulatorBridge");
    id device = FindDevice(udid);
    if (!device) { printf("device not found\n"); return 3; }

    __block BOOL called = NO;
    void (^req)(id) = ^(id bridge){
      called = YES;
      printf("block invoked, bridge=%p class=%s\n", (__bridge void*)bridge, bridge?class_getName(object_getClass(bridge)):"nil");
      if (bridge && [bridge respondsToSelector:@selector(setOrientation:)]) {
        ((void(*)(id,SEL,long long))objc_msgSend)(bridge, @selector(setOrientation:), orient);
        printf("called setOrientation:%lld\n", orient);
      } else {
        printf("bridge does NOT respond to setOrientation:\n");
        if (bridge) {
          Class c = object_getClass(bridge);
          unsigned int n=0; Method *ms=class_copyMethodList(c,&n);
          for(unsigned int i=0;i<n;i++){NSString*s=NSStringFromSelector(method_getName(ms[i])); if([s rangeOfString:@"orient" options:NSCaseInsensitiveSearch].location!=NSNotFound) printf("   bridge has %s\n", s.UTF8String);}
          if(ms)free(ms);
        }
      }
    };
    NSError *err = nil;
    @try {
      ((id(*)(id,SEL,id,id,NSError**))objc_msgSend)(device, @selector(_sendBridgeRequest:caller:error:), req, @"botflow-rotate", &err);
    } @catch (NSException *e) {
      printf("EXCEPTION sending bridge request: %s\n", e.reason.UTF8String);
    }
    printf("block called=%d err=%s\n", called, err?err.description.UTF8String:"none");
    printf("DONE\n");
  }
  return 0;
}
