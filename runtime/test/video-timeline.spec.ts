// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { composeArgs } from "../src/video/ffmpeg.js"
import {
  DEFAULT_TIMELINE,
  type Segment,
  type TimelineStep,
  buildTimeline,
} from "../src/video/timeline.js"

const step = (
  id: string,
  startSec: number,
  endSec: number,
  status: TimelineStep["status"] = "passed",
): TimelineStep => ({ id, startSec, endSec, status })

const kinds = (segments: Segment[]) =>
  segments.map((s) => (s.kind === "email" ? `email${s.mail}` : s.kind))

test.describe("buildTimeline", () => {
  test("intro, app cut at each mail moment, email cards, outro", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps: [step("T1 inbound", 2, 6), step("T2 open", 6, 10)],
      mail: [{ atSec: 3 }, { atSec: 8 }],
    })
    expect(kinds(timeline.segments)).toEqual([
      "intro",
      "app",
      "email0",
      "app",
      "email1",
      "app",
      "outro",
    ])
    const apps = timeline.segments.filter((s) => s.kind === "app")
    // Lead-in 0.5 s before the first step, tail 1.5 s after the last.
    expect(apps.map((s) => [s.fromSec, s.toSec])).toEqual([
      [1.5, 3],
      [3, 8],
      [8, 11.5],
    ])
    expect(apps.every((s) => s.speed === 1)).toBe(true)
    expect(timeline.app).toEqual({ fromSec: 1.5, toSec: 11.5 })
    const { introSec, emailSec, outroSec } = DEFAULT_TIMELINE
    expect(timeline.durationSec).toBe(
      introSec + 2 * emailSec + outroSec + (11.5 - 1.5),
    )
  })

  test("captions stay on the source clock and hold until the next one", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps: [
        step("T1 inbound", 2, 6),
        step("T4 customer receives", 6, 9, "failed"),
      ],
      mail: [{ atSec: 4 }],
    })
    expect(timeline.captions).toEqual([
      { step: 0, fromSec: 2, toSec: 6 },
      // The last caption covers the 1.5 s tail (a failure's end state).
      { step: 1, fromSec: 6, toSec: 10.5 },
    ])
  })

  test("a gap between two steps keeps the earlier caption on screen", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps: [step("T2 open", 2, 4), step("T3 public reply", 5, 7)],
      mail: [],
    })
    expect(timeline.captions).toEqual([
      { step: 0, fromSec: 2, toSec: 5 },
      { step: 1, fromSec: 5, toSec: 8.5 },
    ])
  })

  test("orders cards by time but keeps their recorded index", () => {
    const timeline = buildTimeline({
      videoDurationSec: 20,
      steps: [step("T1 inbound", 1, 10)],
      mail: [{ atSec: 7 }, { atSec: 2 }],
    })
    expect(kinds(timeline.segments)).toEqual([
      "intro",
      "app",
      "email1",
      "app",
      "email0",
      "app",
      "outro",
    ])
  })

  test("back-to-back cards drop the empty app segment between them", () => {
    const timeline = buildTimeline({
      videoDurationSec: 20,
      steps: [step("T1 inbound", 1, 10)],
      mail: [{ atSec: 5 }, { atSec: 5.01 }],
    })
    expect(kinds(timeline.segments)).toEqual([
      "intro",
      "app",
      "email0",
      "email1",
      "app",
      "outro",
    ])
  })

  test("clamps the kept window and mail moments to the recording", () => {
    const timeline = buildTimeline({
      videoDurationSec: 8,
      steps: [step("T1 inbound", 0.2, 12)],
      mail: [{ atSec: -1 }, { atSec: 99 }],
    })
    expect(timeline.app).toEqual({ fromSec: 0, toSec: 8 })
    expect(kinds(timeline.segments)).toEqual([
      "intro",
      "email0",
      "app",
      "email1",
      "outro",
    ])
    expect(timeline.captions).toEqual([{ step: 0, fromSec: 0.2, toSec: 8 }])
  })

  test("a long mail wait is played faster, capped at maxSpeed", () => {
    const timeline = buildTimeline(
      {
        videoDurationSec: 400,
        steps: [step("T4 customer receives", 0.5, 390)],
        mail: [{ atSec: 100.5 }],
      },
      { maxAppSegmentSec: 20, maxSpeed: 10, leadInSec: 0, tailSec: 0 },
    )
    const apps = timeline.segments.filter((s) => s.kind === "app")
    expect(apps[0]).toMatchObject({ fromSec: 0.5, toSec: 100.5, speed: 5 })
    expect(apps[0].durationSec).toBeCloseTo(20, 2)
    // 289.5 s would need 14.5x; capped at 10x.
    expect(apps[1].speed).toBe(10)
    expect(apps[1].durationSec).toBeCloseTo(28.95, 2)
  })

  test("only the waits are sped up, never a UI step between them", () => {
    // Staging shape: T1's inbound wait, a 10 s UI step, T4's mail wait, all in
    // one card-to-card stretch.
    const timeline = buildTimeline({
      videoDurationSec: 240,
      steps: [
        step("T1 inbound", 5, 105),
        step("T2 open", 105, 115),
        step("T4 customer receives", 115, 215),
      ],
      mail: [{ atSec: 6 }, { atSec: 215 }],
    })
    const apps = timeline.segments.filter((s) => s.kind === "app")
    expect(apps.map((s) => [s.fromSec, s.toSec, s.speed])).toEqual([
      [4.5, 6, 1],
      [6, 105, 4.95],
      [105, 115, 1],
      [115, 215, 5],
      [215, 216.5, 1],
    ])
  })

  test("adjacent real-time pieces merge, and no sliver is cut", () => {
    const timeline = buildTimeline({
      videoDurationSec: 60,
      steps: [
        step("T2 open", 2, 8),
        step("T3 public reply", 8, 8.2),
        step("T4 customer receives", 8.2, 40),
      ],
      mail: [],
    })
    const apps = timeline.segments.filter((s) => s.kind === "app")
    // 8.2 is within minSegmentSec of 8, so it does not cut.
    expect(apps.map((s) => [s.fromSec, s.toSec, s.speed])).toEqual([
      [1.5, 8, 1],
      [8, 40, 1.6],
      [40, 41.5, 1],
    ])
  })

  test("a step open when the test timed out stays red to the end", () => {
    // produceVideo maps a never-ended step to the recording's end.
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps: [step("T1 inbound", 2, 6), step("T2 open", 6, 30, "failed")],
      mail: [{ atSec: 3 }],
    })
    expect(timeline.app).toEqual({ fromSec: 1.5, toSec: 30 })
    expect(timeline.captions.at(-1)).toEqual({ step: 1, fromSec: 6, toSec: 30 })
  })

  test("drops invalid steps and still frames a run without mail", () => {
    const timeline = buildTimeline({
      videoDurationSec: 10,
      steps: [step("T2 open", 3, 2), step("T3 public reply", 2, 4)],
      mail: [],
    })
    expect(kinds(timeline.segments)).toEqual(["intro", "app", "outro"])
    expect(timeline.captions).toEqual([{ step: 1, fromSec: 2, toSec: 5.5 }])
  })

  test("no steps: the whole recording between intro and outro", () => {
    const timeline = buildTimeline({ videoDurationSec: 6, steps: [], mail: [] })
    expect(timeline.app).toEqual({ fromSec: 0, toSec: 6 })
    expect(timeline.captions).toEqual([])
  })
})

test.describe("composeArgs", () => {
  const timeline = buildTimeline(
    {
      videoDurationSec: 200,
      steps: [step("T1 inbound", 1, 4), step("T4 customer receives", 4, 150)],
      mail: [{ atSec: 3 }],
    },
    { maxAppSegmentSec: 20 },
  )
  const args = composeArgs(timeline, {
    appVideo: "/r/video.webm",
    frame: "/r/frame.png",
    captions: ["/r/caption-1.png", "/r/caption-2.png"],
    speedBadges: { 4: "/r/speed-4.png" },
    intro: "/r/intro.png",
    outro: "/r/outro.png",
    emails: ["/r/email-1.png"],
    output: "/r/module-loc.mp4",
  })
  const graph = args[args.indexOf("-filter_complex") + 1]

  test("H.264, yuv420p, faststart, no audio, output last", () => {
    expect(args.join(" ")).toContain(
      "-an -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -r 25 -movflags +faststart /r/module-loc.mp4",
    )
    expect(args.at(-1)).toBe("/r/module-loc.mp4")
  })

  test("captions overlay on the source clock before the cut", () => {
    expect(graph).toContain("enable='between(t,1,4)'")
    expect(graph).toContain("enable='between(t,4,151.5)'")
    expect(graph.indexOf("between(t,1,4)")).toBeLessThan(graph.indexOf("trim="))
  })

  test("cards are looped stills of their own duration", () => {
    expect(args.join(" ")).toContain(
      "-loop 1 -framerate 25 -t 3 -i /r/intro.png",
    )
    expect(args.join(" ")).toContain(
      "-loop 1 -framerate 25 -t 4 -i /r/email-1.png",
    )
    expect(args.join(" ")).toContain(
      "-loop 1 -framerate 25 -t 5 -i /r/outro.png",
    )
  })

  test("splits the recording per app segment and speeds up the long one", () => {
    // [0.5, 3] | card | [3, 4] T1's end | [4, 150] T4's wait | [150, 151.5]
    expect(graph).toContain("split=4")
    expect(graph).toContain("trim=start=3:end=4,setpts=PTS-STARTPTS,")
    expect(graph).toMatch(
      /trim=start=4:end=150,setpts=\(PTS-STARTPTS\)\/[\d.]+/,
    )
    expect(graph).toContain("trim=start=150:end=151.5,setpts=PTS-STARTPTS,")
    expect(graph).toContain("concat=n=7:v=1:a=0[out]")
    expect(args).toContain("/r/speed-4.png")
  })
})
