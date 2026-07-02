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
//  • 'vm-queue' (END STATE, not yet implemented):
//      Submit the project tarball to a build slot (one of the 2 VMs), which runs
//      the entire build inside the VM and returns the built bundle bytes; the
//      host writes them to a local path for the sim user to install. Jobs beyond
//      the 2 live slots wait in a software queue (builds are short, so it drains
//      fast). This is the hard-isolation answer and the reason builds and sim
//      RUNTIME are deliberately kept on separate code paths.
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
// build.ts implements that contract for 'local-simuser' today. When the VM queue
// lands, add a VmQueueBuildRunner satisfying the same contract and switch on
// selectedBuildBackend() at the runBuild call site — nothing else changes.

export type BuildBackend = 'local-simuser' | 'vm-queue';

/**
 * Which build backend is active. 'vm-queue' once a queue endpoint is configured
 * (VM_BUILD_QUEUE_URL); 'local-simuser' otherwise. The vm-queue backend is not
 * implemented yet — this selector is the guard that will route to it.
 */
export function selectedBuildBackend(): BuildBackend {
  return process.env.VM_BUILD_QUEUE_URL ? 'vm-queue' : 'local-simuser';
}

/** Throw if a backend is selected that isn't implemented yet, with a clear msg. */
export function assertBuildBackendReady(): void {
  if (selectedBuildBackend() === 'vm-queue') {
    throw new Error(
      'VM_BUILD_QUEUE_URL is set but the vm-queue build backend is not implemented yet. ' +
        'Unset it to use the local-simuser backend, or implement VmQueueBuildRunner (see build-runner.ts).',
    );
  }
}
