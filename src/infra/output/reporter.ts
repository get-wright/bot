import type { AgentEvent } from "../../core/models/events.js";

export function formatEvent(event: AgentEvent, fingerprint: string): string {
  return JSON.stringify({ ...event, fingerprint });
}
