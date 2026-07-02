#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>
static void dumpProto(const char*n){Protocol*p=objc_getProtocol(n);if(!p){printf("proto %s: NOT FOUND\n",n);return;}printf("proto %s found:\n",n);unsigned int c=0;struct objc_method_description*d=protocol_copyMethodDescriptionList(p,YES,YES,&c);for(unsigned int i=0;i<c;i++){NSString*s=NSStringFromSelector(d[i].name);if([s rangeOfString:@"orient" options:NSCaseInsensitiveSearch].location!=NSNotFound)printf("   %s types=%s\n",s.UTF8String,d[i].types);}if(d)free(d);}
int main(){setbuf(stdout,NULL);
 dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",RTLD_NOW|RTLD_GLOBAL);
 dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",RTLD_NOW|RTLD_GLOBAL);
 void*h=dlopen("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator",RTLD_NOW|RTLD_GLOBAL);
 printf("Simulator dlopen=%p err=%s\n",h,dlerror()?:"none");
 dumpProto("SimulatorBridge");
 printf("== classes w/ setOrientation ==\n");
 unsigned int n=0;Class*all=objc_copyClassList(&n);
 for(unsigned int i=0;i<n;i++){if(class_getInstanceMethod(all[i],@selector(setOrientation:))){const char*cn=class_getName(all[i]);NSString*s=@(cn);if([s containsString:@"Sim"]||[s containsString:@"Bridge"]||[s containsString:@"Device"])printf("  %s responds setOrientation:\n",cn);}}
 free(all);printf("DONE\n");return 0;}
