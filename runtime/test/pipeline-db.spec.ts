// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { cloneKey, commandDbIsolation, sleepSync } from "../src/pipeline/db.js"

// The per-run database copy: key shape, create failing loudly, and drop
// retrying with waits and never throwing.

type Result = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}
const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" })
const failed = (stderr = "", error?: Error): Result => ({
  status: 1,
  stdout: "",
  stderr,
  error,
})

function isolation(replies: Result[], dropWaits?: readonly number[]) {
  const calls: string[][] = []
  const sleeps: number[] = []
  const lines: string[] = []
  const db = commandDbIsolation({
    command: "clone-db",
    cwd: ".",
    parse: (stdout) => ({ DATABASE: stdout.trim() }),
    dropWaits,
    log: (l) => lines.push(l),
    run: (args) => {
      calls.push(args)
      return replies.shift() ?? failed()
    },
    sleep: (ms) => sleeps.push(ms),
  })
  return { db, calls, sleeps, lines }
}

test("cloneKey: the prefix and 6 hex digits, zero padded", () => {
  expect(cloneKey("run_", () => 0)).toBe("run_000000")
  expect(cloneKey("run_", () => 0.5)).toBe("run_800000")
  expect(cloneKey("x", () => 0.999999999)).toMatch(/^x[0-9a-f]{6}$/)
  expect(cloneKey("run_")).toMatch(/^run_[0-9a-f]{6}$/)
})

test("sleepSync blocks for about the time asked", () => {
  const before = Date.now()
  sleepSync(15)
  expect(Date.now() - before).toBeGreaterThanOrEqual(10)
})

test("create passes the key and parses stdout into the stage env", () => {
  const { db, calls } = isolation([ok("postgres://copy\n")])
  expect(db.create("k1")).toEqual({ DATABASE: "postgres://copy" })
  expect(calls).toEqual([["k1"]])
})

test("create throws with the last two stderr lines; falls back to the spawn error", () => {
  expect(() =>
    isolation([failed("one\ntwo\nthree\n")]).db.create("k1"),
  ).toThrow("clone-db k1 failed: two three")
  expect(() =>
    isolation([failed("", new Error("spawn clone-db ENOENT"))]).db.create("k1"),
  ).toThrow("clone-db k1 failed: spawn clone-db ENOENT")
  expect(() => isolation([failed()]).db.create("k1")).toThrow(
    "clone-db k1 failed: ",
  )
})

test("drop: first attempt succeeds with no wait", () => {
  const { db, calls, sleeps, lines } = isolation([ok()])
  expect(db.drop("k1")).toBe(true)
  expect(calls).toEqual([["k1", "drop"]])
  expect(sleeps).toEqual([])
  expect(lines).toEqual(["dropped the development DB clone k1"])
})

test("drop retries after the default waits, then succeeds", () => {
  const { db, calls, sleeps, lines } = isolation([failed(), failed(), ok()])
  expect(db.drop("k1")).toBe(true)
  expect(calls).toHaveLength(3)
  expect(sleeps).toEqual([3_000, 10_000])
  expect(lines).toEqual([
    "the DB clone k1 is still in use; retrying the drop",
    "the DB clone k1 is still in use; retrying the drop",
    "dropped the development DB clone k1",
  ])
})

test("drop that never succeeds warns how to drop by hand and returns false", () => {
  const { db, calls, lines } = isolation([], [0, 0])
  expect(db.drop("k1")).toBe(false)
  expect(calls).toHaveLength(2)
  expect(lines).toEqual([
    "the DB clone k1 is still in use; retrying the drop",
    "WARNING: could not drop the DB clone k1 (run: clone-db k1 drop)",
  ])
})

test("drop sleeps for real by default, between attempts only", () => {
  const db = commandDbIsolation({
    command: "clone-db",
    cwd: ".",
    parse: () => ({}),
    dropWaits: [12],
    log: () => {},
    run: () => failed(),
  })
  const before = Date.now()
  expect(db.drop("k1")).toBe(false)
  expect(Date.now() - before).toBeGreaterThanOrEqual(8)
})

test("the default runner reports a command that cannot start, and logs to the console", () => {
  const db = commandDbIsolation({
    command: "/nonexistent/flowreel-clone-script",
    cwd: ".",
    parse: () => ({}),
    dropWaits: [0],
  })
  expect(() => db.create("k1")).toThrow(/failed: .*ENOENT/)
  const log = console.log
  const lines: string[] = []
  console.log = (l: string) => lines.push(String(l))
  try {
    expect(db.drop("k1")).toBe(false)
  } finally {
    console.log = log
  }
  expect(lines).toEqual([
    "WARNING: could not drop the DB clone k1 (run: /nonexistent/flowreel-clone-script k1 drop)",
  ])
})

test("the default runner runs the command with the key and reads its output (node running a throwaway script stands in for a clone script)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-db-"))
  try {
    // `<command> <key>` is `node <script>`: the key is the script's path.
    const script = join(dir, "clone.js")
    writeFileSync(
      script,
      'if (process.argv[3] === "drop") process.exit(0); console.log("DATABASE=copy")',
    )
    const failing = join(dir, "fail.js")
    writeFileSync(
      failing,
      'console.error("no template\\nsecond"); process.exit(3)',
    )
    const lines: string[] = []
    const db = commandDbIsolation({
      command: process.execPath,
      cwd: dir,
      parse: (stdout) => ({ DATABASE: stdout.trim().replace("DATABASE=", "") }),
      dropWaits: [0],
      log: (l) => lines.push(l),
    })
    expect(db.create(script)).toEqual({ DATABASE: "copy" })
    expect(db.drop(script)).toBe(true)
    expect(lines).toEqual([`dropped the development DB clone ${script}`])
    expect(() => db.create(failing)).toThrow("failed: no template second")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
