import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { debug } from "./log.js";

declare const CURRENT_VERSION: string;

const LEGACY_NAME = "pai-acp";
const REGISTRY_BASE = "https://registry.npmjs.org";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
// Throttle file is suffixed with the running package name so pai-acp and
// billion-context-pi don't share the same update-check timestamp.
function throttleFilePath(name: string): string {
  return `${process.env.HOME ?? ""}/.pi/agent/.${name}-update-check`;
}
const THROTTLE_FILE = `${process.env.HOME ?? ""}/.pi/agent/.pai-acp-update-check`;

// Guards against concurrent checks: the context event fires on every LLM call,
// so several can race past the throttle read before any writes the timestamp.
let updateInFlight = false;

/** The running package name, resolved lazily from the extension's own
 *  package.json. Same source works under both names (pai-acp and the renamed
 *  billion-context-pi) without editing constants. */
let cachedPackageName: string | undefined;
async function getPackageName(): Promise<string | undefined> {
  if (cachedPackageName !== undefined) return cachedPackageName;
  const dir = await findExtensionDir();
  if (!dir) return undefined;
  const pkg = await readPackageJson(join(dir, "package.json"));
  cachedPackageName = pkg?.name;
  return cachedPackageName;
}

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

async function readLastCheck(name: string): Promise<number> {
  try {
    const data = await readFile(throttleFilePath(name), "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(name: string, timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(throttleFilePath(name)), { recursive: true });
    await writeFile(throttleFilePath(name), String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf-8"));
    return data && typeof data === "object" ? (data as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function findNpmRoot(extDir: string): string | undefined {
  let dir = dirname(extDir);
  while (dir !== "/" && dir !== ".") {
    if (dir.endsWith("node_modules")) return dirname(dir);
    dir = dirname(dir);
  }
  return undefined;
}

async function findExtensionDir(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = await readPackageJson(join(dir, "package.json"));
    if (pkg?.name === LEGACY_NAME || pkg?.name === "billion-context-pi") return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function autoInstallLatest(latest: string): Promise<boolean> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) return false;
  const extDir = await findExtensionDir();
  if (!extDir) return false;
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) return false;

  try {
    const packageName = await getPackageName();
    if (!packageName) return false;
    const code = await new Promise<number>((resolve) => {
      execFile(
        "npm",
        ["install", `${packageName}@${latest}`, "--silent", "--no-audit", "--no-fund"],
        { cwd: npmDir, timeout: 60_000, shell: process.platform === "win32" },
        (err) => resolve(err ? 1 : 0),
      );
    });
    return code === 0;
  } catch {
    return false;
  }
}

export async function checkForUpdate(
  autoUpdate: boolean,
  notify?: (msg: string) => void,
): Promise<void> {
  const envFlag = process.env.ACP_AUTO_UPDATE?.trim().toLowerCase();
  if (
    !autoUpdate ||
    envFlag === "0" ||
    envFlag === "false" ||
    envFlag === "no" ||
    envFlag === "off"
  ) {
    return;
  }
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const packageName = await getPackageName();
    if (!packageName) return;
    const now = Date.now();
    const lastCheck = await readLastCheck(packageName);
    if (now - lastCheck < CHECK_INTERVAL_MS) return;

    await writeLastCheck(packageName, now);

    const runtimeVersion = await getRuntimeVersion();

    const res = await fetch(`${REGISTRY_BASE}/${packageName}/latest`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    debug.event("update-check", {
      current,
      latest,
      hasUpdate: isNewer(latest, current),
    });

    if (isNewer(latest, current)) {
      const installed = await autoInstallLatest(latest);
      if (installed && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
      } else if (!installed && notify) {
        notify(
          `${packageName} ${latest} available (you have ${current}). Run: pi update --extension npm:${packageName}`,
        );
      }
    }
  } catch {
    // network error, registry down, timeout — silent
  } finally {
    updateInFlight = false;
  }
}

async function getRuntimeVersion(): Promise<string | undefined> {
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const pkg = await readPackageJson(join(extDir, "package.json"));
  return pkg?.version;
}
