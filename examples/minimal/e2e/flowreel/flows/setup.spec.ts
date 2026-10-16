// SPDX-License-Identifier: Apache-2.0

import { PERSONAS } from "../../../flowreel.config"
import { expect, test } from "../fixtures"
import { currentRun } from "../tour"

// Project tour-setup: runs once before the tour's areas and proves every
// persona global setup signed in is still signed in as the right person,
// so no feature discovers a broken persona half way through. Reads only.

test("tour setup", async ({ as }) => {
  await test.step("S1 every persona is signed in as itself", async () => {
    for (const persona of PERSONAS) {
      const me = await as(persona).me()
      expect(me.email, `the ${persona} persona`).toBe(
        currentRun().personas[persona].email,
      )
    }
  })
})
