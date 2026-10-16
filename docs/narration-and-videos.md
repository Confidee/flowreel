# Narration and videos

Every flowreel run can produce branded MP4s from its own recording. At demo
pace, a voice explains each step. This page covers what the videos contain,
how pace, holds and narration fit together, how to make the videos look and
sound like your product, and how demos are published.

Two rules hold throughout:

- **Videos never decide anything.** They are made after the verdict is
  fixed. A video that cannot be made is reported as
  `video: not produced (<reason>)`, and narration that cannot be made as
  `narration: not produced (<reason>)` (the silent video is made instead).
- **Nothing sensitive is shown or spoken.** Email cards redact tokens and
  links. Narration removes addresses, links, ids and tokens. On staging,
  table rows that do not belong to the run are blurred.

- [What gets made](#what-gets-made)
- [Pace, slow motion and holds](#pace-slow-motion-and-holds)
- [Narration](#narration)
- [Voices](#voices)
- [Your video kit](#your-video-kit)
- [Redaction and the privacy mask](#redaction-and-the-privacy-mask)
- [The demos folder](#the-demos-folder)
- [Requirements and performance](#requirements-and-performance)

## What gets made

All videos are H.264, 1920x1080, 25 fps. The app is recorded at 1680x945
and placed 1:1 in the frame (never scaled), with a brand strip above it and
a caption bar below it, so captions never cover the app's controls. A
narrated video carries an AAC audio track.

### Round-trip video: `<RUN_ID>/<module>-<RUN_ID>.mp4`

1. **Intro card**: logo on the brand gradient, run title, target, run id
   and start time.
2. **The recording**, cut between the email cards, with one caption per
   step: the step code, its plain-language title and a status badge
   (Passed or Failed).
3. **Email cards** wherever the flow recorded mail with `videoLog.mail()`:
   From, To, Reply-To, Subject and a short body excerpt, redacted.
4. **Outro card**: the verdict, every step with its status and duration,
   and the latencies the flow noted (`latency.*` facts).

### Tour videos

- **Per feature**, a reel: its recording, a caption per step, email cards,
  and "as <persona>" badges where the recorded page switched persona.
- **Per area**, `<RUN_ID>/tour-<letter>-<RUN_ID>.mp4`: an area intro, then
  for each feature a 1.5 s title card (id, title, policy badge) and its
  reel. A development-only or not-run feature gets a 3 s card with the
  reason instead, and a read-only feature on staging gets a "Read-only on
  staging" card before its reel. The video ends with the area scoreboard.
- **The full tour**, `<RUN_ID>/<module>-<RUN_ID>.mp4`: a tour intro, a
  chapter card per area followed by the same feature parts, then a
  summary page and the full scoreboard. `summary.md` gives each feature's
  start time in this file.

Each part is encoded once with identical settings, so the area and tour
files are joined without a second encode.

### Pipeline video: `<PIPELINE_ID>/<module>-<PIPELINE_ID>.mp4`

A pipeline intro, a chapter card per stage, each stage's body (re-using the
stage's own cuts and cards, without re-recording), and a comparison card
that puts development and staging side by side, step by step or feature by
feature.

### Building blocks on disk

`<RUN_ID>/video/` holds the cards as PNG, `timeline.json` (every cut point)
and `reel.json` or `tour.json` (what a pipeline needs to splice the run in).
If the captions look out of step with the picture, `timeline.json` shows
where the cuts were made.

## Pace, slow motion and holds

| Pace             | While the flow runs                          | In the video                                                                                                                    |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `demo` (default) | browser slowMo 650 ms; `pause()` holds 1.8 s | every recorded piece plays at 1/`FLOWREEL_SLOW_FACTOR` speed (default 1.5, so two-thirds speed); never fast-forwarded; narrated |
| `qa`             | no slowMo, no pauses                         | real time; any stretch longer than 20 s (a mail or status wait) is played faster, up to 20x, with a badge; silent               |

At demo pace a long wait plays in **real time** (not slowed down) with a
"Waiting for the email to arrive…" badge, and the step's sentence gets one
short wait line. Nothing in a demo video is ever sped up.

**Holds** make the narration fit without cutting a sentence off:

- Each step's sentence starts when its caption appears. If the sentence
  (plus a 0.4 s gap) is longer than the step's time on screen, the last
  frame is held until it ends.
- Each card (intro, email, title, scoreboard) stays up at least
  0.3 s + the sentence + 0.6 s, and never less than its normal length.
- Holds only ever add time. Without narration the timeline is unchanged.

Default card lengths: intro 3 s, email 4 s, outro 5 s, feature title 1.5 s,
area intro 3 s, tour intro 4 s, scoreboard 4 s, pipeline intro 4 s,
comparison 7 s. 0.5 s of recording is kept before the first step and 1.5 s
after the last one, so a failure's end state is visible.

## Narration

### When it is on

| Run               | Default | Override                                                  |
| ----------------- | ------- | --------------------------------------------------------- |
| Tour at demo pace | on      | `--narration off` or `FLOWREEL_NARRATION=off`             |
| Tour at qa pace   | off     | `--narration on` or `FLOWREEL_NARRATION=on`               |
| Round trip        | off     | `--narration on`: the video is then composed at demo pace |

`FLOWREEL_NARRATION=off` also silences the combined pipeline video.

### What is said

By default, **every step is spoken as its title's sentence**:
`"B1.1 The agent assigns the order to themselves"` is said as "The agent
assigns the order to themselves." A new step is narrated with no extra
work. Everything else comes from your `NarrationCopy`, whose defaults are
neutral English.

To say something better, add **curated lines** in
`e2e/flowreel/narration/<module>.json`. For a tour, the module is
`tour-<letter>`, so area B's lines are in `tour-b.json`.

```json
{
  "_comment": "keys starting with _ are ignored",
  "B1": "Assignment. Every order has one owner, so nothing falls between two chairs.",
  "B1.1": "The agent assigns the order to themselves.",
  "B1.2": "The order now shows in the agent's own queue.",
  "B8.4.email": "The customer receives the agent's reply by email.",
  "area": "Area B, the order workspace. {COUNT} features.",
  "outro": "{PASSED} of {COUNT} features passed."
}
```

| Key                                                                 | Spoken on                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| full step title                                                     | that step (use this only when a step's title differs between targets)                       |
| step code, `"B1.1"`                                                 | that step                                                                                   |
| feature id, `"B1"`                                                  | the feature's title card                                                                    |
| `"<code>.email"`                                                    | the email card recorded in that step; `"<code>.email.2"` for a second card in the same step |
| `"<feature id>.email"`                                              | an email card whose label has no step code                                                  |
| `"area"`, `"outro"`                                                 | a tour area's intro card and its scoreboard                                                 |
| `"intro"`, `"outro.pass"`, `"outro.fail"`, `"outro.n/a"`, `"outro"` | the round trip's intro and outro cards                                                      |

Placeholders: `{COUNT}`, `{PASSED}` and `{FAILED}` are filled with numbers.
Any other `{NAME}` is said as `NarrationCopy.placeholders[NAME]` (by
default `{RUN_ID}` is said as "this run"), or as "it" if unknown.

A **failed step** adds "This step failed: <short reason>." The reason is a
category (timed out, unreachable, refused, …), never the error text.

### Writing good lines

- One or two plain sentences, present tense, with a subject: "The admin
  deletes it.", not "Then delete it." A card or a hold can come between two
  lines, so each must stand on its own.
- Say what the user does **and why it matters**. The caption already shows
  what happens.
- Never put an address, a link, a record number, an id or a token in a
  line. They would be removed anyway, and the sentence would read badly.
- Add a unit test that fails when a step has no line or a key no longer
  matches a step, so lines never go stale. `/flowreel:init` scaffolds one
  (`e2e/flowreel/unit/narration.spec.ts`, run by `npm run flowreel:unit`),
  and `/flowreel:narrate` runs it after writing the lines.

### Never spoken

Before anything is spoken, these are removed, in this order:

1. A QA subject prefix (`[QA …]`).
2. Email addresses.
3. Links (`http://`, `https://`, `www.`).
4. Run ids (`loc-…`, `stg-…`).
5. **Your own patterns**: `NarrationCopy.speakablePatterns`, for example
   record numbers and internal ids.
6. Any opaque token: 16 or more letters, digits, `_` or `-`, with at least
   one letter and one digit.

`narration.unspeakableParts(text)` names what a line contains that would be
removed. Use it in a unit test over your curated lines.

## Voices

| Platform  | Engine   | What happens                                                                                                                                                  |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS     | `macos`  | `say` with the best installed English voice: a Premium voice (preferring Ava, Zoe, Jamie), then an Enhanced one, then Samantha with a warning in the summary. |
| Linux, CI | `none`   | No narration. `narration: not produced (no voice engine on this platform)`. The video is silent.                                                              |
| any       | your own | A `VoiceEngine` passed to `createVideoKit({ voice: { engine } })`. See [Adapters](adapters.md#voiceengine).                                                   |

Settings:

- `FLOWREEL_VOICE="Zoe (Premium)"` picks an exact voice. `say -v '?'` lists
  the installed ones.
- `FLOWREEL_VOICE_RATE=160` sets words per minute (90 to 360, default 175).
- `FLOWREEL_VOICE_ENGINE=none` forces silent videos.
- `FLOWREEL_SLOW_FACTOR=1.25` plays recordings faster at demo pace (1 to 3).

Each clip is normalised to −16 LUFS, 48 kHz mono, and cached by a hash of
the engine, voice, rate, clip format and text, in `FLOWREEL_VOICE_CACHE_DIR`
(default `.flowreel/cache/voice`). A re-run only synthesizes changed lines.
The summary reports `narration: <voice> (n lines, m synthesized, k cached)`.
The text is always passed to `say` and ffmpeg as an argument, never through
a shell.

`piper` and `azure` are reserved engine names. Selecting them today gives a
silent video with "not built yet".

## Your video kit

Everything a project's videos are made with comes from one object, built
once in your adapter:

```ts
import {
  createVideoKit,
  defineBrand,
  defineCardCopy,
  defineNarrationCopy,
  svgDataUri,
} from "@confidee/flowreel/video"

export const kit = createVideoKit({
  brand: defineBrand({
    name: "Acme",
    colors: { primary: "#1d4ed8", accent: "#60a5fa" },
    logos: () => ({
      onBrand: svgDataUri("e2e/flowreel/brand/logo-white.svg"), // on the gradient
      onLight: svgDataUri("e2e/flowreel/brand/logo.svg"), // on white cards
    }),
  }),
  copy: defineCardCopy({
    run: { title: "Checkout round trip" },
    stepTitles: { "S1 place-order": "The customer pays with a saved card" },
    latencyLabels: { orderToMailMs: "Order to confirmation email" },
    standby: { heading: "Customer's browser", line: "Checkout round trip" },
  }),
  narrationCopy: defineNarrationCopy({
    featureId: "[A-H]\\d{1,2}",
    speakablePatterns: [{ name: "an order number", pattern: /\bORD-\d+\b/g }],
    roundTrip: { intro: "This is the checkout round trip." },
  }),
  narrationDir: "e2e/flowreel/narration",
  // voice: { engine, cacheDir, log }
})
```

The video producers (`produceVideo`, `produceTourVideos`,
`produceCombinedVideo`, `produceCombinedTourVideo`) take the kit. Your
reporter and pipeline pass them on.

### Brand

| Field      | Meaning                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | the product name, used as the logos' alternative text                                                                                                                                       |
| `colors`   | `primary`, `accent` (the gradient and accents), `ink`, `muted`, `body`, `line`, `tint`, `tintLine`, `quote`, `shadow`, and the outcome colours `pass`, `fail`, `neutral`, `skip`, `devOnly` |
| `gradient` | the CSS background of full-frame cards. Default: 135° from `primary` to `accent`                                                                                                            |
| `logos()`  | `{ onBrand, onLight }` as `data:` URIs, or null for no logo. Called once per video, so a logo changed on disk shows in the next video                                                       |

Any CSS colour works. A 3- or 6-digit hex colour is the most compact,
because translucent shadows and badges are derived from it.
`NEUTRAL_BRAND` is a slate theme with no logo.

### CardCopy

Every visible word on the cards. You override only what you name
differently. The main groups: `stepTitles` and `stepCode` (how step ids
become captions), `run` (title, subtitle and target pill), `standby`,
`mail`, `caption`, `outro`, `latencyLabels`, `speedBadge`, `waitBadge`,
`pipeline` and `tour` (titles, policy names, status names, scoreboard
wording). Fields documented as HTML are inserted as they are, so escape
anything you interpolate into them. The full list, with defaults, is
`DEFAULT_CARD_COPY` in `runtime/src/video/copy.ts`.

### NarrationCopy

The spoken counterpart: `speakablePatterns`, `placeholders`, `featureId`,
`featureFallback`, `failure` (categories and line), `email`
(received, reply, sent), `waitLines`, `waitCaptions`, `roundTrip`
(intro, outro) and `tour` (intro, area intro, chapter, dev-only, view,
not run, area outro, summary, scoreboard). Defaults:
`DEFAULT_NARRATION_COPY` in `runtime/src/narration/copy.ts`.

## Redaction and the privacy mask

**Email cards.** `mailCard()` redacts when a flow records a card, and the
card is redacted again when rendered:

- `reply+<token>@` and `notify+<token>@` addresses keep only the prefix and
  the domain (`reply+…@example.com`), because those tokens thread a reply
  into a record;
- any other plus tag of 16 or more characters is cut the same way;
- links become `[link]`;
- opaque strings of 32 or more characters with a digit become `[redacted]`;
- the excerpt drops quoted history, rule lines, "reply above this line"
  markers and mail-sandbox interception banners.

**Privacy mask (staging only).** On staging, the recorded page can show
real people's data on listing and admin pages. Install `installPrivacyMask`
on the recorded page with `addInitScript`. Every table row (`tbody tr` and
ARIA `row`) is then blurred from its first frame, unless its text contains
one of the keep-list strings (the run id, a QA persona's or mailbox's
address). Pages whose path matches your `unmasked` pattern are left alone.
The mask is a CSS filter: it changes neither the DOM text nor what
Playwright considers visible, so assertions are unaffected. Development
recordings are never masked, because they show seed data only.

Treat staging videos as internal QA evidence. Make demo and training videos
from development runs.

## The demos folder

After a **demo-pace development run** that produced videos, the reporter
copies them to your `DemoCatalogue.dir` (for example
`flowreel-demos/latest/`) under fixed names, replacing the previous ones:

```text
flowreel-demos/latest/
├── 00-<round trip>.mp4               the round trip (when narrated, i.e. demo pace)
├── 01-area-A-<area title>.mp4        one per tour area, in order
├── 02-area-B-<area title>.mp4
├── NN-<full tour>.mp4                only from a run of every area
├── demos.json                        what each file is, from which run
└── README.md                         run, date, target, voice, pace and verdict per file
```

The rules:

- A **qa-pace** run never touches `latest/`.
- **Automatic publishing** happens only for the catalogue's development
  target (default `local`), and never replaces a passing video with a
  failing one.
- A **staging** run reaches `latest/` only when you publish it on purpose:
  your demos command, built on `demosCli`, or `/flowreel:demos <RUN_ID>`.
  It exits 0 when something was published, 1 when nothing was (with the
  reason), and 64 for a bad argument.
- The run id argument is checked against your `runIdPattern`. Anything
  path-like (a separator or `..`) is refused whatever the pattern says.
- The run folders stay where they are as the evidence. `latest/` is a copy.

`latest/` can show staging data and must be git-ignored. Share it the way
you share other internal recordings.

## Requirements and performance

- ffmpeg and ffprobe with `libx264` on `PATH`. The runtime checks this
  (`ffmpegProblem()`) and reports the missing piece as the "not produced"
  reason.
- Chromium (installed for Playwright) renders the cards.
- macOS with a downloaded voice for narration.
- `--no-video` or `FLOWREEL_VIDEO=off` skips all of it. This is the fastest
  loop while writing flows.
- A demo-pace tour takes much longer than a qa-pace one: slowMo, pauses,
  holds and two-thirds playback all add up. Budget for it in CI. The
  session keepalive (default limit 2 hours) covers long runs.
