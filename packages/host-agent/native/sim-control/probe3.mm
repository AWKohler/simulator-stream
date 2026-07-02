// SAFE introspection: dump SimulatorBridge protocol + bridge-related classes.
// No device boot, no IPC calls — just reflection.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>

static void DumpProtocolAll(const char *name) {
  Protocol *p = objc_getProtocol(name);
  if (!p) { printf("protocol %s: NOT FOUND\n", name); return; }
  printf("== protocol %s ==\n", name);
  for (int inst = 0; inst < 2; inst++) {
    unsigned int n=0;
    struct objc_method_description *d = protocol_copyMethodDescriptionList(p, YES, inst==1, &n);
    for (unsigned int i=0;i<n;i++)
      printf("  %s %s   types=%s\n", inst?"-":"+", NSStringFromSelector(d[i].name).UTF8String, d[i].types);
    if (d) free(d);
  }
}

int main(){
  setbuf(stdout, NULL);
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW|RTLD_GLOBAL);
  dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW|RTLD_GLOBAL);

  DumpProtocolAll("SimulatorBridge");

  // Classes with "Bridge" or "Indigo" (the sim's HID/orientation transport)
  printf("\n== classes containing Bridge/Indigo/Orientation ==\n");
  unsigned int n=0;
  Class *all = objc_copyClassList(&n);
  for (unsigned int i=0;i<n;i++){
    const char *cn = class_getName(all[i]);
    NSString *s = @(cn);
    if ([s containsString:@"Bridge"] || [s containsString:@"Indigo"] ||
        ([s containsString:@"Orient"] )) {
      printf("  %s\n", cn);
    }
  }
  free(all);
  printf("DONE\n");
  return 0;
}
