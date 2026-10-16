import { expect, note, test, text } from "../fixtures"

// The round trip (the release gate): ONE test whose steps are the plan's
// step table (plans/smoke.md), titled "<id> <slug>" exactly as there.
// Only these expects decide PASS or FAIL. TODO(flowreel): your app's most
// important end-to-end path.

test("smoke", async ({ page }) => {
  await test.step("S1 open", async () => {
    const started = Date.now()
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    note("S1", "latency.open", Date.now() - started)
  })

  await test.step("S2 search", async () => {
    await page.getByRole("searchbox").fill(text("searchTerm"))
    await page.keyboard.press("Enter")
    await expect(page.getByRole("main")).toBeVisible()
  })
})
