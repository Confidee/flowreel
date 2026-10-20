// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import { UndoLedger, fileUndoStore } from "../src/core/undo.js"
import {
  ABORTED_REASON,
  type DbIsolation,
  EXIT,
  type PipelineDocument,
  type PipelineIo,
  type PipelineSpec,
  STOP_REASONS,
  type StopSignal,
  UsageError,
  deadlineAt,
  developmentDecision,
  parseDeadline,
  parsePipelineArgs,
  pipelineOutcome,
  playwrightLauncher,
  resolvePlaywrightCli,
  runPipeline,
  stageEnv,
  stagingDecision,
} from "../src/pipeline/index.js"
import { parsePace } from "../src/tour/policy.js"
import { mediaSignal } from "../src/video/stop.js"

// How the pipeline stops: the deadline's parsing, the stop causes in the
// gate, the write-ahead pipeline.json, the signal rules (duplicates, a
// SIGTERM after the first stop, a forced second Ctrl-C), the --deadline at
// every point of a run, and how a stage's Playwright is started. Driven by
// a scripted io (no real child, no real timer).

interface Summary {
  verdict: string
  verdictReason?: string
}

type Mod = "gate" | "tour"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-stop-"))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const PASS = { verdict: "PASS" }

/** A scripted pipeline: `during` runs inside each stage's child. */
function harness(
  dir: string,
  verdicts: Record<string, Summary | null>,
  during?: (env: Record<string, string>, run: Harness) => void,
  extra: Partial<PipelineSpec<Mod, Summary>> = {},
) {
  const lines: string[] = []
  const children: Record<string, string>[] = []
  const interrupts: ((signal?: StopSignal) => void)[] = []
  const exits: number[] = []
  const childSignals: string[] = []
  const scheduled: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const docs: PipelineDocument[] = []
  let seconds = 0
  const clock = { ms: 0 }
  const io: PipelineIo = {
    env: { PATH: "/bin", APP_SECRET_PW: "pw" },
    log: (l) => {
      lines.push(l)
      run.onLog?.(l)
    },
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, seconds++)),
    clock: () => clock.ms,
    onInterrupt: (handler) => interrupts.push(handler),
    interruptChild: () => (childSignals.push("SIGINT"), true),
    exit: (code) => {
      exits.push(code)
      return undefined as never
    },
    schedule: (ms, fn) => {
      const entry = { ms, fn, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    runChild: (_args, env) => {
      children.push(env)
      const summary = verdicts[env.FLOWREEL_TARGET]
      if (summary) {
        mkdirSync(join(dir, env.FLOWREEL_RUN_ID), { recursive: true })
        writeFileSync(
          join(dir, env.FLOWREEL_RUN_ID, "summary.json"),
          JSON.stringify(summary),
        )
      }
      during?.(env, run)
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
    report: {
      markdown: (doc) => `# ${doc.verdict} (${doc.status})\n`,
      compose: () =>
        Promise.resolve({ produced: false, reason: "composed (fake)" }),
    },
    ...extra,
  }
  const pipelineJson = () =>
    JSON.parse(
      readFileSync(join(dir, "pipe-1", "pipeline.json"), "utf8"),
    ) as PipelineDocument
  const run = {
    io,
    spec,
    lines,
    children,
    interrupts,
    exits,
    childSignals,
    scheduled,
    docs,
    clock,
    pipelineJson,
    /** Called with every log line (to act between stages). */
    onLog: undefined as ((line: string) => void) | undefined,
    /** A signal `ms` after the previous one (default: a second later). */
    signal(signal: StopSignal = "SIGINT", ms = 1000) {
      clock.ms += ms
      interrupts[0](signal)
    },
    /** Fires the deadline's timer. */
    deadline() {
      const entry = scheduled[scheduled.length - 1]
      expect(entry, "a deadline timer").toBeDefined()
      entry.fn()
    },
    /** Remembers the pipeline.json on disk now. */
    snapshot() {
      docs.push(pipelineJson())
    },
  }
  return run
}
type Harness = ReturnType<typeof harness>

test.describe("parseDeadline", () => {
  test("durations from the start, in ms, s, m or h; plain numbers are milliseconds", () => {
    expect(parseDeadline("90s")).toEqual({
      kind: "in",
      ms: 90_000,
      label: "90s",
    })
    expect(parseDeadline(" 25m ")).toMatchObject({ kind: "in", ms: 1_500_000 })
    expect(parseDeadline("1.5h")).toMatchObject({ ms: 5_400_000 })
    expect(parseDeadline("1H")).toMatchObject({ ms: 3_600_000 })
    expect(parseDeadline("500ms")).toMatchObject({ ms: 500 })
    expect(parseDeadline("90000")).toMatchObject({ kind: "in", ms: 90_000 })
  })

  test("absolute times: an ISO time with a zone, or epoch milliseconds", () => {
    expect(parseDeadline("2026-10-19T12:30:00Z")).toEqual({
      kind: "at",
      epochMs: Date.parse("2026-10-19T12:30:00Z"),
      label: "2026-10-19T12:30:00Z",
    })
    expect(parseDeadline("2026-10-19T14:30:00+02:00")).toMatchObject({
      epochMs: Date.parse("2026-10-19T12:30:00Z"),
    })
    expect(parseDeadline("1792411200000")).toEqual({
      kind: "at",
      epochMs: 1_792_411_200_000,
      label: "1792411200000",
    })
  })

  test("anything else is a usage error naming its source", () => {
    const refused: [string, string | undefined, string][] = [
      ["0", undefined, '--deadline must be more than zero (got "0").'],
      ["0s", "FLOWREEL_DEADLINE", "FLOWREEL_DEADLINE must be more than zero"],
      [
        "2026-10-19T12:30:00",
        undefined,
        "--deadline needs a zone on an ISO time (e.g. 2026-10-19T12:30:00Z or 2026-10-19T12:30:00+02:00).",
      ],
      ["2026-13-45T99:00:00Z", undefined, "--deadline needs a duration"],
      ["soon", "CI_DEADLINE", "CI_DEADLINE needs a duration from the start"],
      ["-5m", undefined, 'got "-5m"'],
      ["25 minutes", undefined, 'got "25 minutes"'],
    ]
    for (const [raw, source, message] of refused) {
      let error: unknown
      try {
        parseDeadline(raw, source)
      } catch (e) {
        error = e
      }
      expect(error, raw).toBeInstanceOf(UsageError)
      expect((error as Error).message).toContain(message)
    }
  })

  test("deadlineAt: a duration counts from the start, a time is itself", () => {
    expect(deadlineAt(parseDeadline("90s"), 1000)).toBe(91_000)
    expect(deadlineAt(parseDeadline("1792411200000"), 1000)).toBe(
      1_792_411_200_000,
    )
  })

  test("--deadline on the command line, inline or not; a missing value is refused", () => {
    const spec = {
      modules: ["gate"] as const,
      defaultModule: "gate" as const,
      tourModules: [] as const,
      parseAreas: () => [],
      parsePace: () => "qa" as const,
    }
    expect(parsePipelineArgs(["--deadline", "25m"], spec).deadline).toEqual({
      kind: "in",
      ms: 1_500_000,
      label: "25m",
    })
    expect(parsePipelineArgs(["--deadline=90s"], spec).deadline).toMatchObject({
      ms: 90_000,
    })
    for (const argv of [["--deadline"], ["--deadline", "--local"]]) {
      expect(() => parsePipelineArgs(argv, spec)).toThrow(
        "--deadline needs a duration or a time (e.g. --deadline 25m).",
      )
    }
  })
})

test.describe("stop causes in the gate", () => {
  const dev = { stage: "development" as const, verdict: "PASS" as const }

  test("a stop before development runs nothing; --staging-only still skips", () => {
    expect(developmentDecision({ stagingOnly: false }, "deadline")).toEqual({
      run: false,
      result: {
        stage: "development",
        verdict: "not run",
        reason: "not run (deadline reached)",
      },
    })
    expect(developmentDecision({ stagingOnly: false }, true)).toMatchObject({
      result: { reason: "not run (interrupted)" },
    })
    expect(
      developmentDecision({ stagingOnly: true }, "deadline"),
    ).toMatchObject({ result: { verdict: "skipped" } })
    expect(developmentDecision({ stagingOnly: false })).toEqual({ run: true })
  })

  test("staging records which stop kept it from running", () => {
    const options = { local: false, stagingOnly: false }
    expect(
      stagingDecision(options, { ...dev, reason: "" }, null, "deadline"),
    ).toMatchObject({ result: { reason: STOP_REASONS.deadline } })
    expect(
      stagingDecision(options, { ...dev, reason: "" }, null, "interrupted"),
    ).toMatchObject({ result: { reason: STOP_REASONS.interrupted } })
  })

  test("outcomes: a deadline or an abort is INCOMPLETE 130; FAIL and an undo failure still outrank it", () => {
    const s = (
      stage: "development" | "staging",
      verdict: string,
      reason = "",
    ) =>
      ({ stage, verdict, reason }) as Parameters<
        typeof pipelineOutcome
      >[0][number]
    expect(
      pipelineOutcome([
        s("development", "PASS"),
        s("staging", "not run", STOP_REASONS.deadline),
      ]),
    ).toEqual({
      verdict: "INCOMPLETE",
      reason: "development passed; deadline reached before staging.",
      exitCode: EXIT.interrupted,
    })
    expect(
      pipelineOutcome([
        s("development", "not run", STOP_REASONS.deadline),
        s("staging", "not run", STOP_REASONS.deadline),
      ]).reason,
    ).toBe("Deadline reached before development.")
    expect(
      pipelineOutcome([
        s("development", "not run", ABORTED_REASON),
        s("staging", "not run", STOP_REASONS.interrupted),
      ]).reason,
    ).toBe("Aborted by a second Ctrl-C during development.")
    expect(
      pipelineOutcome([
        s("development", "FAIL"),
        s("staging", "not run", STOP_REASONS.deadline),
      ]).exitCode,
    ).toBe(EXIT.fail)
    expect(
      pipelineOutcome([
        { ...s("development", "not run", ABORTED_REASON), undoFailed: 1 },
        s("staging", "not run", STOP_REASONS.interrupted),
      ]).exitCode,
    ).toBe(EXIT.undoFailed)
  })
})

test.describe("each stage hears about the pipeline", () => {
  test("the pipeline's pid, hangup mode and deadline are set, never inherited", () => {
    const base = {
      PATH: "/bin",
      FLOWREEL_PIPELINE_PID: "1",
      FLOWREEL_HUP: "graceful",
      FLOWREEL_DEADLINE: "5m",
      FLOWREEL_DEADLINE_AT: "1",
    }
    const spec = { isSecret: () => false }
    const options = { headed: false, video: true }
    expect(stageEnv("development", "r1", base, options, spec)).toEqual({
      PATH: "/bin",
      FLOWREEL_TARGET: "local",
      FLOWREEL_RUN_ID: "r1",
      FLOWREEL_MODULE: "",
    })
    expect(
      stageEnv("staging", "r2", base, options, spec, {}, "gate", {
        pipelinePid: 4242,
        gracefulHangup: true,
        deadlineAt: 1_792_411_200_000.4,
      }),
    ).toEqual({
      PATH: "/bin",
      FLOWREEL_TARGET: "staging",
      FLOWREEL_RUN_ID: "r2",
      FLOWREEL_MODULE: "gate",
      FLOWREEL_PIPELINE_PID: "4242",
      FLOWREEL_HUP: "graceful",
      FLOWREEL_DEADLINE_AT: "1792411200000",
    })
    expect(
      stageEnv("staging", "r2", base, options, spec, {}, "gate", {
        gracefulHangup: false,
        deadlineAt: null,
      }),
    ).not.toHaveProperty("FLOWREEL_HUP")
  })
})

test.describe("how a stage's Playwright starts", () => {
  test("node with the project's own @playwright/test CLI, else npx --no-install", () => {
    const found = playwrightLauncher("/repo", "/opt/node", () =>
      join("/repo", "node_modules", "@playwright", "test", "cli.js"),
    )
    expect(found).toEqual({
      command: "/opt/node",
      args: [join("/repo", "node_modules", "@playwright", "test", "cli.js")],
      description: `node ${join("node_modules", "@playwright", "test", "cli.js")}`,
    })
    // Windows: npx is a .cmd that needs a shell; flowreel says what is missing.
    expect(
      playwrightLauncher("/repo", "/opt/node", () => null, "win32"),
    ).toMatchObject({
      problem:
        "@playwright/test/cli could not be resolved from the project; install @playwright/test there (on Windows flowreel does not fall back to npx)",
    })
    expect(
      playwrightLauncher("/repo", "/opt/node", () => null, "linux"),
    ).toEqual({
      command: "npx",
      args: ["--no-install", "playwright"],
      description:
        "npx --no-install playwright (@playwright/test/cli could not be resolved from the project)",
    })
  })

  test("resolves the CLI from the project's own node_modules", () => {
    const cli = resolvePlaywrightCli(ROOT)
    expect(cli).toMatch(/@playwright[\\/]test[\\/]cli\.js$/)
    expect(playwrightLauncher(ROOT).command).toBe(process.execPath)
    const { dir, done } = tmp()
    try {
      expect(resolvePlaywrightCli(dir)).toBeNull()
    } finally {
      done()
    }
  })
})

test.describe("the write-ahead pipeline.json", () => {
  test("says running (with the running stage's folder) while a stage runs, then finished; no temporary file is left", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) =>
        h.snapshot(),
      )
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.pass)
      const [during] = run.docs
      expect(during).toMatchObject({
        status: "running",
        stoppedBy: null,
        verdict: "INCOMPLETE",
        verdictReason: "Running development.",
        exitCode: EXIT.interrupted,
        finishedAt: null,
        video: { produced: false, reason: "the pipeline has not finished" },
      })
      expect(during.stages[0]).toMatchObject({
        stage: "development",
        verdict: "not run",
        reason: "running",
        runId: "local-1",
        resultsDir: "local-1",
        summary: null,
      })
      expect(during.stages[0].startedAt).not.toBeNull()
      expect(during.stages[1]).toMatchObject({
        stage: "staging",
        reason: "pending",
        runId: null,
      })
      // During staging: development's result is already recorded.
      expect(run.docs[1].stages[0]).toMatchObject({ verdict: "PASS" })
      expect(run.docs[1].stages[1]).toMatchObject({ reason: "running" })
      const final = run.pipelineJson()
      expect(final).toMatchObject({
        status: "finished",
        verdict: "PASS",
        exitCode: EXIT.pass,
      })
      expect(final.finishedAt).not.toBeNull()
      expect(
        readdirSync(join(dir, "pipe-1")).filter((f) => f.endsWith(".tmp")),
      ).toEqual([])
    } finally {
      done()
    }
  })

  test("is written before the first stage starts, so a pipeline killed there still says running", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      let before: PipelineDocument | null = null
      run.spec.stagingConfigProblem = () => {
        before = run.pipelineJson()
        return null
      }
      await runPipeline([], run.spec, run.io)
      expect(before).toMatchObject({
        status: "running",
        verdictReason: "Running.",
        stages: [{ reason: "pending" }, { reason: "pending" }],
      })
    } finally {
      done()
    }
  })
})

test.describe("stop signals", () => {
  test("a first Ctrl-C stops the stage (SIGINT), says how to force, writes stopping, then finishes", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGINT")
        h.snapshot()
      })
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.childSignals).toEqual(["SIGINT"])
      expect(run.lines).toContain(
        "interrupted: finishing the current stage's report, no next stage; press Ctrl-C again to stop now without waiting",
      )
      expect(run.docs[0]).toMatchObject({
        status: "stopping",
        stoppedBy: "Ctrl-C (SIGINT)",
        verdictReason: "Stopping (Ctrl-C (SIGINT)): no further stage starts.",
        stages: [{ reason: "stopping" }, { reason: "pending" }],
      })
      expect(run.pipelineJson()).toMatchObject({
        status: "finished",
        stoppedBy: "Ctrl-C (SIGINT)",
        verdict: "INCOMPLETE",
        verdictReason: "development passed; interrupted before staging.",
        video: {
          produced: false,
          reason: "skipped: the pipeline was interrupted",
        },
      })
      expect(run.exits).toEqual([])
    } finally {
      done()
    }
  })

  test("SIGTERM stops like a first Ctrl-C without the hint; a later SIGTERM never forces", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGTERM")
        h.signal("SIGTERM", 2500)
      })
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.childSignals).toEqual(["SIGINT"])
      expect(run.lines).toContain(
        "SIGTERM: finishing the current stage's report, no next stage",
      )
      expect(run.lines).toContain(
        "SIGTERM after the stop request: still finishing the stage's report; a kill may follow",
      )
      expect(run.exits).toEqual([])
      expect(run.pipelineJson()).toMatchObject({
        status: "finished",
        stoppedBy: "SIGTERM",
      })
    } finally {
      done()
    }
  })

  test("a CI's SIGINT, then SIGTERM 7.5 s later, still finishes the stage's report", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGINT")
        h.signal("SIGTERM", 7500)
      })
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.exits).toEqual([])
      expect(run.pipelineJson().status).toBe("finished")
    } finally {
      done()
    }
  })

  test("the same signal within 200 ms is one delivery; another signal with the first is part of it", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGINT")
        h.signal("SIGINT", 5)
        h.signal("SIGINT", 150)
        h.signal("SIGTERM", 10)
        h.signal("SIGINT", 20)
      })
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.childSignals).toEqual(["SIGINT"])
      expect(run.exits).toEqual([])
      // The SIGTERM was not a duplicate of the SIGINT: it is said.
      expect(
        run.lines.filter((l) => l.startsWith("SIGTERM after the stop request")),
      ).toHaveLength(1)
    } finally {
      done()
    }
  })

  test("a SIGINT within 200 ms of a first SIGTERM is part of it, not a force", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS }, (_env, h) => {
        h.signal("SIGTERM")
        h.signal("SIGINT", 30)
      })
      await runPipeline(["--local"], run.spec, run.io)
      expect(run.exits).toEqual([])
    } finally {
      done()
    }
  })

  test("Ctrl-Break (Windows) stops like Ctrl-C; a second one forces", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS }, (_env, h) => {
        h.signal("SIGBREAK")
        h.signal("SIGBREAK", 400)
      })
      await runPipeline(["--local"], run.spec, run.io)
      expect(run.lines).toContain(
        "interrupted: finishing the current stage's report, no next stage; press Ctrl-C again to stop now without waiting",
      )
      expect(run.exits).toEqual([EXIT.interrupted])
      expect(run.pipelineJson()).toMatchObject({
        status: "aborted",
        stoppedBy: "Ctrl-Break (SIGBREAK), then a second Ctrl-C",
      })
    } finally {
      done()
    }
  })

  test("a call without a signal is a Ctrl-C; a stop between stages starts no further stage", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      run.onLog = (line) => {
        if (line === "development: PASS") run.interrupts[0]()
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.children).toHaveLength(1)
      expect(run.childSignals).toEqual([])
      expect(run.lines).toContain(
        "interrupted: no further stage; press Ctrl-C again to stop now without waiting",
      )
    } finally {
      done()
    }
  })

  test("a stop while the database copy is made starts no stage, and the copy is dropped", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      let run: Harness
      const isolation: DbIsolation = {
        create: (key) => {
          run.interrupts[0]("SIGTERM")
          return { APP_DB: key }
        },
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      run = harness(dir, { local: PASS }, undefined, {
        db: { modules: ["tour"], isolation, keyPrefix: "t" },
      })
      expect(
        await runPipeline(["--module", "tour", "--local"], run.spec, run.io),
      ).toBe(EXIT.interrupted)
      expect(run.children).toEqual([])
      expect(events).toHaveLength(1)
      expect(run.pipelineJson().stages[0]).toMatchObject({
        verdict: "not run",
        reason: "not run (interrupted)",
      })
    } finally {
      done()
    }
  })
})

test.describe("a second Ctrl-C", () => {
  test("writes the final files, waits for the stage, kills it if it lingers, drops the copy and exits 130", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const isolation: DbIsolation = {
        create: (key) => ({ APP_DB: key }),
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      let release: (code: number | null) => void = () => undefined
      const run = harness(dir, {}, undefined, {
        db: { modules: ["tour"], isolation, keyPrefix: "t" },
      })
      const waits: number[] = []
      run.io.waitForChild = (ms) => {
        waits.push(ms)
        events.push("waited")
        return Promise.resolve(false)
      }
      run.io.killChild = () => {
        events.push("killed")
        release(null)
      }
      run.io.runChild = (_args, env) => {
        run.children.push(env)
        run.signal("SIGINT")
        run.signal("SIGINT", 300)
        events.push(`files: ${run.pipelineJson().status}`)
        return new Promise((resolve) => {
          release = resolve
        })
      }
      run.io.exit = (code) => {
        events.push(`exit ${code}`)
        return undefined as never
      }
      expect(
        await runPipeline(["--module", "tour", "--local"], run.spec, run.io),
      ).toBe(EXIT.interrupted)
      expect(waits).toEqual([3000])
      // The final files are on disk before the wait starts.
      expect(events.slice(0, 3)).toEqual(["waited", "files: aborted", "killed"])
      expect(events.slice(3)).toEqual([
        expect.stringMatching(/^drop t/),
        "exit 130",
      ])
      expect(run.lines).toContain(
        "second Ctrl-C: stopping now, without waiting for the development stage's report",
      )
      expect(run.lines).toContain(
        "the development stage did not stop within 3 s: killing it",
      )
      const doc = run.pipelineJson()
      expect(doc).toMatchObject({
        status: "aborted",
        stoppedBy: "Ctrl-C (SIGINT), then a second Ctrl-C",
        verdict: "INCOMPLETE",
        verdictReason: "Aborted by a second Ctrl-C during development.",
        exitCode: EXIT.interrupted,
        video: {
          produced: false,
          reason: "skipped: aborted by a second Ctrl-C",
        },
      })
      expect(doc.finishedAt).not.toBeNull()
      expect(doc.stages[0]).toMatchObject({
        verdict: "not run",
        reason: ABORTED_REASON,
        runId: "local-1",
      })
      expect(doc.stages[1]).toMatchObject({ reason: "skipped (--local)" })
      expect(readFileSync(join(dir, "pipe-1", "pipeline.md"), "utf8")).toBe(
        "# INCOMPLETE (aborted)\n",
      )
    } finally {
      done()
    }
  })

  test("a stage that closes in time is not killed", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGINT")
        h.signal("SIGINT")
      })
      const kills: string[] = []
      run.io.waitForChild = () => Promise.resolve(true)
      run.io.killChild = () => kills.push("SIGKILL")
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(kills).toEqual([])
      expect(run.exits).toEqual([EXIT.interrupted])
      // Later signals change nothing once aborted.
      run.signal("SIGINT")
      expect(run.exits).toEqual([EXIT.interrupted])
    } finally {
      done()
    }
  })

  test("a restore the abort leaves pending outranks it: exit 4", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, {}, (env, h) => {
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
        h.signal("SIGINT")
        h.signal("SIGINT")
      })
      expect(await runPipeline(["--local"], run.spec, run.io)).toBe(
        EXIT.undoFailed,
      )
      expect(run.exits).toEqual([EXIT.undoFailed])
      expect(run.pipelineJson()).toMatchObject({
        status: "aborted",
        exitCode: EXIT.undoFailed,
        stages: [{ reason: ABORTED_REASON, undoFailed: 1 }, {}],
      })
    } finally {
      done()
    }
  })

  test("during the combined video, after every stage passed: INCOMPLETE, never a pass", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      run.spec.report.compose = () => {
        run.signal("SIGINT")
        run.signal("SIGINT")
        return Promise.resolve({ produced: false, reason: "stopped" })
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.lines).toContain("second Ctrl-C: stopping now")
      expect(run.pipelineJson()).toMatchObject({
        status: "aborted",
        verdict: "INCOMPLETE",
        verdictReason:
          "development, staging passed. The pipeline was aborted by a second Ctrl-C before it finished.",
        exitCode: EXIT.interrupted,
      })
    } finally {
      done()
    }
  })

  test("between stages: development's verdict stands; staging was never started", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: { verdict: "FAIL" }, staging: PASS })
      run.onLog = (line) => {
        if (line.startsWith("development: FAIL")) {
          run.signal("SIGINT")
          run.signal("SIGINT")
        }
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.fail)
      expect(run.exits).toEqual([EXIT.fail])
      expect(run.pipelineJson().stages[1]).toMatchObject({
        reason: "not run (interrupted)",
      })
    } finally {
      done()
    }
  })

  test("before development started: development reads as not run (aborted)", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      run.spec.stagingConfigProblem = () => {
        run.signal("SIGINT")
        run.signal("SIGINT")
        return null
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.children).toEqual([])
      expect(run.pipelineJson().stages[0]).toMatchObject({
        reason: `not run (${ABORTED_REASON})`,
      })
    } finally {
      done()
    }
  })
})

test.describe("--deadline", () => {
  test("is handed to each stage, logged, and its timer is cleared when the pipeline is done", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      expect(await runPipeline(["--deadline", "25m"], run.spec, run.io)).toBe(
        EXIT.pass,
      )
      const start = Date.UTC(2026, 9, 14, 12, 0, 0)
      expect(run.children[0].FLOWREEL_DEADLINE_AT).toBe(
        String(start + 1_500_000),
      )
      expect(run.lines).toContain(
        `deadline: ${new Date(start + 1_500_000).toISOString()} (--deadline 25m)`,
      )
      expect(run.scheduled).toHaveLength(1)
      expect(run.scheduled[0].ms).toBeGreaterThan(1_490_000)
      expect(run.scheduled[0].cancelled).toBe(true)
      // Never fired: the combined video was composed as usual.
      expect(run.pipelineJson()).toMatchObject({
        options: { deadline: { kind: "in", label: "25m" } },
        video: { produced: false, reason: "composed (fake)" },
      })
      // A timer that fires after the pipeline is done changes nothing.
      run.deadline()
      expect(run.childSignals).toEqual([])
    } finally {
      done()
    }
  })

  test("reached during development: the stage is stopped, staging never starts, no combined video", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) =>
        h.deadline(),
      )
      expect(await runPipeline(["--deadline", "25m"], run.spec, run.io)).toBe(
        EXIT.interrupted,
      )
      expect(run.childSignals).toEqual(["SIGINT"])
      expect(run.children).toHaveLength(1)
      expect(run.lines).toContain(
        "deadline reached (--deadline 25m): stopping development",
      )
      expect(run.lines).toContain("staging: not run (deadline reached)")
      expect(run.pipelineJson()).toMatchObject({
        status: "finished",
        stoppedBy: "the deadline (--deadline 25m)",
        verdictReason: "development passed; deadline reached before staging.",
        video: { produced: false, reason: "skipped: the deadline was reached" },
      })
    } finally {
      done()
    }
  })

  test("reached during staging: staging is stopped and its own verdict stands", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(
        dir,
        { local: PASS, staging: { verdict: "FAIL", verdictReason: "x" } },
        (env, h) => {
          if (env.FLOWREEL_TARGET === "staging") h.deadline()
        },
      )
      expect(await runPipeline(["--deadline", "25m"], run.spec, run.io)).toBe(
        EXIT.fail,
      )
      expect(run.lines).toContain(
        "deadline reached (--deadline 25m): stopping staging",
      )
      expect(run.childSignals).toEqual(["SIGINT"])
    } finally {
      done()
    }
  })

  test("reached between stages: the next stage does not start", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      run.onLog = (line) => {
        if (line === "development: PASS") run.deadline()
      }
      expect(await runPipeline(["--deadline", "25m"], run.spec, run.io)).toBe(
        EXIT.interrupted,
      )
      expect(run.children).toHaveLength(1)
      expect(run.childSignals).toEqual([])
      expect(run.lines).toContain(
        "deadline reached (--deadline 25m): no further stage",
      )
    } finally {
      done()
    }
  })

  test("already past at the start, with the default timers: no database copy, no stage, never a pass", async () => {
    const { dir, done } = tmp()
    try {
      const events: string[] = []
      const isolation: DbIsolation = {
        create: (key) => (events.push(`create ${key}`), { APP_DB: key }),
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      for (const argv of [
        ["--module", "tour", "--deadline", "2020-01-01T00:00:00Z"],
        ["--module", "tour", "--local", "--deadline", "1000000000000"],
      ]) {
        const run = harness(dir, { local: PASS, staging: PASS }, undefined, {
          db: { modules: ["tour"], isolation, keyPrefix: "t" },
        })
        // The real scheduling: a timer would fire only after the stage
        // started.
        delete run.io.schedule
        expect(await runPipeline(argv, run.spec, run.io), argv.join(" ")).toBe(
          EXIT.interrupted,
        )
        expect(run.children).toEqual([])
        expect(run.childSignals).toEqual([])
        const doc = run.pipelineJson()
        expect(doc).toMatchObject({
          status: "finished",
          verdict: "INCOMPLETE",
          verdictReason: "Deadline reached before development.",
          stages: [{ reason: "not run (deadline reached)" }, {}],
        })
        expect(
          run.lines.some((l) =>
            l.endsWith("before the pipeline started: no stage runs"),
          ),
        ).toBe(true)
      }
      expect(events).toEqual([])
    } finally {
      done()
    }
  })

  test("a deadline far ahead with the default timers is cleared at the end", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      delete run.io.schedule
      expect(
        await runPipeline(["--local", "--deadline", "1h"], run.spec, run.io),
      ).toBe(EXIT.pass)
    } finally {
      done()
    }
  })

  test("FLOWREEL_DEADLINE is the fallback; the flag wins; a bad value is a usage error naming the variable", async () => {
    const { dir, done } = tmp()
    const errors: string[] = []
    const original = console.error
    console.error = (line: string) => errors.push(String(line))
    try {
      const run = harness(dir, { local: PASS }, (_env, h) => h.deadline())
      run.io.env.FLOWREEL_DEADLINE = "90s"
      // The (scripted) stage still passed, but a stopped run is never a
      // pass: INCOMPLETE, naming the stop.
      expect(await runPipeline(["--local"], run.spec, run.io)).toBe(
        EXIT.interrupted,
      )
      expect(run.pipelineJson()).toMatchObject({
        verdict: "INCOMPLETE",
        verdictReason:
          "development passed. Stopped by the deadline (FLOWREEL_DEADLINE=90s) before the pipeline finished.",
      })
      expect(run.lines).toContain(
        "deadline reached (FLOWREEL_DEADLINE=90s): stopping development",
      )
      // The stage never sees the pipeline's own setting.
      expect(run.children[0]).not.toHaveProperty("FLOWREEL_DEADLINE")

      const flag = harness(dir, { local: PASS })
      flag.io.env.FLOWREEL_DEADLINE = "90s"
      await runPipeline(["--local", "--deadline=2h"], flag.spec, flag.io)
      expect(flag.lines.some((l) => l.endsWith("(--deadline 2h)"))).toBe(true)

      const bad = harness(dir, {})
      bad.io.env.FLOWREEL_DEADLINE = "soon"
      expect(await runPipeline([], bad.spec, bad.io)).toBe(EXIT.usage)
      expect(await runPipeline(["--deadline", "0"], bad.spec, bad.io)).toBe(
        EXIT.usage,
      )
      expect(bad.children).toEqual([])
    } finally {
      console.error = original
      done()
    }
    expect(errors[0]).toContain("FLOWREEL_DEADLINE needs a duration")
    expect(errors[1]).toContain("--deadline must be more than zero")
  })

  test("too close to the deadline for the combined video: skipped; FLOWREEL_COMPOSE_BUDGET_SEC tunes it", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      expect(await runPipeline(["--deadline", "30s"], run.spec, run.io)).toBe(
        EXIT.pass,
      )
      expect(run.pipelineJson().video).toEqual({
        produced: false,
        reason: "skipped: not enough time before the deadline",
      })

      const tuned = harness(dir, { local: PASS, staging: PASS })
      tuned.io.env.FLOWREEL_COMPOSE_BUDGET_SEC = "0"
      await runPipeline(["--deadline", "30s"], tuned.spec, tuned.io)
      expect(tuned.pipelineJson().video).toEqual({
        produced: false,
        reason: "composed (fake)",
      })
    } finally {
      done()
    }
  })

  test("a Ctrl-C after the deadline forces; one with it is part of it; a second deadline is only said", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.deadline()
        h.deadline()
        h.signal("SIGINT", 50)
        expect(h.exits).toEqual([])
        h.signal("SIGINT", 500)
      })
      expect(await runPipeline(["--deadline", "25m"], run.spec, run.io)).toBe(
        EXIT.interrupted,
      )
      expect(run.lines).toContain(
        "deadline reached (--deadline 25m) while already stopping",
      )
      expect(run.exits).toEqual([EXIT.interrupted])
      expect(run.pipelineJson()).toMatchObject({
        status: "aborted",
        stoppedBy: "the deadline (--deadline 25m), then a second Ctrl-C",
      })
    } finally {
      done()
    }
  })

  test("the pipeline's pid and a terminal's hangup mode reach each stage", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      run.io.pid = 31337
      run.io.interactive = true
      await runPipeline(["--local"], run.spec, run.io)
      expect(run.children[0]).toMatchObject({
        FLOWREEL_PIPELINE_PID: "31337",
        FLOWREEL_HUP: "graceful",
      })
      expect(run.children[0]).not.toHaveProperty("FLOWREEL_DEADLINE_AT")
    } finally {
      done()
    }
  })
})

test.describe("the combined video", () => {
  test("a first stop during its composition ends it (its tools get the signal): INCOMPLETE, never a pass", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      let seen: AbortSignal | undefined
      run.spec.report.compose = () => {
        seen = mediaSignal()
        setTimeout(() => run.signal("SIGTERM"), 5)
        return new Promise(() => undefined)
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(seen?.aborted).toBe(true)
      expect(run.exits).toEqual([])
      expect(run.pipelineJson()).toMatchObject({
        status: "finished",
        stoppedBy: "SIGTERM",
        verdict: "INCOMPLETE",
        verdictReason:
          "development, staging passed. Stopped by SIGTERM before the pipeline finished.",
        exitCode: EXIT.interrupted,
        video: {
          produced: false,
          reason: "video composition stopped (interrupted)",
        },
      })
      expect(run.lines).toContain(
        "combined video: not produced (video composition stopped (interrupted))",
      )
    } finally {
      done()
    }
  })

  test("a FAIL stands when a stop ends the composition", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: { verdict: "FAIL" } })
      run.spec.report.compose = () => {
        setTimeout(() => run.signal("SIGINT"), 5)
        return new Promise(() => undefined)
      }
      expect(await runPipeline(["--local"], run.spec, run.io)).toBe(EXIT.fail)
    } finally {
      done()
    }
  })

  test("a second Ctrl-C during it stops the encode and waits for it before exiting", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS })
      const events: string[] = []
      run.io.exit = (code) => {
        events.push(`exit ${code}`)
        return undefined as never
      }
      run.spec.report.compose = () => {
        const signal = mediaSignal()
        setTimeout(() => {
          run.signal("SIGINT")
          run.signal("SIGINT")
        }, 5)
        // An encode that ends a moment after it is told to stop.
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () =>
            setTimeout(() => {
              events.push("encode ended")
              resolve({ produced: false, reason: "ffmpeg stopped" })
            }, 20),
          ),
        )
      }
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(events).toEqual(["encode ended", "exit 130"])
      expect(run.pipelineJson()).toMatchObject({
        status: "aborted",
        verdict: "INCOMPLETE",
      })
    } finally {
      done()
    }
  })

  test("a composer that throws still rejects the run (a crash, not a verdict)", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS })
      run.spec.report.compose = () => Promise.reject(new Error("composer bug"))
      await expect(runPipeline(["--local"], run.spec, run.io)).rejects.toThrow(
        "composer bug",
      )
    } finally {
      done()
    }
  })
})

test.describe("a terminal's hangup", () => {
  test("SIGHUP stops like a SIGTERM and never forces", async () => {
    const { dir, done } = tmp()
    try {
      const run = harness(dir, { local: PASS, staging: PASS }, (_env, h) => {
        h.signal("SIGHUP")
        h.signal("SIGHUP", 2000)
        h.signal("SIGTERM", 2000)
      })
      expect(await runPipeline([], run.spec, run.io)).toBe(EXIT.interrupted)
      expect(run.exits).toEqual([])
      expect(run.childSignals).toEqual(["SIGINT"])
      expect(run.lines).toContain(
        "SIGHUP: finishing the current stage's report, no next stage",
      )
      expect(run.lines).toContain(
        "SIGHUP after the stop request: still finishing the stage's report; a kill may follow",
      )
      expect(run.pipelineJson().stoppedBy).toBe("SIGHUP (the terminal closed)")
    } finally {
      done()
    }
  })
})
