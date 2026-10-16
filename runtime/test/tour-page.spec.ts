// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  PRIVACY_MASK_CSS,
  installPrivacyMask,
  privacyKeepList,
  rowKept,
} from "../src/tour/page.js"

// The staging privacy mask. installPrivacyMask runs inside the recorded
// page; here it runs against a small fake DOM so the behaviour that keeps
// real people's rows blurred is pinned: blur by default, un-blur only rows
// that carry a QA marker, never mask the pages the project exempts.

class FakeNode {
  attrs = new Map<string, string>()
  children: FakeNode[] = []
  id = ""
  textContent: string | null = null
  constructor(text: string | null = null) {
    this.textContent = text
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string) {
    this.attrs.delete(name)
  }
  appendChild(node: FakeNode) {
    this.children.push(node)
    return node
  }
}

function fakePage(pathname: string, withRoot = true) {
  const root = withRoot ? new FakeNode() : null
  const rows: FakeNode[] = []
  let observed: (() => void) | undefined
  let observeOptions: Record<string, boolean> | undefined
  const listeners = new Map<string, () => void>()
  const globals = {
    document: {
      documentElement: root,
      getElementById: (id: string) =>
        root?.children.find((c) => c.id === id) ?? null,
      createElement: () => new FakeNode(),
      querySelectorAll: () => rows,
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener)
      },
    },
    window: { location: { pathname } },
    MutationObserver: class {
      constructor(callback: () => void) {
        observed = callback
      }
      observe(_target: unknown, options: Record<string, boolean>) {
        observeOptions = options
      }
    },
  }
  return {
    root,
    rows,
    globals,
    listeners,
    mutate: () => observed?.(),
    options: () => observeOptions,
  }
}

function install(
  page: ReturnType<typeof fakePage>,
  args: { keep: string[]; unmasked: string },
) {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = {
    document: g.document,
    window: g.window,
    MutationObserver: g.MutationObserver,
  }
  Object.assign(g, page.globals)
  // The listeners run later inside the page, so the globals stay until the
  // caller restores them.
  installPrivacyMask({ ...args, css: PRIVACY_MASK_CSS })
  return () => {
    g.document = saved.document
    g.window = saved.window
    g.MutationObserver = saved.MutationObserver
  }
}

test.describe("the keep list and the row rule", () => {
  test("lower-cased, unique, no empty entries", () => {
    expect(
      privacyKeepList([
        "Loc-1",
        "loc-1",
        "",
        null,
        undefined,
        "QA@Example.test",
      ]),
    ).toEqual(["loc-1", "qa@example.test"])
    expect(privacyKeepList([])).toEqual([])
  })

  test("a row stays sharp only when its text carries a keep entry", () => {
    const keep = ["loc-1", "qa@example.test"]
    expect(rowKept("Order LOC-1 shipped", keep)).toBe(true)
    expect(rowKept("jane@real.example", keep)).toBe(false)
    expect(rowKept("anything", [""])).toBe(false)
    expect(rowKept("anything", [])).toBe(false)
  })

  test("the CSS blurs body rows and grid rows but never header rows or marked ones", () => {
    expect(PRIVACY_MASK_CSS).toContain("tbody tr:not([data-qa-keep])")
    expect(PRIVACY_MASK_CSS).toContain(':not(:has([role="columnheader"]))')
    expect(PRIVACY_MASK_CSS).toContain("html:not([data-qa-unmasked])")
    expect(PRIVACY_MASK_CSS).toContain("blur(7px)")
  })
})

test.describe("installPrivacyMask in a page", () => {
  test("injects the style once, observes the document and marks QA rows on each change", () => {
    const page = fakePage("/orders")
    const restore = install(page, { keep: ["loc-1", ""], unmasked: "^/login" })
    try {
      const style = page.root!.children[0]
      expect(style.id).toBe("qa-privacy-mask")
      expect(style.textContent).toBe(PRIVACY_MASK_CSS)
      expect(page.options()).toEqual({
        subtree: true,
        childList: true,
        characterData: true,
      })

      const qa = new FakeNode("Order LOC-1")
      const real = new FakeNode("Jane Real")
      const blank = new FakeNode(null)
      page.rows.push(qa, real, blank)
      real.setAttribute("data-qa-keep", "")
      page.mutate()
      expect(qa.attrs.has("data-qa-keep")).toBe(true)
      expect(real.attrs.has("data-qa-keep")).toBe(false)
      expect(blank.attrs.has("data-qa-keep")).toBe(false)
      // Still one style element after the change handler ran.
      expect(page.root!.children).toHaveLength(1)
      expect(page.root!.attrs.has("data-qa-unmasked")).toBe(false)

      page.listeners.get("DOMContentLoaded")!()
      expect(qa.attrs.has("data-qa-keep")).toBe(true)
    } finally {
      restore()
    }
  })

  test("a row that stops being QA is blurred again", () => {
    const page = fakePage("/orders")
    const restore = install(page, { keep: ["loc-1"], unmasked: "^/login" })
    try {
      const row = new FakeNode("Order LOC-1")
      page.rows.push(row)
      page.mutate()
      expect(row.attrs.has("data-qa-keep")).toBe(true)
      row.textContent = "Order of a real person"
      page.mutate()
      expect(row.attrs.has("data-qa-keep")).toBe(false)
    } finally {
      restore()
    }
  })

  test("a page the project exempts is flagged unmasked; leaving it clears the flag", () => {
    const page = fakePage("/login/new")
    const restore = install(page, { keep: [], unmasked: "^/login" })
    try {
      page.mutate()
      expect(page.root!.attrs.has("data-qa-unmasked")).toBe(true)
      page.globals.window.location.pathname = "/orders"
      page.mutate()
      expect(page.root!.attrs.has("data-qa-unmasked")).toBe(false)
    } finally {
      restore()
    }
  })

  test("before the document element exists nothing is injected and nothing throws", () => {
    const page = fakePage("/orders", false)
    const restore = install(page, { keep: ["loc-1"], unmasked: "^/login" })
    try {
      page.rows.push(new FakeNode("Order LOC-1"))
      expect(() => page.mutate()).not.toThrow()
      expect(page.rows[0].attrs.has("data-qa-keep")).toBe(true)
    } finally {
      restore()
    }
  })
})
