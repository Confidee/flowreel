# Tour area A — Getting around

Human contract for `e2e/flowreel/flows/tour/a-example.spec.ts`. One `test()` per feature, titled `<id> <slug>`; each step below is a `test.step` titled `<id>.<n> <sentence>` (the video caption is the sentence). Change this file and the spec together. Policy legend and the per-feature catalogue: `e2e/flowreel/CATALOGUE.md`. Every string typed or sent is in `e2e/flowreel/texts/tour-a.json`.

Conventions:

- **Setup** runs off camera through the persona's API client, never through the recorded page.
- Every record the tour creates is named `[QA <RUN_ID>] <id> <text>`, so no check depends on other data on the target.
- Shared configuration changes only through `undo.change` (recorded before the change, restored after, read back).

| Feature      | Policy | Step                                           | Action   | Expect                      |
| ------------ | ------ | ---------------------------------------------- | -------- | --------------------------- |
| A1 home-page | both   | A1.1 The home page opens with its main heading | open `/` | the main heading is visible |
