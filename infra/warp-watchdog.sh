#!/bin/bash
# Keep consumer WARP connected (tunnel_only). Covers cold boot and drops.
# Deployed at /usr/local/sbin/warp-watchdog.sh, driven by
# /Library/LaunchDaemons/com.botflow.warp-watchdog.plist (RunAtLoad + 120s).
#
# tunnel_only mode is REQUIRED on this box: full "warp" mode tries to bind a
# local DNS proxy on port 53 and loses the fight against mDNSResponder, which
# already serves DNS for the build-VM NAT subnet on 192.168.64.1:53 — WARP then
# sits in "Unable" and black-holes the box. See infra/pf-egress-load.sh for how
# build-VM traffic is routed into the tunnel.
W=/usr/local/bin/warp-cli
$W status 2>/dev/null | grep -q "Connected" && exit 0
$W mode tunnel_only >/dev/null 2>&1
$W connect >/dev/null 2>&1
sleep 8
$W status 2>/dev/null | grep -q "Connected" \
  && echo "$(date '+%F %T') reconnected WARP" >> /var/log/warp-watchdog.log \
  || echo "$(date '+%F %T') WARP connect FAILED" >> /var/log/warp-watchdog.log
