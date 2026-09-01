import { mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { prune, defaultCountTokens, type CoreMessage, type CompressionState } from "acp-kernel";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages, extractText } from "./messages.js";
import { SessionStateStore } from "./state.js";

// The full conversation always lives in Pi's .jsonl; ACP state in the adjacent
// <sessionFile>.acp.json (written every turn). So a session is exportable once
// ACP has processed a turn in it — we scan for the state file to enumerate them.
const ACP_STATE_SUFFIX = ".acp.json";

export interface ExportOptions {
  output?: string;
  full?: boolean;
}

export interface SessionSummary {
  id: string;
  title?: string;
  label?: string;
  savedAt?: number;
  contextTokens?: number;
  blocks: number;
}

interface LoadedSession {
  id: string;
  name?: string;
  title?: string;
  entries: SessionEntry[];
  state: CompressionState;
  contextTokens: number;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function latestBlockTime(state: CompressionState): number {
  let latest = 0;
  for (const b of state.blocks) if (b.createdAt > latest) latest = b.createdAt;
  return latest;
}

function firstUserText(entries: SessionEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const text = extractText(m.content);
    if (text.trim()) return text;
  }
  return undefined;
}

async function loadSession(jsonlPath: string, store: SessionStateStore): Promise<LoadedSession> {
  const sm = SessionManager.open(jsonlPath);
  const id = sm.getSessionId();
  const entries = sm.buildContextEntries();
  const state = await store.load(jsonlPath, id);
  const coreMessages = entriesToCoreMessages(entries);
  const contextTokens = coreMessages.reduce((sum, m) => sum + defaultCountTokens(m.text ?? ""), 0);
  return { id, name: sm.getSessionName(), title: firstUserText(entries), entries, state, contextTokens };
}

async function loadAllSessions(sessionDir: string): Promise<LoadedSession[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return [];
  }
  const store = new SessionStateStore();
  const sessions: LoadedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(ACP_STATE_SUFFIX)) continue;
    const jsonl = name.slice(0, -ACP_STATE_SUFFIX.length);
    try {
      sessions.push(await loadSession(path.join(sessionDir, jsonl), store));
    } catch {
      // unreadable / corrupt session file — skip it
    }
  }
  sessions.sort((a, b) => latestBlockTime(b.state) - latestBlockTime(a.state));
  return sessions;
}

export async function listSessions(sessionDir: string): Promise<SessionSummary[]> {
  const sessions = await loadAllSessions(sessionDir);
  return sessions.map((s) => ({
    id: s.id,
    title: s.title ? truncate(s.title, 120) : undefined,
    label: s.name,
    savedAt: latestBlockTime(s.state) || undefined,
    contextTokens: s.contextTokens || undefined,
    blocks: s.state.blocks.length,
  }));
}

function renderHandoff(s: LoadedSession, full: boolean): string {
  const lines: string[] = [];
  lines.push("# billion-context session handoff");
  lines.push("");
  lines.push(`- title: ${s.title ? truncate(s.title, 200) : "(untitled)"}`);
  if (s.name) lines.push(`- label: ${s.name}`);
  lines.push(`- session id: ${s.id}`);
  lines.push(`- messages: ${s.entries.length}`);
  if (s.contextTokens) lines.push(`- last context tokens: ~${s.contextTokens}`);
  lines.push(`- compression blocks: ${s.state.blocks.length} (active ${s.state.blocks.filter((b) => b.active).length})`);
  lines.push("");

  // prune injects block summaries in place of compressed ranges by default.
  const coreMessages = entriesToCoreMessages(s.entries);
  const view = full ? coreMessages : prune(coreMessages, s.state);
  lines.push(full
    ? `## Full conversation (${coreMessages.length} messages)`
    : `## Conversation (folded view as the model saw it, ${view.length} client messages)`);
  lines.push("");
  if (view.length === 0) {
    lines.push("No conversation messages to export.");
    lines.push("");
  }
  let lastRole = "";
  for (const m of view) {
    if (m.role !== lastRole) {
      lines.push(`### ${m.role}`);
      lines.push("");
      lastRole = m.role;
    }
    lines.push(renderMessage(m));
  }
  lines.push("");
  return lines.join("\n");
}

function renderMessage(m: CoreMessage): string {
  const parts: string[] = [];
  switch (m.contentType) {
    case "text":
      parts.push(m.text ?? "");
      break;
    case "tool-call":
      parts.push(`\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` args: ${m.text ?? ""}`);
      break;
    case "tool-result":
      parts.push(`\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` → ${m.text ?? ""}`);
      break;
    case "reasoning":
      parts.push(`_reasoning_: ${m.text ?? ""}`);
      break;
  }
  const body = parts.join("\n").trim();
  return body === "" ? "_(empty)_" : body + "\n";
}

function matchSession(sessions: LoadedSession[], selector: string): LoadedSession[] {
  const exact = sessions.filter((s) => s.id === selector);
  if (exact.length > 0) return exact;
  const byLabel = sessions.filter((s) => s.name === selector);
  if (byLabel.length > 0) return byLabel;
  return sessions.filter((s) => s.id.startsWith(selector) || (s.name ?? "").startsWith(selector));
}

export async function exportSession(selector: string | undefined, opts: ExportOptions, sessionDir: string): Promise<string> {
  const all = await loadAllSessions(sessionDir);
  if (all.length === 0) {
    return "No ACP-managed sessions found in this project's session directory. A session becomes exportable once billion-context-pi has processed a turn in it (its compression state is saved alongside the session file).";
  }
  if (!selector) {
    const rows = all.map((s) =>
      `${s.id}${s.name ? `  label=${s.name}` : ""}  blocks=${s.state.blocks.length}${s.contextTokens ? `  ctx~${s.contextTokens}` : ""}  ${s.title ? truncate(s.title, 80) : ""}`
    );
    return ["ACP-managed sessions:", "", ...rows.map((r) => `  ${r}`), "", "Usage: /acp-export <session-id|label> [--output handoff.md] [--full]"].join("\n");
  }
  const matches = matchSession(all, selector);
  if (matches.length === 0) {
    throw new Error(`no session matches "${selector}" (run "/acp-export" to list sessions)`);
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join(", ");
    throw new Error(`selector "${selector}" matches ${matches.length} sessions (${ids}); use the full session id`);
  }
  const markdown = renderHandoff(matches[0]!, opts.full ?? false);
  if (opts.output) {
    mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    writeFileSync(opts.output, markdown, "utf8");
    return `written to ${opts.output}`;
  }
  return markdown;
}

export function parseExportArgs(args: string): { selector?: string; full: boolean; output?: string; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let selector: string | undefined;
  let full = false;
  let output: string | undefined;
  let error: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--full") {
      full = true;
    } else if (t === "--output" || t === "-o") {
      const value = tokens[i + 1];
      if (value === undefined) {
        error = "--output requires a file path (e.g. /acp-export <id> --output handoff.md)";
        break;
      }
      output = value;
      i++;
    } else if (t.startsWith("--output=")) {
      output = t.slice("--output=".length);
    } else if (!selector) {
      selector = t;
    }
  }
  return { selector, full, output, error };
}
