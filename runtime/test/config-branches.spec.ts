// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  type TargetPolicy,
  assertNoPlaceholders,
  assertPrivateFile,
  defineConfig,
  openConfigSource,
  readPrivateFile,
  requireKeys,
  resolveBaseUrl,
} from "../src/config/index.js"
import { ConfigError } from "../src/core/errors.js"
import { describeCandidates, describeQuery } from "../src/mail/match.js"
import type { MailMessage } from "../src/mail/types.js"

// The configuration module's remaining paths: defaults, wording without
// optional hints, platforms without POSIX ownership, unreadable secrets.

const POLICY: TargetPolicy = {
  local: { portMin: 4101, portMax: 4199 },
  staging: ["https://qa.example.org"],
  isProductionHost: (host) => host === "example.org",
}

const BASE = {
  targets: POLICY,
  personas: ["admin"],
  secrets: { file: (home: string) => join(home, "secrets.env") },
  results: "results",
} as const

test.describe("defineConfig", () => {
  test("repeated module names are refused; a given log prefix is kept", () => {
    expect(() =>
      defineConfig({
        ...BASE,
        modules: { names: ["a", "b", "a"], default: "a" },
      }),
    ).toThrow("modules.names repeats a name (a, b, a).")
    const config = defineConfig({
      ...BASE,
      modules: { names: ["a"], default: "a" },
      logPrefix: "mine",
    })
    expect(config.logPrefix).toBe("mine")
    expect(config.envAliases).toEqual({})
    expect(
      defineConfig({ ...BASE, modules: { names: ["a"], default: "a" } })
        .logPrefix,
    ).toBe("flowreel")
  })
})

test.describe("the secrets file", () => {
  test("without POSIX ownership only the mode is checked", () => {
    const original = Object.getOwnPropertyDescriptor(process, "getuid")
    try {
      Object.defineProperty(process, "getuid", {
        value: undefined,
        configurable: true,
        writable: true,
      })
      // Another owner would be refused on POSIX; here it is not checked.
      expect(() =>
        assertPrivateFile("/f", { uid: 4242, mode: 0o100600 }),
      ).not.toThrow()
      expect(() =>
        assertPrivateFile("/f", { uid: 4242, mode: 0o100640 }),
      ).toThrow("/f is accessible to other users (mode 640)")
    } finally {
      if (original) Object.defineProperty(process, "getuid", original)
    }
  })

  test("a file owned by someone else is refused without reading it", () => {
    expect(() => assertPrivateFile("/f", { uid: 1, mode: 0o600 }, 2)).toThrow(
      "/f is not owned by the current user; refusing to read QA secrets from it.",
    )
  })

  test("an error other than a missing file is rethrown", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-secrets-"))
    try {
      const file = join(dir, "plain")
      writeFileSync(file, "A=1")
      // A file in the path where a directory is needed: ENOTDIR, not ENOENT.
      expect(() => readPrivateFile(join(file, "inner"))).toThrow(/ENOTDIR/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("config source defaults", () => {
  test("the target and environment default to the process's", () => {
    const keys = ["FLOWREEL_TARGET", "FLOWREEL_ENV_FILE"] as const
    const saved = keys.map((k) => process.env[k])
    try {
      process.env.FLOWREEL_TARGET = "local"
      delete process.env.FLOWREEL_ENV_FILE
      const source = openConfigSource({ file: (home) => `${home}/s.env` })
      expect(source.target).toBe("local")
      expect(source.local).toBe(true)
      expect(source.env).toBe(process.env)
      expect(source.file.endsWith("/s.env")).toBe(true)
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]
      })
    }
  })

  test("the target comes from the given environment when not passed", () => {
    const source = openConfigSource(
      { file: () => "/f" },
      { env: { FLOWREEL_TARGET: "local", X: "1" } },
    )
    expect(source.target).toBe("local")
    expect(source.get("X")).toBe("1")
    expect(source.get("MISSING")).toBeUndefined()
  })
})

test.describe("config messages without optional hints", () => {
  const source = {
    get: () => undefined,
    file: "/f",
    target: "staging",
  } as const

  test("missing keys, bare", () => {
    expect(() => requireKeys(source, ["A"])).toThrow(
      "Missing required staging config: A. Pass them in the environment or set them in /f (chmod 600).",
    )
  })

  test("nothing missing is fine", () => {
    expect(() =>
      requireKeys({ ...source, get: () => "v" }, ["A"]),
    ).not.toThrow()
  })

  test("placeholders, bare; real values pass", () => {
    const holder = {
      get: (k: string) => (k === "A" ? " CHANGE-ME " : "real"),
      target: "staging",
    } as const
    expect(() =>
      assertNoPlaceholders(holder, ["A", "B"], new Set(["change-me"])),
    ).toThrow(
      "Template placeholder values in staging config: A. Replace them with the real values.",
    )
    expect(() =>
      assertNoPlaceholders(holder, ["B"], new Set(["change-me"])),
    ).not.toThrow()
  })

  test("the base URL key defaults to FLOWREEL_BASE_URL", () => {
    const get = (k: string) =>
      k === "FLOWREEL_BASE_URL" ? "https://qa.example.org/" : undefined
    expect(resolveBaseUrl({ get, env: {}, target: "staging" }, POLICY)).toBe(
      "https://qa.example.org",
    )
    expect(() =>
      resolveBaseUrl(
        { get: () => "https://example.org", env: {}, target: "staging" },
        POLICY,
      ),
    ).toThrow(ConfigError)
  })
})

test.describe("mail query descriptions", () => {
  const message = (receivedAt: string, subject: string): MailMessage =>
    ({ receivedAt, subject, to: [] }) as unknown as MailMessage

  test("a body filter is named", () => {
    expect(
      describeQuery({
        to: "a@example.test",
        bodyIncludes: "hi",
        since: new Date(0),
      }),
    ).toBe('mail to=a@example.test body~"hi" since=1970-01-01T00:00:00.000Z')
  })

  test("the newest message is reported whatever the order; no recipient is '(none)'", () => {
    const since = new Date("2026-01-01T00:00:00Z")
    const newer = message("2026-01-03T00:00:00Z", "newer")
    const older = message("2026-01-02T00:00:00Z", "older")
    const expected =
      '2 message(s) since the query start, none matching; newest "newer" to (none)'
    expect(describeCandidates([older, newer], since)).toBe(expected)
    expect(describeCandidates([newer, older], since)).toBe(expected)
  })
})
