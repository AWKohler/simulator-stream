#!/bin/sh
# Builds duo-control for the iOS simulator (it runs inside one; see main.m).
set -eu
cd "$(dirname "$0")"
mkdir -p build
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
xcrun --sdk iphonesimulator clang \
  -arch arm64 \
  -isysroot "$SDK" \
  -mios-simulator-version-min=17.0 \
  -fobjc-arc -O2 -Wall -Wextra \
  main.m -o build/duo-control \
  -framework Foundation -framework CoreFoundation
# Ad-hoc signature: the simulator will not launch an unsigned binary.
codesign --force --sign - build/duo-control
