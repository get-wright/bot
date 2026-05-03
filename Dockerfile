# syntax=docker/dockerfile:1.7

# ─── Stage 1: build ───────────────────────────────────────────
FROM oven/bun:1-debian AS build
WORKDIR /src
ARG TARGETARCH
COPY package.json bun.lock ./
# --ignore-scripts skips better-sqlite3's node-gyp build; at runtime the
# compiled binary uses bun:sqlite (built into the Bun runtime), not better-sqlite3.
RUN bun install --frozen-lockfile --ignore-scripts
COPY . ./
# CPU variant: bun-linux-x64-baseline for max amd64 portability (pre-Haswell);
# arm64 has only one variant.
RUN case "$TARGETARCH" in \
      amd64) BUN_TARGET=bun-linux-x64-baseline ;; \
      arm64) BUN_TARGET=bun-linux-arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build src/index.ts \
      --compile \
      --target=${BUN_TARGET} \
      --outfile sast-triage \
 && chmod +x sast-triage

# ─── Stage 2: runtime (with code-review-graph for SAST_USE_GRAPH) ──
# Switched from distroless to python:slim because the graph integration
# spawns `code-review-graph` (a Python CLI distributed on PyPI) as a
# subprocess. The agent calls `code-review-graph build` on first run when
# SAST_USE_GRAPH=1, so the binary must exist on PATH at runtime.
FROM python:3.12-slim-bookworm
WORKDIR /work

# git: code-review-graph uses it for repo discovery / language detection.
# libstdc++6 + libgcc-s1: required by some tree-sitter native parsers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      libstdc++6 \
      libgcc-s1 \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir 'code-review-graph>=1.2,<3.0' \
 && code-review-graph --version

COPY --from=build /src/sast-triage /usr/local/bin/sast-triage

# nonroot user (uid 65532 matches distroless convention so volume mounts
# from existing pipelines keep working).
RUN useradd -u 65532 -m -d /home/sastuser -s /usr/sbin/nologin sastuser \
 && chown -R sastuser:sastuser /work
USER sastuser

ENV SAST_FINDINGS=/work/findings.json \
    SAST_OUTPUT=/work/findings-out.json \
    SAST_USE_GRAPH=1

ENTRYPOINT ["/usr/local/bin/sast-triage"]
