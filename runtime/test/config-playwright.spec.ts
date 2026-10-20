// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  type CreateConfigInput,
  createConfig,
  localWebServer,
} from "../src/config/playwright.js"

// createConfig() fixes what must not vary (no retries, one worker, full
// evidence) and passes the project's options through; localWebServer()
// builds the development stage's server entry.

const BASE: CreateConfigInput = {
  target: "local",
  baseURL: "http://localhost:4101",
  resultsDir: "/r/loc-1",
  reportDir: "/r/loc-1/report",
  reporter: "./reporter.ts",
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  testDir: "./tests",
  timeout: 60_000,
  projects: [{ name: "gate" }],
  video: { on: false },
  slowMo: 0,
}

function withCi<T>(value: string | undefined, body: () => T): T {
  const saved = process.env.CI
  if (value === undefined) delete process.env.CI
  else process.env.CI = value
  try {
    return body()
  } finally {
    if (saved === undefined) delete process.env.CI
    else process.env.CI = saved
  }
}

test("never retries, one worker, full evidence, the run's own folders", () => {
  const config = createConfig(BASE)
  expect(config).toMatchObject({
    retries: 0,
    workers: 1,
    fullyParallel: false,
    testDir: "./tests",
    timeout: 60_000,
    globalSetup: "./setup.ts",
    globalTeardown: "./teardown.ts",
    expect: { timeout: 15_000 },
    outputDir: "/r/loc-1/test-results",
    reporter: [
      ["list"],
      ["html", { open: "never", outputFolder: "/r/loc-1/report" }],
      ["./reporter.ts"],
    ],
    use: {
      baseURL: "http://localhost:4101",
      trace: "on",
      screenshot: "on",
      actionTimeout: 15_000,
      navigationTimeout: 30_000,
    },
    projects: [{ name: "gate" }],
  })
  expect("testIgnore" in config).toBe(false)
})

test("forbidOnly follows CI unless the project says", () => {
  expect(withCi("1", () => createConfig(BASE).forbidOnly)).toBe(true)
  expect(withCi(undefined, () => createConfig(BASE).forbidOnly)).toBe(false)
  expect(
    withCi("1", () => createConfig({ ...BASE, forbidOnly: false }).forbidOnly),
  ).toBe(false)
  expect(
    withCi(
      undefined,
      () => createConfig({ ...BASE, forbidOnly: true }).forbidOnly,
    ),
  ).toBe(true)
})

test("video: plain 'on' unless recording is on AND a size is given", () => {
  expect(createConfig(BASE).use?.video).toBe("on")
  expect(createConfig({ ...BASE, video: { on: true } }).use?.video).toBe("on")
  expect(
    createConfig({
      ...BASE,
      video: { on: false, size: { width: 1, height: 2 } },
    }).use?.video,
  ).toBe("on")
  expect(
    createConfig({
      ...BASE,
      video: { on: true, size: { width: 1280, height: 720 } },
    }).use?.video,
  ).toEqual({ mode: "on", size: { width: 1280, height: 720 } })
})

test("the project's use options merge under flowreel's; slowMo wins over launch options", () => {
  const use = createConfig({
    ...BASE,
    slowMo: 250,
    use: {
      locale: "en-GB",
      baseURL: "http://elsewhere.test",
      trace: "off",
      launchOptions: { headless: false, slowMo: 1 },
    },
    expectTimeout: 5_000,
    actionTimeout: 6_000,
    navigationTimeout: 7_000,
    testIgnore: "**/*.unit.ts",
  })
  expect(use.use).toMatchObject({
    locale: "en-GB",
    baseURL: "http://localhost:4101",
    trace: "on",
    actionTimeout: 6_000,
    navigationTimeout: 7_000,
    launchOptions: { headless: false, slowMo: 250 },
  })
  expect(use.expect?.timeout).toBe(5_000)
  expect(use.testIgnore).toBe("**/*.unit.ts")
})

test("the web server is for the local target only", () => {
  const server = localWebServer({
    cwd: ".",
    port: 4101,
    command: "bin/serve 4101",
    baseURL: "http://localhost:4101",
    reuse: false,
    env: {},
  })
  expect(createConfig({ ...BASE, webServer: server }).webServer).toBe(server)
  expect(
    createConfig({ ...BASE, target: "staging", webServer: server }).webServer,
  ).toBeUndefined()
})

test("localWebServer: ready path and timeout default, or come from the project", () => {
  const base = {
    cwd: "app",
    port: 4101,
    command: "bin/serve",
    baseURL: "http://localhost:4101",
    reuse: true,
    env: { A: "1" },
  }
  expect(localWebServer(base)).toEqual({
    cwd: "app",
    command: "bin/serve",
    url: "http://localhost:4101/up",
    timeout: 180_000,
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "pipe",
    env: { A: "1" },
  })
  expect(
    localWebServer({
      ...base,
      readyPath: "/health",
      timeout: 5_000,
      reuse: false,
    }),
  ).toMatchObject({
    url: "http://localhost:4101/health",
    timeout: 5_000,
    reuseExistingServer: false,
  })
})

// A CI signals the job's whole process group: a worker that closed its
// browser on SIGTERM would lose the running test's video, so browsers leave
// SIGTERM to the runner's graceful stop (issue #11). SIGHUP keeps
// Playwright's default.
test("browsers leave SIGTERM to the runner, in every project, unless one says otherwise", () => {
  const config = createConfig({
    ...BASE,
    projects: [
      { name: "plain" },
      { name: "slow", use: { launchOptions: { slowMo: 100 } } },
      { name: "own", use: { launchOptions: { handleSIGTERM: true } } },
    ],
  })
  expect(config.use?.launchOptions).toEqual({
    handleSIGTERM: false,
    slowMo: 0,
  })
  expect(config.projects?.[0]).toEqual({ name: "plain" })
  expect(config.projects?.[1].use?.launchOptions).toEqual({
    handleSIGTERM: false,
    slowMo: 100,
  })
  expect(config.projects?.[2].use?.launchOptions).toEqual({
    handleSIGTERM: true,
  })
  expect(JSON.stringify(config)).not.toContain("handleSIGHUP")
})
