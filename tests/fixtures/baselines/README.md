# Baselines

Recorded outputs from prior `findings-out.json` runs, used by `scripts/compare-baseline.ts`
to verify that read-efficiency changes do not regress token/tool-call counts.

## How to record a new baseline

```bash
./sast-triage findings.json --provider <p> --model <m> --output baseline.json
cp baseline.json tests/fixtures/baselines/<date>-<dataset>-<model>.json
git add tests/fixtures/baselines/
git commit -m "chore(validation): record baseline for <dataset> on <model>"
```

## How to diff a current run against a baseline

```bash
bun scripts/compare-baseline.ts \
  tests/fixtures/baselines/<date>-<dataset>-<model>.json \
  /path/to/current/findings-out.json
```

The script exits 1 if either `input_tokens` or `tool_calls` increased vs the baseline.

## Note

The 2026-04-29 NodeGoat / GLM-5.1 baseline was not committed in this PR — it was not
available on the machine that ran the implementation. Re-run the triage on NodeGoat
before merging Phase 2 to fill in this baseline and verify the 30-50% reduction
target from `specs/2026-04-29-read-efficiency-impl-spec.md`.
