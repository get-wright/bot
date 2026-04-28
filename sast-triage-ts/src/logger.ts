import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let logPath: string | null = null;
let enabled = false;

export function initLogger(path: string): void {
  logPath = path;
  enabled = true;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `=== sast-triage debug log — ${new Date().toISOString()} ===\n\n`);
}

function write(level: string, category: string, message: string, data?: unknown): void {
  if (!enabled || !logPath) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const prefix = `[${ts}] ${level.padEnd(5)} [${category}]`;
  let line = `${prefix} ${message}`;
  if (data !== undefined) {
    const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    // Indent multi-line data under the prefix
    if (json.includes("\n")) {
      line += "\n" + json.split("\n").map((l) => `  ${l}`).join("\n");
    } else {
      line += ` ${json}`;
    }
  }
  appendFileSync(logPath, line + "\n");
}

export const log = {
  info(category: string, message: string, data?: unknown): void {
    write("INFO", category, message, data);
  },
  debug(category: string, message: string, data?: unknown): void {
    write("DEBUG", category, message, data);
  },
  warn(category: string, message: string, data?: unknown): void {
    write("WARN", category, message, data);
  },
  error(category: string, message: string, data?: unknown): void {
    write("ERROR", category, message, data);
  },
};
