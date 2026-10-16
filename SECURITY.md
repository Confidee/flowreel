# Security policy

flowreel drives real browsers against real environments, signs in as real
accounts and can send real email. We take reports about it seriously,
whether they concern the runtime, the stack adapters or the Claude Code
plugin.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a
security problem.**

Report it privately, in either of these ways:

- **GitHub private vulnerability reporting** (preferred): the repository's
  [Security tab -> "Report a vulnerability"](https://github.com/Confidee/flowreel/security/advisories/new).
  The report, the discussion and the fix stay private until the advisory
  is published.
- **Email** to **support@confidee.com**, with "flowreel security" in the
  subject. Use this if you cannot use GitHub. If you need to send
  something sensitive, ask for an encrypted channel in a first email
  without the details.

Please include:

- the flowreel version (runtime `package.json`, plugin `plugin.json`) and
  your Node.js and Playwright versions;
- what an attacker could do, and under which conditions;
- steps to reproduce, ideally against the `examples/minimal` app or a
  minimal project, never against a system you do not own;
- whether the problem is already public.

What happens next:

1. **Within 3 business days** we acknowledge your report.
2. **Within 10 business days** we confirm or dispute the problem, tell you
   our assessment of its impact, and agree a disclosure date with you. We
   aim to release a fix within 90 days of the report, sooner for severe
   problems, and keep you updated at least every two weeks until then.
3. We release a fix, publish a GitHub security advisory crediting you
   (unless you prefer not to be named), and note the fix in the changelog
   under "Security".

These are targets from a small team, not a contractual service level. If
you hear nothing within 3 business days, write again by the other route.

## Supported versions

flowreel is pre-release (0.x). Only the **latest released 0.x version**
receives security fixes; a fix ships as a new 0.x release, not as a patch
to an older one. Please upgrade before reporting.

| Version            | Security fixes |
| ------------------ | -------------- |
| latest 0.x release | yes            |
| older 0.x releases | no             |
| unreleased `main`  | best effort    |

Node.js: CI tests Node 20, 22, 24 and 26. Node 20 reached end-of-life on
2026-04-30 and is supported as **best effort** only: it stays in the test
matrix while it keeps working, but a problem that occurs only on Node 20
may be answered with "upgrade Node" rather than a fix, and support for it
may be dropped in a minor 0.x release. Use Node 22 or later.

## Scope

In scope: anything in this repository: the runtime
(`@confidee/flowreel` and its subpaths), the plugin (skills, agents,
hook, scripts, templates), the examples and the release workflow. In particular:

- a way to make a run target a production host, an unlisted host, or a
  non-loopback host as `local`;
- a way to make the mail send guard send to an address outside the
  configured domain;
- a secret (password, token, credential, cookie value) appearing in a log,
  an error message, `summary.*`, `pipeline.*`, a video or narration;
- a staging secret reaching the development stage's environment;
- a retry of a sign-in or a mail send;
- a failed restore or cleanup not reflected in the exit code;
- a plugin hook or skill that installs, downloads, writes or reads secrets
  without the user's confirmation, or a command the plugin runs that
  [docs/plugin.md](docs/plugin.md) does not list;
- a way for a cloned project to inject instructions into the model's
  context through the session-start check's output;
- prompt injection through run evidence or app content (a page snapshot,
  a screenshot, mail, a summary or the app's source) that makes a skill or
  agent run a command or edit a file it was not asked to;
- command injection through flow titles, narration text, run ids or file
  names.

Out of scope: vulnerabilities in your own application found _with_
flowreel (report those to the application's owner), in Playwright, Node.js,
ffmpeg or the OS voice tools (report those upstream), and findings that
require an attacker who can already edit your project's flowreel
configuration or code.

## Security posture

[docs/safety.md](docs/safety.md) explains each rule and why it exists. The
posture has two parts, and the difference matters:

- **Enforced by the runtime**: flowreel applies the rule itself, whatever
  your project code does.
- **Provided as an API**: flowreel ships the check, but it only applies
  where your mail driver, flow, fixture or adapter calls it. The shipped
  drivers and the Rails seam kit call the checks named below; in a driver,
  flow or seam you write, these rules hold only if your code calls them.

### Enforced by the runtime

**Targets**

- Production hosts are refused for every target, even when a policy lists
  them by mistake. Staging is an exact allowlist of `https://` origins.
  Local is a loopback host on a fixed port range.
- The target is read from the process environment only, never from a
  secrets file. Conflicting values under two names are refused.

**Runs and the verdict**

- `createConfig()` fixes `retries: 0` and one worker. A run that dies
  before writing a summary is a FAIL, and N/A is never counted as a pass.
- A failed or still-pending restore in the undo ledger makes the pipeline
  exit 4, which outranks every other exit code.

**Credentials and sessions**

- Global setup calls your adapter's `signIn` once per persona session and
  never retries it. The browser it hands to `signIn` is launched outside
  any traced test. Sessions are handed to workers in memory, never on disk.
- Teardown calls your adapter's `signOut` for every session, pass or fail,
  and warns loudly, naming the persona, when the adapter reports a session
  not revoked. The session keepalive is bounded, never signs in again, and
  is off under the debugger.
- A secrets file must be owner-only (`0600`), checked on the open
  descriptor. Local runs never read it. Messages name keys, never values.
- The pipeline strips `FLOWREEL_BASE_URL` and `FLOWREEL_ENV_FILE` (and
  their aliases) from the development stage's environment, plus every
  variable your `PipelineSpec.isSecret` matches. A custom
  `secrets.baseUrlKey` must also be matched by `isSecret`.

**Videos and narration**

- Video email cards redact reply tokens, long plus tags, links and opaque
  strings. Narration never speaks addresses, links, ids or tokens.
- Tools (`say`, `ffmpeg`, `ffprobe`) are called with argument arrays, never
  through a shell.

### Provided as an API your code must call

- **The mail send guard** (`assertReplyDomainRecipient`): on staging, mail
  goes only to one configured domain (exact match, one bare address),
  checked before any network call. It applies only where a mail driver or
  flow calls it:
  - the Microsoft 365 driver (`GraphMailDriver`, `/mail-graph`) calls it
    before every send and every reply;
  - the HTTP seam driver (`HttpSeamMailDriver`, `/rails-inertia`) does not.
    It talks only to the loopback local target, and the mail it "sends" is
    handed to the app's own inbound pipeline: it never leaves the app;
  - a driver you write must call it before any send.
- **The inbound-mail budget** (`InboundMailBudget`, the cross-run inbound
  ledger): refuses a send over the per-run or per-sender hourly limit, but
  only where your flow or fixture calls `consume()` before sending. Neither
  shipped driver consumes it.
- **Mail sends are never retried by flowreel.** flowreel has no send
  retry. A driver you write must not add one.
- **The undo ledger** (`undo.change()`): write-ahead, restored newest
  first. It covers the changes your flows route through it.
- **The off-camera cleanup** (`cleanUpRunRecords`): considers only records
  that match your `CleanupAdapter`'s number shape and this run's marker.
  Whether it closes or deletes is up to the `solve` functions you supply.
  Supply functions that close records and never delete.
- **The privacy mask** (`installPrivacyMask`): on staging, blurs table
  rows that do not belong to the run, once your page fixture installs it.
- **The Microsoft 365 driver** (`GraphMailDriver`) is shipped. It is
  designed for an app whose mail permissions are scoped to one QA
  mailbox (RBAC for Applications in Exchange Online, or an existing
  application access policy), tested before the first run; the tenant
  setup is in
  [docs/adapters.md](docs/adapters.md#mail-graph-microsoft-365). The scope
  is yours to set: the driver cannot check it.
- **Test seams**: the Rails seam kit (`plugin/templates/rails/`) is shipped
  and keeps the contract: routed only in test and development behind an
  explicit flag, a controller gate on `Rails.env.local?` AND the flag
  that also refuses a request not from this machine by a loopback `Host`
  (DNS rebinding) and a `POST` without a JSON body (a cross-site form or
  no-body post), a request spec per seam proving both 404 paths, request
  specs for those two refusals, and a tripwire spec that
  fails in both directions: a `/test/` route whose controller lacks the
  gate (or has no controller, or a missing one), and a gated seam
  controller routed outside `/test/`. See
  [docs/adapters.md](docs/adapters.md#the-rails-seam-kit). The kit only
  holds once you copy it in and its specs pass; seams you write yourself
  are yours to gate and test.

### What stays your responsibility

- Results folders hold traces and reports with (revoked) session cookies
  and must be treated as credential-bearing: git-ignored, shared only as
  `summary.md` / `pipeline.md`, deleted within 30 days.
- Use a password manager (for one command) or an owner-only file outside
  the repository for secrets.

### The plugin, the network and the supply chain

**Plugin**

- No hook installs or downloads anything. The `SessionStart` check is
  read-only, never blocks and always exits 0. What it prints reaches the
  model's context, so every value it takes from the project, the
  environment or another program is reduced to the characters a version,
  voice name or path needs, and shortened, before it is printed.
- Every skill with a side effect (`doctor`, `init`, `inventory`,
  `author`, `narrate`, `run`, `demos`) is user-invoked only and asks
  before acting. `author` is the widest: it writes flows, starts the app
  and starts `flow-author` agents that can edit files and run shell
  commands; it runs only the development stage, never staging, but that
  is an instruction, not a control. `explain`, which only reads, is the
  one model-invocable skill; it applies a proposed fix only after your
  yes. File writes and shell commands go through Claude Code's permission
  prompts, which protect only where you have not allowlisted the commands
  or edits (a project that allows `Bash(npm run *)` runs every npm script
  without one). Every command the plugin may run is listed in
  [docs/plugin.md](docs/plugin.md).
- Run evidence and app content are untrusted: a staging page's
  accessibility snapshot, screenshots, `.eml` files, summaries and the
  app's source can carry text written by people outside your team. Every
  skill and agent is told to treat them as data, never instructions, and
  to report rather than follow anything they ask for. That is an
  instruction to the model, not a control: `flow-author` has an
  unrestricted `Bash` tool, so only your permission prompts limit what it
  runs. Keep `Bash` and file edits un-allowlisted while it works if your
  app shows text from outside the team.

**Network**

- No telemetry. flowreel talks only to the targets, the mail provider and
  the voice provider you configure. The built-in macOS voice is local.

**Supply chain**

- The runtime has no runtime dependencies. `@playwright/test` is a peer
  dependency chosen by your project.
- Every runtime source file, plugin script and example source file carries
  an SPDX license header. The plugin templates carry none: init copies
  them into your project as your own files. A tripwire
  (`scripts/check-leaks.mjs`) scans the whole repository, its own files
  included, for the publisher's name outside its allowlisted tokens and
  for project-specific names, hosts and colours. Those project patterns
  are supplied at run time by the project that owns them (in CI, from a
  repository secret) and are not published here.
- Releases are published to npm by this repository's release workflow
  through npm trusted publishing (OpenID Connect), with provenance: no
  long-lived npm token exists. `npm view @confidee/flowreel --json` and
  the package page on npmjs.com show the provenance of each version
  ([RELEASING.md](RELEASING.md)).
- CI and release workflows pin every GitHub Action to a full commit SHA.
