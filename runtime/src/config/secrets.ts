// SPDX-License-Identifier: Apache-2.0

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"

import { ConfigError } from "../core/errors.js"

// The optional secrets file: KEY=VALUE lines outside the repository, read
// only for a staging run and only when it is private to the current user
// (chmod 600). Nothing here ever logs or echoes a value.

/**
 * The secrets file holds passwords and API secrets, so it must be owned by
 * the current user and closed to group/other (chmod 600). Throws naming the
 * path, never a value. `uid` is null on platforms without POSIX ownership
 * (the mode check still applies).
 */
export function assertPrivateFile(
  path: string,
  stat: { uid: number; mode: number },
  uid: number | null = process.getuid?.() ?? null,
): void {
  if (uid !== null && stat.uid !== uid) {
    throw new ConfigError(
      `${path} is not owned by the current user; refusing to read QA secrets from it.`,
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0")
    throw new ConfigError(
      `${path} is accessible to other users (mode ${mode}); run: chmod 600 ${path}`,
    )
  }
}

/** Reads the secrets file, or undefined when it does not exist. */
export function readPrivateFile(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    // fstat on the open descriptor: the checked file is the one read.
    assertPrivateFile(path, fstatSync(fd))
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

/** Tiny KEY=VALUE parser: `#` comments, optional `export `, quoted values. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim()
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}
