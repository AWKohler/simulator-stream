# Raising the 2-VM limit (16GB Air sim host)

Virtualization.framework refuses a 3rd concurrent macOS guest. The cap is the
kernel variable `hv_apple_isa_vm_quota`; release kernels only read its boot-arg
override when SIP reports AppleInternal, but **development** kernels honour it
behind `hypervisor=0x1`. Method from
<https://khronokernel.com/macos/2023/08/08/AS-VM.html>.

Set up on `botflows-macbook-air` (Mac14,2, M2, 16GB, macOS 26.7.1 `25G241`) on
2026-10-11.

## What is installed

- KDK `KDK_26.7.1_25G241.kdk` (must match the host build exactly).
- `~/VirtualMachine.kc.development` — built from the KDK's
  `kernel.development.t8112` plus every bundle in the stock release boot
  collection except SEPHiber (377 bundles):

  ```bash
  bundles=$(kmutil inspect -V release --no-header \
    | awk '$1 ~ /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/ {print $1}' | grep -v SEPHiber)
  sudo kmutil create --arch arm64e --no-authorization --variant-suffix development \
    --new boot --boot-path ~/VirtualMachine.kc \
    --kernel $KDK/System/Library/Kernels/kernel.development.t8112 \
    --repository $KDK/System/Library/Extensions \
    --repository /System/Library/Extensions \
    --repository /System/Library/DriverExtensions \
    --explicit-only $(for b in $bundles; do printf -- '-b %s ' $b; done)
  ```

  `kmutil` appends the variant: the output file is `VirtualMachine.kc.development`.
  Note `kmutil inspect --no-header` still prints an `Extension Information:`
  line; the awk filter keeps it out of the bundle list.

- In recoveryOS:

  ```bash
  csrutil disable
  bputil --disable-boot-args-restriction
  kmutil configure-boot --volume "/Volumes/Macintosh HD" \
    --custom-boot-object "/Volumes/Macintosh HD - Data/Users/botflow/VirtualMachine.kc.development"
  nvram 40A0DDD2-77F8-4392-B4A3-1E7304206516:boot-args="kcsuffix=development hypervisor=0x1 hv_apple_isa_vm_quota=0xFF"
  ```

Verify: `sysctl kern.osbuildconfig` → `development`; `sysctl kern.bootargs`.

## Consequences

- SIP is off and boot security is Permissive.
- **No macOS updates** while booted this way — a finished update leaves the
  machine unbootable until the boot policy is reset. Undo first in recoveryOS:
  `bputil --full-security && csrutil enable`, update, then redo all of the above
  with the new build's KDK.
- External USB storage was flaky right after the first boot on this kernel
  (a Samsung T7 enumerated but never mounted through a hub; it mounted when
  re-plugged directly).

## Host-agent

Set `VM_BUILD_SLOTS` above 2 only on a host set up like this. RAM, not the
quota, is the real limit on 16GB — size `VM_BUILD_MEMORY_MB` accordingly.
