// ── Build executor seam ─────────────────────────────────────────────────────
//
// DECIDED END STATE: every build — simulator preview, device `.ipa`, and
// App Store / TestFlight — is QUEUED THROUGH A 2-VM SLOT SYSTEM. Untrusted
// compilation (arbitrary Package.swift / SwiftPM plugins / Run Script phases /
// app code) runs INSIDE a disposable macOS VM (hard isolation, capped at 2
// concurrent per host by Virtualization.framework), never on the bare-metal
// sim host. The compiled `.app`/`.ipa` is the only thing handed back out.
//
// This module is the single swap point so that migration is one implementation
// change rather than a rewrite of the build orchestration in build.ts.
//
// ── Backends ────────────────────────────────────────────────────────────────
//
//  • 'local-simuser' (INTERIM, bare metal):
//      build.ts's runBuild / runDeviceBuild / runAppStoreBuild ARE this backend.
//      Builds run on the sim host as the non-admin `simhost` user (sealed by the
//      per-uid PF firewall), in a shared /tmp workdir. This contains build-time
//      code under the firewalled sim user instead of the privileged orchestrator
//      — acceptable as a stopgap, but NOT a hard boundary (same uid as the sims).
//
//  • 'vm-queue' (IMPLEMENTED — vm-build-runner.ts):
//      Every flavor compiles inside a disposable VM cloned from the golden
//      image, and only the built artifact comes back. ALL THREE contend for the
//      same 2 slots; jobs beyond that wait in a FIFO queue (builds are ~8s, so
//      it drains fast). Sims still run on bare metal as `simhost` — it is only
//      COMPILATION that moves into the VM, which is why builds and sim RUNTIME
//      are deliberately separate code paths.
//        - sim / device: built entirely in the guest (both are unsigned).
//        - App Store: archived UNSIGNED in the guest, then signed + exported +
//          uploaded on the HOST, so the distribution private key never enters a
//          VM that runs untrusted build scripts.
//
// ── Contract a build executor must satisfy ──────────────────────────────────
//   build(tarball, hints, onLog) -> {
//     appBundlePath: string,        // local path the sim user can `simctl install`
//     diagnostics:   BuildDiagnostic[],
//     code:          number,        // 0 == success
//   }
//   ...streaming sanitized log lines via onLog as it goes, and exposing a
//   cancel() so a stale build can be killed when the user hits Refresh.
//
// build.ts implements that contract for 'local-simuser'; vm-build-runner.ts
// implements it for 'vm-queue'. Call sites switch on selectedBuildBackend().

export type BuildBackend = 'local-simuser' | 'vm-queue';

/**
 * Which build backend is active: 'vm-queue' when VM_BUILD_QUEUE_URL is set,
 * 'local-simuser' otherwise. Call sites (session.ts, index.ts) switch on this.
 */
export function selectedBuildBackend(): BuildBackend {
  return process.env.VM_BUILD_QUEUE_URL ? 'vm-queue' : 'local-simuser';
}

/**
 * Defensive guard for the BARE-METAL build entry points.
 *
 * All three flavors (simulator preview, device .ipa, App Store) now have a VM
 * implementation and are routed by their call sites. Reaching a local entry
 * point while `VM_BUILD_QUEUE_URL` is set therefore means a routing bug — and
 * silently compiling untrusted input on bare metal (beside the signing
 * keychain) is exactly what this backend exists to prevent. Fail loudly.
 */
export function assertLocalBackendAllowed(flavor: string): void {
  if (selectedBuildBackend() === 'vm-queue') {
    throw new Error(
      `${flavor} build reached the bare-metal path while VM_BUILD_QUEUE_URL is set — ` +
        `routing bug. Refusing to compile untrusted input outside the VM.`,
    );
  }
}
