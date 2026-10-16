# Feature tour: catalogue

The inventory of every feature the tour covers, written by `/flowreel:inventory` (read-only exploration) and approved by the project owner. `e2e/flowreel/tour.ts` `TOUR_CATALOGUE` is its committed mirror: `feature()` refuses a test whose id, slug or policy differs. Entry points are the labels found in the code; re-verify each one before writing a flow.

**Staging policy** (the owner's decision per feature):

- `both` — runs on development and staging, on QA-created objects (`[QA <RUN_ID>]` names).
- `both+undo` — changes shared staging configuration; the flow records the before-state and restores it in a guaranteed teardown (the undo ledger).
- `dev` — development only; reason given. Staging shows a "development only: <reason>" card instead.
- `view` — staging renders the page read-only (no writes); development runs the full flow.

## Area A — Getting around

| id           | Feature   | Entry point | Setup | Assert               | Undo | Policy |
| ------------ | --------- | ----------- | ----- | -------------------- | ---- | ------ |
| A1 home-page | Home page | `/`         | —     | main heading visible | —    | both   |
