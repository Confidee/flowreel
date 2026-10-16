// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { UndoLedger, fileUndoStore } from "../src/core/undo.js"
import {
  type DbIsolation,
  EXIT,
  type PipelineArgsSpec,
  type PipelineIo,
  type PipelineSpec,
  UsageError,
  cloneKey,
  commandDbIsolation,
  configProblemOf,
  parsePipelineArgs,
  pipelineOutcome,
  preferredEnvName,
  runPipeline,
  stageCommand,
  stageEnv,
  stageLabel,
  stageVerdictFrom,
  stagingDecision,
} from "../src/pipeline/index.js"
import { parsePace } from "../src/tour/policy.js"

// The pipeline module: arguments, each stage's clean env and command, the
// gate and exit codes, per-run database isolation and the runner (driven
// by a scripted child).

const ARGS: PipelineArgsSpec<"gate" | "tour"> = {
  modules: ["gate", "tour"],
  defaultModule: "gate",
  tourModules: ["tour"],
  parseAreas: (raw) => {
    const areas = raw.split(",").map((a) => a.trim().toUpperCase())
    if (areas.some((a) => !/^[AB]$/.test(a)))
      throw new Error(`Unknown area in ${raw}.`)
    return areas
  },
  parsePace: (raw) => parsePace(raw, "--pace"),
}

test.describe("arguments", () => {
  test("defaults and flags", () => {
    expect(parsePipelineArgs([], ARGS)).toEqual({
      module: "gate",
      local: false,
      stagingOnly: false,
      headed: false,
      video: true,
      areas: null,
      pace: null,
      keepDb: false,
      narration: null,
      help: false,
    })
    expect(
      parsePipelineArgs(
        [
          "--module=tour",
          "--local",
          "--headed",
          "--no-video",
          "--area",
          "b,a",
          "--pace",
          "QA",
          "--keep-db",
          "--narration=On",
        ],
        ARGS,
      ),
    ).toMatchObject({
      module: "tour",
      local: true,
      headed: true,
      video: false,
      areas: ["B", "A"],
      pace: "qa",
      keepDb: true,
      narration: "on",
    })
  })

  test("usage errors", () => {
    const refused: [string[], string][] = [
      [["--module"], "--module needs a name (e.g. --module gate)."],
      [["--module", "x"], 'Unknown module "x". Known: gate, tour.'],
      [["--local=yes"], "--local takes no value."],
      [
        ["--local", "--staging-only"],
        "--local and --staging-only exclude each other.",
      ],
      [
        ["--module", "tour", "--area"],
        "--area needs letters (e.g. --area A,C).",
      ],
      [["--module", "tour", "--area", "Z"], "Unknown area in Z."],
      [
        ["--module", "tour", "--pace", "slow"],
        '--pace must be "demo" or "qa" (got "slow").',
      ],
      [["--pace"], "--pace needs demo or qa."],
      [["--narration", "maybe"], "--narration needs on or off."],
      [
        ["--keep-db"],
        "--area, --pace and --keep-db apply to --module tour only.",
      ],
      [["x"], 'Unknown argument "x".'],
    ]
    for (const [argv, message] of refused) {
      let error: unknown
      try {
        parsePipelineArgs(argv, ARGS)
      } catch (e) {
        error = e
      }
      expect(error, argv.join(" ")).toBeInstanceOf(UsageError)
      expect((error as Error).message).toBe(message)
    }
  })
})

test.describe("each stage", () => {
  const SPEC = { isSecret: (name: string) => name.startsWith("APP_SECRET_") }

  test("only staging gets the secrets; the pipeline's own keys are never inherited", () => {
    const base = {
      PATH: "/bin",
      APP_SECRET_PW: "pw",
      FLOWREEL_ENV_FILE: "/s.env",
      FLOWREEL_BASE_URL: "https://qa.example.org",
      FLOWREEL_TARGET: "staging",
      FLOWREEL_RUN_ID: "old",
      FLOWREEL_MODULE: "x",
      FLOWREEL_DB_KEY: "k",
      FLOWREEL_STATE_AGENT: "{}",
      FLOWREEL_VIDEO: "on",
      FLOWREEL_PACE: "demo",
    }
    const dev = stageEnv(
      "development",
      "r1",
      base,
      { headed: false, video: false, module: "tour", pace: "qa" },
      SPEC,
      { DB: "x" },
    )
    expect(dev).toEqual({
      PATH: "/bin",
      FLOWREEL_TARGET: "local",
      FLOWREEL_RUN_ID: "r1",
      FLOWREEL_MODULE: "tour",
      FLOWREEL_PACE: "qa",
      FLOWREEL_VIDEO: "off",
      DB: "x",
    })
    const staging = stageEnv(
      "staging",
      "r2",
      base,
      { headed: true, video: true },
      SPEC,
      { DB: "x" },
      "gate",
    )
    expect(staging).toEqual({
      PATH: "/bin",
      APP_SECRET_PW: "pw",
      FLOWREEL_ENV_FILE: "/s.env",
      FLOWREEL_BASE_URL: "https://qa.example.org",
      FLOWREEL_TARGET: "staging",
      FLOWREEL_RUN_ID: "r2",
      FLOWREEL_MODULE: "gate",
      FLOWREEL_VIDEO: "on",
      FLOWREEL_PACE: "demo",
      FLOWREEL_SLOW_MO: "300",
    })
    expect(preferredEnvName("PIPELINE_SPEC_UNREGISTERED")).toBe(
      "FLOWREEL_PIPELINE_SPEC_UNREGISTERED",
    )
  })

  test("one playwright run of the module's projects, never with retries", () => {
    expect(stageCommand("e2e/flowreel.config.ts", ["a", "b"], true)).toEqual([
      "--no-install",
      "playwright",
      "test",
      "--config=e2e/flowreel.config.ts",
      "--project=a",
      "--project=b",
      "--headed",
    ])
  })
})

test.describe("the gate", () => {
  const dev = (verdict: "PASS" | "FAIL") => ({
    stage: "development" as const,
    verdict,
    reason: "",
  })

  test("staging only after a development PASS; --local; interrupts; config", () => {
    expect(
      stagingDecision({ local: false, stagingOnly: false }, dev("PASS"), null),
    ).toEqual({ run: true })
    expect(
      stagingDecision(
        { local: false, stagingOnly: false },
        dev("FAIL"),
        "missing X",
      ),
    ).toEqual({
      run: false,
      result: {
        stage: "staging",
        verdict: "not run",
        reason: "not run (development FAIL)",
      },
    })
    expect(
      stagingDecision({ local: true, stagingOnly: false }, dev("PASS"), null),
    ).toMatchObject({
      result: { verdict: "skipped", reason: "skipped (--local)" },
    })
    expect(
      stagingDecision({ local: false, stagingOnly: true }, dev("FAIL"), null),
    ).toEqual({ run: true })
    expect(
      stagingDecision(
        { local: false, stagingOnly: false },
        dev("PASS"),
        null,
        true,
      ),
    ).toMatchObject({
      result: { reason: "not run (interrupted)" },
    })
    expect(
      stagingDecision(
        { local: false, stagingOnly: false },
        dev("PASS"),
        "missing X",
      ),
    ).toMatchObject({
      result: { verdict: "not configured", reason: "missing X" },
    })
  })

  test("outcomes and exit codes; an undo failure outranks every verdict", () => {
    const s = (stage: "development" | "staging", verdict: string, extra = {}) =>
      ({ stage, verdict, reason: "", ...extra }) as Parameters<
        typeof pipelineOutcome
      >[0][number]
    expect(
      pipelineOutcome([s("development", "PASS"), s("staging", "PASS")]),
    ).toEqual({
      verdict: "PASS",
      reason: "development, staging passed.",
      exitCode: EXIT.pass,
    })
    expect(
      pipelineOutcome([s("development", "FAIL"), s("staging", "not run")])
        .exitCode,
    ).toBe(1)
    expect(
      pipelineOutcome([
        s("development", "PASS"),
        s("staging", "not configured", { reason: "missing X" }),
      ]),
    ).toEqual({
      verdict: "INCOMPLETE",
      reason: "development passed; staging not configured (missing X).",
      exitCode: EXIT.notConfigured,
    })
    expect(
      pipelineOutcome([s("development", "N/A"), s("staging", "skipped")])
        .exitCode,
    ).toBe(3)
    expect(
      pipelineOutcome([s("development", "skipped"), s("staging", "skipped")])
        .exitCode,
    ).toBe(3)
    // Ctrl-C after development passed: staging never ran, so never a PASS.
    expect(
      pipelineOutcome([
        s("development", "PASS"),
        s("staging", "not run", { reason: "not run (interrupted)" }),
      ]),
    ).toEqual({
      verdict: "INCOMPLETE",
      reason: "development passed; interrupted before staging.",
      exitCode: EXIT.interrupted,
    })
    expect(
      pipelineOutcome([
        s("development", "skipped"),
        s("staging", "not run", { reason: "not run (interrupted)" }),
      ]).reason,
    ).toBe("Interrupted before staging.")
    // A failure that did happen still outranks the interruption.
    expect(
      pipelineOutcome([
        s("development", "FAIL"),
        s("staging", "not run", { reason: "not run (interrupted)" }),
      ]).exitCode,
    ).toBe(EXIT.fail)
    const undo = pipelineOutcome([
      s("development", "PASS", { undoFailed: 2 }),
      s("staging", "PASS"),
    ])
    expect(undo.exitCode).toBe(EXIT.undoFailed)
    expect(undo.reason).toBe(
      "UNDO FAILED, manual action needed (development: 2 change(s), see its undo.md). development, staging passed.",
    )
  })

  test("a stage's verdict from its summary and exit code", () => {
    expect(stageVerdictFrom("staging", null, 1)).toEqual({
      stage: "staging",
      verdict: "FAIL",
      reason: "no summary written (playwright exited 1)",
    })
    expect(stageVerdictFrom("staging", { verdict: "PASS" }, 2).reason).toBe(
      "playwright exited 2 after a PASS summary",
    )
    expect(
      stageVerdictFrom(
        "staging",
        { verdict: "PASS", undo: { manual: [1] } },
        1,
      ),
    ).toEqual({
      stage: "staging",
      verdict: "PASS",
      reason: "",
      undoFailed: 1,
    })
    expect(stageVerdictFrom("staging", null, null, 2)).toMatchObject({
      verdict: "FAIL",
      undoFailed: 2,
    })
    expect(
      stageLabel({ verdict: "skipped", reason: "skipped (--local)" }),
    ).toBe("skipped (--local)")
    expect(stageLabel({ verdict: "FAIL", reason: "boom" })).toBe("FAIL (boom)")
    expect(
      configProblemOf(
        new Error("Missing required staging config: A, B. Pass them"),
      ),
    ).toBe("missing A, B")
    expect(
      configProblemOf(new Error("Missing required local config: C. x")),
    ).toBe("missing C")
    expect(configProblemOf("first\nsecond")).toBe("first")
  })
})

test.describe("database isolation", () => {
  test("create parses, drop retries after waits, failures say what to run", () => {
    const calls: string[][] = []
    const waits: number[] = []
    const lines: string[] = []
    const replies = [
      { status: 0, stdout: "DB=copy_1\n", stderr: "" },
      { status: 1, stdout: "", stderr: "busy" },
      { status: 1, stdout: "", stderr: "busy" },
      { status: 1, stdout: "", stderr: "busy" },
      { status: 3, stdout: "", stderr: "", error: new Error("ENOENT") },
    ]
    const db = commandDbIsolation({
      command: "bin/db-copy",
      cwd: "/repo",
      parse: (out) => {
        const [key, value] = out.trim().split("=")
        return { [key]: value }
      },
      run: (args) => (calls.push(args), replies.shift()!),
      sleep: (ms) => waits.push(ms),
      log: (l) => lines.push(l),
    })
    expect(db.create("k1")).toEqual({ DB: "copy_1" })
    expect(db.drop("k1")).toBe(false)
    expect(() => db.create("k2")).toThrow("bin/db-copy k2 failed: ENOENT")
    expect(calls).toEqual([
      ["k1"],
      ["k1", "drop"],
      ["k1", "drop"],
      ["k1", "drop"],
      ["k2"],
    ])
    expect(waits).toEqual([3000, 10000])
    expect(lines.at(-1)).toBe(
      "WARNING: could not drop the DB clone k1 (run: bin/db-copy k1 drop)",
    )
    expect(cloneKey("run", () => 0.5)).toBe("run800000")
  })
})

test.describe("the runner", () => {
  interface Summary {
    verdict: string
    verdictReason?: string
    video?: unknown
  }

  function harness(
    dir: string,
    verdicts: Record<string, Summary | null>,
    extra: Partial<PipelineSpec<"gate" | "tour", Summary>> = {},
    onChild?: (env: Record<string, string>) => void,
  ) {
    const lines: string[] = []
    const children: Record<string, string>[] = []
    let n = 0
    const io: PipelineIo = {
      env: { PATH: "/bin", APP_SECRET_PW: "pw" },
      log: (l) => lines.push(l),
      now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, n++)),
      onInterrupt: () => undefined,
      exit: (code) => {
        throw new Error(`exit ${code}`)
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
    const spec: PipelineSpec<"gate" | "tour", Summary> = {
      ...ARGS,
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
      projects: (o) =>
        o.module === "tour"
          ? (o.areas ?? ["A", "B"]).map((a) => `tour-${a}`)
          : ["gate"],
      stagingConfigProblem: (env) =>
        env.APP_SECRET_PW ? null : "missing APP_SECRET_PW",
      report: {
        markdown: (doc) => `# ${doc.verdict}\n`,
        extras: (request) => ({ features: request.stages.length }),
        compose: (_request, env) =>
          Promise.resolve(
            env.FLOWREEL_VIDEO === "off"
              ? { produced: false, reason: "FLOWREEL_VIDEO=off" }
              : {
                  produced: true,
                  path: join(dir, "pipe-1", "pipeline.mp4"),
                  durationSec: 12.34,
                  narration: { produced: true },
                },
          ),
        closingLines: (doc) => [`narration: ${JSON.stringify(doc.narration)}`],
      },
      ...extra,
    }
    return { io, spec, lines, children }
  }

  test("development PASS, then staging; pipeline.json and .md; the video and closing lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
    try {
      const { io, spec, lines, children } = harness(dir, {
        local: { verdict: "PASS" },
        staging: { verdict: "PASS", video: { produced: true, path: "x.mp4" } },
      })
      expect(await runPipeline([], spec, io)).toBe(EXIT.pass)
      expect(children.map((c) => [c.FLOWREEL_TARGET, c.APP_SECRET_PW])).toEqual(
        [
          ["local", undefined],
          ["staging", "pw"],
        ],
      )
      const doc = JSON.parse(
        readFileSync(join(dir, "pipe-1", "pipeline.json"), "utf8"),
      ) as Record<string, unknown> & { stages: unknown[]; video: unknown }
      expect(doc).toMatchObject({
        pipelineId: "pipe-1",
        module: "gate",
        verdict: "PASS",
        exitCode: 0,
        resultsDir: "pipe-1",
        features: 2,
        stages: [
          {
            stage: "development",
            verdict: "PASS",
            runId: "local-1",
            summary: "local-1/summary.md",
          },
          {
            stage: "staging",
            verdict: "PASS",
            runId: "staging-2",
            video: "x.mp4",
          },
        ],
        video: {
          produced: true,
          path: "pipe-1/pipeline.mp4",
          file: "pipeline.mp4",
          durationSec: 12.34,
        },
        narration: { produced: true },
      })
      expect(Object.keys(doc).indexOf("features")).toBeLessThan(
        Object.keys(doc).indexOf("video"),
      )
      expect(readFileSync(join(dir, "pipe-1", "pipeline.md"), "utf8")).toBe(
        "# PASS\n",
      )
      expect(lines).toContain("development: local-1 (FLOWREEL_TARGET=local)")
      expect(lines).toContain("combined video: pipe-1/pipeline.mp4 (12.3s)")
      expect(lines.at(-1)).toBe('narration: {"produced":true}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a fresh database for the tour, dropped after; --keep-db keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
    try {
      const events: string[] = []
      const isolation: DbIsolation = {
        create: (key) => (
          events.push(`create ${key}`),
          { APP_DB: `db_${key}` }
        ),
        drop: (key) => (events.push(`drop ${key}`), true),
      }
      const db = {
        modules: ["tour" as const],
        isolation,
        keyPrefix: "t",
        describe: (env: Record<string, string>) => env.APP_DB,
        dropCommand: (k: string) => `drop ${k}`,
      }
      const run = harness(dir, { local: { verdict: "PASS" } }, { db }, (env) =>
        events.push(`child ${env.APP_DB} ${env.FLOWREEL_DB_KEY}`),
      )
      expect(
        await runPipeline(
          ["--module", "tour", "--local", "--area", "a"],
          run.spec,
          run.io,
        ),
      ).toBe(0)
      expect(events[0]).toMatch(/^create t[0-9a-f]{6}$/)
      const key = events[0].slice(7)
      expect(events).toEqual([
        `create ${key}`,
        `child db_${key} ${key}`,
        `drop ${key}`,
      ])
      expect(run.lines).toContain(`development DB clone: ${key} (db_${key})`)

      events.length = 0
      const kept = harness(dir, { local: { verdict: "PASS" } }, { db })
      await runPipeline(
        ["--module", "tour", "--local", "--keep-db"],
        kept.spec,
        kept.io,
      )
      expect(events.some((e) => e.startsWith("drop"))).toBe(false)
      expect(
        kept.lines.some((l) =>
          /kept the development DB clone t[0-9a-f]{6} \(--keep-db; drop: drop t/.test(
            l,
          ),
        ),
      ).toBe(true)
      // The round trip never copies a database.
      events.length = 0
      const gate = harness(dir, { local: { verdict: "PASS" } }, { db })
      await runPipeline(["--local"], gate.spec, gate.io)
      expect(events).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failed copy fails development without a child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
    try {
      const isolation: DbIsolation = {
        create: () => {
          throw new Error("copy refused")
        },
        drop: () => true,
      }
      const run = harness(
        dir,
        {},
        { db: { modules: ["tour"], isolation, keyPrefix: "t" } },
      )
      expect(
        await runPipeline(["--module", "tour", "--local"], run.spec, run.io),
      ).toBe(EXIT.fail)
      expect(run.children).toEqual([])
      expect(run.lines).toContain("development: FAIL (copy refused)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a dead child with a pending undo entry exits 4; not configured is said up front", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
    try {
      const run = harness(dir, {}, {}, (env) => {
        // The child dies after writing its write-ahead entry, before a summary.
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
      run.io.env = { PATH: "/bin" }
      const code = await runPipeline(["--no-video"], run.spec, run.io)
      expect(code).toBe(EXIT.undoFailed)
      expect(run.lines[1]).toBe(
        "staging is not configured (missing APP_SECRET_PW); development only.",
      )
      const doc = JSON.parse(
        readFileSync(join(dir, "pipe-1", "pipeline.json"), "utf8"),
      ) as Record<string, unknown> & { stages: unknown[]; video: unknown }
      expect(doc.stages[0]).toMatchObject({
        verdict: "FAIL",
        undoFailed: 1,
        undoFile: "local-1/undo.md",
      })
      expect(doc.video).toEqual({
        produced: false,
        reason: "FLOWREEL_VIDEO=off",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bad arguments exit 64 with the usage; --help prints it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-runner-"))
    const errors: string[] = []
    const logs: string[] = []
    const { error, log } = console
    console.error = (l: string) => errors.push(l)
    console.log = (l: string) => logs.push(l)
    try {
      const run = harness(dir, {})
      expect(await runPipeline(["--nope"], run.spec, run.io)).toBe(EXIT.usage)
      expect(await runPipeline(["--help"], run.spec, run.io)).toBe(EXIT.pass)
    } finally {
      console.error = error
      console.log = log
      rmSync(dir, { recursive: true, force: true })
    }
    expect(errors).toEqual(['Unknown argument "--nope".\n\nusage: run'])
    expect(logs).toEqual(["usage: run"])
  })
})
