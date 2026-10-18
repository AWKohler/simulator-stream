# Sim host: 16GB MacBook Air (`botflows-macbook-air`)

Rebuilt 2026-10-11 from a Time Machine backup of the previous prod box
(`macbook-pro-1`, M5 Pro/64GB, HOST_ID `botflow-mba-26`). Same HOST_ID, tokens
and Cloudflare tunnel, so the Botflow web app needed no change.

| | |
|---|---|
| Hardware | Mac14,2 (M2, 8 cores, 16GB), macOS 26.7.1 `25G241` |
| Kernel | development KC with the VM quota raised — see [vm-quota.md](vm-quota.md) |
| Users | `botflow` (admin, orchestrator, uid 501), `simhost` (standard, uid 502, console auto-login) |
| Ingress | Cloudflare Tunnel `sim.botflow-site.app` → controller :8080 |
| Egress | Cloudflare WARP, tunnel_only/WireGuard — see [warp-egress.md](warp-egress.md) |
| Management | Tailscale standalone (accept-routes OFF), relays via DERP under WARP |

## Layout

- Code: `~botflow/expo-stream` (this repo), secrets in `~botflow/expo-stream/.env`.
- Node 22.11 + pnpm: `~botflow/.local/node`. xcodegen/idb: `~botflow/.local`.
- Xcode 26.6 at `/Applications/Xcode.app`, iOS 26.5 simulator runtime.
- `/opt/sim-tools`: framebuffer capturer, notifypost, orientation dylib,
  idb_companion, **tart.app** — built/copied by [install-sim-tools.sh](install-sim-tools.sh)
  (tart is copied in by hand: `sudo cp -R ~/tools/tart/tart.app /opt/sim-tools/`).
- Golden build image: `~simhost/.tart/vms/golden-v3` (Xcode 26.4.1 inside).
- `sshpass` via Homebrew, linked to `/usr/local/bin/sshpass`.

## LaunchDaemons (`/Library/LaunchDaemons`)

`com.simstream.controller`, `com.simstream.host-agent`,
`com.botflow.cloudflared-sim`, `com.botflow.warp-watchdog`,
`com.botflow.warp-tailscale-excludes`, `com.botflow.pf-egress`,
`com.botflow.sim-watchdog`, `com.botflow.tailscale-keepalive`,
`com.botflow.xcode-select-guard`, `com.botflow.pmset-guard`.
Logs: `~botflow/Library/Logs/simstream/`, `/var/log/*.log`.

`com.simstream.host-agent` **must** carry `<key>ProcessType</key><string>Interactive</string>`.
Without it launchd applies its default "light resource limits" to the job and
everything it spawns, coalescing timers: the framebuffer capturer (60 Hz
dispatch timer) delivered ~13 fps to browsers while an identical capturer
started from a shell did 60. Verify with
`sudo launchctl print system/com.simstream.host-agent | grep "spawn type"` →
`interactive (4)`. Changing the plist needs `bootout` + `bootstrap`
(`kickstart -k` does not re-read it).

## Host-agent settings that differ from the old box

| Env | Value | Why |
|---|---|---|
| `HOST_SLOTS` (.env) | 2 | was 10 on 64GB |
| `VM_BUILD_SLOTS` | 1 | 2 sims + 2 compiling 4GB VMs exhausted RAM: one launch timed out at 60s |
| `VM_BUILD_MEMORY_MB` / `VM_BUILD_CPU` | 4096 / 4 | golden-v3 config asks for 32GB/14 CPUs |
| `VM_BUILD_TART_AS_SIM_USER` | 1 | VMs only boot under a user with a login session (see below) |
| `TART_BIN` | `/opt/sim-tools/tart.app/Contents/MacOS/tart` | readable by simhost |
| `SIM_LEAN` | 1 | Lean mode (`src/lean.ts`) |

### Build VMs run as `simhost`

Virtualization.framework creates a per-host identity key in the Secure Enclave
for the user running a macOS guest. With only `simhost` logged in, a VM started
by `botflow` (or root) fails with `VZErrorDomain -9 … Failed to create new
HostKey` (SEP: `errKCInteractionNotAllowed`). `simhost` holds the console
session, so tart runs as `simhost`; the orchestrator still drives guests over
SSH. This also means a guest escape lands in the PF-contained sim user.

## Measured (2026-10-11)

- Single session: build in VM ~17–25s, streaming at ~54s from create.
- Two sessions + two 4GB build VMs: one launch timed out (memory: compressor
  holding ~10GB, 59% free). With `VM_BUILD_SLOTS=1` both streamed; the second
  waited ~2 min for the build VM to be recycled.
- Guest isolation verified from inside a build VM: egress `warp=on`, GitHub
  reachable; host sshd/controller, router, BGW, tailnet all blocked.
- simhost: egress `warp=on`; router/tailnet blocked.
- Lean mode, one iOS 26.5 iPhone 16 Pro, 120s after boot, sum of per-process
  `phys_footprint` over the launchd_sim tree: **3963 MB off → 3156 MB on
  (−20%)**, 279 → 214 processes. (One pair; whole-system vm_stat deltas were
  too noisy — they include file cache — to use.)

## Known gaps

- **Loopback is not filtered**: `pfctl -vsI` shows `lo0 (skip)` while WARP is
  connected, so the `simblock-loopback` rule never matches and simhost (i.e. a
  user app in a simulator) can reach 127.0.0.1:8080. Every controller API needs
  the platform token, host token or a per-session stream token, so only
  `/health` is exposed; the camera server (:8090) must be reachable anyway.
- The Air is on the ER605's VLAN 1 port (192.168.0.100), not the walled-off
  BOTFLOW VLAN 20 port, and is not yet tagged `tag:botflow` in Tailscale.
- No macOS updates while on the development kernel (see vm-quota.md).
