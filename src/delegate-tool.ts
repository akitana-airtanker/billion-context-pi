import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { debug } from "./log.js";

const MAX_DEPTH = 2;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const RESULT_SUMMARY_CHARS = 500;
const OUT_DIR = join(tmpdir(), "acp-delegate");

interface AgentDef {
  prompt: string;
  tools: string;
}

// Minimal roster. The tool description lists these so the model knows how to
// pick one — no separate prompt injection needed (keeps fixed cost tiny).
const AGENTS: Record<string, AgentDef> = {
  reviewer: {
    tools: "read,bash",
    prompt: `You are a senior code reviewer with read-only access.
Read the given code and report: bugs, security/safety risks, correctness issues, and concrete improvement suggestions.
Be specific — cite file:line for every finding. Do NOT modify any files; only read and report.`,
  },
  researcher: {
    tools: "read,bash",
    prompt: `You are a code researcher with read-only access.
Investigate the codebase to answer the question thoroughly. Report findings with exact file:line references, function/type signatures, and relevant code snippets.
Do NOT modify any files; only read and report.`,
  },
  worker: {
    tools: "read,edit,write,bash",
    prompt: `You are a precise implementer.
Make exactly the requested code changes — minimal, focused, following existing project conventions (check AGENTS.md first if present).
After editing, briefly summarize what you changed and why. Do not expand scope.`,
  },
  planner: {
    tools: "read,bash",
    prompt: `You are a technical planner with read-only access.
Analyze the task and produce a concrete, ordered step-by-step implementation plan with rationale for each step.
Cite file:line for code you reference. Do NOT modify any files; only read and propose.`,
  },
  oracle: {
    tools: "read,bash",
    prompt: `You are an expert advisor with read-only access.
Answer the question concisely with clear reasoning. Cite file:line when referencing code. Do NOT modify any files.`,
  },
};

const AGENT_NAMES = Object.keys(AGENTS);

// ─── Run registry (module-level, shared across tools) ───────────────────────

type RunStatus = "running" | "completed" | "failed" | "cancelled";

interface DelegateRun {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitCode?: number | null;
  child?: ChildProcess;
  // Resolves when the child has fully exited AND its result (if async) has
  // been injected into the parent chat. Used by acp_delegate_status to report
  // completion; best-effort (pi's sendUserMessage is fire-and-forget).
  done: Promise<void>;
}

const runs = new Map<string, DelegateRun>();

const DelegateParams = Type.Object({
  agent: Type.String({
    description: `Role of the delegate. One of: ${AGENT_NAMES.join(", ")}. See tool description for what each does.`,
  }),
  task: Type.String({
    description: "The self-contained task to hand off. State purpose, scope, and any constraints explicitly.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the delegate (default: current project dir)." }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Model override as "provider/id" (default: inherit current model).' }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description: "If true (default), return immediately with a runId. In long-lived sessions (interactive/rpc) a short notification is injected into chat when the delegate finishes; in one-shot sessions (print/json, e.g. `pi -p` / SDK) async auto-downgrades to sync and the result is returned here. If false, always block and return the output here.",
    }),
  ),
});

type DelegateArgs = Static<typeof DelegateParams>;

const StatusParams = Type.Object({});

const CancelParams = Type.Object({
  runId: Type.String({ description: "The runId returned by acp_delegate to cancel." }),
});

const agentListLine = (name: string): string => {
  const def = AGENTS[name];
  if (!def) return "";
  const blurb: Record<string, string> = {
    reviewer: "read-only code review (bugs/risks, file:line)",
    researcher: "read-only codebase investigation",
    worker: "make code changes (read+edit+write)",
    planner: "analyze + propose step-by-step plan (read-only)",
    oracle: "answer questions / advise (read-only)",
  };
  return `  • ${name} — ${blurb[name]} [tools: ${def.tools}]`;
};

export function makeDelegateTool(pi: ExtensionAPI): ToolDefinition<typeof DelegateParams> {
  return {
    name: "acp_delegate",
    label: "ACP Delegate",
    description: `Hand a self-contained task to a fresh sub-agent running in a clean context (its own pi process). Use to get focused review/investigation/implementation without polluting the main context, or to run several tasks concurrently.

Agents (pick by name):
${AGENT_NAMES.map(agentListLine).join("\n")}

Behavior:
• async=true (default): returns immediately with a runId. The delegate runs in the background. In long-lived sessions (interactive/rpc) a short notification (status + file path + preview) is injected back into this chat when it finishes. In one-shot sessions (print/json) async auto-downgrades to sync so the result is returned inline within the same turn. Use acp_delegate_status / acp_delegate_cancel to manage runs. Call acp_delegate again to launch more in parallel.
• async=false: blocks until the delegate finishes. The full output is saved to a file; the tool result contains the path plus a short preview. Use the \`read\` tool to open the file for the complete content.

The delegate runs in its own clean pi process — it does NOT see this conversation's context. Give it everything it needs (paths, goals, constraints). Full results always go to a file so the chat context stays small; only a preview is shown inline.`,
    promptSnippet:
      'acp_delegate({ agent: "reviewer", task: "Review src/index.ts for race conditions" })',
    promptGuidelines: [
      "Delegate to get a focused result in a clean context, or to parallelize independent work.",
      "The sub-agent has NO access to this conversation — write a fully self-contained task.",
      "Prefer async=true and launch several; results arrive back automatically when each finishes.",
      "For changes you must apply yourself, delegate read-only investigation (reviewer/researcher/oracle) and keep the main context as the sole writer.",
    ],
    parameters: DelegateParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const args = params as DelegateArgs;
      const outcome = await runDelegate(pi, args, ctx, signal);
      return { details: undefined, content: [{ type: "text", text: outcome }] };
    },
  };
}

export function makeDelegateStatusTool(pi: ExtensionAPI): ToolDefinition<typeof StatusParams> {
  return {
    name: "acp_delegate_status",
    label: "ACP Delegate Status",
    description:
      "List active and recently finished background delegates (acp_delegate async runs). Shows runId, agent, status, and elapsed time. Use to check on delegates launched in the background.",
    promptSnippet: "acp_delegate_status()",
    promptGuidelines: [],
    parameters: StatusParams,
    async execute(): Promise<AgentToolResult<unknown>> {
      const now = Date.now();
      const all = Array.from(runs.values()).sort((a, b) => b.startedAt - a.startedAt);
      const active = all.filter((r) => r.status === "running");
      const recent = all.filter((r) => r.status !== "running").slice(0, 5);
      if (all.length === 0) {
        return { details: undefined, content: [{ type: "text", text: "No delegate runs." }] };
      }
      const lines: string[] = [];
      lines.push(`Active: ${active.length}`);
      for (const r of active) {
        const elapsed = Math.round((now - r.startedAt) / 1000);
        lines.push(
          `  • ${r.runId} [${r.agent}] running ${elapsed}s — ${truncate(r.task, 80)} (@ ${r.cwd})`,
        );
      }
      if (recent.length > 0) {
        lines.push("");
        lines.push("Recent (last 5):");
        for (const r of recent) {
          const dur = r.finishedAt ? Math.round((r.finishedAt - r.startedAt) / 1000) : 0;
          lines.push(
            `  • ${r.runId} [${r.agent}] ${r.status} (exit ${r.exitCode ?? "?"}, ${dur}s) — ${truncate(r.task, 60)}`,
          );
        }
      }
      return { details: undefined, content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

export function makeDelegateCancelTool(pi: ExtensionAPI): ToolDefinition<typeof CancelParams> {
  return {
    name: "acp_delegate_cancel",
    label: "ACP Delegate Cancel",
    description:
      "Cancel a background delegate (acp_delegate async run) by runId. Sends SIGTERM to the sub-agent process.",
    promptSnippet: 'acp_delegate_cancel({ runId: "del_..." })',
    promptGuidelines: [],
    parameters: CancelParams,
    async execute(toolCallId, params): Promise<AgentToolResult<unknown>> {
      const { runId } = params as Static<typeof CancelParams>;
      const run = runs.get(runId);
      if (!run) {
        return {
          details: undefined,
          content: [{ type: "text", text: `Unknown runId "${runId}". Use acp_delegate_status to list runs.` }],
        };
      }
      if (run.status !== "running") {
        return {
          details: undefined,
          content: [{ type: "text", text: `Run ${runId} already ${run.status} (no action).` }],
        };
      }
      run.status = "cancelled";
      try {
        run.child?.kill("SIGTERM");
      } catch (err) {
        debug.event("delegate-cancel-kill-error", { runId, error: String(err) });
      }
      return {
        details: undefined,
        content: [{ type: "text", text: `Cancelled ${runId} (${run.agent}).` }],
      };
    },
  };
}

async function runDelegate(
  pi: ExtensionAPI,
  args: DelegateArgs,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const agent = AGENTS[args.agent];
  if (!agent) {
    return `Unknown agent "${args.agent}". Choose one of: ${AGENT_NAMES.join(", ")}.`;
  }
  const parentDepth = Number(process.env.PI_ACP_DELEGATE_DEPTH ?? "0");
  if (Number.isNaN(parentDepth) || parentDepth >= MAX_DEPTH) {
    return `Delegate nesting limit reached (depth ${parentDepth}, max ${MAX_DEPTH}). The delegate cannot spawn further delegates.`;
  }

  const cwd = args.cwd && args.cwd.trim() ? args.cwd : ctx.cwd;
  const childEnv = {
    ...process.env,
    PI_ACP_DELEGATE_DEPTH: String(parentDepth + 1),
  };

  const { cliArgs, tmpDir } = await buildChildArgs(args, agent.prompt, ctx);
  // One-shot modes (print/json = `pi -p` / SDK) exit after one turn, so async
  // injection (a follow-up turn) is never observed. Downgrade to sync there:
  // the result returns as the tool result within the same turn. Long-lived
  // modes (tui/rpc) keep true async + injection (consumed by the main loop).
  const requestedAsync = args.async !== false;
  const isAsync = requestedAsync && ctx.mode !== "print" && ctx.mode !== "json";
  if (requestedAsync && !isAsync) {
    debug.event("delegate-async-downgraded", { reason: `mode=${ctx.mode}` });
  }
  debug.event("delegate-spawn", { agent: args.agent, cwd, async: isAsync, cliArgs });

  const child = spawn("pi", cliArgs, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcess;
  // Pass the task via stdin (not argv) so tasks starting with `-` are not
  // mis-parsed as CLI options. pi reads piped stdin as the prompt in print mode.
  child.stdin?.end(args.task);

  const stdoutChunks: Buffer[] = [];
  let stderrText = "";
  child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on("data", (c: Buffer) => {
    stderrText += c.toString("utf8");
  });

  const runId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  if (isAsync) {
    // done resolves when the child exits AND its result has been persisted
    // (and best-effort injected via sendUserMessage). Used by acp_delegate_status
    // to report completion. sendUserMessage is fire-and-forget, so injection is
    // best-effort — not awaited (no API to await a turn).
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const run: DelegateRun = {
      runId,
      agent: args.agent,
      task: args.task,
      cwd,
      startedAt,
      status: "running",
      child,
      done,
    };
    runs.set(runId, run);

    child.on("close", (code) => {
      void cleanupTmp(tmpDir);
      const output = Buffer.concat(stdoutChunks).toString("utf8").trim();
      run.status = run.status === "cancelled" ? "cancelled" : code === 0 ? "completed" : "failed";
      run.finishedAt = Date.now();
      run.exitCode = code;
      const body = code === 0 ? (output || "(no output)") : (stderrText.trim() || output || "(no output)");
      void persistResult(runId, body)
        .then((file) => {
          const injected = injectResult(pi, args.agent, runId, code, file, body);
          debug.event("delegate-done", { runId, code, status: run.status, injected, outLen: output.length, file });
        })
        .catch((err) => {
          debug.event("delegate-done-error", { runId, error: String(err) });
        })
        .finally(resolveDone);
    });
    child.on("error", (err) => {
      void cleanupTmp(tmpDir);
      run.status = "failed";
      run.finishedAt = Date.now();
      debug.event("delegate-spawn-error", { runId, error: String(err) });
      resolveDone();
    });
    // Detach so the child survives the tool returning. Injection is best-effort:
    // the close handler calls sendUserMessage (fire-and-forget) to notify the
    // parent chat; interactive/rpc sessions consume it via their main loop.
    child.unref();
    return [
      `Delegated to **${args.agent}** (runId \`${runId}\`).`,
      `Task: ${truncate(args.task, 160)}`,
      `Running in the background at \`${cwd}\`.`,
      ``,
      `The full output will be saved to a file; a short notification (path + preview) will be injected here when it finishes. You may continue with other work now, or launch more delegates in parallel.`,
      `Tip: use acp_delegate_status() to check active runs, acp_delegate_cancel({runId}) to stop one.`,
    ].join("\n");
  }

  // Sync: block until the child finishes (bounded by a timeout).
  const result = await waitForChild(child, signal);
  void cleanupTmp(tmpDir);
  const body =
    result.timedOut || result.code !== 0
      ? (result.stderr.trim() || "(no stderr)")
      : (result.stdout || "(no output)");
  const file = await persistResult(runId, body);
  return formatSyncResult(args.agent, runId, result, file);
}

async function buildChildArgs(
  args: DelegateArgs,
  rolePrompt: string,
  ctx: ExtensionContext,
): Promise<{ cliArgs: string[]; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "acp-delegate-"));
  // Combine the role prompt with a small framing instruction so the child
  // treats the positional message as the task to execute.
  const promptFile = join(tmpDir, "role.md");
  await writeFile(promptFile, `${rolePrompt}\n\n---\n\nComplete the task below.`, "utf8");

  const cliArgs = ["-p", "--no-session", "--append-system-prompt", promptFile];

  if (args.model && args.model.includes("/")) {
    const [providerId, ...rest] = args.model.split("/");
    const modelId = rest.join("/");
    cliArgs.push("--provider", providerId!, "--model", modelId);
  } else if (ctx.model) {
    // Inherit the parent's current model so the delegate runs on the same one.
    cliArgs.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  }

  return { cliArgs, tmpDir };
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function waitForChild(child: ChildProcess, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: "", stderr: stderrText, timedOut: true });
    }, SYNC_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(r: ChildResult) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    }

    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: stderrText,
        timedOut: false,
      });
    });
    child.on("error", (err) => {
      finish({ code: null, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

function formatSyncResult(agent: string, runId: string, r: ChildResult, file: string): string {
  const status = r.timedOut ? "timed out" : r.code === 0 ? "completed" : "failed";
  const header = `Delegate **${agent}** ${status} (runId \`${runId}\`, exit ${r.code ?? "?"}).`;
  const body = r.timedOut || r.code !== 0 ? (r.stderr.trim() || "(no stderr)") : (r.stdout || "(no output)");
  return formatPayload(header, runId, file, body);
}

function injectResult(
  pi: ExtensionAPI,
  agent: string,
  runId: string,
  code: number | null,
  file: string,
  body: string,
): boolean {
  const send = pi.sendUserMessage;
  if (typeof send !== "function") {
    debug.event("delegate-inject-skipped", { runId, reason: "sendUserMessage unavailable" });
    return false;
  }
  const status = code === 0 ? "completed" : "failed";
  const header = `[acp_delegate ${status}] **${agent}** (runId \`${runId}\`, exit ${code ?? "?"})`;
  const text = formatPayload(header, runId, file, body);
  try {
    // sendUserMessage is fire-and-forget (returns void): it enqueues a
    // follow-up turn. Interactive/rpc sessions consume it via their main loop;
    // injection at shutdown is best-effort (no API to await a turn).
    send.call(pi, text, { deliverAs: "followUp" });
    return true;
  } catch (err) {
    debug.event("delegate-inject-error", { runId, error: String(err) });
    return false;
  }
}

// Build the lightweight payload delivered to the model/user: a header, the
// result file path (full output lives there), and a short preview. Keeping
// the in-context footprint small preserves the point of delegating.
function formatPayload(header: string, runId: string, file: string, body: string): string {
  const lines: string[] = [header, ""];
  if (file) {
    lines.push(`Full result: \`${file}\``);
    lines.push("(use the `read` tool to open it if you need the details)");
  } else {
    lines.push("(result could not be persisted to a file)");
  }
  lines.push("");
  lines.push("Preview (first lines):", "~~~", truncate(body, RESULT_SUMMARY_CHARS), "~~~", "");
  void runId;
  return lines.join("\n");
}

/** Persist the full delegate output to a stable file and return its path.
 *  The file outlives the run so the model (or the user) can read it later
 *  instead of carrying the full payload in the chat context. */
async function persistResult(runId: string, body: string): Promise<string> {
  try {
    await mkdir(OUT_DIR, { recursive: true });
  } catch {
    // directory may already exist — ignore
  }
  const file = join(OUT_DIR, `${runId}.out`);
  try {
    await writeFile(file, body, "utf8");
    return file;
  } catch (err) {
    debug.event("delegate-persist-error", { runId, file, error: String(err) });
    return "";
  }
}

async function cleanupTmp(tmpDir: string | null): Promise<void> {
  if (!tmpDir) return;
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
