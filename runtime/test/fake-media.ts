// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import type { PngJob } from "../src/video/render.js"

// Hermetic stand-ins for ffmpeg and ffprobe: two tiny node scripts put first
// on PATH. They record every invocation (one JSON argv per line), write an
// empty file at the output path and answer the probes deterministically, so
// the video producers run end to end with no real encoder and no browser.
//
//   ffprobe  <name>.webm        -> 30 s (a page recording)
//            <name>-<n>.mp4     -> n + 0.02 s (an encoded card still)
//            <name>-reel.mp4    -> 12 s
//            anything else      -> 9.96 s (a joined video)
//            audio probes       -> a stream index unless the path matches
//                                  FAKE_NOAUDIO (a regex)
//   ffmpeg   any invocation whose argv matches FAKE_FAIL (a regex) fails
//            with "fake ffmpeg refused" on stderr.

const FFMPEG = `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args.includes("-version")) process.exit(0)
if (args.includes("-encoders")) { console.log(" V..... libx264"); process.exit(0) }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "ffmpeg", args }) + "\\n")
const fail = process.env.FAKE_FAIL
if (fail && new RegExp(fail).test(args.join(" "))) {
  console.error("fake ffmpeg refused\\nsecond line")
  process.exit(1)
}
fs.writeFileSync(args[args.length - 1], "")
`

const FFPROBE = `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args.includes("-version")) process.exit(0)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "ffprobe", args }) + "\\n")
const path = args[args.length - 1]
if (args.includes("stream=index")) {
  const none = process.env.FAKE_NOAUDIO
  console.log(none && new RegExp(none).test(path) ? "" : "1")
  process.exit(0)
}
const named = /-(\\d+(?:\\.\\d+)?)\\.mp4$/.exec(path)
if (path.endsWith(".webm")) console.log("30")
else if (path.endsWith("-reel.mp4")) console.log("12")
else if (named) console.log(String(Number(named[1]) + 0.02))
else console.log("9.96")
`

export interface Call {
  tool: "ffmpeg" | "ffprobe"
  args: string[]
}

export interface FakeMedia {
  /** A scratch directory for the test's own files. */
  dir: string
  /** Every recorded invocation, oldest first. */
  calls(tool?: Call["tool"]): Call[]
  /** Restores PATH and the FAKE_* variables and removes the directory. */
  restore(): void
}

const VARS = ["PATH", "FAKE_LOG", "FAKE_FAIL", "FAKE_NOAUDIO"] as const

/**
 * Puts the fakes first on PATH for this process (child processes inherit it).
 * `fail` / `noAudio` set FAKE_FAIL / FAKE_NOAUDIO. `tools: false` leaves PATH
 * with an empty directory only, so ffmpeg is "not installed".
 */
export function installFakeMedia(
  options: { fail?: string; noAudio?: string; tools?: boolean } = {},
): FakeMedia {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-fake-media-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  if (options.tools !== false) {
    for (const [name, source] of [
      ["ffmpeg", FFMPEG],
      ["ffprobe", FFPROBE],
    ]) {
      writeFileSync(join(bin, name), source)
      chmodSync(join(bin, name), 0o755)
    }
  }
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]))
  const log = join(dir, "calls.jsonl")
  writeFileSync(log, "")
  process.env.FAKE_LOG = log
  process.env.PATH =
    options.tools === false ? bin : `${bin}${delimiter}${saved.PATH ?? ""}`
  for (const [key, value] of [
    ["FAKE_FAIL", options.fail],
    ["FAKE_NOAUDIO", options.noAudio],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const calls = (tool?: Call["tool"]): Call[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call)
      .filter((c) => !tool || c.tool === tool)
  return {
    dir,
    calls,
    restore() {
      for (const key of VARS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A renderer that records its jobs and writes an empty file per PNG. */
export function recordingRenderer() {
  const jobs: PngJob[] = []
  return {
    jobs,
    render: (batch: PngJob[]): Promise<void> => {
      for (const job of batch) {
        jobs.push(job)
        writeFileSync(job.path, "")
      }
      return Promise.resolve()
    },
  }
}
