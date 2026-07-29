#!/bin/bash
# Botflow sim egress containment guard.
#
# HARD RULE: never reload the MAIN ruleset (pfctl -f /etc/pf.conf) on a healthy
# system. A main-ruleset reload flushes anchors that system services insert
# dynamically — including the Virtualization.framework/vmnet NAT rules — which
# silently kills ALL network egress for running build VMs (packets leave the
# physical interface with un-NATted 192.168.64.x sources). /etc/pf.conf's own
# header warns about exactly this. The original version of this script reloaded
# every 300s and broke SPM dependency resolution in every build VM (xcodebuild
# exit 74: "Failed to connect to github.com port 443").
ANCHOR=com.botflow.simegress
CONF=/etc/pf.conf
LOG=/var/log/pf-egress-guard.log
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

[ -f "/etc/pf.anchors/$ANCHOR" ] || { log "anchor file missing — cannot enforce"; exit 1; }

# Drift check 1: pf.conf lost our anchor refs (macOS update rewrote it).
# Re-append the refs so the NEXT full reload (reboot) picks them up — but do
# NOT force a main reload now; the anchor-scoped load below is sufficient.
if ! grep -q "$ANCHOR" "$CONF" 2>/dev/null; then
  printf '\n# Botflow sim egress containment (re-added by pf-egress-load.sh)\nanchor "%s"\nload anchor "%s" from "/etc/pf.anchors/%s"\n' \
    "$ANCHOR" "$ANCHOR" "$ANCHOR" >> "$CONF"
  log "re-added anchor refs to $CONF (macOS update or manual edit had removed them)"
fi

# Drift check 2: our anchor rules are gone from the live ruleset. Load ONLY the
# anchor — pfctl -a scopes the flush/load to that anchor and leaves the main
# ruleset and every dynamically-inserted system anchor untouched.
if ! pfctl -a "$ANCHOR" -sr 2>/dev/null | grep -q simblock-loopback; then
  pfctl -a "$ANCHOR" -f "/etc/pf.anchors/$ANCHOR" >/dev/null 2>&1
  log "anchor was empty — reloaded (anchor-scoped)"
fi

# PF itself must be enabled (idempotent; errors when already enabled are fine).
pfctl -s info 2>/dev/null | grep -q "Status: Enabled" || pfctl -e >/dev/null 2>&1

if ! pfctl -a "$ANCHOR" -sr 2>/dev/null | grep -q simblock-loopback; then
  log "WARNING: anchor $ANCHOR is EMPTY after load — sim egress is NOT contained"
fi
