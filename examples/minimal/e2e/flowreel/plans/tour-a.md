# Notes tour, area A: Notes

The plan is the human contract for area A of the Notes feature tour: which
features exist, what each one proves, and where it may run. The flows in
`e2e/flowreel/flows/a*.spec.ts` follow it step by step.

The catalogue table below is read by the tour (`e2e/flowreel/tour.ts`,
`parseCatalogue`): each row's first cell is `<id> <slug>` (the test title)
and its Policy column is the feature's staging policy. `feature()` refuses a
flow whose policy differs, so the policy is changed here first, never in a
flow alone.

| Policy      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `both`      | development and staging, on records the run creates itself         |
| `both+undo` | changes shared settings; the undo ledger records and restores them |
| `dev`       | development only; on staging it is skipped as "development only"   |
| `view`      | staging shows the page read-only; development runs the whole flow  |

## Catalogue

| id                    | Policy                                                           | Proves                                                                        |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A1 create-note        | both                                                             | the list, the form and the detail page work together, and search finds a note |
| A2 workspace-greeting | both+undo                                                        | an admin's setting reaches every user, and is put back afterwards             |
| A3 delete-note        | dev (deleting cannot be undone; the notes on staging are shared) | a note can be deleted from its own page                                       |

## A1 create-note (both)

1. **A1.1** The notes list opens: the heading and the table are shown.
2. **A1.2** The editor writes a new note in the form (title and body from
   `texts/tour-a.json`, the title marked `[QA <RUN_ID>]`).
3. **A1.3** Saving opens the new note on its own page.
4. **A1.4** Back on the list, searching for the run finds exactly that note.

Undo: none. The note is the run's own record (its title carries the run id).

## A2 workspace-greeting (both+undo)

1. **A2.1** The admin opens the workspace settings.
2. **A2.2** The admin saves a new greeting. Before the change, the undo
   ledger records the old greeting and how to put it back by hand.
3. **A2.3** The editor sees the new greeting on the notes list.
4. **A2.4** The original greeting is put back (the ledger's restore, read
   back through the API) and the list shows it again.

Undo: the greeting. If the restore fails, the run exits non-zero and
`undo.md` says what to do.

## A3 delete-note (dev)

Setup (off camera): the editor creates a note through the API.

1. **A3.1** The editor opens the note.
2. **A3.2** Deleting it returns to the list, which says so and no longer
   shows the note.

Development only: deleting cannot be undone, and the notes on a shared
staging app belong to people.
