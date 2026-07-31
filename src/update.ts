import { debug } from "./log.js";

// Injected at build time by tsup (define) from package.json — single source of truth.
declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "pai-acp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const THROTTLE_FILE = `${process.env.HOME ?? ""}/.pi/agent/.pai-acp-update-check`;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function readLastCheck(): Promise<number> {
  try {
    const fs = await import("node:fs/promises");
    const data = await fs.readFile(THROTTLE_FILE, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.dirname(THROTTLE_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(THROTTLE_FILE, String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

export async function checkForUpdate(
  notify?: (msg: string) => void,
): Promise<void> {
  const now = Date.now();
  const lastCheck = await readLastCheck();
  if (now - lastCheck < CHECK_INTERVAL_MS) return;

  await writeLastCheck(now);

  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;

    debug.event("update-check", {
      current: CURRENT_VERSION,
      latest,
      hasUpdate: isNewer(latest, CURRENT_VERSION),
    });

    if (isNewer(latest, CURRENT_VERSION) && notify) {
      notify(
        `${PACKAGE_NAME} ${latest} is available (you have ${CURRENT_VERSION}). Run: pi update --extension npm:${PACKAGE_NAME}`,
      );
    }
  } catch {
    // network error, registry down, timeout — silent
  }
}
