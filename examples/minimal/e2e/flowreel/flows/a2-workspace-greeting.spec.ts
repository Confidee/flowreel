// SPDX-License-Identifier: Apache-2.0

import { expect, feature, test, text } from "../fixtures"

// A2 workspace-greeting (both+undo): an admin changes a setting every user
// sees. The undo ledger records the old greeting BEFORE the change and puts
// it back (re-reading it) inside the test; anything still pending is
// restored at the test's end, pass or fail. Plan: plans/tour-a.md.

test("A2 workspace-greeting", async ({
  appPage: page,
  as,
  asPersona,
  undo,
  pause,
}) => {
  feature(test, { id: "A2", policy: "both+undo" })
  const greeting = page.getByRole("status", { name: "Greeting" })
  const newGreeting = text("subjects", "greeting")
  const before = await as("admin").settings()

  await test.step("A2.1 The admin opens the workspace settings", async () => {
    await asPersona(page, "admin")
    await page.goto("/settings")
    await expect(
      page.getByRole("heading", { name: "Workspace settings" }),
    ).toBeVisible()
  })

  const change =
    await test.step("A2.2 The admin saves a new greeting", async () => {
      // Written to <RUN_ID>/undo.json and undo.md before the change is made.
      const entry = await undo.change({
        what: `Workspace greeting: "${before.greeting}" -> "${newGreeting}"`,
        before,
        manual: `Settings: set the workspace greeting back to "${before.greeting}".`,
        restore: async ({ as }) => {
          await as("admin").updateSettings(before)
          const now = await as("admin").settings()
          if (now.greeting !== before.greeting) {
            throw new Error(
              `the greeting reads "${now.greeting}" after restore`,
            )
          }
        },
      })
      await page
        .getByRole("textbox", { name: "Workspace greeting" })
        .fill(newGreeting)
      await page.getByRole("button", { name: "Save settings" }).click()
      await expect(page.getByText("Settings saved.")).toBeVisible()
      await pause()
      return entry
    })

  await test.step("A2.3 The editor sees the new greeting", async () => {
    await asPersona(page, "editor")
    await page.goto("/notes")
    await expect(greeting).toHaveText(newGreeting)
    await pause()
  })

  await test.step("A2.4 The original greeting is put back", async () => {
    await change.restoreNow()
    await page.reload()
    await expect(greeting).toHaveText(before.greeting)
    await pause()
  })
})
