// BotflowPreviewOrientation — a tiny iOS-Simulator dylib that lets Botflow's
// live preview rotate ANY running app, regardless of when the project was
// scaffolded or whether its source contains an orientation observer.
//
// It is injected at launch via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES (the same
// mechanism the camera shim uses), so it needs ZERO changes to the user's
// project. Its constructor runs before UIApplicationMain and registers Darwin
// notification observers for io.botflow.orient.* ; when the host posts one
// (via `simctl spawn notifypost`), the handler drives the public
// requestGeometryUpdate API to rotate the app — exactly like real hardware.
//
// Requirements (supplied by the host's xcodebuild plist overrides):
//   • the app's Info.plist must allow the target orientation
//   • UIRequiresFullScreen=YES on iPad (else iPadOS rejects the geometry change)
//
// Built for the iphonesimulator SDK (arm64). Pure preview tooling — it is never
// part of a device or App Store build.
#import <UIKit/UIKit.h>
#import <CoreFoundation/CoreFoundation.h>

static UIInterfaceOrientationMask BotflowMaskForName(NSString *name) {
    if ([name hasSuffix:@"landscapeleft"]) return UIInterfaceOrientationMaskLandscapeLeft;
    if ([name hasSuffix:@"landscaperight"] || [name hasSuffix:@"landscape"])
        return UIInterfaceOrientationMaskLandscapeRight;
    if ([name hasSuffix:@"portraitupsidedown"]) return UIInterfaceOrientationMaskPortraitUpsideDown;
    return UIInterfaceOrientationMaskPortrait;
}

static void BotflowApplyOrientation(UIInterfaceOrientationMask mask) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIWindowScene *target = nil;
        for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            UIWindowScene *ws = (UIWindowScene *)scene;
            if (!target) target = ws;
            if (scene.activationState == UISceneActivationStateForegroundActive) {
                target = ws;
                break;
            }
        }
        if (!target) return;
        UIWindowSceneGeometryPreferencesIOS *prefs =
            [[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:mask];
        [target requestGeometryUpdateWithPreferences:prefs
                                        errorHandler:^(NSError *error) {
            NSLog(@"[BotflowPreviewOrientation] requestGeometryUpdate failed: %@", error.localizedDescription);
        }];
    });
}

static void BotflowOrientCallback(CFNotificationCenterRef center,
                                  void *observer,
                                  CFNotificationName name,
                                  const void *object,
                                  CFDictionaryRef userInfo) {
    NSString *n = (__bridge NSString *)name;
    BotflowApplyOrientation(BotflowMaskForName(n));
}

__attribute__((constructor))
static void BotflowPreviewOrientationInit(void) {
    CFNotificationCenterRef center = CFNotificationCenterGetDarwinNotifyCenter();
    if (!center) return;
    const CFStringRef names[] = {
        CFSTR("io.botflow.orient.portrait"),
        CFSTR("io.botflow.orient.portraitupsidedown"),
        CFSTR("io.botflow.orient.landscape"),
        CFSTR("io.botflow.orient.landscaperight"),
        CFSTR("io.botflow.orient.landscapeleft"),
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        CFNotificationCenterAddObserver(center, NULL, BotflowOrientCallback, names[i], NULL,
                                        CFNotificationSuspensionBehaviorDeliverImmediately);
    }
    NSLog(@"[BotflowPreviewOrientation] orientation observers registered");
}
