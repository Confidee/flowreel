# flowreel documentation

New here? Read [Getting started](getting-started.md), then
[Concepts](concepts.md).

| Guide                                           | What it covers                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Getting started](getting-started.md)           | Prerequisites (why each is needed, with install commands per OS), the plugin, doctor, init, inventory, the first run, reading the result, wiring it by hand                                                  |
| [Concepts](concepts.md)                         | Targets, modules, plans, features, areas, the catalogue, policies, steps, personas, the pipeline gate, verdicts, the undo ledger, pace, narration                                                            |
| [Configuration](configuration.md)               | The `defineConfig()` reference, targets and the allowlist, every `FLOWREEL_*` variable, your own variable names, secrets, `createConfig()`                                                                   |
| [Writing flows](writing-flows.md)               | Project fixtures, the round trip, tour features and `feature()`, steps, assertions, facts, personas, undo, texts, mail, pacing, the tripwire                                                                 |
| [Adapters](adapters.md)                         | `AppAdapter`, `MailDriver`, `DbIsolation`, `CleanupAdapter`, `Brand`/`CardCopy`, `VoiceEngine`, `ModuleDescriptor`, `TourManifest`, `DemoCatalogue`; the rails-inertia and mail-graph (Microsoft 365) guides |
| [Narration and videos](narration-and-videos.md) | What gets made, pace and holds, narration keys and rules, voices, your video kit, redaction and the privacy mask, the demos folder                                                                           |
| [Pipeline and gates](pipeline-and-gates.md)     | Development then staging, flags, exit codes 0/1/2/3/4/64/130, stage environments, `pipeline.json`, the entry file, CI                                                                                        |
| [Safety](safety.md)                             | Every safety rule, why it exists, and what remains your responsibility                                                                                                                                       |
| [Troubleshooting](troubleshooting.md)           | Messages you may see, what they mean, and what to do, from configuration to module loading and the plugin                                                                                                    |
| [Claude Code plugin](plugin.md)                 | Every skill, agent and hook, and every command the plugin may run                                                                                                                                            |
| [Installing the plugin](team-install.md)        | Adding the `flowreel` marketplace from GitHub or a clone, and enabling the plugin for a whole project                                                                                                        |
| [Architecture](design/architecture.md)          | The parts, the principles, the public interfaces, the repository layout, what is out of scope and the roadmap                                                                                                |
| [Design decisions](design/decisions.md)         | The decisions behind flowreel and why they were made                                                                                                                                                         |

These guides describe flowreel as it is in the code. Pieces that are
designed but not built yet (a `flowreel` command-line binary, voice engines
off macOS) are named as such where they come up.
