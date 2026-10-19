// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"
import ts from "typescript"

import { type GuardProcess, installStageGuard } from "../src/reporter/guard.js"

// The stage guard: unit tests over a fake process (every trigger, the
// stop-once rule, the SIGINT observer, idempotence), then real processes: a
// node child that installs the guard is stopped by SIGTERM and by its
// pipeline's death, exits 130 without a SIGINT listener, and survives
// writing to a closed pipe.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src")

/** A process stand-in: events, exits, kills and output errors recorded. */
function fakeProcess(pid = 100) {
  const proc = new EventEmitter()
  const exits: number[] = []
  const killed: [number, unknown][] = []
  let alive: Record<number, "alive" | "gone" | "not ours"> = {}
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const fake = Object.assign(proc, {
    pid,
    exit: (code: number) => {
      exits.push(code)
    },
    kill: (target: number, signal?: unknown) => {
      killed.push([target, signal])
      const state = alive[target] ?? "alive"
      if (state === "alive") return true
      throw Object.assign(new Error(state), {
        code: state === "gone" ? "ESRCH" : "EPERM",
      })
    },
    stdout,
    stderr,
  })
  return {
    proc: fake as unknown as Omit<GuardProcess, "stdout" | "stderr"> &
      EventEmitter & { stdout: EventEmitter; stderr: EventEmitter },
    exits,
    killed,
    setAlive: (map: typeof alive) => {
      alive = map
    },
  }
}

/** Manual timers: tick() runs every interval once; fire() runs timeouts. */
function fakeTimers() {
  const intervals = new Map<number, () => void>()
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = []
  let ids = 0
  return {
    intervals,
    timeouts,
    seams: {
      setInterval: (fn: () => void) => {
        const id = ++ids
        intervals.set(id, fn)
        return { id, unref: () => undefined }
      },
      clearInterval: (timer: unknown) => {
        intervals.delete((timer as { id: number }).id)
      },
      setTimeout: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cleared: false }
        timeouts.push(entry)
        return { entry, unref: () => undefined }
      },
      clearTimeout: (timer: unknown) => {
        ;(timer as { entry: { cleared: boolean } }).entry.cleared = true
      },
    },
    tick: () => {
      for (const fn of [...intervals.values()]) fn()
    },
  }
}

test.describe("installStageGuard over a fake process", () => {
  test("SIGTERM becomes a Ctrl-C when a SIGINT listener exists, else exits 130; only once", async () => {
    const f = fakeProcess()
    const warnings: string[] = []
    const guard = installStageGuard(
      {},
      { proc: f.proc, warn: (l) => warnings.push(l) },
    )
    expect(guard.pipelinePid).toBeNull()
    // No SIGINT listener yet (Playwright's runner has not started).
    f.proc.emit("SIGTERM")
    expect(f.exits).toEqual([130])
    guard.uninstall()

    const g = fakeProcess()
    const sigints: unknown[] = []
    g.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    const second = installStageGuard(
      {},
      { proc: g.proc, warn: (l) => warnings.push(l), logPrefix: "notes" },
    )
    g.proc.emit("SIGTERM")
    expect(sigints).toEqual(["SIGINT"])
    // A second SIGTERM never cuts the teardown short: it is only said.
    g.proc.emit("SIGTERM")
    expect(sigints).toHaveLength(1)
    expect(warnings).toEqual([
      "[notes] SIGTERM after the stop request: still finishing this run's report; a kill may follow.",
    ])
    expect(g.exits).toEqual([])
    second.uninstall()
  })

  test("a SIGINT that reached the run already (terminal, pipeline) makes a later SIGTERM only a line", async () => {
    const f = fakeProcess()
    const sigints: unknown[] = []
    const watcher = (s: unknown) => sigints.push(s)
    const warnings: string[] = []
    const guard = installStageGuard(
      {},
      { proc: f.proc, warn: (l) => warnings.push(l) },
    )
    // Playwright's watcher arrives after the guard: the guard observes too.
    f.proc.on("SIGINT", watcher)
    expect(f.proc.listenerCount("SIGINT")).toBe(2)
    f.proc.emit("SIGINT", "SIGINT")
    f.proc.emit("SIGTERM")
    expect(sigints).toEqual(["SIGINT"])
    expect(warnings).toHaveLength(1)
    // The watcher leaves: so does the guard's observer, and a Ctrl-C keeps
    // its default (no listener at all).
    f.proc.off("SIGINT", watcher)
    expect(f.proc.listenerCount("SIGINT")).toBe(0)
    guard.uninstall()
  })

  test("the observer joins a SIGINT listener that existed before the guard; removing an unrelated listener keeps it", async () => {
    const f = fakeProcess()
    const a = () => undefined
    const b = () => undefined
    f.proc.on("SIGINT", a)
    const guard = installStageGuard({}, { proc: f.proc, warn: () => undefined })
    expect(f.proc.listenerCount("SIGINT")).toBe(2)
    f.proc.on("SIGINT", b)
    f.proc.off("SIGINT", a)
    expect(f.proc.listenerCount("SIGINT")).toBe(2)
    f.proc.off("SIGTERM", () => undefined)
    f.proc.off("SIGINT", b)
    expect(f.proc.listenerCount("SIGINT")).toBe(0)
    guard.uninstall()
    expect(f.proc.listenerCount("SIGTERM")).toBe(0)
    expect(f.proc.listenerCount("newListener")).toBe(0)
  })

  test("is installed once per process", async () => {
    const f = fakeProcess()
    const one = installStageGuard({}, { proc: f.proc })
    expect(installStageGuard({}, { proc: f.proc })).toBe(one)
    expect(f.proc.listenerCount("SIGTERM")).toBe(1)
    one.uninstall()
    const two = installStageGuard({}, { proc: f.proc })
    expect(two).not.toBe(one)
    two.uninstall()
  })

  test("output to a reader that is gone is ignored; any other output error still throws", async () => {
    const f = fakeProcess()
    const guard = installStageGuard({}, { proc: f.proc })
    for (const code of ["EPIPE", "EIO", "ERR_STREAM_DESTROYED"]) {
      f.proc.stdout.emit("error", Object.assign(new Error(code), { code }))
      f.proc.stderr.emit("error", Object.assign(new Error(code), { code }))
    }
    expect(() =>
      f.proc.stdout.emit(
        "error",
        Object.assign(new Error("full"), { code: "ENOSPC" }),
      ),
    ).toThrow("full")
    expect(() => f.proc.stderr.emit("error", new Error("no code"))).toThrow(
      "no code",
    )
    guard.uninstall()
    expect(f.proc.stdout.listenerCount("error")).toBe(0)
  })

  test("the pipeline's pid is polled: alive or not ours goes on; gone stops the run once", async () => {
    const f = fakeProcess(100)
    const timers = fakeTimers()
    const sigints: unknown[] = []
    f.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    const warnings: string[] = []
    const guard = installStageGuard(
      { FLOWREEL_PIPELINE_PID: " 4242 " },
      { proc: f.proc, ...timers.seams, warn: (l) => warnings.push(l) },
    )
    expect(guard.pipelinePid).toBe(4242)
    timers.tick()
    f.setAlive({ 4242: "not ours" })
    timers.tick()
    expect(sigints).toEqual([])
    f.setAlive({ 4242: "gone" })
    timers.tick()
    expect(sigints).toEqual(["SIGINT"])
    expect(warnings).toEqual([
      "[flowreel] the pipeline (pid 4242) is gone: stopping this run as Ctrl-C would.",
    ])
    expect(
      f.killed.every(([pid, signal]) => pid === 4242 && signal === 0),
    ).toBe(true)
    // Polling stopped.
    expect(timers.intervals.size).toBe(0)
    guard.uninstall()
  })

  test("a pipeline that dies while the run already stops changes nothing", async () => {
    const f = fakeProcess(100)
    const timers = fakeTimers()
    const sigints: unknown[] = []
    f.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    const warnings: string[] = []
    const guard = installStageGuard(
      { FLOWREEL_PIPELINE_PID: "4242" },
      { proc: f.proc, ...timers.seams, warn: (l) => warnings.push(l) },
    )
    f.proc.emit("SIGINT", "SIGINT")
    f.setAlive({ 4242: "gone" })
    timers.tick()
    expect(sigints).toEqual(["SIGINT"])
    expect(warnings).toEqual([
      "[flowreel] the pipeline (pid 4242) is gone; this run is already stopping.",
    ])
    guard.uninstall()
  })

  test("no pid, a bad pid or its own pid: nothing is polled", async () => {
    for (const value of [undefined, "", "abc", "0", "100", "-5"]) {
      const f = fakeProcess(100)
      const timers = fakeTimers()
      const env = value === undefined ? {} : { FLOWREEL_PIPELINE_PID: value }
      const guard = installStageGuard(env, { proc: f.proc, ...timers.seams })
      expect(guard.pipelinePid, String(value)).toBeNull()
      expect(timers.intervals.size).toBe(0)
      guard.uninstall()
    }
  })

  test("SIGHUP stops gracefully only when the pipeline runs in a terminal", async () => {
    const f = fakeProcess()
    const plain = installStageGuard({}, { proc: f.proc })
    expect(f.proc.listenerCount("SIGHUP")).toBe(0)
    plain.uninstall()
    const sigints: unknown[] = []
    f.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    const hup = installStageGuard(
      { FLOWREEL_HUP: "graceful" },
      { proc: f.proc },
    )
    f.proc.emit("SIGHUP")
    expect(sigints).toEqual(["SIGINT"])
    hup.uninstall()
    expect(f.proc.listenerCount("SIGHUP")).toBe(0)
  })

  test("Windows: Ctrl-Break is a stop, and the pipeline's deadline stops the run (the pipeline cannot signal it)", async () => {
    const f = fakeProcess()
    const timers = fakeTimers()
    const sigints: unknown[] = []
    f.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    const warnings: string[] = []
    const guard = installStageGuard(
      { FLOWREEL_DEADLINE_AT: "61000" },
      {
        proc: f.proc,
        platform: "win32",
        now: () => 1000,
        ...timers.seams,
        warn: (l) => warnings.push(l),
      },
    )
    expect(timers.timeouts.map((t) => t.ms)).toEqual([60_000])
    timers.timeouts[0].fn()
    expect(sigints).toEqual(["SIGINT"])
    expect(warnings).toEqual([
      "[flowreel] deadline reached: stopping this run as Ctrl-C would.",
    ])
    // Ctrl-Break after that is only said.
    f.proc.emit("SIGBREAK")
    expect(sigints).toHaveLength(1)
    // The deadline firing again (it cannot, but) is only said too.
    timers.timeouts[0].fn()
    expect(warnings.at(-1)).toBe(
      "[flowreel] deadline reached; this run is already stopping.",
    )
    guard.uninstall()
    expect(timers.timeouts[0].cleared).toBe(true)

    // Not on POSIX, not past a timer's range, not without a deadline.
    for (const [platform, at] of [
      ["linux", "61000"],
      ["win32", String(2 ** 33)],
      ["win32", "soon"],
    ] as const) {
      const g = fakeProcess()
      const t = fakeTimers()
      installStageGuard(
        { FLOWREEL_DEADLINE_AT: at },
        { proc: g.proc, platform, now: () => 1000, ...t.seams },
      ).uninstall()
      expect(t.timeouts, `${platform} ${at}`).toEqual([])
    }
  })

  // Stopping there would exit 130 from the reporter's constructor, before
  // Playwright listens for Ctrl-C, and leave no summary.
  test("a deadline already past on Windows when the run starts is said, never acted on", async () => {
    const f = fakeProcess()
    const timers = fakeTimers()
    const warnings: string[] = []
    for (const at of ["500", "1000"]) {
      installStageGuard(
        { FLOWREEL_DEADLINE_AT: at },
        {
          proc: f.proc,
          platform: "win32",
          now: () => 1000,
          ...timers.seams,
          warn: (l) => warnings.push(l),
        },
      ).uninstall()
    }
    expect(timers.timeouts).toEqual([])
    expect(f.exits).toEqual([])
    expect(warnings).toEqual([
      "[flowreel] the pipeline's deadline passed before this run started: it is not stopped for it.",
      "[flowreel] the pipeline's deadline passed before this run started: it is not stopped for it.",
    ])
  })

  test("a Windows deadline that comes before Playwright listens for Ctrl-C waits until it does", async () => {
    const f = fakeProcess()
    const timers = fakeTimers()
    const guard = installStageGuard(
      { FLOWREEL_DEADLINE_AT: "2000" },
      { proc: f.proc, platform: "win32", now: () => 1000, ...timers.seams },
    )
    timers.timeouts[0].fn()
    // Nobody listens yet: no exit, a retry instead.
    expect(f.exits).toEqual([])
    expect(timers.timeouts.map((t) => t.ms)).toEqual([1000, 250])
    const sigints: unknown[] = []
    f.proc.on("SIGINT", (s: unknown) => sigints.push(s))
    timers.timeouts[1].fn()
    expect(sigints).toEqual(["SIGINT"])
    guard.uninstall()
    expect(timers.timeouts[1].cleared).toBe(true)
  })

  test("defaults: the real process, timers and clock", () => {
    // Installs on this worker's process: idempotent, and SIGTERM-safe here
    // (Playwright's workers ignore SIGTERM and SIGINT anyway).
    const guard = installStageGuard({})
    expect(installStageGuard()).toBe(guard)
    guard.uninstall()
    const polled = installStageGuard(
      { FLOWREEL_PIPELINE_PID: String(process.pid + 1_000_000) },
      { platform: "win32" },
    )
    expect(polled.pipelinePid).toBe(process.pid + 1_000_000)
    polled.uninstall()
    const windows = installStageGuard(
      { FLOWREEL_DEADLINE_AT: String(Date.now() + 3_600_000) },
      { platform: "win32" },
    )
    windows.uninstall()
  })
})

// Real processes. The guard and what it imports are transpiled once into a
// temporary ESM folder (the child cannot load TypeScript on every Node
// version flowreel supports).
test.describe("installStageGuard in a real process", () => {
  test.describe.configure({ mode: "serial" })

  let dir: string
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flowreel-guard-"))
    for (const file of [
      "reporter/guard",
      "core/deadline",
      "core/env",
      "core/passive",
    ]) {
      const source = readFileSync(join(SRC, `${file}.ts`), "utf8")
      const out = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText
      mkdirSync(join(dir, dirname(file)), { recursive: true })
      writeFileSync(join(dir, `${file}.js`), out)
    }
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n')
  })
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** Starts a child that installs the guard, then runs `body`. */
  function child(body: string, env: Record<string, string> = {}): ChildProcess {
    const script = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(
      script,
      `import { installStageGuard } from "./reporter/guard.js"\ninstallStageGuard()\n${body}\n`,
    )
    return spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
  }

  const exited = (proc: ChildProcess) =>
    new Promise<{ code: number | null; signal: string | null }>((done) =>
      proc.on("close", (code, signal) => done({ code, signal })),
    )

  const firstLine = (proc: ChildProcess) =>
    new Promise<string>((done) => {
      let text = ""
      proc.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString()
        if (text.includes("\n")) done(text.split("\n")[0])
      })
    })

  // Keeps the child alive with a SIGINT listener that reports and exits 0.
  const LISTENS = `
process.on("SIGINT", () => { console.log("sigint"); process.exit(0) })
console.log("ready")
setInterval(() => {}, 1000)
`

  test("SIGTERM reaches the SIGINT listener", async () => {
    const proc = child(LISTENS)
    expect(await firstLine(proc)).toBe("ready")
    const next = firstLineAfter(proc)
    proc.kill("SIGTERM")
    expect(await next).toBe("sigint")
    expect(await exited(proc)).toEqual({ code: 0, signal: null })
  })

  test("SIGTERM without a SIGINT listener exits 130", async () => {
    const proc = child(`console.log("ready"); setInterval(() => {}, 1000)`)
    expect(await firstLine(proc)).toBe("ready")
    proc.kill("SIGTERM")
    expect(await exited(proc)).toEqual({ code: 130, signal: null })
  })

  test("a pipeline that is gone stops the run within a poll or two (1 s each)", async () => {
    const gone = spawn(process.execPath, ["-e", ""])
    await exited(gone)
    const proc = child(LISTENS, { FLOWREEL_PIPELINE_PID: String(gone.pid) })
    const stderr: string[] = []
    proc.stderr!.on("data", (c: Buffer) => stderr.push(c.toString()))
    expect(await firstLine(proc)).toBe("ready")
    // Measured from the child's own start, with room for a loaded machine.
    const ready = Date.now()
    expect(await exited(proc)).toEqual({ code: 0, signal: null })
    expect(Date.now() - ready).toBeLessThan(4000)
    expect(stderr.join("")).toContain(
      `[flowreel] the pipeline (pid ${gone.pid}) is gone: stopping this run as Ctrl-C would.`,
    )
  })

  test("writing to a closed pipe does not crash the run (without the guard it does)", async () => {
    const body = `
import { writeFileSync } from "node:fs"
const until = Date.now() + 600
const chunk = "x".repeat(65536) + "\\n"
const timer = setInterval(() => {
  process.stdout.write(chunk)
  if (Date.now() > until) {
    clearInterval(timer)
    writeFileSync(process.env.MARK, "alive")
    process.exit(0)
  }
}, 5)
`
    for (const guarded of [true, false]) {
      const mark = join(dir, `mark-${guarded}`)
      const script = join(dir, `pipe-${guarded}.mjs`)
      writeFileSync(
        script,
        guarded
          ? `import { installStageGuard } from "./reporter/guard.js"\ninstallStageGuard()\n${body}`
          : body,
      )
      const proc = spawn(process.execPath, [script], {
        env: { ...process.env, MARK: mark },
        stdio: ["ignore", "pipe", "ignore"],
      })
      // The reader goes away: the next writes fail with EPIPE.
      proc.stdout.destroy()
      const result = await exited(proc)
      if (guarded) {
        expect(result).toEqual({ code: 0, signal: null })
        expect(readFileSync(mark, "utf8")).toBe("alive")
      } else {
        expect(result.code).not.toBe(0)
      }
    }
  })
})

/** The next stdout line after the ones already read. */
function firstLineAfter(proc: ChildProcess): Promise<string> {
  return new Promise((done) => {
    let text = ""
    const onData = (chunk: Buffer) => {
      text += chunk.toString()
      if (text.includes("\n")) {
        proc.stdout!.off("data", onData)
        done(text.split("\n")[0])
      }
    }
    proc.stdout!.on("data", onData)
  })
}
