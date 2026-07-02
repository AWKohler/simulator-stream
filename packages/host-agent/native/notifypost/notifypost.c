// notifypost — a tiny iOS-Simulator helper that posts a Darwin notification
// inside the guest's notify namespace. The host-agent runs it via
// `xcrun simctl spawn <udid> notifypost <name>`; the Botflow template's
// BotflowPreviewOrientation observer receives the notification and rotates the
// app via requestGeometryUpdate().
//
// This is how we rotate the simulated device with ZERO macOS TCC permissions:
// no Accessibility, no GUI scripting, no helper .app — just a Darwin
// notification, the same kind iOS uses internally. Built for the
// iphonesimulator SDK (arm64) and executed inside the device by simctl spawn.
//
// Usage:   notifypost <darwin-notification-name>
// Exit:    0 on NOTIFY_STATUS_OK, 1 otherwise, 2 on bad args.
#include <notify.h>
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: notifypost <name>\n");
    return 2;
  }
  uint32_t r = notify_post(argv[1]);
  if (r != NOTIFY_STATUS_OK) {
    fprintf(stderr, "notify_post(%s) failed: %u\n", argv[1], r);
    return 1;
  }
  return 0;
}
