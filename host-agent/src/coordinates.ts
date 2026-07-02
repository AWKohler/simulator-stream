import type { DeviceLogical, ScreenRect, WindowInfo } from '@sim/shared';

// iPhone 16 Pro device model (with bezel) is ~0.914× the window content area.
// The thin metal frame accounts for the remaining ~8.6%, evenly split on all sides.
// These fractions are scale-invariant (hold at any simulator zoom level).
export const BEZEL_FRAC = 0.043;
export const TITLE_BAR_H = 28; // macOS window title bar, logical points

export function computeScreenRect(windowInfo: WindowInfo): ScreenRect {
  const ww = windowInfo.w;
  const wh = windowInfo.h;
  const contentH = wh - TITLE_BAR_H;
  return {
    left: ww * BEZEL_FRAC,
    right: ww * (1 - BEZEL_FRAC),
    top: TITLE_BAR_H + contentH * BEZEL_FRAC,
    bottom: TITLE_BAR_H + contentH * (1 - BEZEL_FRAC),
  };
}

// normX/normY: 0–1 relative to the full SCK-captured window image.
// Returns device logical coordinates for idb, or null when the point lies in the bezel.
export function windowNormToDeviceLogical(
  normX: number,
  normY: number,
  windowInfo: WindowInfo,
  screenRect: ScreenRect,
  deviceLogical: DeviceLogical,
): { x: number; y: number } | null {
  const { left, top, right, bottom } = screenRect;
  const absX = normX * windowInfo.w;
  const absY = normY * windowInfo.h;
  const sx = (absX - left) / (right - left);
  const sy = (absY - top) / (bottom - top);
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null;
  return {
    x: Math.round(sx * deviceLogical.w),
    y: Math.round(sy * deviceLogical.h),
  };
}

export function clampPt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
