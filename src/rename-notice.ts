import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const LEGACY_NAME = "pai-acp";
const NEW_NAME = "billion-context-pi";
const LEGACY_REF = `npm:${LEGACY_NAME}`;
const NEW_REF = `npm:${NEW_NAME}`;
const REGISTRY_URL = `https://registry.npmjs.org/${NEW_NAME}/latest`;

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

/** Resolve settings.json location. pai-acp lives in
 *  <agentDir>/npm/node_modules/pai-acp, so the npm root is <agentDir>/npm
 *  and its parent is agentDir. Works for any pi fork's configDir. */
function resolveSettingsPath(npmDir: string): string {
  return join(dirname(npmDir), "settings.json");
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

/** Run a pi subcommand using the CURRENT pi process (node + cli.js), so the
 *  migration follows whatever pi fork the user is running (pi / pi-stable /
 *  any other). stdin is ignored to avoid hanging on unexpected prompts. */
function runPi(args: string[]): Promise<number> {
  const cliEntry = process.argv[1];
  if (!cliEntry) return Promise.resolve(1);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntry, ...args],
      { timeout: 120_000, shell: false },
      (err) => resolve(err ? 1 : 0),
    );
  });
}

/** Backup settings.json for restore-on-failure. Returns the backup path or
 *  undefined if backup failed (caller falls back to manual notice). */
async function backupSettings(settingsPath: string): Promise<string | undefined> {
  try {
    const bak = `${settingsPath}.migrate.bak`;
    const raw = await readFile(settingsPath, "utf-8");
    await writeFile(bak, raw, "utf-8");
    return bak;
  } catch {
    return undefined;
  }
}

async function restoreSettings(settingsPath: string, bak: string): Promise<void> {
  try {
    const raw = await readFile(bak, "utf-8");
    const tmp = `${settingsPath}.tmp`;
    await writeFile(tmp, raw, "utf-8");
    await rename(tmp, settingsPath);
  } catch {
    // best-effort restore; if this fails the user is in an unknown state,
    // but pi's own install/uninstall failures leave settings in a consistent
    // shape (they use the SettingsManager which is transactional).
  }
}

/** Verify migration outcome: settings.json should reference the new package
 *  and not the legacy one. */
async function verifyMigrated(settingsPath: string): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(settingsPath, "utf-8"));
    const pkgs: string[] = Array.isArray(data.packages) ? data.packages : [];
    return pkgs.includes(NEW_REF) && !pkgs.includes(LEGACY_REF);
  } catch {
    return false;
  }
}

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
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

function rollbackNotice(): string {
  const body = [
    "\u2192 pai-acp → billion-context-pi migration was rolled back.",
    "Settings restored. You can migrate manually:",
    "  pi uninstall pai-acp",
    "  pi install billion-context-pi",
  ].join("\n");
  return `${CYAN}${body}${RESET}`;
}

/** Auto-migrate using the running pi's own package manager (pi install /
 *  pi uninstall), not raw npm — so location, lockfile and settings.json are
 *  all handled correctly by pi itself. Order: backup → install new →
 *  uninstall old → verify. Any failure restores the backup and falls back
 *  to the manual notice. The current process keeps running from in-memory
 *  code, so uninstalling the legacy package on disk is safe. */
async function autoMigrate(): Promise<string> {
  const extDir = await findExtensionDir();
  if (!extDir) return manualNotice();
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) return manualNotice();
  const settingsPath = resolveSettingsPath(npmDir);

  // 1. Backup settings.json (atomic-ish: we read then write a sibling file).
  const bak = await backupSettings(settingsPath);

  // 2. Install the new package first. If this fails, nothing changed
  //    (pi install is transactional) — settings still has pai-acp only.
  if ((await runPi(["install", NEW_REF])) !== 0) {
    return manualNotice();
  }

  // 3. Uninstall the legacy package. If this fails, settings may now have
  //    both packages — restore the backup so the user boots into pai-acp
  //    (not a double-loaded state). The newly installed billion-context-pi
  //    on disk is harmless (unused until referenced).
  if ((await runPi(["uninstall", LEGACY_REF])) !== 0) {
    if (bak) await restoreSettings(settingsPath, bak);
    return bak ? rollbackNotice() : manualNotice();
  }

  // 4. Verify the final settings state.
  if (!(await verifyMigrated(settingsPath))) {
    if (bak) await restoreSettings(settingsPath, bak);
    return bak ? rollbackNotice() : manualNotice();
  }

  return successNotice();
}

let migrateInFlight = false;

/** Checks if the extension is running under the legacy name (pai-acp) and
 *  migrates to billion-context-pi. If a real version of the new package is
 *  published, performs the migration automatically (backup → install new →
 *  uninstall old → verify, with rollback on any failure). Otherwise, shows a
 *  friendly notice with manual steps. Stays silent once renamed. */
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
