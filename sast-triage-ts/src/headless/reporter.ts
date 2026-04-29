import type { AgentEvent } from "../models/events.js";

export function formatEvent(event: AgentEvent, fingerprint: string): string {
  return JSON.stringify({ ...event, fingerprint });
}
