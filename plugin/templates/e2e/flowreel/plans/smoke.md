# Plan: smoke round trip

Human contract for `e2e/flowreel/flows/smoke.spec.ts`, the release gate. Each `test.step` in the spec is titled with a step id from the table below (`S1 open`); this file and the spec change together. Pass or fail is decided only by the Playwright `expect`s, never by AI.

**Preconditions:** the app answers on the target; the `user` persona can sign in. If a precondition cannot hold on a target (a feature switched off there), the flow skips with an `N/A: <reason>` and the run is **N/A**, not green.

**Personas:** `user` (the recorded page). Locally the seeded development account; on staging `FLOWREEL_USER_EMAIL`.

| Step      | Action                                             | Expect                                  |
| --------- | -------------------------------------------------- | --------------------------------------- |
| S1 open   | Open the home page.                                | The main heading is visible.            |
| S2 search | Search for `texts.bodies.searchTerm`, press Enter. | The main region shows the results page. |

**Evidence per run** (`flowreel-results/<RUN_ID>/`): `summary.md`, `summary.json`, `summary.lines`, traces, video, screenshots and the branded run video `smoke-<RUN_ID>.mp4`. The video never decides anything.

**Cleanup:** what the flow creates, and how it is put back or left harmless (records carry `[QA <RUN_ID>]` so cleanup can find them). Never delete data the run did not create.
