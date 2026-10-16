// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  LOOPBACK_HOSTS,
  type TargetPolicy,
  agreedEnvValue,
  assertNoPlaceholders,
  assertPrivateFile,
  assertSafeBaseUrl,
  assertTargetPolicy,
  createConfig,
  defineConfig,
  localWebServer,
  openConfigSource,
  parseEnvFile,
  parseLocalPort,
  parseModule,
  parsePositiveInt,
  parseTarget,
  readPrivateFile,
  readTarget,
  reportDir,
  requireKeys,
  resolveBaseUrl,
  resultsDir,
  settleEnvValue,
} from "../src/config/index.js"
import { envNames, registerEnvAliases } from "../src/core/env.js"
import { ConfigError } from "../src/core/errors.js"

// The config module: the target allowlist (production refused with its own
// message, nothing else accepted), the owner-only secrets file, where a
// run's settings come from (target from process env only; local never reads
// the file; process env authoritative even when empty) and defineConfig().

const POLICY: TargetPolicy = {
  local: { portMin: 4101, portMax: 4199 },
  staging: ["https://staging.example.org", "https://qa.example.org"],
  isProductionHost: (host) =>
    host === "example.org" ||
    (host.endsWith(".example.org") &&
      !host.startsWith("staging.") &&
      !host.startsWith("qa.")),
}

const SECRETS = {
  file: (home: string) => join(home, ".config", "app-qa", "staging.env"),
  baseUrlKey: "APP_BASE_URL",
  template: "flowreel/env.example",
  envHint: "e.g. from a password manager",
}

test.describe("target allowlist", () => {
  test("accepts exactly the allowlisted origins", () => {
    expect(assertSafeBaseUrl("http://localhost:4101", "local", POLICY)).toBe(
      "http://localhost:4101",
    )
    expect(assertSafeBaseUrl("http://localhost:4199/", "local", POLICY)).toBe(
      "http://localhost:4199",
    )
    expect(
      assertSafeBaseUrl("https://qa.example.org/", "staging", POLICY),
    ).toBe("https://qa.example.org")
  })

  test("refuses production hosts with their own message, for both targets", () => {
    for (const target of ["local", "staging"] as const) {
      for (const url of ["https://example.org", "https://app.example.org/x"]) {
        expect(() => assertSafeBaseUrl(url, target, POLICY)).toThrow(
          /production hosts are never a QA target/,
        )
      }
    }
  })

  test("the local host is loopback only and never a production host, whatever the policy says", () => {
    // A policy whose "local" host is a production host: refused by the
    // policy check AND by assertSafeBaseUrl (which runs the production
    // refusal before either allowlist).
    const prod: TargetPolicy = {
      local: { host: "app.example.com", portMin: 8000, portMax: 8999 },
      staging: [],
      isProductionHost: (h) =>
        h.endsWith(".example.com") && !h.startsWith("staging."),
    }
    expect(() =>
      assertSafeBaseUrl("http://app.example.com:8443", "local", prod),
    ).toThrow(
      "Refusing http://app.example.com:8443: production hosts are never a QA target.",
    )
    expect(() => assertTargetPolicy(prod)).toThrow(
      "targets.local.host: app.example.com is a production host by the policy's own rule.",
    )
    // Any other non-loopback host: refused too (local seams stay on this machine).
    const lan: TargetPolicy = {
      ...POLICY,
      local: { ...POLICY.local, host: "dev.internal" },
    }
    expect(() => assertTargetPolicy(lan)).toThrow(
      'targets.local.host must be a loopback host (localhost, 127.0.0.1, [::1]); got "dev.internal".',
    )
    expect(() =>
      assertSafeBaseUrl("http://dev.internal:4101", "local", lan),
    ).toThrow(/^Refusing base URL http:\/\/dev.internal:4101\//)
    expect(LOOPBACK_HOSTS).toEqual(["localhost", "127.0.0.1", "[::1]"])
    for (const host of LOOPBACK_HOSTS) {
      const policy = { ...POLICY, local: { ...POLICY.local, host } }
      expect(() => assertTargetPolicy(policy), host).not.toThrow()
      expect(assertSafeBaseUrl(`http://${host}:4101`, "local", policy)).toBe(
        `http://${host}:4101`,
      )
    }
    // A production origin a policy lists for staging is still refused.
    const listed = { ...POLICY, staging: ["https://app.example.org"] }
    expect(() =>
      assertSafeBaseUrl("https://app.example.org", "staging", listed),
    ).toThrow(/production hosts are never a QA target/)
  })

  test("refuses everything else, never echoing credentials", () => {
    const refused = [
      ["http://localhost:4200", "local"],
      ["http://127.0.0.1:4101", "local"],
      ["https://localhost:4101", "local"],
      ["http://localhost:4101/path", "local"],
      ["https://staging.example.org/x", "staging"],
      ["https://staging.example.org?x=1", "staging"],
      ["http://staging.example.org", "staging"],
      ["https://other.test", "staging"],
      ["http://localhost:4101", "staging"],
    ] as const
    for (const [url, target] of refused) {
      expect(() => assertSafeBaseUrl(url, target, POLICY), url).toThrow(
        ConfigError,
      )
    }
    expect(() => assertSafeBaseUrl("::", "local", POLICY)).toThrow(
      "Base URL is not a valid URL.",
    )
    let message = ""
    try {
      assertSafeBaseUrl(
        "https://u:S3cret@staging.example.org/x",
        "staging",
        POLICY,
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(
      "Allowed: https://staging.example.org, https://qa.example.org.",
    )
    expect(message).not.toContain("S3cret")
  })

  test("local ports: default, range, label", () => {
    expect(parseLocalPort(undefined, POLICY, "X")).toBe(4101)
    expect(parseLocalPort(" ", POLICY, "X")).toBe(4101)
    expect(parseLocalPort("4150", POLICY, "X")).toBe(4150)
    expect(
      parseLocalPort(
        undefined,
        { ...POLICY, local: { ...POLICY.local, defaultPort: 4120 } },
        "X",
      ),
    ).toBe(4120)
    expect(() => parseLocalPort("4200", POLICY, "MY_PORT")).toThrow(
      'MY_PORT must be a port from 4101 to 4199 (got "4200").',
    )
    expect(() => parseLocalPort("41x0", POLICY, "MY_PORT")).toThrow(ConfigError)
  })

  test("targets: local by default, staging on request, nothing else", () => {
    expect(parseTarget(undefined, "T")).toBe("local")
    expect(parseTarget("staging", "T")).toBe("staging")
    expect(() => parseTarget("production", "MY_TARGET")).toThrow(
      'MY_TARGET must be "local" or "staging" (got "production").',
    )
    expect(readTarget({})).toBe("local")
    expect(readTarget({ FLOWREEL_TARGET: "staging" })).toBe("staging")
    expect(() => readTarget({ FLOWREEL_TARGET: "x" })).toThrow(
      /^FLOWREEL_TARGET must be/,
    )
  })
})

test.describe("secrets file", () => {
  test("owner-only, by mode and owner", () => {
    expect(() =>
      assertPrivateFile("/f", { uid: 7, mode: 0o100600 }, 7),
    ).not.toThrow()
    expect(() =>
      assertPrivateFile("/f", { uid: 7, mode: 0o100400 }, null),
    ).not.toThrow()
    expect(() =>
      assertPrivateFile("/f", { uid: 7, mode: 0o100644 }, 7),
    ).toThrow("/f is accessible to other users (mode 644); run: chmod 600 /f")
    expect(() =>
      assertPrivateFile("/f", { uid: 8, mode: 0o100600 }, 7),
    ).toThrow(/not owned by the current user/)
  })

  test("reads a 600 file, refuses a 644 one, a missing file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-secrets-"))
    try {
      const file = join(dir, "s.env")
      expect(readPrivateFile(file)).toBeUndefined()
      writeFileSync(file, "A=1\n")
      chmodSync(file, 0o600)
      expect(readPrivateFile(file)).toBe("A=1\n")
      chmodSync(file, 0o644)
      expect(() => readPrivateFile(file)).toThrow(/chmod 600/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KEY=VALUE: comments, export, quotes; junk ignored", () => {
    expect(
      parseEnvFile("# c\nA=1\nexport B='two'\nC=\"3 3\"\n=x\njunk\nD = 4 "),
    ).toEqual({ A: "1", B: "two", C: "3 3", D: "4" })
  })
})

test.describe("config source", () => {
  const open = (env: Record<string, string>, file?: string) => {
    const reads: string[] = []
    const source = openConfigSource(SECRETS, {
      env,
      homeDir: "/home/q",
      readFile: (path) => {
        reads.push(path)
        return file
      },
    })
    return { source, reads }
  }

  test("local never reads the file, even when one is configured", () => {
    const { source, reads } = open({ FLOWREEL_ENV_FILE: "/x.env" }, "SECRET=1")
    expect(source.target).toBe("local")
    expect(source.get("SECRET")).toBeUndefined()
    expect(reads).toEqual([])
  })

  test("staging reads (and checks) the file at once; process env wins, even empty", () => {
    const { source, reads } = open(
      { FLOWREEL_TARGET: "staging", B: "env", C: "" },
      "A=file\nB=file\nC=file\nFLOWREEL_TARGET=local",
    )
    expect(reads).toEqual(["/home/q/.config/app-qa/staging.env"])
    expect(source.get("A")).toBe("file")
    expect(source.get("B")).toBe("env")
    expect(source.get("C")).toBeUndefined()
    // The target never comes from the file.
    expect(source.target).toBe("staging")
    expect(
      open({ FLOWREEL_TARGET: "staging", FLOWREEL_ENV_FILE: "/o.env" }).reads,
    ).toEqual(["/o.env"])
  })

  test("required keys and placeholders are named, never echoed", () => {
    const { source } = open({ FLOWREEL_TARGET: "staging", PW: "change-me" }, "")
    expect(() => requireKeys(source, ["PW", "ID", "SECRET"], SECRETS)).toThrow(
      "Missing required staging config: ID, SECRET. Pass them in the environment (e.g. from a password manager) or set them in /home/q/.config/app-qa/staging.env (template: flowreel/env.example, chmod 600).",
    )
    expect(() =>
      assertNoPlaceholders(
        source,
        ["PW", "ID"],
        new Set(["change-me"]),
        SECRETS,
      ),
    ).toThrow(
      "Template placeholder values in staging config: PW. Replace them with the real values (flowreel/env.example only shows the shape).",
    )
    expect(() => requireKeys(source, ["PW"])).not.toThrow()
  })

  test("base URL: the configured key, else the local port; always checked", () => {
    expect(resolveBaseUrl(open({}).source, POLICY, SECRETS)).toBe(
      "http://localhost:4101",
    )
    expect(
      resolveBaseUrl(
        open({ FLOWREEL_LOCAL_PORT: "4172" }).source,
        POLICY,
        SECRETS,
      ),
    ).toBe("http://localhost:4172")
    expect(
      resolveBaseUrl(
        open(
          { FLOWREEL_TARGET: "staging" },
          "APP_BASE_URL=https://qa.example.org",
        ).source,
        POLICY,
        SECRETS,
      ),
    ).toBe("https://qa.example.org")
    expect(() =>
      resolveBaseUrl(
        open({ APP_BASE_URL: "https://www.example.org" }).source,
        POLICY,
        SECRETS,
      ),
    ).toThrow(/production hosts/)
  })

  test("agreedEnvValue / settleEnvValue: one value under every name, disagreement refused", () => {
    registerEnvAliases({ CONFIG_SPEC_AGREE: ["APP_SPEC_AGREE"] })
    expect(agreedEnvValue({}, "CONFIG_SPEC_AGREE")).toBeUndefined()
    expect(agreedEnvValue({ APP_SPEC_AGREE: "a" }, "CONFIG_SPEC_AGREE")).toBe(
      "a",
    )
    expect(
      agreedEnvValue(
        { FLOWREEL_CONFIG_SPEC_AGREE: "a", APP_SPEC_AGREE: " a " },
        "CONFIG_SPEC_AGREE",
      ),
    ).toBe("a")
    // Empty counts as unset, not as a disagreement.
    expect(
      agreedEnvValue(
        { FLOWREEL_CONFIG_SPEC_AGREE: "", APP_SPEC_AGREE: "b" },
        "CONFIG_SPEC_AGREE",
      ),
    ).toBe("b")
    expect(() =>
      agreedEnvValue(
        { FLOWREEL_CONFIG_SPEC_AGREE: "s3cret-a", APP_SPEC_AGREE: "s3cret-b" },
        "CONFIG_SPEC_AGREE",
      ),
    ).toThrow(
      "FLOWREEL_CONFIG_SPEC_AGREE and APP_SPEC_AGREE are both set, to different values; unset one (they name the same setting).",
    )

    const env: Record<string, string | undefined> = { APP_SPEC_AGREE: "x" }
    expect(settleEnvValue(env, "CONFIG_SPEC_AGREE", () => "y")).toBe("x")
    expect(env).toEqual({
      APP_SPEC_AGREE: "x",
      FLOWREEL_CONFIG_SPEC_AGREE: "x",
    })
    const fresh: Record<string, string | undefined> = {}
    expect(settleEnvValue(fresh, "CONFIG_SPEC_AGREE", () => "y")).toBe("y")
    expect(fresh).toEqual({
      APP_SPEC_AGREE: "y",
      FLOWREEL_CONFIG_SPEC_AGREE: "y",
    })
    expect(() =>
      settleEnvValue(
        { FLOWREEL_CONFIG_SPEC_AGREE: "1", APP_SPEC_AGREE: "2" },
        "CONFIG_SPEC_AGREE",
        () => "y",
      ),
    ).toThrow(ConfigError)
  })

  test("modules and positive integers", () => {
    expect(parseModule({}, ["a", "b"], "a")).toBe("a")
    expect(parseModule({ FLOWREEL_MODULE: " b " }, ["a", "b"], "a")).toBe("b")
    expect(() =>
      parseModule({ FLOWREEL_MODULE: "c" }, ["a", "b"], "a"),
    ).toThrow('FLOWREEL_MODULE must be one of a, b (got "c").')
    expect(parsePositiveInt("T", "5000")).toBe(5000)
    expect(() => parsePositiveInt("T", "0")).toThrow(
      "T must be a positive integer (milliseconds).",
    )
  })
})

test.describe("defineConfig", () => {
  const input = {
    targets: POLICY,
    modules: { names: ["gate", "tour"] as const, default: "gate" as const },
    personas: ["agent", "admin"] as const,
    secrets: SECRETS,
    results: "/tmp/flowreel-results",
  }

  test("fills defaults and registers the project's aliases", () => {
    const config = defineConfig({
      ...input,
      envAliases: { CONFIG_SPEC_KEY: ["APP_CONFIG_SPEC_KEY"] },
    })
    expect(config.logPrefix).toBe("flowreel")
    expect(envNames("CONFIG_SPEC_KEY")).toEqual([
      "FLOWREEL_CONFIG_SPEC_KEY",
      "APP_CONFIG_SPEC_KEY",
    ])
    expect(resultsDir(config, "r1")).toBe("/tmp/flowreel-results/r1")
    expect(reportDir(config, "r1")).toBe("/tmp/flowreel-results/r1/report")
  })

  test("refuses an incoherent config", () => {
    const bad: [Partial<typeof input> & Record<string, unknown>, RegExp][] = [
      [
        { modules: { names: [], default: "gate" } } as never,
        /modules.names is empty/,
      ],
      [
        { modules: { names: ["gate"], default: "tour" } } as never,
        /modules.default/,
      ],
      [{ personas: ["agent", "agent"] } as never, /personas repeats/],
      [
        { targets: { ...POLICY, local: { portMin: 5, portMax: 4 } } },
        /port range/,
      ],
      [
        { targets: { ...POLICY, staging: ["http://staging.example.org"] } },
        /bare https origin/,
      ],
      [
        { targets: { ...POLICY, staging: ["https://example.org"] } },
        /production host/,
      ],
      [
        {
          targets: {
            ...POLICY,
            local: { ...POLICY.local, host: "app.example.org" },
          },
        },
        /targets.local.host: app.example.org is a production host/,
      ],
      [
        {
          targets: { ...POLICY, local: { ...POLICY.local, host: "0.0.0.0" } },
        },
        /must be a loopback host/,
      ],
      [{ envAliases: { lower: ["X"] } }, /is not a key/],
      [{ envAliases: { K: ["FLOWREEL_K"] } }, /project's own/],
    ]
    for (const [patch, error] of bad) {
      expect(() => defineConfig({ ...input, ...patch }), String(error)).toThrow(
        error,
      )
    }
  })
})

test.describe("createConfig", () => {
  const base = {
    target: "local" as const,
    baseURL: "http://localhost:4101",
    resultsDir: "/r/loc-1",
    reportDir: "/r/loc-1/report",
    reporter: "./flowreel/reporter.ts",
    globalSetup: "./flowreel/setup.ts",
    globalTeardown: "./flowreel/teardown.ts",
    testDir: "./flowreel",
    timeout: 60_000,
    projects: [{ name: "gate" }],
    video: { on: true, size: { width: 1680, height: 945 } },
    slowMo: 250,
  }

  test("fixes what must not vary: no retries, one worker, full evidence", () => {
    const config = createConfig({
      ...base,
      forbidOnly: false,
      webServer: localWebServer({
        cwd: "..",
        port: 4101,
        command: "serve -p 4101",
        baseURL: base.baseURL,
        reuse: false,
        env: { A: "1" },
      }),
    })
    expect(config).toMatchObject({
      retries: 0,
      workers: 1,
      fullyParallel: false,
      outputDir: "/r/loc-1/test-results",
      reporter: [
        ["list"],
        ["html", { open: "never", outputFolder: "/r/loc-1/report" }],
        ["./flowreel/reporter.ts"],
      ],
      globalSetup: "./flowreel/setup.ts",
      globalTeardown: "./flowreel/teardown.ts",
      use: {
        baseURL: "http://localhost:4101",
        trace: "on",
        screenshot: "on",
        video: { mode: "on", size: { width: 1680, height: 945 } },
        launchOptions: { slowMo: 250 },
      },
      webServer: {
        url: "http://localhost:4101/up",
        timeout: 180_000,
        reuseExistingServer: false,
        env: { A: "1" },
      },
    })
  })

  test("staging never starts a local server; video off records at the default size", () => {
    const config = createConfig({
      ...base,
      target: "staging",
      video: { on: false },
      webServer: localWebServer({
        cwd: ".",
        port: 1,
        command: "x",
        baseURL: "http://localhost:1",
        reuse: true,
        env: {},
      }),
    })
    expect(config.webServer).toBeUndefined()
    expect(config.use?.video).toBe("on")
  })
})
