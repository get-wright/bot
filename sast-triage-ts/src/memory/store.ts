import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryLookup } from "../parser/prefilter.js";
import { VerdictValue } from "../models/verdict.js";
import type { TriageVerdict } from "../models/verdict.js";

export interface TriageRecord {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreInput {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
}

interface DbAdapter {
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): unknown;
  all(sql: string, ...params: unknown[]): unknown[];
  close(): void;
}

function createBunAdapter(dbPath: string): DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  return {
    run(sql, ...params) { db.run(sql, ...params); },
    get(sql, ...params) { return db.prepare(sql).get(...params); },
    all(sql, ...params) { return db.prepare(sql).all(...params); },
    close() { db.close(); },
  };
}

function createNodeAdapter(dbPath: string): DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite3 = require("better-sqlite3");
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  return {
    run(sql, ...params) { db.prepare(sql).run(...params); },
    get(sql, ...params) { return db.prepare(sql).get(...params); },
    all(sql, ...params) { return db.prepare(sql).all(...params); },
    close() { db.close(); },
  };
}

const isBun = typeof globalThis.Bun !== "undefined";

export class MemoryStore {
  private db: DbAdapter;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = isBun ? createBunAdapter(dbPath) : createNodeAdapter(dbPath);
    this.createTables();
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS triage_records (
        fingerprint TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        path TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        key_evidence TEXT NOT NULL DEFAULT '[]',
        suggested_fix TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Migration: add columns to existing databases (idempotent)
    const cols = this.db.all("PRAGMA table_info(triage_records)") as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("key_evidence")) {
      this.db.run("ALTER TABLE triage_records ADD COLUMN key_evidence TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has("suggested_fix")) {
      this.db.run("ALTER TABLE triage_records ADD COLUMN suggested_fix TEXT");
    }
  }

  lookup(fingerprint: string): TriageRecord | null {
    const row = this.db.get("SELECT * FROM triage_records WHERE fingerprint = ?", fingerprint) as TriageRecord | undefined;
    return row ?? null;
  }

  lookupByRule(checkId: string, limit = 10): TriageRecord[] {
    return this.db.all("SELECT * FROM triage_records WHERE check_id = ? ORDER BY updated_at DESC LIMIT ?", checkId, limit) as TriageRecord[];
  }

  store(input: StoreInput): void {
    const now = new Date().toISOString();
    const evidenceJson = JSON.stringify(input.key_evidence);
    this.db.run(
      `INSERT INTO triage_records (fingerprint, check_id, path, verdict, reasoning, key_evidence, suggested_fix, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         verdict = excluded.verdict,
         reasoning = excluded.reasoning,
         key_evidence = excluded.key_evidence,
         suggested_fix = excluded.suggested_fix,
         updated_at = excluded.updated_at`,
      input.fingerprint, input.check_id, input.path, input.verdict, input.reasoning,
      evidenceJson, input.suggested_fix ?? null, now, now,
    );
  }

  /** Returns the full verdict reconstructed from the record, or null if not found. */
  lookupVerdict(fingerprint: string): TriageVerdict | null {
    const row = this.db.get(
      "SELECT verdict, reasoning, key_evidence, suggested_fix FROM triage_records WHERE fingerprint = ?",
      fingerprint,
    ) as { verdict: string; reasoning: string; key_evidence: string; suggested_fix: string | null } | undefined;
    if (!row) return null;
    const verdictParse = VerdictValue.safeParse(row.verdict);
    if (!verdictParse.success) return null;
    let evidence: string[] = [];
    try {
      const parsed = JSON.parse(row.key_evidence);
      if (Array.isArray(parsed)) evidence = parsed.map(String);
    } catch { /* corrupted JSON — return empty */ }
    return {
      verdict: verdictParse.data,
      reasoning: row.reasoning,
      key_evidence: evidence,
      suggested_fix: row.suggested_fix ?? undefined,
    };
  }

  getHints(checkId: string, fingerprint: string): string[] {
    const hints: string[] = [];
    const exact = this.lookup(fingerprint);
    if (exact) {
      hints.push(`Previously triaged as ${exact.verdict}: ${exact.reasoning.slice(0, 100)}`);
    }
    const records = this.lookupByRule(checkId, 50);
    if (records.length >= 2) {
      const tpCount = records.filter((r) => r.verdict === "true_positive").length;
      hints.push(`${records.length} previous findings for rule ${checkId}: ${tpCount}/${records.length} true positives`);
    }
    return hints;
  }

  createLookup(): MemoryLookup {
    return (fingerprint: string) => {
      const record = this.lookup(fingerprint);
      if (!record) return null;
      return { verdict: record.verdict };
    };
  }

  close(): void {
    this.db.close();
  }
}
