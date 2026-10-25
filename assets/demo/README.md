# flowreel demo

A 76-second narrated demo of flowreel, shown at the top of the
[README](../../README.md).

| File                                                       | What it is                                    |
| ---------------------------------------------------------- | --------------------------------------------- |
| [flowreel-demo.mp4](flowreel-demo.mp4)                     | The video: 1920x1080, 25 fps, H.264 and AAC   |
| [flowreel-demo-thumbnail.jpg](flowreel-demo-thumbnail.jpg) | Its thumbnail (1280x720), also embedded in it |
| [run/summary.md](run/summary.md)                           | The report of the flowreel run in the video   |

## What it shows

1. The flowreel logo and "Your tests are your demos."
2. flowreel as a plugin for Claude Code, and its npm runtime.
3. A flowreel recording of a small demo app, the Confidee demo app: a task
   list where Maya adds a task with a due date and completes it. Five
   steps, each with a caption and its verdict (Passed).
4. Credits and where to start.

The recording in part 3 is a real flowreel run: `@confidee/flowreel` 0.2.0
installed from npm, at the demo pace.

**The sound.** The video was first narrated with the macOS voice Ava
(Premium). Apple licenses its system voices for personal, non-commercial use
only (macOS licence, section 2F), so on 2026-10-25 the whole soundtrack was
re-voiced with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (voice
`af_heart`; Apache-2.0 weights, trained on permissively licensed audio): the
same 13 lines at the same moments, loudness-matched, with the picture
unchanged frame for frame. The run report below is kept exactly as flowreel
wrote it, so it still names the original voice. The run passed every step; its report is
[run/summary.md](run/summary.md), as flowreel wrote it. The report's
evidence links (the HTML report, traces, screenshots) point to files that
stay on the machine that ran it: traces hold session cookies, so flowreel's
run evidence is never published (see [SECURITY.md](../../SECURITY.md)).

The opening, the plugin screen and the credits were made separately from
HTML pages rendered frame by frame and joined to the recording with
ffmpeg; they are not flowreel output.

The README plays a copy of this video uploaded to GitHub, because GitHub
plays a video in a README only from its own uploads; the file here is the
original.

The flowreel name and logo appear in the video; see
[assets/brand](../brand/README.md) for how they may be used.
