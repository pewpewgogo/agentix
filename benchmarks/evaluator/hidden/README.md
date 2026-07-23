# Evaluator-only definitions

These manifests are loaded by the evaluator after the agent session. They are
never copied into a materialized agent workspace and are never included in the
agent prompt. Descriptions here may state regression cases that would leak task
solutions if exposed earlier.

The evaluator treats an absent, malformed, or hash-mismatched manifest as an
infrastructure integrity failure. It does not silently omit hidden checks.
