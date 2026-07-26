# Known minor findings (final adversarial review, 2026-07-26)

All majors from the review were fixed (commit 7a36e80). These reproduced minors
remain open by choice; full repros in final-review-findings.json (#index):

- #0 sandbox arms diverge on paths outside the compared matrix (e.g. 405
  handling differs between the Express arm and Agentix) — README scopes the
  claim, arms stay minimal by design.
- #16 createTestApplication offers no reset for auto-bound store state
  (calls.reset() clears only the log) — create a fresh app per test instead.
- #17 store-port detection in createTestApplication is structural (get/save/
  delete/list + kinds) and can false-positive on a hand-built lookalike port —
  a `preset` tag on port.store descriptors is the clean fix (also requested by
  the P2 testing agent).
- #18 ensures checks receive the validated output object itself in dev/test —
  a mutating check could alter the returned value; keep checks pure.
- #19 emit called after dispatch settles throws EVENT_OUTSIDE_EXECUTION into
  the caller's context (timer/floating promise) — an unhandled rejection there
  rather than a latched fault.
