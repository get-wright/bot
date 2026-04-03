export type DoomLoopStatus = "ok" | "warn" | "abort";

interface ToolCall {
  tool: string;
  argsKey: string;
}

export class DoomLoopDetector {
  private history: ToolCall[] = [];
  private warned = false;

  record(tool: string, args: Record<string, unknown>): void {
    this.history.push({
      tool,
      argsKey: JSON.stringify(args, Object.keys(args).sort()),
    });
  }

  check(): DoomLoopStatus {
    if (this.history.length < 3) return "ok";
    const last3 = this.history.slice(-3);
    const allSame = last3.every(
      (c) => c.tool === last3[0]!.tool && c.argsKey === last3[0]!.argsKey,
    );
    if (!allSame) return "ok";
    if (this.warned) return "abort";
    return "warn";
  }

  acknowledge(): void {
    this.warned = true;
  }
}
