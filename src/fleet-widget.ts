import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DELEGATE_WIDGET_KEY = "pai-acp-delegates";
const REFRESH_MS = 500;
const MAX_TASK_LEN = 48;

interface WidgetRun {
  runId: string;
  agent: string;
  task: string;
  startedAt: number;
}

type RunsSnapshot = () => WidgetRun[];

let ui: ExtensionContext["ui"] | undefined;
let ctxMode: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastRenderKey = "";
let runsSnapshot: RunsSnapshot | undefined;

function isStaleExtensionContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /stale|no longer active/i.test(msg);
}

function truncateTask(task: string): string {
  const oneLine = task.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_TASK_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TASK_LEN - 1)}…`;
}

function renderLines(runs: WidgetRun[]): string[] | undefined {
  if (runs.length === 0) return undefined;
  const now = Date.now();
  const header = runs.length === 1
    ? `acp_delegate · 1 running`
    : `acp_delegate · ${runs.length} running`;
  const rows = runs.map((r) => {
    const elapsed = Math.max(0, Math.round((now - r.startedAt) / 1000));
    return `  ● ${r.agent} (${elapsed}s) — ${truncateTask(r.task)}`;
  });
  return [header, ...rows];
}

function refresh(): void {
  if (!ui) return;
  const runs = runsSnapshot ? runsSnapshot() : [];
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  // Debounce: skip re-render if the visible state (agent + elapsed-second +
  // count) hasn't changed since last render. Elapsed is rounded to seconds, so
  // this naturally re-renders ~once per second per run.
  const renderKey = sorted
    .map((r) => `${r.agent}:${Math.round((Date.now() - r.startedAt) / 1000)}:${r.task.slice(0, MAX_TASK_LEN)}`)
    .join("|");
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  const lines = renderLines(sorted);
  try {
    ui.setWidget(DELEGATE_WIDGET_KEY, lines, { placement: "belowEditor" });
  } catch (err) {
    if (isStaleExtensionContextError(err)) {
      // The ctx we cached went stale (e.g. /reload). Drop it; the next
      // session_start / tool_result will rebind a fresh one.
      ui = undefined;
      ctxMode = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  }
}

export const delegateStatusWidget = {
  setContext(ctx: ExtensionContext, snapshot: RunsSnapshot): void {
    // Only the interactive TUI renders widgets; rpc/json/print have no use for
    // them (and calling setWidget there is a no-op or error).
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    ctxMode = ctx.mode;
    runsSnapshot = snapshot;
    if (!timer) {
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref?.();
    }
    refresh();
  },
  dispose(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (ui) {
      try {
        ui.setWidget(DELEGATE_WIDGET_KEY, undefined);
      } catch {
        // session is tearing down — best effort
      }
    }
    ui = undefined;
    ctxMode = undefined;
    lastRenderKey = "";
  },
  poke(): void {
    refresh();
  },
};
