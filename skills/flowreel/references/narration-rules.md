<!-- Generated from plugin/skills/narrate/reference/narration-rules.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

# Narration rules

What flowreel says in a narrated video and how it picks the line. The
runtime reads `<narration dir>/<module>.json` (`narrationDir` in the
project's video kit; the scaffold uses `e2e/flowreel/narration/`).

## Contents

- How a line is chosen
- Keys
- Placeholders
- Never spoken
- Style
- Voices and pace

## How a line is chosen

For every step the video shows, the narrator looks up, in order: the full
step title (for a step whose title differs per target), the step code
(`S1`, `A4.1`), and otherwise says the caption sentence of the step title
itself. A feature's title card uses the feature id (`A4`); with no line it
says "Feature A4: list search." (the copy's fallback from its slug). Email cards use `<code>.email` (the step's code,
else the feature id; `.email.2` for a second card of the same step), else
the copy's default "received" / "sent" sentence. A failed step adds "This
step failed: <short reason>." from the copy (never the error text).

## Keys

| Video      | Keys                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| round trip | `intro`, `outro.pass`, `outro.fail`, `outro.n/a`, `outro` (fallback), step codes, `<code>.email` |
| tour area  | `area` (area intro), `outro` (area scoreboard), feature ids, step codes, `<code>.email`          |

Keys starting with `_` are comments (`_comment` explains the file).

## Placeholders

`{COUNT}`, `{PASSED}`, `{FAILED}` (filled with the numbers), plus any the
project's narration copy defines as `placeholders`. Any other `{NAME}` is
said as "it": do not invent new ones.

## Never spoken

flowreel removes these before speaking, in every project: `[QA …]`
subject prefixes, email addresses, links, run ids (`loc-…`, `stg-…`), and
opaque tokens (16+ characters mixing letters and digits). A project adds
its own (record numbers, internal ids) as `speakablePatterns` in its
narration copy. Removal leaves a gap in the sentence, so never write them
in the first place. Also never: passwords, names of real people or
customers, and any word the project's vocabulary guard forbids.

## Style

- Present tense, second or third person ("The agent assigns the record to
  themselves."), plain words, one idea per sentence.
- Say why it matters, not how the test checks it: "so a queue means the
  same thing to everyone", not "the assertion verifies the row count".
- Name UI elements as the user sees them ("the views menu"), never CSS,
  test ids or file names.
- Feature lines: "<Feature name>. <one sentence of purpose>."
- Outros state the result neutrally with placeholders; never claim a pass
  in a line that is also said on a failure (that is what `outro.pass` /
  `outro.fail` are for).

## Voices and pace

- macOS `say` with a Premium voice (`FLOWREEL_VOICE` picks an exact one;
  rate `FLOWREEL_VOICE_RATE`, 90-360 words per minute, default 175).
  Without a Premium voice the run warns and uses a standard one. Clips are
  cached in `.flowreel/cache/voice` (`FLOWREEL_VOICE_CACHE_DIR`).
- Narration is on by default at the tour's demo pace, off at qa pace and
  for the round trip; `--narration on|off` overrides. The demo pace slows
  the recording (never speeds it up) and the video waits for each line.
- A narration problem never changes a verdict: the summary says
  `narration: not produced (<reason>)`.
