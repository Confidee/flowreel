import { expect, test } from "@playwright/test"

// The tour's setup project: every area depends on it. It signs nothing in
// (global setup did) and records no feature; it only checks the target
// answers before the areas start.

test("tour setup", async ({ request }) => {
  const response = await request.get("/")
  expect(response.ok()).toBe(true)
})
