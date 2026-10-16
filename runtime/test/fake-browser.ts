// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs"

import { chromium } from "@playwright/test"

// A stand-in for chromium.launch(): records what the renderer asked of the
// browser and writes an (empty) file where a screenshot was requested.

export interface BrowserLog {
  launches: number
  contexts: unknown[]
  contents: { html: string; options: unknown }[]
  shots: { path: string; omitBackground: boolean }[]
  /** "context" | "browser" in the order they were closed. */
  closed: string[]
}

export interface FakeBrowserOptions {
  /** Throw from screenshot() for this path. */
  failShotAt?: string
}

type Launch = typeof chromium.launch

export function installFakeBrowser(options: FakeBrowserOptions = {}): {
  log: BrowserLog
  restore: () => void
} {
  const log: BrowserLog = {
    launches: 0,
    contexts: [],
    contents: [],
    shots: [],
    closed: [],
  }
  const original = chromium.launch
  const fake = () => {
    log.launches++
    return Promise.resolve({
      newContext: (contextOptions: unknown) => {
        log.contexts.push(contextOptions)
        return Promise.resolve({
          newPage: () =>
            Promise.resolve({
              setContent: (html: string, opts: unknown) => {
                log.contents.push({ html, options: opts })
                return Promise.resolve()
              },
              screenshot: (shot: { path: string; omitBackground: boolean }) => {
                if (shot.path === options.failShotAt) {
                  return Promise.reject(new Error("screenshot failed"))
                }
                log.shots.push({
                  path: shot.path,
                  omitBackground: shot.omitBackground,
                })
                writeFileSync(shot.path, "")
                return Promise.resolve(Buffer.alloc(0))
              },
            }),
          close: () => {
            log.closed.push("context")
            return Promise.resolve()
          },
        })
      },
      close: () => {
        log.closed.push("browser")
        return Promise.resolve()
      },
    })
  }
  chromium.launch = fake as unknown as Launch
  return {
    log,
    restore: () => {
      chromium.launch = original
    },
  }
}
