# syntax=docker/dockerfile:1.7

# ─── Stage 1: build ───────────────────────────────────────────
FROM oven/bun:1-debian AS build
WORKDIR /src
ARG TARGETARCH
COPY sast-triage-ts/package.json sast-triage-ts/bun.lock ./
# --ignore-scripts skips better-sqlite3's node-gyp build; at runtime the
# compiled binary uses bun:sqlite (built into the Bun runtime), not better-sqlite3.
RUN bun install --frozen-lockfile --ignore-scripts
COPY sast-triage-ts/ ./
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

# ─── Stage 2: runtime ─────────────────────────────────────────
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /work
COPY --from=build /src/sast-triage /usr/local/bin/sast-triage
USER nonroot:nonroot
ENV SAST_FINDINGS=/work/findings.json \
    SAST_OUTPUT=/work/findings-out.json \
    SAST_MEMORY_DB=/work/.sast-triage/memory.db
ENTRYPOINT ["/usr/local/bin/sast-triage"]
