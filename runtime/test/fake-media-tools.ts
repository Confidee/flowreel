// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

// Stand-ins for ffmpeg and ffprobe, put first on PATH for a test: they log
// every call (tool + arguments) and answer from a list of rules, so the
// code under test runs its real child-process path with no media tools.

export interface FakeRule {
  tool: "ffmpeg" | "ffprobe"
  /** Matches when the space-joined arguments contain this text. */
  match?: string
  stdout?: string
  stderr?: string
  /** Exit code (default 0). */
  code?: number
  /** Write an (empty) file at the last argument, as an encoder would. */
  write?: boolean
}

export interface FakeCall {
  tool: string
  args: string[]
}

const SCRIPT = (cfg: string) => `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfg)}, "utf8"))
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(cfg.log, JSON.stringify({ tool, args }) + "\\n")
const joined = args.join(" ")
const rule = cfg.rules.find(
  (r) => r.tool === tool && (r.match === undefined || joined.includes(r.match)),
)
if (!rule) process.exit(0)
if (rule.write) fs.writeFileSync(args[args.length - 1], "")
if (rule.stdout) process.stdout.write(rule.stdout)
if (rule.stderr) process.stderr.write(rule.stderr)
process.exit(rule.code ?? 0)
`

export class FakeMediaTools {
  readonly dir = mkdtempSync(join(tmpdir(), "flowreel-fake-tools-"))
  private readonly cfgPath = join(this.dir, "cfg.json")
  private readonly logPath = join(this.dir, "calls.log")
  private savedPath: string | undefined

  constructor() {
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const file = join(this.dir, tool)
      writeFileSync(file, SCRIPT(this.cfgPath))
      chmodSync(file, 0o755)
    }
    this.rules([])
  }

  /** Replaces the rules (first match wins) and clears the call log. */
  rules(rules: FakeRule[]): void {
    writeFileSync(this.cfgPath, JSON.stringify({ log: this.logPath, rules }))
    writeFileSync(this.logPath, "")
  }

  calls(): FakeCall[] {
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall)
  }

  /** Puts the fakes first on PATH. */
  install(): void {
    this.savedPath = process.env.PATH
    process.env.PATH = `${this.dir}${delimiter}${this.savedPath ?? ""}`
  }

  uninstall(): void {
    if (this.savedPath === undefined) delete process.env.PATH
    else process.env.PATH = this.savedPath
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Rules for a healthy install: both tools answer, libx264 listed. */
export const HEALTHY: FakeRule[] = [
  { tool: "ffmpeg", match: "-encoders", stdout: " V....D libx264  H.264\n" },
]
