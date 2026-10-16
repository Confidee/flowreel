import { expect, feature, test } from "../../tour"

// Tour area A (plans/tour-a.md). One test per catalogue feature, titled
// "<id> <slug>"; feature() is its FIRST call; steps are "<id>.<n> <sentence>"
// (the sentence is the video caption). Narration: narration/tour-a.json.
// Every string a test types or sends: areaText("A", key) from ../../tour,
// kept in texts/tour-a.json.

test("A1 home-page", async ({ page, pause }) => {
  feature(test, { id: "A1", policy: "both" })

  await test.step("A1.1 The home page opens with its main heading", async () => {
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await pause()
  })
})
