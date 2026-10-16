// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext, APIResponse } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { LoginError } from "../src/core/index.js"
import {
  INERTIA_ACCEPT,
  INERTIA_RAILS_CSRF,
  InertiaPropsReader,
  asInertiaPage,
  decodeHtmlEntities,
  parseInitialPage,
  pathnameOf,
} from "../src/rails-inertia/index.js"

// The Inertia props reader (rails-inertia): the initial page from a full
// HTML response, X-Inertia requests, partial reloads, the 409 retry and the
// signed-out check, over a fake APIRequestContext.

function page(component: string, props: Record<string, unknown>) {
  return { component, props, url: "/orders", version: "v-abc" }
}

function scriptHtml(json: unknown, attributes = 'data-page="app"') {
  // Rails' to_json escapes <, > and & inside the script element.
  const body = JSON.stringify(json)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
  return `<!doctype html><html><head><title>x</title>
<script nonce="n1">window.theme = "dark"</script></head><body>
<script ${attributes} type="application/json" nonce="abc">${body}</script>
<div id="app"></div></body></html>`
}

test.describe("parseInitialPage", () => {
  test("reads the Inertia v3 script element (escaped JSON, nonce)", () => {
    const html = scriptHtml(page("orders/index", { note: "<b>A & B</b>" }))
    expect(parseInitialPage(html)).toEqual({
      component: "orders/index",
      props: { note: "<b>A & B</b>" },
      url: "/orders",
      version: "v-abc",
    })
  })

  test("accepts the type attribute before data-page", () => {
    const body = JSON.stringify(page("home", {}))
    const html = `<script type='application/json' data-page="app">${body}</script>`
    expect(parseInitialPage(html)?.component).toBe("home")
  })

  test("ignores JSON script elements that are not the page", () => {
    const html = `<script type="application/json" id="i18n">{"a":1}</script>${scriptHtml(page("home", {}))}`
    expect(parseInitialPage(html)?.component).toBe("home")
  })

  test("falls back to the legacy data-page attribute", () => {
    const json = JSON.stringify(page("legacy", { q: 'say "hi"' }))
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
    const html = `<div id="app" data-page="${json}"></div>`
    expect(parseInitialPage(html)).toMatchObject({
      component: "legacy",
      props: { q: 'say "hi"' },
    })
  })

  test("returns null for a document without an Inertia page", () => {
    expect(parseInitialPage("<html><body>Not found</body></html>")).toBeNull()
  })

  test("throws a named error for a malformed page element", () => {
    expect(() =>
      parseInitialPage(
        '<script data-page="app" type="application/json">{oops</script>',
      ),
    ).toThrow(/data-page script element/)
    expect(() =>
      parseInitialPage('<div data-page="{&quot;component&quot;:1}"></div>'),
    ).toThrow(/data-page attribute: The data-page attribute is not an Inertia/)
  })

  test("defaults a missing version to null and a missing url to empty", () => {
    const html = scriptHtml({ component: "x", props: {} })
    expect(parseInitialPage(html)).toEqual({
      component: "x",
      props: {},
      url: "",
      version: null,
    })
  })
})

test.describe("helpers", () => {
  test("decodeHtmlEntities decodes the common attribute entities once", () => {
    expect(
      decodeHtmlEntities("&quot;a&#39;b&#x27;&lt;c&gt;&nbsp;&amp;amp;"),
    ).toBe("\"a'b'<c> &amp;")
  })

  test("asInertiaPage refuses a value that is not a page", () => {
    expect(() => asInertiaPage({ props: {} }, "GET /x")).toThrow(
      "GET /x is not an Inertia page object.",
    )
    expect(() => asInertiaPage(null, "GET /x")).toThrow(/not an Inertia/)
  })

  test("pathnameOf drops the query; constants", () => {
    expect(pathnameOf("/orders?view=3&q=a")).toBe("/orders")
    expect(INERTIA_ACCEPT).toBe("text/html, application/xhtml+xml")
    expect(INERTIA_RAILS_CSRF).toEqual({
      cookie: "XSRF-TOKEN",
      header: "X-XSRF-TOKEN",
    })
  })
})

// --- The reader over a fake APIRequestContext ------------------------------

interface FakeCall {
  url: string
  headers: Record<string, string>
}

interface FakeReply {
  status?: number
  url?: string
  body?: unknown
  html?: string
}

function fakeRequest(handler: (call: FakeCall) => FakeReply) {
  const calls: FakeCall[] = []
  const request = {
    get(url: string, options: { headers?: Record<string, string> } = {}) {
      const call = { url, headers: options.headers ?? {} }
      calls.push(call)
      const reply = handler(call)
      const response = {
        status: () => reply.status ?? 200,
        url: () => `http://127.0.0.1:3000${reply.url ?? url}`,
        text: () => Promise.resolve(reply.html ?? JSON.stringify(reply.body)),
        json: () => Promise.resolve(reply.body),
      }
      return Promise.resolve(response as unknown as APIResponse)
    },
  }
  return { request: request as unknown as APIRequestContext, calls }
}

test.describe("InertiaPropsReader", () => {
  test("first read is the HTML page; a partial reload then names component and props", async () => {
    const { request, calls } = fakeRequest((call) =>
      call.headers["X-Inertia"]
        ? { body: page("orders/index", { records: [{ id: 1 }] }) }
        : { html: scriptHtml(page("orders/index", { views: [] })) },
    )
    const reader = new InertiaPropsReader(request)
    expect(await reader.props("/orders")).toEqual({ views: [] })
    expect(calls[0].headers).toEqual({ Accept: "text/html" })

    const props = await reader.props("/orders?view=2", ["records"])
    expect(props).toEqual({ records: [{ id: 1 }] })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      url: "/orders?view=2",
      headers: {
        Accept: INERTIA_ACCEPT,
        "X-Inertia": "true",
        "X-Requested-With": "XMLHttpRequest",
        "X-Inertia-Version": "v-abc",
        "X-Inertia-Partial-Component": "orders/index",
        "X-Inertia-Partial-Data": "records",
      },
    })
  })

  test("a partial reload of a path not read yet reads its HTML first", async () => {
    const { request, calls } = fakeRequest((call) =>
      call.headers["X-Inertia"]
        ? { body: page("orders/index", { records: [] }) }
        : { html: scriptHtml(page("orders/index", {})) },
    )
    const reader = new InertiaPropsReader(request)
    await reader.props("/orders", ["records"])
    expect(calls.map((c) => Boolean(c.headers["X-Inertia"]))).toEqual([
      false,
      true,
    ])
    expect(calls[1].headers["X-Inertia-Partial-Component"]).toBe("orders/index")
  })

  test("a 409 refetches the HTML version once and retries", async () => {
    let inertiaCalls = 0
    let version = "v1"
    const { request, calls } = fakeRequest((call) => {
      if (!call.headers["X-Inertia"]) {
        return { html: scriptHtml({ ...page("home", {}), version }) }
      }
      inertiaCalls += 1
      if (inertiaCalls === 1) {
        version = "v2"
        return { status: 409 }
      }
      return { body: { ...page("home", { ok: true }), version } }
    })
    const reader = new InertiaPropsReader(request)
    await reader.htmlPage("/")
    expect(await reader.props("/")).toEqual({ ok: true })
    const inertia = calls.filter((c) => c.headers["X-Inertia"])
    expect(inertia.map((c) => c.headers["X-Inertia-Version"])).toEqual([
      "v1",
      "v2",
    ])
  })

  test("a second 409 is an error, not another retry", async () => {
    const { request, calls } = fakeRequest((call) =>
      call.headers["X-Inertia"]
        ? { status: 409 }
        : { html: scriptHtml(page("home", {})) },
    )
    const reader = new InertiaPropsReader(request, { persona: "editor" })
    await reader.htmlPage("/")
    await expect(reader.props("/")).rejects.toThrow(
      "GET / (Inertia) as the editor persona returned HTTP 409.",
    )
    expect(calls.filter((c) => c.headers["X-Inertia"])).toHaveLength(2)
  })

  test("a partial reload that renders another component is an error", async () => {
    const { request } = fakeRequest((call) =>
      call.headers["X-Inertia"]
        ? { url: "/", body: page("home", {}) }
        : { html: scriptHtml(page("orders/index", {})) },
    )
    const reader = new InertiaPropsReader(request)
    await reader.htmlPage("/orders")
    await expect(reader.props("/orders", ["records"])).rejects.toThrow(
      "GET /orders rendered home instead of orders/index (redirected to /).",
    )
  })

  test("non-200 answers and HTML without a page are errors", async () => {
    const { request } = fakeRequest(() => ({ status: 500, html: "oops" }))
    await expect(new InertiaPropsReader(request).props("/x")).rejects.toThrow(
      "GET /x as the signed-in persona returned HTTP 500.",
    )
    const { request: plain } = fakeRequest(() => ({ html: "<p>hi</p>" }))
    await expect(new InertiaPropsReader(plain).htmlPage("/x")).rejects.toThrow(
      "GET /x returned HTML without an Inertia page.",
    )
  })

  test("landing on the sign-in page is a LoginError (default and custom wording)", async () => {
    const { request } = fakeRequest(() => ({
      url: "/login",
      html: scriptHtml(page("sessions/new", {})),
    }))
    const error = await new InertiaPropsReader(request, {
      persona: "agent",
      isSignInPath: (path) => path === "/login",
    })
      .props("/orders")
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toBe(
      "GET /orders as the agent persona was redirected to /login: the session from the global setup is not signed in (expired or revoked). Do not retry the sign-in.",
    )

    const custom = await new InertiaPropsReader(request, {
      isSignInPath: (path) => path === "/login",
      signedOutMessage: (req, landed, persona) => `${persona}|${req}|${landed}`,
    })
      .props("/orders")
      .catch((e: unknown) => e as Error)
    expect(custom.message).toBe("signed-in|GET /orders|/login")
  })

  test("without isSignInPath the landing page is read as any other", async () => {
    const { request } = fakeRequest(() => ({
      url: "/login",
      html: scriptHtml(page("sessions/new", {})),
    }))
    const read = await new InertiaPropsReader(request).page("/orders")
    expect(read.component).toBe("sessions/new")
  })

  test("a subclass builds on the protected members", async () => {
    class OrdersApp extends InertiaPropsReader {
      async firstOrderId(): Promise<number> {
        const props = await this.props("/orders", ["records"])
        return (props.records as { id: number }[])[0].id
      }
      headersForWrite(): Record<string, string> {
        return this.inertiaHeaders()
      }
      currentVersion(): string | null | undefined {
        return this.assetVersion
      }
    }
    const { request } = fakeRequest((call) =>
      call.headers["X-Inertia"]
        ? { body: page("orders/index", { records: [{ id: 42 }] }) }
        : { html: scriptHtml(page("orders/index", {})) },
    )
    const app = new OrdersApp(request)
    expect(app.currentVersion()).toBeUndefined()
    expect(await app.firstOrderId()).toBe(42)
    expect(app.currentVersion()).toBe("v-abc")
    expect(app.headersForWrite()["X-Inertia-Version"]).toBe("v-abc")
  })
})
