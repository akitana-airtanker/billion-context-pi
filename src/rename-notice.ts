import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const LEGACY_NAME = "pai-acp";
const NEW_NAME = "billion-context-pi";
const NEW_REF = `npm:${NEW_NAME}`;
const REGISTRY_URL = `https://registry.npmjs.org/${NEW_NAME}/latest`;

type PackageJson = { name?: string };

/** Walk up from this module to find the extension's package.json (matching
 *  either name). SYNC version for use in the synchronous factory function.
 *  Uses the `parent === dir` stabilization guard so it terminates on Windows
 *  drive roots (e.g. `C:\`) where `dirname("C:\\") === "C:\\"`. */
function findExtensionDirSync(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const data = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (data?.name === LEGACY_NAME || data?.name === NEW_NAME) return dir;
    } catch {
      // not found / bad json — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Walk up to the npm root (first ancestor ending in `node_modules`, return
 *  its parent). SYNC. Same stabilization guard as findExtensionDirSync. */
function findNpmRootSync(extDir: string): string | undefined {
  let dir = dirname(extDir);
  for (;;) {
    if (dir.endsWith("node_modules")) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** SYNC: is the running package the legacy pai-acp? Used by the factory to
 *  decide whether self-disable logic applies. */
export function isLegacyPackage(): boolean {
  const dir = findExtensionDirSync();
  if (!dir) return false;
  try {
    const data = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return data?.name === LEGACY_NAME;
  } catch {
    return false;
  }
}

/** SYNC: has billion-context-pi been installed in the shared node_modules?
 *  Used by the legacy factory to self-disable when the new package takes over.
 *  Checks the physical node_modules directory (not settings.json), so it is
 *  unaffected by settings scope (user vs project). */
export function isNewPackageInstalled(): boolean {
  const extDir = findExtensionDirSync();
  if (!extDir) return false;
  const npmDir = findNpmRootSync(extDir);
  if (!npmDir) return false;
  try {
    const data = JSON.parse(
      readFileSync(join(npmDir, "node_modules", NEW_NAME, "package.json"), "utf-8"),
    );
    return data?.name === NEW_NAME;
  } catch {
    return false;
  }
}

/** Returns true if billion-context-pi has a real release (version > 0.0.1
 *  placeholder) published to npm. Migration only fires once a real version
 *  exists — otherwise it would install the empty placeholder. */
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

/** Run a pi subcommand using the CURRENT pi process (node + cli.js), so the
 *  install follows whatever pi fork the user is running. stdin is ignored to
 *  avoid hanging on unexpected prompts. */
function runPi(args: string[]): Promise<number> {
  const cliEntry = process.argv[1];
  if (!cliEntry || !existsSync(cliEntry)) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliEntry, ...args],
      { timeout: 120_000, shell: false },
      (err: NodeJS.ErrnoException | null) => resolve(err ? 1 : 0),
    );
    // Ignore stdin so an unexpected prompt cannot hang the child.
    child.stdin?.end();
  });
}

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function manualNotice(): string {
  const body = [
    "\u2192 pai-acp is now billion-context-pi",
    "Your context tools are unchanged — same package, new name.",
    "To switch:",
    "  pi install billion-context-pi",
    "  pi uninstall pai-acp",
    "(Your ~/.pi/acp.json config carries over.)",
  ].join("\n");
  return `${CYAN}${body}${RESET}`;
}

function installingNotice(): string {
  return `${CYAN}Installing billion-context-pi\u2026${RESET}`;
}

function successNotice(): string {
  return `${GREEN}\u2714 billion-context-pi installed — restart Pi to switch.${RESET}`;
}

/** Notice shown when self-disabled (new package is active, legacy is inert). */
function canUninstallNotice(): string {
  const body = [
    `${GREEN}\u2714 billion-context-pi is active.${RESET}`,
    `${CYAN}pai-acp is now inert. To clean up:${RESET}`,
    `  ${CYAN}pi uninstall pai-acp${RESET}`,
  ].join("\n");
  return body;
}

/** Install the new package alongside the legacy one (does NOT uninstall the
 *  legacy package). Safe because install is additive and idempotent: a
 *  failure leaves settings.json unchanged, and two concurrent sessions both
 *  installing the same package is harmless. Returns true on success. */
async function installNewPackage(): Promise<boolean> {
  return (await runPi(["install", NEW_REF])) === 0;
}

let migrateInFlight = false;

/** Called from session_start of the LEGACY package (only). If the new package
 *  has a real release on npm, installs it and notifies the user to restart.
 *  The legacy package then self-disables on the next launch (factory detects
 *  the new package in node_modules and registers nothing). Until a real
 *  release exists, shows a friendly manual notice. */
export async function checkRename(notify: (msg: string) => void): Promise<void> {
  const safeNotify = (msg: string) => {
    try {
      notify(msg);
    } catch {
      // notification must never crash the host
    }
  };
  if (migrateInFlight) return;
  migrateInFlight = true;
  try {
    // If the new package is already installed, this session is the inert
    // legacy copy (the factory already self-disabled the active logic).
    // Just nudge the user to uninstall.
    if (isNewPackageInstalled()) {
      safeNotify(canUninstallNotice());
      return;
    }
    const ready = await newPackageReady();
    if (!ready) {
      safeNotify(manualNotice());
      return;
    }
    // Real version exists — install it (additive, safe).
    safeNotify(installingNotice());
    const ok = await installNewPackage();
    safeNotify(ok ? successNotice() : manualNotice());
  } catch {
    safeNotify(manualNotice());
  } finally {
    migrateInFlight = false;
  }
}
