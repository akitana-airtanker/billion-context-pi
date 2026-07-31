import { promises as fs } from "node:fs";
import * as path from "node:path";

const DEBUG = process.env.ACP_DEBUG === "1" || process.env.ACP_DEBUG === "true";
const LOG_FILE = process.env.ACP_LOG_FILE ?? path.join(process.env.HOME ?? "/tmp", ".pi", "acp-debug.log");

let initialized = false;

async function write(line: string): Promise<void> {
  if (!DEBUG) return;
  if (!initialized) {
    initialized = true;
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true }).catch(() => {});
  }
  await fs.appendFile(LOG_FILE, line, "utf8").catch(() => {});
}

export const debug = {
  get enabled(): boolean {
    return DEBUG;
  },
  get logFile(): string {
    return LOG_FILE;
  },
  event(scope: string, fields: Record<string, unknown>): void {
    if (!DEBUG) return;
    const ts = new Date().toISOString();
    const body = Object.entries(fields)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" ");
    void write(`${ts} [${scope}] ${body}\n`);
  },
};

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return `[${v.length}]`;
    }
  }
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
