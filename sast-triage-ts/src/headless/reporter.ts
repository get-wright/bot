import type { AgentEvent } from "../models/events.js";

export function formatEvent(event: AgentEvent, fingerprint: string): string {
  // permission_request has a non-serializable resolve callback — skip it in NDJSON
  if (event.type === "permission_request") {
    return JSON.stringify({
      type: "permission_request",
      path: event.path,
      directory: event.directory,
      fingerprint,
    });
  }
  return JSON.stringify({ ...event, fingerprint });
}
