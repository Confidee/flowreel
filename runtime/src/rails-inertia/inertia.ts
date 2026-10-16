// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext, APIResponse } from "@playwright/test"

import { safePath } from "../app/session.js"
import { LoginError } from "../core/errors.js"

// Reading what an Inertia app rendered, without scraping the DOM: the
// initial page object a full HTML response carries, and the page object of
// an `X-Inertia` request (with partial reloads for deferred props and the
// one-time retry of a 409 asset-version conflict). Works over any
// authenticated Playwright request context (a persona's storageState from
// the global setup). Nothing here signs in, and nothing here logs a cookie.

/** The Inertia page object. */
export interface InertiaPage<P = Record<string, unknown>> {
  component: string
  props: P
  url: string
  version: string | null
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&amp;": "&",
}

/**
 * Decodes the HTML entities an attribute value (or a server-rendered text
 * fragment) commonly carries: `&quot; &#39; &#x27; &lt; &gt; &nbsp; &amp;`.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:quot|#39|#x27|lt|gt|nbsp|amp);/g,
    (m) => ENTITIES[m],
  )
}

/** Validates a parsed JSON value as an Inertia page object. */
export function asInertiaPage(json: unknown, where: string): InertiaPage {
  const page = json as Partial<InertiaPage> | null
  if (!page || typeof page.component !== "string" || !page.props) {
    throw new Error(`${where} is not an Inertia page object.`)
  }
  return {
    component: page.component,
    props: page.props,
    url: page.url ?? "",
    version: page.version ?? null,
  }
}

/**
 * The initial Inertia page from a full HTML response. Inertia v3 (and
 * inertia_rails with `use_script_element_for_initial_page`) renders
 * `<script data-page="app" type="application/json">{…}</script>`; the legacy
 * `<div id="app" data-page="{…}">` form is accepted too. Returns null when
 * the document carries no Inertia page (e.g. a plain error page).
 */
export function parseInitialPage(html: string): InertiaPage | null {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)
  for (const [, attributes, body] of scripts) {
    if (!/\bdata-page\s*=/.test(attributes)) continue
    if (!/\btype\s*=\s*["']application\/json["']/i.test(attributes)) continue
    try {
      return asInertiaPage(JSON.parse(body), "The data-page script element")
    } catch (error) {
      throw new Error(
        `Could not parse the Inertia data-page script element: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
  const div = /<div\b[^>]*\bdata-page="([^"]*)"/i.exec(html)
  if (div) {
    try {
      return asInertiaPage(
        JSON.parse(decodeHtmlEntities(div[1])),
        "The data-page attribute",
      )
    } catch (error) {
      throw new Error(
        `Could not parse the Inertia data-page attribute: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
  return null
}

/** The Accept header an Inertia client sends. */
export const INERTIA_ACCEPT = "text/html, application/xhtml+xml"

/**
 * inertia_rails' CSRF pair: a page GET sets the `XSRF-TOKEN` cookie, sent
 * back URL-decoded as `X-XSRF-TOKEN` (inertia_rails copies it to
 * `X-CSRF-Token`). The shape of `SessionProtocol.csrf` in `/app`.
 */
export const INERTIA_RAILS_CSRF = {
  cookie: "XSRF-TOKEN",
  header: "X-XSRF-TOKEN",
} as const

/** The path of `path` (which may carry a query string). */
export function pathnameOf(path: string): string {
  return new URL(path, "http://app.invalid").pathname
}

export interface InertiaPropsReaderOptions {
  /** Named in error messages ("agent", "admin", …). Default "signed-in". */
  persona?: string
  /**
   * True for the path a signed-out request lands on (the sign-in page).
   * When set, a response that landed there throws a LoginError instead of
   * being read. Omit for an app without sessions.
   */
  isSignInPath?: (pathname: string) => boolean
  /**
   * The LoginError text for a signed-out answer. `request` is what was
   * asked ("GET /orders"), `landed` the path it was redirected to.
   */
  signedOutMessage?: (
    request: string,
    landed: string,
    persona: string,
  ) => string
}

const defaultSignedOutMessage = (
  request: string,
  landed: string,
  persona: string,
): string =>
  `${request} as the ${persona} persona was redirected to ${landed}: the session from the global setup is not signed in (expired or revoked). Do not retry the sign-in.`

/**
 * Reads Inertia page objects and props over an authenticated
 * APIRequestContext (created with the target baseURL and a persona's
 * storageState). Extend it with the app's own waiters; the protected
 * members are the building blocks.
 */
export class InertiaPropsReader {
  /** undefined = not read yet; null = the server sends no version. */
  private inertiaVersion: string | null | undefined
  private readonly pageComponents = new Map<string, string>()
  protected readonly persona: string

  constructor(
    protected readonly request: APIRequestContext,
    private readonly readerOptions: InertiaPropsReaderOptions = {},
  ) {
    this.persona = readerOptions.persona ?? "signed-in"
  }

  /** The asset version last read (null when the server sends none). */
  protected get assetVersion(): string | null | undefined {
    return this.inertiaVersion
  }

  /** The LoginError for a request that landed on the sign-in page. */
  protected notSignedIn(request: string, landed: string): LoginError {
    const message =
      this.readerOptions.signedOutMessage ?? defaultSignedOutMessage
    return new LoginError(message(request, landed, this.persona))
  }

  /** True when `landed` (a path) is the sign-in page. */
  protected landedOnSignIn(landed: string): boolean {
    return this.readerOptions.isSignInPath?.(landed) ?? false
  }

  /** Throws notSignedIn() when `response` landed on the sign-in page. */
  protected assertSignedIn(response: APIResponse, path: string): void {
    const landed = safePath(response.url())
    if (this.landedOnSignIn(landed)) {
      throw this.notSignedIn(`GET ${path}`, landed)
    }
  }

  /** Full HTML GET; reads the initial page (and so the asset version). */
  async htmlPage(path: string): Promise<InertiaPage> {
    const response = await this.request.get(path, {
      headers: { Accept: "text/html" },
    })
    this.assertSignedIn(response, path)
    if (response.status() !== 200) {
      throw new Error(
        `GET ${path} as the ${this.persona} persona returned HTTP ${response.status()}.`,
      )
    }
    const page = parseInitialPage(await response.text())
    if (!page) {
      throw new Error(`GET ${path} returned HTML without an Inertia page.`)
    }
    this.inertiaVersion = page.version
    this.pageComponents.set(pathnameOf(path), page.component)
    return page
  }

  /** The Inertia request headers, with the asset version once known. */
  protected inertiaHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: INERTIA_ACCEPT,
      "X-Inertia": "true",
      "X-Requested-With": "XMLHttpRequest",
    }
    if (this.inertiaVersion) headers["X-Inertia-Version"] = this.inertiaVersion
    return headers
  }

  /**
   * The Inertia page object for `path`. With `only`, an Inertia partial
   * reload of those props (how deferred props such as a listing's records
   * are resolved). A 409 (asset version changed) refetches the HTML once
   * and retries.
   */
  async page(path: string, only?: string[]): Promise<InertiaPage> {
    if (this.inertiaVersion === undefined) {
      const initial = await this.htmlPage(path)
      if (!only) return initial
    }
    const pathname = pathnameOf(path)
    for (let attempt = 0; ; attempt++) {
      const headers = this.inertiaHeaders()
      if (only) {
        const component =
          this.pageComponents.get(pathname) ??
          (await this.htmlPage(path)).component
        headers["X-Inertia-Partial-Component"] = component
        headers["X-Inertia-Partial-Data"] = only.join(",")
      }
      const response = await this.request.get(path, { headers })
      if (response.status() === 409 && attempt === 0) {
        await this.htmlPage(path)
        continue
      }
      this.assertSignedIn(response, path)
      if (response.status() !== 200) {
        throw new Error(
          `GET ${path} (Inertia${only ? `, partial ${only.join(",")}` : ""}) as the ${this.persona} persona returned HTTP ${response.status()}.`,
        )
      }
      const page = asInertiaPage(await response.json(), `GET ${path}`)
      const expected = this.pageComponents.get(pathname)
      if (only && expected && page.component !== expected) {
        throw new Error(
          `GET ${path} rendered ${page.component} instead of ${expected} (redirected to ${safePath(response.url())}).`,
        )
      }
      this.pageComponents.set(pathname, page.component)
      return page
    }
  }

  /** The props of `path` (a partial reload of `only` when given). */
  async props(path: string, only?: string[]): Promise<Record<string, unknown>> {
    return (await this.page(path, only)).props
  }
}
