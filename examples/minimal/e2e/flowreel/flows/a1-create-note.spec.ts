// SPDX-License-Identifier: Apache-2.0

import { runSubject } from "@confidee/flowreel/run"

import { expect, feature, test, text } from "../fixtures"

// A1 create-note (both): the list, the form and the detail page, on a note
// the run creates itself. Plan: e2e/flowreel/plans/tour-a.md.

test("A1 create-note", async ({ appPage: page, runId, pause }) => {
  feature(test, { id: "A1", policy: "both" })
  // "[QA <RUN_ID>] Weekly plan": the run's own record, easy to find.
  const title = runSubject(runId, text("subjects", "newNote"))

  await test.step("A1.1 The notes list opens", async () => {
    await page.goto("/notes")
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
    await expect(page.getByRole("table")).toBeVisible()
    await pause()
  })

  await test.step("A1.2 The editor writes a new note in the form", async () => {
    await page.getByRole("link", { name: "New note" }).click()
    await page.getByRole("textbox", { name: "Title" }).fill(title)
    await page
      .getByRole("textbox", { name: "Body" })
      .fill(text("bodies", "newNote"))
    await page.getByRole("button", { name: "Save note" }).click()
  })

  await test.step("A1.3 Saving opens the new note on its own page", async () => {
    await expect(page).toHaveURL(/\/notes\/\d+$/)
    await expect(
      page.getByRole("heading", { level: 1, name: title }),
    ).toBeVisible()
    await pause()
  })

  await test.step("A1.4 Searching the list finds exactly that note", async () => {
    await page.getByRole("link", { name: "Back to notes" }).click()
    await page.getByRole("searchbox", { name: "Search notes" }).fill(runId)
    // The header row and the one note that carries this run's id.
    await expect(page.getByRole("row")).toHaveCount(2)
    await expect(page.getByRole("link", { name: title })).toBeVisible()
    await pause()
  })
})
