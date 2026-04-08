import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

const MAX_BYTES = 50 * 1024;
const DEFAULT_TIMEOUT_SEC = 30;
const BLOCKED_COMMANDS = new Set([
  "rm", "mv", "cp", "chmod", "chown",
  "curl", "wget", "nc", "ncat", "netcat",
  "dd", "mkfs", "fdisk",
]);

export interface BashToolInput {
  command: string;
  timeout?: number;
}

export interface BashTool {
  execute(input: BashToolInput): Promise<string>;
}

function extractCommands(command: string): string[] {
  // Split on pipe, semicolon, &&, || to get individual command words
  return command.split(/[|;&]/).map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

export function createBashTool(projectRoot: string): BashTool {
  const root = resolve(projectRoot);

  return {
    async execute({ command, timeout = DEFAULT_TIMEOUT_SEC }: BashToolInput): Promise<string> {
      const cmds = extractCommands(command);
      for (const cmd of cmds) {
        if (BLOCKED_COMMANDS.has(cmd)) {
          throw new Error(`Command blocked for safety: '${cmd}' is not allowed`);
        }
      }

      try {
        const result = await execFileAsync("bash", ["-c", command], {
          cwd: root,
          timeout: timeout * 1000,
          maxBuffer: MAX_BYTES * 2,
          encoding: "utf8",
        });
        return (result.stdout ?? "").slice(0, MAX_BYTES);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string };
        const stdout = (e.stdout ?? "").slice(0, MAX_BYTES);
        const stderr = (e.stderr ?? "").slice(0, MAX_BYTES);
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        return `Command failed: ${combined}`;
      }
    },
  };
}
