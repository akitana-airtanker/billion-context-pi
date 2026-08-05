import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const LEGACY_NAME = "pai-acp";
const NEW_NAME = "billion-context-pi";
const REGISTRY_URL = `https://registry.npmjs.org/${NEW_NAME}/latest`;
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

type PackageJson = { name?: string };

/** Walk up from this module to find the extension's package.json (matching
 *  either the legacy or new name). Returns the directory or undefined. */
async function findExtensionDir(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const data = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
      if (data?.name === LEGACY_NAME || data?.name === NEW_NAME) return dir;
    } catch {
      // not found / bad json — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Returns the running package name (pai-acp or billion-context-pi), or
 *  undefined if it cannot be determined. */
async function getPackageName(): Promise<string | undefined> {
  const dir = await findExtensionDir();
  if (!dir) return undefined;
  try {
    const data = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    return data?.name;
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

/** Returns true if billion-context-pi has a real release (version > 0.0.1
 *  placeholder) published to npm. Migration only fires once a real version
 *  exists — otherwise it would install the empty placeholder and the user
 *  would lose all ACP functionality. */
async function newPackageReady(): Promise<boolean> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { version?: string };
    const v = (data.version ?? "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
    return (v[0] ?? 0) > 0 || (v[1] ?? 0) > 0 || (v[2] ?? 0) > 1;
  } catch {
    return false;
  }
}

function runNpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("npm", args, { cwd, timeout: 60_000, shell: process.platform === "win32" }, (err) =>
      resolve(err ? 1 : 0),
    );
  });
}

/** Atomically rewrite settings.json: replace "npm:pai-acp" with
 *  "npm:billion-context-pi" in the packages array. Returns false if the
 *  file is missing, unparseable, or doesn't reference pai-acp. */
async function updateSettingsPackages(): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(SETTINGS_PATH, "utf-8");
  } catch {
    return false;
  }
  let data: { packages?: string[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(data.packages)) return false;
  const oldRef = `npm:${LEGACY_NAME}`;
  const newRef = `npm:${NEW_NAME}`;
  if (!data.packages.includes(oldRef)) return false;
  data.packages = data.packages.map((p) => (p === oldRef ? newRef : p));
  const tmp = `${SETTINGS_PATH}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, "\t"), "utf-8");
    await rename(tmp, SETTINGS_PATH);
    return true;
  } catch {
    return false;
  }
}

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function manualNotice(): string {
  // NB: wrap the whole block in a single color span (no per-line resets).
  // pi's showStatus wraps the message in theme.fg("dim", ...) — a per-line
  // reset would clear that dim and leave subsequent lines colorless.
  const body = [
    "\u2192 pai-acp is now billion-context-pi",
    "Your context tools are unchanged — same package, new name.",
    "To switch:",
    "  pi uninstall pai-acp",
    "  pi install billion-context-pi",
    "(Your ~/.pi/acp.json config carries over.)",
  ].join("\n");
  return `${CYAN}${body}${RESET}`;
}

function successNotice(): string {
  const body = `✔ Auto-migrated to billion-context-pi — restart Pi to finish.`;
  return `${GREEN}${body}${RESET}`;
}

/** Auto-migrate: install the new package, rewrite settings.json, uninstall
 *  the legacy package. The current process keeps running from in-memory
 *  code, so deleting the on-disk package is safe. Returns a notice string. */
async function autoMigrate(): Promise<string> {
  const extDir = await findExtensionDir();
  if (!extDir) return manualNotice();
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) return manualNotice();

  // 1. Install the new package.
  if ((await runNpm(["install", `${NEW_NAME}@latest`, "--silent", "--no-audit", "--no-fund"], npmDir)) !== 0) {
    return manualNotice();
  }
  // 2. Rewrite settings.json. If this fails, don't uninstall — leave both
  //    packages present so the user can fix it manually.
  if (!(await updateSettingsPackages())) {
    return manualNotice();
  }
  // 3. Uninstall the legacy package. Current process is unaffected (ESM
  //    modules are loaded into memory; deleting the directory is safe).
  await runNpm(["uninstall", LEGACY_NAME, "--silent"], npmDir);

  return successNotice();
}

let migrateInFlight = false;

/** Checks if the extension is running under the legacy name (pai-acp) and
 *  migrates to billion-context-pi. If a real version of the new package is
 *  published, performs the migration automatically (install + config update
 *  + uninstall). Otherwise, shows a friendly notice with manual steps.
 *  Stays silent once renamed. */
export async function checkRename(notify: (msg: string) => void): Promise<void> {
  const name = await getPackageName();
  if (name !== LEGACY_NAME) return;
  if (migrateInFlight) return;
  migrateInFlight = true;
  try {
    const ready = await newPackageReady();
    const msg = ready ? await autoMigrate() : manualNotice();
    notify(msg);
  } catch {
    // any unexpected error — fall back to manual notice, don't crash
    notify(manualNotice());
  } finally {
    migrateInFlight = false;
  }
}
