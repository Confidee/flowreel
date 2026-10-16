// SPDX-License-Identifier: Apache-2.0

// The Notes app's only script: the list's search box hides the rows whose
// text does not contain what was typed (and shows "No note matches." when
// none is left).

document.addEventListener("DOMContentLoaded", () => {
  const input = /** @type {HTMLInputElement | null} */ (
    document.querySelector('input[data-filter="notes"]')
  )
  const empty = /** @type {HTMLElement | null} */ (
    document.querySelector(".empty")
  )
  if (!input) return
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase()
    let shown = 0
    for (const row of document.querySelectorAll("#notes tbody tr")) {
      const match = (row.textContent ?? "").toLowerCase().includes(query)
      ;/** @type {HTMLElement} */ (row).hidden = !match
      if (match) shown += 1
    }
    if (empty) empty.hidden = shown > 0
  })
})
