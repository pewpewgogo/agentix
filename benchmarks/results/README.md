# Raw benchmark evidence

This directory is append-only evidence storage. Confirmatory run records and
their raw provider artifacts are written with create-only semantics by the
harness; corrections create linked superseding records and never replace the
original bytes.

Engineering smoke records use names containing `smoke` and are permanently
excluded from confirmatory analysis. No paid or external model run is present
unless its record names the pinned provider, immutable model, reasoning
configuration, pricing snapshot, fixture hash, evaluator hash, and schedule.

Provider token telemetry for framework construction in the current development
session is unavailable. It will not be estimated from text, elapsed chat time,
or repository size, so token and monetary construction break-even remain
unavailable unless prospectively instrumented evidence is added.

The four checked-in `runtime-*-smoke-2026-07-23.json` files predate the current
schema-version 2 fresh-build and sealed-publication hardening. They are retained
as append-only historical calibration artifacts, but are legacy unsealed smoke
data: the current runtime reader does not treat them as a publication, and they
cannot satisfy a runtime/DX or primary-hypothesis evidence gate. Current smoke
validation was generated from fresh isolated builds and either inspected on
stdout or written to a temporary sealed publication; it was not added here as a
confirmatory result.

`http-frameworks-exploratory-v1-2026-07-23.json` is the create-only raw report
for D-028's separate Agentix/Express/NestJS-on-Express HTTP comparison. It
contains 705 raw observations, records zero unavailable measurements, and is
permanently classified as exploratory and confirmatory-ineligible. Its SHA-256
is `d6ea63a0a57100a62ce810ed4c828d2c19e0e4f546e2a7e32e6f541d26d56ca4`.
