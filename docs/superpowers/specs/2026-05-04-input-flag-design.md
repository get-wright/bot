# --input Flag + Env-Var Audit

## Goal

Add `--input <path>` CLI flag as an alias for the existing positional `[findings]` argument. Confirm every CLI flag has an environment-variable equivalent so `.env`-driven runs work end-to-end.

## Context

`sast-triage` currently accepts the Semgrep JSON path only as a positional argument:

```
sast-triage findings.json --provider openai --model gpt-4o
```

Users running the binary via Docker/CI workflows want a named flag for symmetry with the rest of the CLI surface and to fit `KEY=value`-style invocation conventions. They also want assurance that `.env` files alone can drive the tool — no required positional args.

Bun auto-loads `.env` at process start, so the binary already sees env vars without an extra dotenv dep.

## Env-Var Coverage (audit result)

All existing flags already map to env vars via `resolveConfig`:

| Flag | Env |
|---|---|
| `[findings]` arg | `SAST_FINDINGS` |
| `--provider` | `SAST_PROVIDER` |
| `--model` | `SAST_MODEL` |
| `--api-key` | `SAST_API_KEY`, `<PROVIDER>_API_KEY` |
| `--base-url` | `SAST_BASE_URL` |
| `--allow-bash` | `SAST_ALLOW_BASH` |
| `--max-steps` | `SAST_MAX_STEPS` |
| `--effort` | `SAST_EFFORT` |
| `--concurrency` | `SAST_CONCURRENCY` |
| `--output` | `SAST_OUTPUT` |
| `--no-log` | `SAST_LOG=0` |
| `--langsmith` | `LANGSMITH_TRACING` |

No new env vars required. `--input` reuses `SAST_FINDINGS`.

## Design

### Surface

Add to `src/cli/cli.ts` Commander setup:

```ts
.option("--input <path>", "Path to Semgrep JSON output file (alias for positional arg, or set SAST_FINDINGS)")
```

Keep the positional `[findings]` arg for back-compat with existing scripts and the examples in `CLAUDE.md`.

### Precedence

Resolved inside the action handler before calling `resolveConfig`:

```
const inputPath = opts.input ?? findingsPath;
```

Then pass `inputPath` as `findingsPath` into `resolveConfig`. `resolveConfig` already handles `SAST_FINDINGS` and the `/work/findings.json` default; no change there.

Final precedence chain (highest first):
1. `--input <path>`
2. Positional `[findings]`
3. `SAST_FINDINGS`
4. `/work/findings.json` (Docker default)

### Conflict handling

If both `--input` and positional are supplied with different values: `--input` wins (explicit named flag beats positional). No warning — Commander treats them as independent inputs and the user picked the more explicit form.

### Help text

Update positional arg description to mention the alias:

```
.argument("[findings]", "Path to Semgrep JSON file (or use --input / SAST_FINDINGS)")
```

## Files Touched

- `src/cli/cli.ts` — add `--input` option, resolve precedence
- `tests/cli/config-resolution.test.ts` (or new `tests/cli/input-flag.test.ts`) — cover the new precedence

## Tests

1. `--input X` alone → resolved `findingsPath === X`
2. Positional `Y` alone → resolved `findingsPath === Y` (existing behavior, regression guard)
3. `--input X` + positional `Y` → `findingsPath === X`
4. Neither + `SAST_FINDINGS=Z` → `findingsPath === Z` (existing behavior)

## Out of Scope

- Removing the positional argument
- Adding new env vars
- Loading a custom `.env` path (Bun handles this)
- Validating that the input path exists at CLI parse time (parser already errors on missing file)
