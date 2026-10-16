# Installing the plugin

flowreel's Claude Code plugin is served from this repository, which is
also its marketplace. This page covers adding the marketplace, installing
the plugin, installing from a clone, and enabling the plugin for everyone
who works in a project.

- [What you get](#what-you-get)
- [Before you start](#before-you-start)
- [Install from GitHub](#install-from-github)
- [Install from a clone](#install-from-a-clone)
- [Enable it for a whole project (optional)](#enable-it-for-a-whole-project-optional)
- [Run a module](#run-a-module)
- [Update and remove](#update-and-remove)

## What you get

This repository has a marketplace manifest at
`.claude-plugin/marketplace.json`. The marketplace is named `flowreel` and
lists one plugin, `flowreel`, whose source is `./plugin`. Installing it
adds eight skills (`/flowreel:doctor`, `init`, `inventory`, `author`,
`narrate`, `run`, `explain`, `demos`), three agents and one read-only
`SessionStart` check. [The plugin page](plugin.md) lists everything it
contains and every command it may run.

The plugin does not install the runtime. A project gets the
`@confidee/flowreel` runtime as a dev dependency through `/flowreel:init`,
which asks first.

## Before you start

Claude Code with plugin support (`/plugin` works in a session, and
`claude plugin --help` in a terminal). The repository is public: no GitHub
account or git credentials are needed to install from it.

## Install from GitHub

In a Claude Code session:

```text
/plugin marketplace add Confidee/flowreel
/plugin install flowreel@flowreel
```

Or in a terminal:

```bash
claude plugin marketplace add Confidee/flowreel --sparse .claude-plugin plugin
claude plugin install flowreel@flowreel
```

`--sparse <paths...>` checks out only those directories (plus the files at
the repository root), not the whole repository. Without it, Claude Code
clones the full repository.

<!-- TODO(verify): run the sparse install from GitHub end to end. The
`--sparse <paths...>` flag and the `sparsePaths` key (under the marketplace
source in the settings schema) exist in Claude Code 2.1.301, the version CI
pins (`claude plugin marketplace add --help` and the settings schema);
earlier install checks used a local clone. -->

The plugin is installed for you (user scope), in every project. Restart
Claude Code (or start a new session) to load it, then check it with
`/plugin` or `claude plugin list`: `flowreel@flowreel`, enabled.

## Install from a clone

To try an unreleased change, or to work on the plugin, point the
marketplace at a clone. The plugin is read straight from your clone, so it
always matches the branch you have checked out:

```bash
git clone https://github.com/Confidee/flowreel.git
```

```text
/plugin marketplace add <path to the clone>
/plugin install flowreel@flowreel
```

To try it for one session without installing:
`claude --plugin-dir <path to the clone>/plugin`.

## Enable it for a whole project (optional)

To offer the plugin to everyone who opens a project, declare the
marketplace and enable the plugin in that project's
`.claude/settings.json` (commit it with the project). This changes a shared
settings file: agree it with the project's owners first.

```json
{
  "extraKnownMarketplaces": {
    "flowreel": {
      "source": {
        "source": "github",
        "repo": "Confidee/flowreel",
        "sparsePaths": [".claude-plugin", "plugin"]
      }
    }
  },
  "enabledPlugins": {
    "flowreel@flowreel": true
  }
}
```

Merge the two keys into the existing file rather than replacing it. When a
team member trusts the project folder, Claude Code offers to add the
marketplace and install the plugin. The repository is public, so no git
credentials are needed.

`claude plugin marketplace add <source> --scope project` and
`claude plugin install flowreel@flowreel --scope project` write the same
two keys for you (checked with Claude Code 2.1.301: the marketplace under
`extraKnownMarketplaces.flowreel.source`, and
`"enabledPlugins": { "flowreel@flowreel": true }`). With a local clone as
the source, the first key holds a `"directory"` source with that clone's
absolute path, which works only on your machine: commit the `github` form
above instead.

## Run a module

In the project, start a new Claude Code session, then:

1. `/flowreel:doctor`: checks Node.js, Playwright, Chromium, ffmpeg and the
   voice, and offers the install command for anything missing.
2. `/flowreel:run <module> --local`: runs the development stage once and
   explains the result. Add `--pace qa` for a fast run without demo pauses.

Without Claude Code, the same run is the project's pipeline script, for
example `npm run flowreel -- --module <module> --local`
([Pipeline and gates](pipeline-and-gates.md)).

## Update and remove

```text
/plugin marketplace update flowreel     # fetch the newest plugin
/plugin uninstall flowreel@flowreel
/plugin marketplace remove flowreel
```

The terminal forms are `claude plugin marketplace update flowreel`,
`claude plugin uninstall flowreel@flowreel` and
`claude plugin marketplace remove flowreel`.
