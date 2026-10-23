<!-- Generated from plugin/skills/inventory/reference/catalogue-format.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

# The feature catalogue format

`/flowreel:inventory` writes it, the owner approves it, the tour's mirror
(`TOUR_CATALOGUE`) copies it, and `parseCatalogue()` from
`@confidee/flowreel/tour` reads it so a unit test can prove the two
agree: the scaffold's `e2e/flowreel/unit/tour.spec.ts`
(`npm run flowreel:unit`). A project without that test has nothing that
catches the two drifting apart (feature() checks flows against the mirror
only). Keep the shape exactly.

## Contents

- Document shape
- Columns
- Policies and how to choose
- A worked row

## Document shape

```markdown
# <Module> feature tour: catalogue (<date>)

<one paragraph: how it was made; entry points must be re-verified in code>

**Staging policy** (proposed <date>, pending the owner's approval):

- `both` — …
- `both+undo` — …
- `dev` — …
- `view` — …

## Area A — <title> (<persona>)

| id            | Feature            | Entry point                         | Setup          | Assert          | Undo | Policy |
| ------------- | ------------------ | ----------------------------------- | -------------- | --------------- | ---- | ------ |
| A1 list-views | Switch saved views | view dropdown (`app/…/list.tsx:42`) | two QA records | rows match view | n/a  | both   |
```

Parser rules (follow them or the parse fails):

- Every area is a `## ` heading; each table's header row starts with `id`
  and has a `Policy` column.
- A feature row's first cell is `<id> <slug>`: an area letter, a number,
  one space, a slug without spaces (`A1 list-views`).
- The Policy cell starts with the policy word: `both`, `both+undo`, `dev`
  or `view`, optionally followed by a note (`both (QA records only)`,
  `dev (sends real mail)`). ``dev; staging `view` `` reads as `view`.
- A section titled `… (dev only)` may leave out the Policy column: its rows
  are `dev`.

## Columns

| Column      | What to write                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ |
| id          | `<letter><n> <slug>`; ids never change once approved                                             |
| Feature     | what the user does, in a few words                                                               |
| Entry point | the visible label or route, with the file and line it was found in                               |
| Setup       | what must exist first, created off camera by the flow (named `[QA <RUN_ID>] …`)                  |
| Assert      | what the flow checks on screen (and off camera, if a fact backs it up)                           |
| Undo        | how the change is put back (`n/a`, `delete the QA view`, `restore the setting`, `no (terminal)`) |
| Policy      | the proposed staging policy and, for `dev`, its reason                                           |

## Policies and how to choose

- `both` (default): runs on development and staging, touching only objects
  the run created. Most read and create features.
- `both+undo`: changes shared staging configuration (a setting, an order,
  a default) that a restore can read back and put back. Every such change
  goes through the undo ledger; a failed restore exits the run 4.
- `dev` + reason: development only. Use when the change cannot be undone,
  affects data the run did not create, sends mail outside the configured
  QA domain, needs a persona staging must not have, is a compliance,
  billing or security event, or needs a test-only seam.
- `view`: development runs the full flow; staging only renders the page
  and asserts what is shown (no write).

When unsure between two, propose the safer one (`dev` over `both+undo`,
`view` over `both`) and say why in the Policy cell's note.

## A worked row

```markdown
| B3 priority | Change a record's priority | Priority menu (`app/…/actions.tsx:701`) | a QA record | label shows the new priority | set it back | both |
```
