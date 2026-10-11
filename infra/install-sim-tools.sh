#!/bin/bash
# Build the host-agent's native helpers into /opt/sim-tools, a path the
# non-admin sim user (simhost) can read and execute. In sim-user mode the
# host-agent does NOT compile these itself (SIM_CAPTURER_BIN etc. point here),
# because simhost cannot read the orchestrator's home directory.
#
# Usage (as an admin, from the repo root):  sudo infra/install-sim-tools.sh
# Re-run after changing anything under packages/host-agent/native/ or after an
# Xcode update. Compile flags mirror framebuffer-capturer.ts, notifypost.ts and
# orientation-shim.ts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$REPO/packages/host-agent/native"
OUT=/opt/sim-tools
IDB_SRC="${IDB_COMPANION_DIR:-$HOME/.local/idb/idb-companion.universal}"

mkdir -p "$OUT"
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)

# Host binary: reads the simulator framebuffer IOSurface and encodes H.264.
clang++ -std=c++17 -fobjc-arc "$NATIVE/framebuffer-capturer/main.mm" -o "$OUT/framebuffer-capturer" \
  -framework Foundation -framework CoreMedia -framework CoreVideo -framework VideoToolbox \
  -framework IOSurface -framework CoreImage -framework ImageIO -framework CoreGraphics \
  -framework UniformTypeIdentifiers

# Simulator binary: posts a Darwin notification inside the device (rotation).
xcrun -sdk iphonesimulator clang -target arm64-apple-ios15.0-simulator -isysroot "$SDK" -O2 \
  "$NATIVE/notifypost/notifypost.c" -o "$OUT/notifypost"

# Simulator dylib: injected at app launch to honour rotation requests.
xcrun -sdk iphonesimulator clang -target arm64-apple-ios16.0-simulator -isysroot "$SDK" \
  -dynamiclib -fobjc-arc -framework UIKit -framework CoreFoundation -framework Foundation \
  "$NATIVE/orientation-shim/BotflowPreviewOrientation.m" -o "$OUT/BotflowPreviewOrientation.dylib"

# idb_companion (touch/keyboard input). Prebuilt universal release.
if [ -d "$IDB_SRC" ]; then
  rm -rf "$OUT/idb-companion.universal"
  cp -R "$IDB_SRC" "$OUT/idb-companion.universal"
fi

chown -R root:wheel "$OUT"
chmod -R go-w,a+rX "$OUT"
ls -l "$OUT"
