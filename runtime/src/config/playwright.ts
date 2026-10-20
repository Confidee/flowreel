// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"

import type { PlaywrightTestConfig } from "@playwright/test"

import type { TargetName } from "./targets.js"

// createConfig(): a flowreel run's Playwright config. The project supplies
// what differs (its projects, timeouts, browser, web server); flowreel fixes
// what must not: never a retry (a re-sent mail duplicates records, a re-run
// sign-in feeds the target's lockout counter), one worker, a trace, video
// and screenshot of everything, the run's evidence and HTML report in its
// own results folder (a shared report folder would keep only a pipeline's
// last stage), the project's summary reporter, and global setup paired with
// the teardown that signs every persona out (traces record the session
// cookie). Browsers do not close themselves on SIGTERM (`handleSIGTERM`
// off, unless a project sets it): a CI signals a job's whole process group,
// and a worker that closed its browser on the spot would lose the running
// test's video. The runner stops on SIGINT instead (the stage guard turns
// SIGTERM into one) and closes the browsers in its teardown, so the video
// is saved. SIGHUP keeps Playwright's default.

/** Browsers leave SIGTERM to the runner's graceful stop. */
const STOP_SIGNALS_TO_RUNNER = { handleSIGTERM: false }

type Project = NonNullable<PlaywrightTestConfig["projects"]>[number]
type Use = NonNullable<PlaywrightTestConfig["use"]>
type WebServer = Exclude<
  PlaywrightTestConfig["webServer"],
  unknown[] | undefined
>

/**
 * What a project supplies to createConfig(): the parts of the Playwright
 * config that differ per project. The fixed parts (no retries, one worker,
 * full evidence, global setup + teardown) are not inputs.
 */
export interface CreateConfigInput {
  target: TargetName
  baseURL: string
  /** The run's evidence folder (<results>/<RUN_ID>). */
  resultsDir: string
  /** The run's HTML report folder (inside resultsDir). */
  reportDir: string
  /** The project's summary reporter module, relative to the config file. */
  reporter: string
  /** Global setup / teardown modules, relative to the config file. */
  globalSetup: string
  globalTeardown: string
  testDir: string
  /** Per-test timeout (ms). */
  timeout: number
  projects: Project[]
  /** Files that are never tests (browser-free unit tests, say). */
  testIgnore?: string | string[]
  /** Recording: a fixed page size recorded at full size, or Playwright's default. */
  video: { on: boolean; size?: { width: number; height: number } }
  /** Browser slowMo for every project that does not set its own. */
  slowMo: number
  /** Extra `use` options (merged under flowreel's). */
  use?: Use
  /** The development stage's server (ignored on staging). */
  webServer?: WebServer
  /** Refuse test.only (default: on CI). */
  forbidOnly?: boolean
  /** Default 15 000 ms. */
  expectTimeout?: number
  /** Default 15 000 ms. */
  actionTimeout?: number
  /** Default 30 000 ms. */
  navigationTimeout?: number
}

/** The Playwright config of one flowreel run (pass it to Playwright's defineConfig). */
export function createConfig(input: CreateConfigInput): PlaywrightTestConfig {
  return {
    testDir: input.testDir,
    fullyParallel: false,
    forbidOnly: input.forbidOnly ?? !!process.env.CI,
    retries: 0,
    workers: 1,
    timeout: input.timeout,
    expect: { timeout: input.expectTimeout ?? 15_000 },
    outputDir: resolve(input.resultsDir, "test-results"),
    reporter: [
      ["list"],
      ["html", { open: "never", outputFolder: input.reportDir }],
      [input.reporter],
    ],
    globalSetup: input.globalSetup,
    globalTeardown: input.globalTeardown,
    use: {
      ...input.use,
      baseURL: input.baseURL,
      trace: "on",
      video:
        input.video.on && input.video.size
          ? { mode: "on", size: input.video.size }
          : "on",
      screenshot: "on",
      actionTimeout: input.actionTimeout ?? 15_000,
      navigationTimeout: input.navigationTimeout ?? 30_000,
      launchOptions: {
        ...STOP_SIGNALS_TO_RUNNER,
        ...input.use?.launchOptions,
        slowMo: input.slowMo,
      },
    },
    ...(input.testIgnore ? { testIgnore: input.testIgnore } : {}),
    // A project's own launchOptions replace the shared ones: keep the
    // signal settings in them too.
    projects: input.projects.map((project) =>
      project.use?.launchOptions
        ? {
            ...project,
            use: {
              ...project.use,
              launchOptions: {
                ...STOP_SIGNALS_TO_RUNNER,
                ...project.use.launchOptions,
              },
            },
          }
        : project,
    ),
    webServer: input.target === "local" ? input.webServer : undefined,
  }
}

/**
 * The local target's web server, as localWebServer() turns it into
 * Playwright's `webServer` entry (used only when the target is local).
 */
export interface LocalServerInput {
  /** The server's working directory, relative to the config file. */
  cwd: string
  port: number
  /** The command that starts the server on `port` (built by the project). */
  command: string
  /** A path that answers 200 once the server is up (default "/up"). */
  readyPath?: string
  baseURL: string
  /** Default 180 000 ms. */
  timeout?: number
  /**
   * Reuse an already running server: only when nothing per-run (a fresh
   * database) is in play and not on CI.
   */
  reuse: boolean
  env: Record<string, string>
}

/** The development stage's web server entry. */
export function localWebServer(input: LocalServerInput): WebServer {
  return {
    cwd: input.cwd,
    command: input.command,
    url: `${input.baseURL}${input.readyPath ?? "/up"}`,
    timeout: input.timeout ?? 180_000,
    reuseExistingServer: input.reuse,
    stdout: "ignore",
    stderr: "pipe",
    env: input.env,
  }
}
