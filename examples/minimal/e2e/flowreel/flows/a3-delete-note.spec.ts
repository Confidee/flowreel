// SPDX-License-Identifier: Apache-2.0

import { runSubject } from "@confidee/flowreel/run"

import { expect, feature, test, text } from "../fixtures"

// A3 delete-note (dev): deleting cannot be undone, so this runs on the
// development stage only; on staging feature() skips it as "development
// only: <reason>" (counted dev-only, never a failure). Plan: plans/tour-a.md.

test("A3 delete-note", async ({ appPage: page, as, runId, pause }) => {
  feature(test, {
    id: "A3",
    policy: "dev",
    devOnlyReason:
      "deleting a note cannot be undone, and the notes on staging are shared",
  })
  // Set up off camera, through the API.
  const note = await as("editor").createNote({
    title: runSubject(runId, text("subjects", "oldNote")),
    body: text("bodies", "oldNote"),
  })

  await test.step("A3.1 The editor opens a note they no longer need", async () => {
    await page.goto(`/notes/${note.id}`)
    await expect(
      page.getByRole("heading", { level: 1, name: note.title }),
    ).toBeVisible()
    await pause()
  })

  await test.step("A3.2 Deleting it returns to a list without it", async () => {
    await page.getByRole("button", { name: "Delete note" }).click()
    await expect(page).toHaveURL(/\/notes\?deleted=1$/)
    await expect(page.getByText("Note deleted.")).toBeVisible()
    await expect(page.getByRole("link", { name: note.title })).toHaveCount(0)
    await pause()
  })
})
