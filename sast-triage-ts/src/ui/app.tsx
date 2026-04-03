import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";

export async function runTui(
  _findings: Finding[],
  _totalCount: number,
  _config: AppConfig,
  _memory: MemoryStore,
): Promise<void> {
  console.error("TUI not yet implemented. Use --headless.");
  process.exit(1);
}
