import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_NAME = "pai-acp";
const NEW_NAME = "billion-context-pi";

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

/** Returns a rename notice if running under the legacy package name (pai-acp),
 *  or undefined if already renamed (billion-context-pi) or unknown.
 *
 *  Shown on every session_start (no throttle) so users who haven't migrated
 *  keep seeing the prompt until they switch. */
export async function getRenameNotice(): Promise<string | undefined> {
  const name = await getPackageName();
  if (name !== LEGACY_NAME) return undefined;
  return [
    "\x1b[33m\u26A0 pai-acp has been renamed to billion-context-pi\x1b[0m",
    "This package is deprecated. To migrate:",
    "  1. pi uninstall pai-acp",
    "  2. pi install billion-context-pi",
    "Config (~/.pi/acp.json) is preserved automatically.",
  ].join("\n");
}
