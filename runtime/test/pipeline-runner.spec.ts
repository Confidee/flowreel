// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { expect, test } from "@playwright/test"

import {
  type DbIsolation,
  EXIT,
  type PipelineIo,
  type PipelineSpec,
  type StageRecord,
  type StopSignal,
  processIo,
  readUndoLedger,
  runPipeline,
  runPipelineCli,
  stageJson,
} from "../src/pipeline/index.js"
import { UndoLedger, fileUndoStore } from "../src/core/undo.js"
import { parsePace } from "../src/tour/policy.js"

// The pipeline runner's safety paths: the interrupt handler, the database
// copy's lifecycle on every exit, report files that cannot be written, the
// undo ledger read on its own, the CLI wrapper and the real process IO
// (driven by a fake spawn, never a real child).

interface Summary {
  verdict: string
  verdictReason?: string
  video?: unknown
  undo?: { manual?: unknown; total?: unknown }
}

type Mod = "gate" | "tour"

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function harness(
  dir: string,
  verdicts: Record<string, Summary | null>,
  extra: Partial<PipelineSpec<Mod, Summary>> = {},
  onChild?: (env: Record<string, string>) => void,
) {
  const lines: string[] = []
  const children: Record<string, string>[] = []
  const interrupts: ((signal?: StopSignal) => void)[] = []
  const exits: number[] = []
  let n = 0
  // The monotonic clock the signal de-duplication reads; tests advance it.
  const clock = { ms: 0 }
  const io: PipelineIo = {
    env: { PATH: "/bin", APP_SECRET_PW: "pw" },
    log: (l) => lines.push(l),
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, n++)),
    clock: () => clock.ms,
    onInterrupt: (handler) => interrupts.push(handler),
    exit: (code) => {
      exits.push(code)
      return undefined as never
    },
    runChild: (_args, env) => {
      children.push(env)
      onChild?.(env)
      const summary = verdicts[env.FLOWREEL_TARGET]
      if (summary) {
        mkdirSync(join(dir, env.FLOWREEL_RUN_ID), { recursive: true })
        writeFileSync(
          join(dir, env.FLOWREEL_RUN_ID, "summary.json"),
          JSON.stringify(summary),
        )
      }
      return Promise.resolve(summary?.verdict === "PASS" ? 0 : 1)
    },
  }
  let ids = 0
  const spec: PipelineSpec<Mod, Summary> = {
    modules: ["gate", "tour"],
    defaultModule: "gate",
    tourModules: ["tour"],
    parseAreas: (raw) => raw.split(","),
    parsePace: (raw) => parsePace(raw, "--pace"),
    isSecret: (name) => name.startsWith("APP_SECRET_"),
    repoRoot: dir,
    playwrightConfig: "flowreel.config.ts",
    usage: "usage: run",
    resultsDir: (id) => join(dir, id),
    makeRunId: (target) => `${target}-${++ids}`,
    makePipelineId: () => "pipe-1",
    stageInfo: {
      development: { title: "Development", detail: "local", target: "local" },
      staging: { title: "Staging", detail: "staging", target: "staging" },
    },
    projects: () => ["gate"],
    stagingConfigProblem: (env) =>
      env.APP_SECRET_PW ? null : "missing APP_SECRET_PW",
    report: { markdown: (doc) => `# ${doc.verdict}\n` },
    ...extra,
  }
  /** A second Ctrl-C, a second after the first (never a duplicate). */
  const later = (signal?: StopSignal) => {
    clock.ms += 1000
    interrupts[0](signal)
  }
  return { io, spec, lines, children, interrupts, exits, clock, later }
}

const PASS = { verdict: "PASS" }

test.describe("readUndoLedger", () => {
  test("null without a ledger; the summary when present", () => {
    const { dir, done } = tmp()
    try {
      expect(readUndoLedger(dir, "r1")).toBeNull()
      writeFileSync(
        join(dir, "undo.json"),
        JSON.stringify({
          runId: "r1",
          entries: [
            { id: "u1", seq: 1, status: "FAILED" },
            { id: "u2", seq: 2, status: "restored" },
          ],
        }),
      )
      expect(readUndoLedger(dir, "r1")).toMatchObject({
        total: 2,
        failed: 1,
        restored: 1,
      })
    } finally {
      done()
    }
  })

  // A damaged ledger must never read as "nothing to restore": that would
  // turn a crashed run's exit 4 into a pass.
  for (const [name, body] of [
    ["corrupt JSON", "{broken"],
    ["no entries list", JSON.stringify({ runId: "r1" })],
    ["entries not a list", JSON.stringify({ runId: "r1", entries: {} })],
  ] as const) {
    test(`an unreadable ledger (${name}) fails closed: one change needs a person`, () => {
      const { dir, done } = tmp()
      try {
        writeFileSync(join(dir, "undo.json"), body)
        const ledger = readUndoLedger(dir, "r1")
        expect(ledger).toMatchObject({ total: 1, failed: 1, restored: 0 })
        expect(ledger?.manual).toHaveLength(1)
        expect(ledger?.manual[0]).toMatchObject({
          status: "FAILED",
          what: "undo.json could not be read",
        })
        expect(ledger?.manual[0].manual).toContain(join(dir, "undo.json"))
      } finally {
        done()
      }
    })
  }

  test("a malformed entry counts as manual action, beside the readable ones", () => {
    const { dir, done } = tmp()
    try {
      writeFileSync(
        join(dir, "undo.json"),
        JSON.stringify({
          runId: "r1",
          entries: [null, { id: "u2", seq: 2, status: "restored" }],
        }),
      )
      expect(readUndoLedger(dir, "r1")).toMatchObject({
        total: 2,
        restored: 1,
        manual: [null],
      })
    } finally {
      done()
    }
  })
})

test.describe("--staging-only", () => {
  test("says there is nothing to run when staging is not configured, and exits 2", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, {})
      run.io.env = { PATH: "/bin" }
      expect(await runPipeline(["--staging-only"], run.spec, run.io)).toBe(
        EXIT.notConfigured,
      )
      expect(run.children).toEqual([])
      expect(run.lines).toContain(
        "staging is not configured (missing APP_SECRET_PW); nothing to run.",
      )
      const doc = JSON.parse(
        readFileSync(join(dir, "pipe-1", "pipeline.json"), "utf8"),
      ) as { stages: { stage: string; verdict: string; reason: string }[] }
      expect(doc.stages[0]).toMatchObject({
        stage: "development",
        verdict: "skipped",
        reason: "skipped (--staging-only)",
      })
      expect(doc.stages[1].verdict).toBe("not configured")
    } finally {
      done()
    }
  })

  test("runs staging alone when it is configured", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { staging: PASS })
      expect(await runPipeline(["--staging-only"], run.spec, run.io)).toBe(
        EXIT.pass,
      )
      expect(run.children.map((c) => c.FLOWREEL_TARGET)).toEqual(["staging"])
    } finally {
      done()
    }
  })
})

test.describe("Ctrl-C", () => {
  test("the first interrupt lets the stage finish and starts no staging", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, {}, () =>
        run.interrupts[0](),
      )
      // Development passed, but staging never ran: INCOMPLETE, never a PASS.
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.children.map((c) => c.FLOWREEL_TARGET)).toEqual(["local"])
      expect(run.lines).toContain(
        "interrupted: finishing the current stage's report, no next stage; press Ctrl-C again to stop now without waiting",
      )
      expect(run.lines).toContain("staging: not run (interrupted)")
      expect(run.exits).toEqual([])
    } finally {
      done()
    }
  })

  test("a second interrupt drops the live database copy before exiting 130", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const isolation: DbIsolation = {
        create: (key) => (events.push(`create ${key}`), { APP_DB: key }),
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      const run = harness(
        dir,
        { local: PASS },
        { db: { modules: ["tour"], isolation, keyPrefix: "t" } },
        () => {
          run.interrupts[0]()
          events.push("second Ctrl-C")
          run.later()
          events.push(`exit ${run.exits.join(",")}`)
        },
      )
      await runPipeline(["--module", "tour", "--local"], run.spec, run.io)
      const key = events[0].slice(7)
      expect(events.slice(0, 4)).toEqual([
        `create ${key}`,
        "second Ctrl-C",
        `drop ${key}`,
        "exit 130",
      ])
    } finally {
      done()
    }
  })

  test("with --keep-db a second interrupt exits without dropping anything", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const isolation: DbIsolation = {
        create: (key) => (events.push(`create ${key}`), { APP_DB: key }),
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      const run = harness(
        dir,
        { local: PASS },
        { db: { modules: ["tour"], isolation, keyPrefix: "t" } },
        () => {
          run.interrupts[0]()
          run.later()
        },
      )
      await runPipeline(
        ["--module", "tour", "--local", "--keep-db"],
        run.spec,
        run.io,
      )
      expect(run.exits).toEqual([130])
      expect(events.filter((e) => e.startsWith("drop"))).toEqual([])
    } finally {
      done()
    }
  })

  test("a copy that could not be dropped is still dropped by the second interrupt", async () => {
    const { dir, done } = tmp()
    try {
      const drops: string[] = []
      const isolation: DbIsolation = {
        create: (key) => ({ APP_DB: key }),
        drop: (key) => (drops.push(key), false),
      }
      const run = harness(
        dir,
        { local: PASS },
        { db: { modules: ["tour"], isolation, keyPrefix: "t" } },
        () => {
          run.interrupts[0]()
          run.later()
        },
      )
      await runPipeline(["--module", "tour", "--local"], run.spec, run.io)
      expect(run.exits[0]).toBe(130)
      // Handler attempt, then the finally block's attempt: drop never throws.
      expect(drops).toHaveLength(2)
      expect(drops[0]).toBe(drops[1])
    } finally {
      done()
    }
  })
})

test.describe("the database copy", () => {
  const isolation = (events: string[]): DbIsolation => ({
    create: (key) => (events.push(`create ${key}`), { APP_DB: key }),
    drop: (key) => (events.push(`drop ${key}`), true),
  })

  test("a copy that does not describe itself or give a drop command reads plainly", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const run = harness(
        dir,
        { local: PASS },
        {
          db: {
            modules: ["tour"],
            isolation: isolation(events),
            keyPrefix: "t",
            describe: () => null,
          },
        },
      )
      await runPipeline(
        ["--module", "tour", "--local", "--keep-db"],
        run.spec,
        run.io,
      )
      const key = events[0].slice(7)
      expect(run.lines).toContain(`development DB clone: ${key}`)
      expect(run.lines).toContain(
        `kept the development DB clone ${key} (--keep-db; drop it when done)`,
      )
    } finally {
      done()
    }
  })

  test("a non-Error failure of the copy fails development with its text; the copy is not dropped when none was made", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const run = harness(
        dir,
        {},
        {
          db: {
            modules: ["tour"],
            isolation: {
              create: () => {
                throw "no space left"
              },
              drop: (key) => (events.push(`drop ${key}`), true),
            },
            keyPrefix: "t",
          },
        },
      )
      expect(
        await runPipeline(["--module", "tour", "--local"], run.spec, run.io),
      ).toBe(EXIT.fail)
      expect(run.lines).toContain("development: FAIL (no space left)")
      expect(events).toEqual([])
    } finally {
      done()
    }
  })

  test("the copy is dropped even when the child blows up", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const run = harness(
        dir,
        {},
        {
          db: {
            modules: ["tour"],
            isolation: isolation(events),
            keyPrefix: "t",
          },
        },
      )
      run.io.runChild = () => Promise.reject(new Error("spawn exploded"))
      expect(
        await runPipeline(["--module", "tour", "--local"], run.spec, run.io),
      ).toBe(EXIT.fail)
      expect(run.lines).toContain("development: FAIL (spawn exploded)")
      expect(events.map((e) => e.split(" ")[0])).toEqual(["create", "drop"])
    } finally {
      done()
    }
  })
})

test.describe("reports", () => {
  test("a report that cannot be written is logged and never changes the exit code", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(
        dir,
        { local: PASS, staging: PASS },
        {
          report: {
            markdown: () => {
              throw "markdown exploded"
            },
            extras: () => ({ big: 1n }),
          },
        },
      )
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.pass)
      const failures = run.lines.filter((l) => l.startsWith("could not write"))
      expect(failures).toHaveLength(4)
      expect(failures[0]).toMatch(/^could not write pipeline\.json: .*BigInt/)
      expect(failures[1]).toBe("could not write pipeline.md: markdown exploded")
    } finally {
      done()
    }
  })

  test("an Error from the markdown hook is logged with its message", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(
        dir,
        { local: PASS },
        {
          report: {
            markdown: () => {
              throw new Error("template broke")
            },
          },
        },
      )
      await runPipeline(["--local"], run.spec, run.io)
      expect(run.lines).toContain("could not write pipeline.md: template broke")
    } finally {
      done()
    }
  })

  test("no composer: the video is not produced and says why; no closing lines", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      expect(await runPipeline(["--local"], run.spec, run.io)).toBe(EXIT.pass)
      const doc = JSON.parse(
        readFileSync(join(dir, "pipe-1", "pipeline.json"), "utf8"),
      ) as { video: unknown; narration: unknown }
      expect(doc.video).toEqual({
        produced: false,
        reason: "no video composer configured",
      })
      expect(doc.narration).toEqual({
        produced: false,
        reason: "composition did not finish",
      })
      expect(run.lines).toContain(
        "combined video: not produced (no video composer configured)",
      )
      expect(run.lines.at(-1)).toBe(
        "combined video: not produced (no video composer configured)",
      )
    } finally {
      done()
    }
  })

  test("--narration replaces every inherited narration name; --no-video forces video off", async () => {
    const { dir, done } = tmp()
    try {
      const envs: Record<string, string | undefined>[] = []
      const compose = (
        _r: unknown,
        env: Record<string, string | undefined>,
      ) => {
        envs.push(env)
        return Promise.resolve({ produced: false as const, reason: "x" })
      }
      const run = harness(
        dir,
        { local: PASS },
        { report: { markdown: () => "", compose } },
      )
      run.io.env = { PATH: "/bin", FLOWREEL_NARRATION: "off" }
      await runPipeline(["--local", "--narration", "on"], run.spec, run.io)
      expect(envs[0].FLOWREEL_NARRATION).toBe("on")
      expect(envs[0].PATH).toBe("/bin")

      const quiet = harness(
        dir,
        { local: PASS },
        { report: { markdown: () => "", compose } },
      )
      await runPipeline(["--local", "--no-video"], quiet.spec, quiet.io)
      expect(envs[1]).toEqual({ FLOWREEL_VIDEO: "off" })
    } finally {
      done()
    }
  })
})

test.describe("a runner that is not a UsageError", () => {
  test("an unexpected failure while parsing is rethrown, not turned into exit 64", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, {})
      Object.defineProperty(run.spec, "tourModules", {
        get() {
          throw new TypeError("spec is broken")
        },
      })
      await expect(runPipeline([], run.spec, run.io)).rejects.toThrow(
        "spec is broken",
      )
    } finally {
      done()
    }
  })
})

test.describe("stageJson", () => {
  const base: StageRecord<Summary> = {
    stage: "development",
    title: "Development",
    detail: "local",
    target: "local",
    result: { stage: "development", verdict: "PASS", reason: "" },
    runId: "r1",
    dir: "/repo/r1",
    summary: { verdict: "PASS" },
    ledger: null,
    startedAt: "2026-10-14T12:00:00.000Z",
    durationMs: 5,
    exitCode: 0,
  }
  const rel = (p: string) => p.replace("/repo/", "")

  test("undo counts: the summary's total, else the ledger's, else 0", () => {
    expect(
      stageJson(
        { ...base, summary: { verdict: "PASS", undo: { total: 3 } } },
        rel,
      ).undoChanges,
    ).toBe(3)
    expect(
      stageJson(
        {
          ...base,
          ledger: { total: 2, restored: 2, failed: 0, pending: 0, manual: [] },
        },
        rel,
      ).undoChanges,
    ).toBe(2)
    expect(stageJson(base, rel).undoChanges).toBe(0)
  })

  test("a video that was not produced is a note, not a path; a failed undo names undo.md", () => {
    const json = stageJson(
      {
        ...base,
        summary: {
          verdict: "PASS",
          video: { produced: false, reason: "no ffmpeg" },
        },
        result: { ...base.result, undoFailed: 1 },
      },
      rel,
    )
    expect(json.video).toBeNull()
    expect(json.videoNote).toBe("no ffmpeg")
    expect(json.undoFailed).toBe(1)
    expect(json.undoFile).toBe("r1/undo.md")
    expect(json.summary).toBe("r1/summary.md")
  })

  test("a stage that never ran has no paths", () => {
    const json = stageJson(
      { ...base, dir: null, runId: null, summary: null },
      rel,
    )
    expect(json).toMatchObject({
      resultsDir: null,
      summary: null,
      summaryJson: null,
      video: null,
      videoNote: null,
      undoFile: null,
    })
  })
})

test.describe("runPipelineCli", () => {
  test("exits with the pipeline's code", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      const codes = new Promise<number>((resolve) => {
        run.io.exit = (code) => {
          resolve(code)
          return undefined as never
        }
      })
      runPipelineCli(run.spec, ["--local"], run.io)
      expect(await codes).toBe(EXIT.pass)
    } finally {
      done()
    }
  })

  test("a crash of the runner is logged and exits 1; a non-Error crash too", async () => {
    const { dir, done } = tmp()
    const errors: string[] = []
    const original = console.error
    console.error = (l: string) => errors.push(String(l))
    try {
      for (const thrown of [new Error("id source down"), "just text"]) {
        const run = harness(
          dir,
          {},
          {
            makePipelineId: () => {
              throw thrown
            },
          },
        )
        const codes = new Promise<number>((resolve) => {
          run.io.exit = (code) => {
            resolve(code)
            return undefined as never
          }
        })
        runPipelineCli(run.spec, ["--local"], run.io)
        expect(await codes).toBe(EXIT.fail)
      }
    } finally {
      console.error = original
      done()
    }
    expect(errors).toEqual([
      "[pipeline] crashed: id source down",
      "[pipeline] crashed: just text",
    ])
  })
})

test.describe("processIo with a fake spawn", () => {
  function fakeSpawn() {
    const calls: { command: string; args: string[]; cwd?: string }[] = []
    const children: (EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    })[] = []
    const spawnFn = ((
      command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      calls.push({ command, args, cwd: options.cwd })
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      })
      children.push(child)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    return { spawnFn, calls, children }
  }

  function captureStreams() {
    const out: string[] = []
    const err: string[] = []
    const so = process.stdout.write
    const se = process.stderr.write
    process.stdout.write = ((t: string) => (out.push(String(t)), true)) as never
    process.stderr.write = ((t: string) => (err.push(String(t)), true)) as never
    return {
      out,
      err,
      restore() {
        process.stdout.write = so
        process.stderr.write = se
      },
    }
  }

  const LAUNCHER = {
    launcher: () => ({
      command: "/usr/bin/node",
      args: ["/repo/node_modules/@playwright/test/cli.js"],
      description: "node node_modules/@playwright/test/cli.js",
    }),
  }

  test("runs Playwright's CLI with node in the repo, says so, prefixes both streams line by line, resolves with the exit code", async () => {
    const fake = fakeSpawn()
    const io = processIo("pipe", fake.spawnFn, LAUNCHER)
    const capture = captureStreams()
    try {
      const done = io.runChild(["test"], { A: "1" }, "/repo", "[development]")
      const child = fake.children[0]
      child.stdout.write("one\ntw")
      child.stdout.write("o\nlast without newline")
      child.stderr.write("warn\n")
      child.stdout.end()
      child.stderr.end()
      await new Promise((r) => setImmediate(r))
      child.emit("close", 3)
      expect(await done).toBe(3)
    } finally {
      capture.restore()
    }
    expect(fake.calls).toEqual([
      {
        command: "/usr/bin/node",
        args: ["/repo/node_modules/@playwright/test/cli.js", "test"],
        cwd: "/repo",
      },
    ])
    expect(capture.out).toEqual([
      "[pipe] [development] playwright: node node_modules/@playwright/test/cli.js\n",
      "[development] one\n",
      "[development] two\n",
      "[development] last without newline\n",
    ])
    expect(capture.err).toEqual(["[development] warn\n"])
  })

  test("falls back to npx --no-install when the project's CLI cannot be resolved, and says so", async () => {
    const fake = fakeSpawn()
    // No package.json and no @playwright/test under this folder.
    const { dir, done } = tmp()
    const io = processIo("pipe", fake.spawnFn)
    const capture = captureStreams()
    try {
      const run = io.runChild(["test"], {}, dir, "[development]")
      fake.children[0].emit("close", 0)
      expect(await run).toBe(0)
    } finally {
      capture.restore()
      done()
    }
    expect(fake.calls[0]).toMatchObject({
      command: "npx",
      args: ["--no-install", "playwright", "test"],
    })
    expect(capture.out[0]).toContain(
      "playwright: npx --no-install playwright (@playwright/test/cli could not be resolved from the project)",
    )
  })

  test("a launcher with a problem starts nothing: the stage says why and resolves null", async () => {
    const fake = fakeSpawn()
    const io = processIo("pipe", fake.spawnFn, {
      launcher: () => ({
        command: "npx",
        args: [],
        description: "none",
        problem: "install @playwright/test",
      }),
    })
    const capture = captureStreams()
    let code: number | null | undefined
    try {
      code = await io.runChild(["test"], {}, "/repo", "[development]")
    } finally {
      capture.restore()
    }
    expect(code).toBeNull()
    expect(fake.calls).toEqual([])
    expect(capture.err).toEqual([
      "[development] could not start: install @playwright/test\n",
    ])
  })

  test("a signal-killed child resolves null; a child that cannot start says so and resolves null", async () => {
    const fake = fakeSpawn()
    const io = processIo("pipe", fake.spawnFn, LAUNCHER)
    const capture = captureStreams()
    let killed: number | null | undefined
    let failed: number | null | undefined
    try {
      const a = io.runChild([], {}, "/repo", "[staging]")
      fake.children[0].emit("close", null)
      killed = await a
      const b = io.runChild([], {}, "/repo", "[staging]")
      fake.children[1].emit("error", new Error("spawn node ENOENT"))
      failed = await b
    } finally {
      capture.restore()
    }
    expect(killed).toBeNull()
    expect(failed).toBeNull()
    expect(capture.err).toEqual([
      "[staging] could not start: spawn node ENOENT\n",
    ])
  })

  /**
   * The listeners `register` added for each signal (and the output error
   * listeners on stdout/stderr), all removed again after.
   */
  function addedListeners(
    register: () => void,
  ): Record<string, ((...args: unknown[]) => void)[]> {
    const signals: NodeJS.Signals[] = [
      "SIGINT",
      "SIGTERM",
      "SIGBREAK",
      "SIGHUP",
    ]
    const streams = { stdout: process.stdout, stderr: process.stderr }
    const before = Object.fromEntries([
      ...signals.map((s) => [s, process.listeners(s)]),
      ...Object.entries(streams).map(([n, st]) => [n, st.listeners("error")]),
    ])
    register()
    const added: Record<string, ((...args: unknown[]) => void)[]> = {}
    for (const s of signals) {
      const fresh = process.listeners(s).filter((l) => !before[s].includes(l))
      for (const l of fresh) process.off(s, l)
      added[s] = fresh as unknown as ((...args: unknown[]) => void)[]
    }
    for (const [n, st] of Object.entries(streams)) {
      added[n] = st
        .listeners("error")
        .filter((l) => !before[n].includes(l)) as ((
        ...args: unknown[]
      ) => void)[]
      for (const l of added[n]) st.off("error", l as never)
    }
    return added
  }

  test("log prefixes with the command name; env is the process env; SIGINT, SIGTERM and exit are wired", () => {
    const io = processIo("my-run", fakeSpawn().spawnFn)
    const logs: string[] = []
    const original = console.log
    console.log = (l: string) => logs.push(String(l))
    try {
      io.log("hello")
    } finally {
      console.log = original
    }
    expect(logs).toEqual(["[my-run] hello"])
    expect(io.env).toBe(process.env)
    expect(io.now()).toBeInstanceOf(Date)
    expect(io.pid).toBe(process.pid)
    expect(typeof io.clock?.()).toBe("number")

    const got: (string | undefined)[] = []
    const added = addedListeners(() =>
      io.onInterrupt((signal) => got.push(signal)),
    )
    expect(added.SIGINT).toHaveLength(1)
    expect(added.SIGTERM).toHaveLength(1)
    // No terminal: SIGHUP keeps its default (nohup works).
    expect(added.SIGHUP).toHaveLength(0)
    added.SIGINT[0]()
    added.SIGTERM[0]()
    expect(got).toEqual(["SIGINT", "SIGTERM"])

    const realExit = process.exit
    let code: number | undefined
    process.exit = ((c: number) => {
      code = c
    }) as never
    try {
      io.exit(7)
    } finally {
      process.exit = realExit
    }
    expect(code).toBe(7)
  })

  test("on Windows Ctrl-Break is a stop signal too, and the stage is never signalled", async () => {
    const fake = fakeSpawn()
    const io = processIo("pipe", fake.spawnFn, {
      ...LAUNCHER,
      platform: "win32",
      interactive: true,
    })
    expect(io.interactive).toBe(true)
    const got: (string | undefined)[] = []
    const added = addedListeners(() =>
      io.onInterrupt((signal) => got.push(signal)),
    )
    added.SIGBREAK[0]()
    // In a terminal, a hangup is a stop request too.
    added.SIGHUP[0]()
    expect(got).toEqual(["SIGBREAK", "SIGHUP"])
    // A closed terminal's output errors never crash the pipeline; others do.
    for (const stream of ["stdout", "stderr"]) {
      expect(added[stream]).toHaveLength(1)
      const onError = added[stream][0]
      for (const code of ["EPIPE", "EIO", "ERR_STREAM_DESTROYED"]) {
        onError(Object.assign(new Error(code), { code }))
      }
      expect(() => onError(new Error("disk full"))).toThrow("disk full")
    }
    const capture = captureStreams()
    try {
      const run = io.runChild(["test"], {}, "/repo", "[development]")
      const kills: string[] = []
      Object.assign(fake.children[0], {
        kill: (signal: string) => (kills.push(signal), true),
      })
      expect(io.interruptChild?.()).toBe(false)
      expect(kills).toEqual([])
      fake.children[0].emit("close", 0)
      await run
    } finally {
      capture.restore()
    }
  })

  test("interruptChild sends SIGINT to the running stage; waitForChild and killChild", async () => {
    const fake = fakeSpawn()
    const io = processIo("pipe", fake.spawnFn, {
      ...LAUNCHER,
      platform: "linux",
    })
    // No stage: nothing to signal, nothing to wait for, nothing to kill.
    expect(io.interruptChild?.()).toBe(false)
    expect(await io.waitForChild?.(10)).toBe(true)
    io.killChild?.()
    const capture = captureStreams()
    try {
      const run = io.runChild(["test"], {}, "/repo", "[development]")
      const kills: string[] = []
      Object.assign(fake.children[0], {
        kill: (signal: string) => {
          kills.push(signal)
          if (signal === "SIGKILL") throw new Error("already gone")
          return true
        },
      })
      expect(io.interruptChild?.()).toBe(true)
      // Still running: the wait times out.
      expect(await io.waitForChild?.(5)).toBe(false)
      io.killChild?.()
      expect(kills).toEqual(["SIGINT", "SIGKILL"])
      const waiting = io.waitForChild?.(5000)
      fake.children[0].emit("close", null)
      expect(await waiting).toBe(true)
      expect(await run).toBeNull()
      // A child whose kill throws is reported as not signalled.
      const second = io.runChild(["test"], {}, "/repo", "[development]")
      Object.assign(fake.children[1], {
        kill: () => {
          throw new Error("EPERM")
        },
      })
      expect(io.interruptChild?.()).toBe(false)
      fake.children[1].emit("close", 1)
      expect(await second).toBe(1)
    } finally {
      capture.restore()
    }
  })

  test("schedule runs once after the delay, can be cancelled, and ignores delays beyond a timer's range", async () => {
    const io = processIo("pipe", fakeSpawn().spawnFn)
    const fired: string[] = []
    io.schedule?.(1, () => fired.push("a"))
    const cancel = io.schedule?.(1, () => fired.push("b"))
    cancel?.()
    io.schedule?.(2 ** 31, () => fired.push("never"))()
    await new Promise((r) => setTimeout(r, 30))
    expect(fired).toEqual(["a"])
  })
})

test.describe("the write-ahead ledger decides the exit when the child dies", () => {
  test("an entry left pending by a killed child is exit 4 even with a PASS-looking exit", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, {}, {}, (env) => {
        const ledger = new UndoLedger(
          fileUndoStore(join(dir, env.FLOWREEL_RUN_ID), env.FLOWREEL_RUN_ID),
          () => ({}),
        )
        void ledger.change("A1", {
          what: "a setting",
          before: 1,
          manual: "put it back",
          restore: () => Promise.resolve(),
        })
      })
      run.io.runChild = (
        (orig) =>
        (
          args: string[],
          env: Record<string, string>,
          cwd: string,
          prefix: string,
        ) =>
          orig(args, env, cwd, prefix).then(() => null)
      )(run.io.runChild)
      expect(await runPipeline(["--local"], run.spec, run.io)).toBe(
        EXIT.undoFailed,
      )
      expect(
        run.lines.some((l) => l.startsWith("development: UNDO FAILED, 1 ")),
      ).toBe(true)
    } finally {
      done()
    }
  })
})
