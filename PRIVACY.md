# Privacy

This policy covers flowreel: the Claude Code plugin, the Agent Skill and
the `@confidee/flowreel` npm runtime, all published from this
repository (the copyright holder is named in [NOTICE](NOTICE)).

## What we receive

Nothing. flowreel has no server, no account, no telemetry, no analytics
and no update check. Nothing you run with it, and nothing Claude reads or
writes through it, is sent to us, the maintainers.

## What flowreel reads and stores, on your machine only

To run a flow, flowreel signs in to your app as the test users (personas)
you configure, and, if you set up a mail adapter, reads one QA mailbox. A
run saves its results in your project:

- summaries, HTML reports and traces, which include request headers and
  session cookies;
- screenshots and videos, which show whatever your app displayed;
- saved emails (`.eml`), which can contain reply tokens.

These files can contain personal data from the environment you tested,
such as names and email addresses. They stay on your machine, in folders
`/flowreel:init` adds to `.gitignore`. You decide who sees them and how
long they are kept; we recommend sharing only `summary.md` and deleting
run folders within 30 days. See
[docs/safety.md](docs/safety.md#results-and-retention).

The plugin never reads `.env*` files, your secrets file or `.npmrc`.

## Where flowreel connects

Only to services you configure or approve:

- your local and staging app;
- your mail provider, if configured (for Microsoft 365:
  `login.microsoftonline.com` and `graph.microsoft.com`);
- a voice provider, if you add one (the built-in macOS voice is local);
- during setup, after you say yes: the npm registry, to look up and
  install packages, and Playwright's download servers, to install
  Chromium.

Those services handle data under their own terms, not this policy.

## Children

flowreel is a development tool and is not intended for anyone under 18.

## Changes and contact

Changes to this policy are made in this file, and its git history shows
every change. Questions: open an issue at
<https://github.com/Confidee/flowreel/issues>, or for anything private,
email the address in [SECURITY.md](SECURITY.md) with "flowreel privacy"
in the subject.
