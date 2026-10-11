#!/bin/bash
# Keep the Tailscale management path alive while consumer WARP is connected.
# Deployed at /usr/local/sbin/warp-tailscale-excludes.sh, run by
# warp-watchdog.sh before every (re)connect and hourly via
# com.botflow.warp-tailscale-excludes.
#
# WHY: Tailscale's network extension binds its sockets to the PHYSICAL
# interface. WARP's PF firewall drops every non-tunnel flow on that interface
# unless the destination is in WARP's split-tunnel EXCLUDE list. So with WARP up,
# Tailscale cannot reach its control plane or DERP relays and the box drops off
# the tailnet — the only management path — while everything else (which
# routes through the WARP utun) works fine. Verified 2026-10-11 on the 16GB Air:
# curl to derp1/controlplane worked through WARP while `tailscale status` said
# offline; the netcheck storm showed up as ~1000 route lookups per 30s.
#
# FIX: exclude exactly Tailscale's DERP nodes (from the published DERP map) and
# its control/log endpoints. Only Tailscale infrastructure leaves via the home
# IP; sims, build VMs and services still egress via WARP. Direct peer-to-peer
# UDP stays blocked, so the tailnet path relays via DERP (as on the old box).
#
# Idempotent: only adds missing entries. Fetches through whatever path is up
# (WARP or not); keeps the previous list if the fetch fails.
W=/usr/local/bin/warp-cli
LOG=/var/log/warp-tailscale-excludes.log
log() { echo "$(date '+%F %T') $1" >> "$LOG"; }

DERPMAP=$(/usr/bin/curl -fsS --max-time 20 https://login.tailscale.com/derpmap/default) \
  || { log "derpmap fetch failed — keeping existing excludes"; exit 0; }

want=$(
  {
    # DERP node IPv4/IPv6 addresses (Tailscale publishes them in the map).
    echo "$DERPMAP" | /usr/bin/python3 -c '
import json, sys
m = json.load(sys.stdin)
for r in m.get("Regions", {}).values():
    for n in r.get("Nodes", []):
        for k in ("IPv4", "IPv6"):
            v = n.get(k)
            if v and v != "none":
                print(v)
'
    # Control plane, login and log endpoints (resolved now; refreshed hourly).
    for h in controlplane.tailscale.com login.tailscale.com log.tailscale.io; do
      /usr/bin/dscacheutil -q host -a name "$h" 2>/dev/null \
        | /usr/bin/awk '/^ip(v6)?_address:/{print $2}'
    done
  } | /usr/bin/sort -u
)
[ -n "$want" ] || { log "no addresses resolved — keeping existing excludes"; exit 0; }

# Compare NORMALIZED addresses: warp-cli prints IPv6 in its own compressed form,
# so a string match re-adds entries that are already there.
missing=$(
  WANT="$want" HAVE="$($W --accept-tos tunnel ip list 2>/dev/null)" /usr/bin/python3 -c '
import ipaddress, os, re
have = set()
for tok in re.findall(r"[0-9A-Fa-f:.]+/\d+", os.environ["HAVE"]):
    try: have.add(ipaddress.ip_network(tok, strict=False))
    except ValueError: pass
for line in os.environ["WANT"].split():
    try: ip = ipaddress.ip_address(line)
    except ValueError: continue
    if ipaddress.ip_network(ip) not in have: print(ip)
'
)
added=0
while read -r ip; do
  [ -z "$ip" ] && continue
  # `ip add` takes a bare address and lists it as /32 or /128.
  if $W --accept-tos tunnel ip add "$ip" >/dev/null 2>&1; then
    added=$((added+1))
  else
    log "could not add $ip"
  fi
done <<< "$missing"
[ "$added" -gt 0 ] && log "added $added Tailscale exclude(s); total wanted $(printf '%s\n' "$want" | wc -l | tr -d ' ')"
exit 0
