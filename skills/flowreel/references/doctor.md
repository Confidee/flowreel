<!-- Generated from plugin/skills/doctor/SKILL.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

> In the plugin this workflow starts only when the user asks for it (`disable-model-invocation`). Here too: start it only on the user's request in this conversation.

# /flowreel:doctor

Checks what flowreel needs on this machine and in this project, explains
it, and helps install what is missing. **It installs nothing without the
user's explicit yes for that command.**

## 1. Check (read-only)

Run the plugin's check in report mode with Bash:

```bash
bash <this skill's folder>/scripts/check-prereqs.sh --report
```

It only reads (versions, the project's `"type"`, the Playwright download
cache, `ffmpeg -encoders`, `say -v '?'`, and, with grep, whether
`e2e/flowreel/adapter.ts` sets a request timeout), never installs and
always exits 0. The project is the folder it runs in (or `$CLAUDE_PROJECT_DIR` when set). Each line is `ok`, `missing`
(required: Node.js, `@playwright/test`, Chromium), `video-only` (ffmpeg,
ffprobe: only the MP4s need them), `voice-only` (`say`, a Premium voice:
only the narration), `optional`, `unchecked` or `advice` (an adapter
scaffolded before 0.4.0 opens request contexts without a timeout: say
what the 0.4.0 template adds, `REQUEST_TIMEOUT_MS` on every
`api.newContext` and on `SESSION`; the doctor never edits a project
file). A `note:` line explains the item above it. The last line counts the missing required items out of
three, and any unchecked ones.

`unchecked` means the tool resolves to a version manager's shim (Volta,
mise, asdf, nodenv, proto) or to a path inside the project, so the check
did not run it: those shims read project files, and a cloned repository
could make them download or run code. Do not run the tool silently. Tell
the user why, and either ask them to run the command the line names
(e.g. `node --version`) in the project, or offer to run it yourself
through the normal permission prompt after saying it runs the project's
version-manager configuration. Then apply the same rule as for a checked
version. Details: "Version managers" in
[references/prerequisites.md](references/prerequisites.md).

## 2. Explain

Show a short table: item, status, what flowreel uses it for, and the
install command from the check's output. The details per item (why, the
macOS and Linux commands, the voice download steps, what works without
it) are in [references/prerequisites.md](references/prerequisites.md); read
it when the user asks or an item is missing.

Say plainly what is optional: without ffmpeg there are no videos, but every
verdict still works; narration is off unless turned on, and the macOS
voices it uses are licensed by Apple for personal, non-commercial use only;
without a Premium voice narration falls back to a standard voice; off macOS videos are silent; psql is only for a Postgres
per-run database copy.

Node.js is checked against what the project needs: the runtime is
ESM-only, so a CommonJS project (no `"type": "module"`) needs Node 20.19+
/ 22.12+ / 23+, while an ESM project runs on any 20+. If the check says
Node is too old for a CommonJS project, offer upgrading Node first; adding
`"type": "module"` is the user's call (it changes how every `.js` file in
the project loads) and is never made by this skill.

## 3. Offer, then ask

For each missing item, propose its command and ask the user which ones to
run (e.g. "Install ffmpeg with `brew install ffmpeg`? yes / no"). Then:

- Run ONLY the commands the user confirmed, one at a time, showing each
  before it runs. Never combine them into one line the user did not see.
- Never run `sudo`, a curl-pipe-to-shell, or a global `npm i -g` unless the
  user confirmed that exact command.
- `npm i -D @playwright/test` (or `npm i -D @playwright/test@latest` to
  upgrade an older one) and `npx playwright install chromium` change the
  project (package.json, lockfile) or download a browser: say so before
  asking. On Linux the check proposes `npx playwright install --with-deps
chromium`, which also installs system libraries through `sudo apt`: say
  that too.
- Homebrew's `libpq` is keg-only: the check proposes `brew install libpq
&& brew link --force libpq`; show both commands, ask for each.
- The Premium voice cannot be installed from the terminal: give the
  System Settings steps and wait for the user.
- A failed install is reported with its last lines; never retry it on your
  own and never try an alternative installer without asking.

## 4. Re-check

Run the check again and report what is now `ok` and what is still missing.
If the project has no flowreel setup yet, suggest `/flowreel:init` next.

## Never

- Never install, upgrade or download anything without a yes for that exact
  command. The SessionStart hook never installs; neither does this skill
  on its own.
- Never read `.env*` files or the project's secrets file to "check" the
  staging configuration: that is diagnosed by a run's own messages.
