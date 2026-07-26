# Runtime benchmark

This package measures framework runtime and toolchain costs separately from the
agent-maintenance experiment. It does not convert time into tokens or mix these
samples into agent-efficiency results.

## Smoke and confirmatory runs

```sh
# Diagnostic JSON on stdout; omitted groups are explicit unavailable records.
npm run build
node benchmarks/runtime/dist/cli.js --smoke --root=/absolute/repository --no-process

# Optional smoke toolchain and sealed output.
node benchmarks/runtime/dist/cli.js --smoke --toolchain \
  --root=/absolute/repository --output-dir=/absolute/runtime-results

# Full preregistered run. Sealed output is mandatory.
node benchmarks/runtime/dist/cli.js --confirmatory-runtime \
  --root=/absolute/clean-repository --output-dir=/absolute/runtime-results
```

`--output=/directory` remains an alias for `--output-dir`. It now always names a
publication directory, never a raw JSON file. Unsealed stdout is allowed only
for smoke diagnostics. A confirmatory run requires a clean exact Git commit, a
system command executor, all metric groups, 10 warmups, 30 measured samples,
and 10 toolchain samples. Even then, the report is marked confirmatory-eligible
only if every required observation and evidence gate succeeds.

## Measurement protocol

Every two-arm block is balanced and its order is derived from the recorded
seed. Warmups remain in raw samples but are excluded from summaries. Summaries
retain sorted measured samples and report R-7 median, IQR, p95, and range.
Failed commands and probes produce explicit `unavailable` outcomes and never a
zero, failed duration, or other numeric sample.

The synthetic dispatch comparison gives both arms preconstructed permission
state, runtime input validation, and a simple successful result. Index
generation has no plain equivalent and is labeled `framework-only`.

Process measurements cannot consume ignored or stale build output:

- each arm is copied into its own new temporary repository with every `dist`
  directory excluded;
- repository-owned npm workspace links are retargeted into that temporary
  repository, while installed third-party packages are copied and have write
  bits removed only inside that temporary repository;
- the selected arm is built before any process probe;
- the exact entry, app output manifest, all emitted workspace output, and arm
  source manifest are SHA-256 bound into the report;
- cold start imports only that bound entry;
- the memory child retains 100 systems, records the signed RSS delta, and
  normalizes Node's `process.resourceUsage().maxRSS` KiB value to bytes. If the
  API or value is unsupported, max RSS is explicitly unavailable.

Clean build, full typecheck, and semantic incremental verification each run in
a separate fresh copy. Workspace provisioning and arm-local incremental cache
builds are outside the measured interval; no repository-wide prerequisite can
couple an arm to unrelated packages. Framework full typecheck also freshly
bootstraps the locally linked compiler outside its interval because the app's
test config imports that installed tool without a project reference. No
benchmark path installs packages, uses the network, or starts paid work.

The copied dependency permissions guard against accidental writes; they are not
a security boundary against code running as the same operating-system user,
which can restore permissions on its private copy. The original `node_modules`
tree is neither linked nor permission-modified by workspace provisioning.
Dependency-adjacent caches are not copied, and provisioning fails if any copied
dependency symlink would escape the temporary repository.

## Sealed evidence

`publishRuntimeReport` validates the report, derives its publication ID from
the canonical report SHA-256, and reserves that address with an exclusive lock.
It writes `report.json`, `manifest.json`, and finally `complete.json` into a
same-filesystem staging directory, fsyncs files, and atomically renames the
directory into place. Existing addresses are never overwritten. The manifest
binds the measurement plan, lockfile, runtime sources, application sources, and
fresh-build evidence hashes.

`readRuntimePublication` requires the lock and completion marker, rejects
partial or extra files and symlinks, recomputes every content/evidence hash,
recomputes summaries and confirmatory eligibility, and fails closed on any
tampering. File permissions are an accidental-write guard; hashes and the
create-only protocol provide the integrity check.

Smoke numbers validate executability and can help set budgets before
confirmatory agent results are observed. They are not confirmatory evidence for
the primary hypothesis.

## Exploratory HTTP-framework comparison (methodology v2)

The separate comparison runner exercises real loopback endpoints on three
configured stacks:

- Agentix v2 (`feature()`/`command()`) with the `serveNode` raw Node host —
  no extra validation in the target: dispatch already validates input and
  output (the v1 target's redundant `mapResponse` re-parse is gone);
- Express 5.2.1;
- NestJS 11.1.28 on its default Express adapter.

```sh
npm run benchmark:http-frameworks -- --isolated
```

Prefer `--isolated`: each target then runs in its own child process while the
measuring client stays in the parent, so requests cross real loopback sockets
between processes. The in-process default is kept only for continuity; it runs
every server and the client on one event loop, which inflated the v1
cross-stack gap roughly tenfold.

Workloads: `POST /echo` valid and invalid, `GET /items/:id`, and an
8-in-flight keep-alive echo batch whose summaries derive requests-per-second
from batch completion time. Two validation conditions run per report:
`default` (Express/NestJS byte-identical to v1: hand-written echo guard, no
output validation) and `validated` (Express/NestJS run zod input AND output
validation, matching the work Agentix always performs). Every sample is
labeled with its condition, workload, and concurrency.

The runner uses seeded three-stack blocks, a dedicated keep-alive client per
stack and condition, complete response consumption, fresh child processes for
cold-ready and memory observations, and raw distributions. v2 reports use a
new seed lineage without v1 ancestry and supersede
`benchmarks/results/http-frameworks-exploratory-v1-2026-07-23.json` with a
methodology change: v1 and v2 values are not comparable, and the frozen v1
record is never modified. Every report is explicitly exploratory and
ineligible for use as a confirmatory result under the preregistered
Agentix-versus-plain hypothesis.

This microbenchmark measures the configured HTTP stacks, not framework cores.
NestJS includes Express, loopback and JSON costs can dominate, and echo-scale
routes do not predict commerce-application or agent-maintenance performance.
