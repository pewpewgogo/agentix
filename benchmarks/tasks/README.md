# Versioned maintenance tasks

`v1/` contains exactly ten implementation-neutral task specifications. Each
specification points to one framework fixture, one plain TypeScript fixture, and
one evaluator-only manifest by SHA-256. The user request and public criteria are
the only task-specific text supplied to an agent.

The files are data. They must not contain edit hints, source paths, hidden
assertions, or implementation-specific wording. Change a task by adding a new
task version; never rewrite a frozen version after observing benchmark results.

`corpus.lock.json` freezes every task, fixture, overlay input, base inventory,
and hidden evaluator definition used by this corpus. Run the evaluator tests
before a freeze or run. A hash mismatch is an integrity error, not a reason to
skip a file.
