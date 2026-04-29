import { log } from "./logger.js";

let tracingEnabled = false;

/**
 * Initialize LangSmith tracing by wrapping the AI SDK.
 * Requires LANGSMITH_TRACING=true and LANGSMITH_API_KEY env vars.
 * Returns true if tracing was successfully enabled.
 */
export async function initTracing(): Promise<boolean> {
  if (tracingEnabled) return true;

  // Ensure required env vars are set
  if (!process.env.LANGSMITH_API_KEY) {
    log.warn("tracing", "LANGSMITH_API_KEY not set — tracing disabled");
    return false;
  }

  // Set defaults if not provided
  process.env.LANGSMITH_TRACING ??= "true";
  process.env.LANGSMITH_ENDPOINT ??= "https://api.smith.langchain.com";
  process.env.LANGSMITH_PROJECT ??= "sast-triage";

  try {
    const { wrapAISDK } = await import("langsmith/experimental/vercel");
    const ai = await import("ai");
    wrapAISDK(ai);
    tracingEnabled = true;
    log.info("tracing", "LangSmith tracing enabled", {
      endpoint: process.env.LANGSMITH_ENDPOINT,
      project: process.env.LANGSMITH_PROJECT,
    });
    return true;
  } catch (err) {
    log.warn("tracing", `Failed to initialize LangSmith: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

/**
 * Check if LangSmith env vars are configured (even if not yet initialized).
 */
export function hasLangSmithConfig(): boolean {
  return !!(process.env.LANGSMITH_API_KEY && process.env.LANGSMITH_TRACING === "true");
}
