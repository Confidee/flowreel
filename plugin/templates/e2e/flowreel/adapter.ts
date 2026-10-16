import {
  type AppAdapter,
  type Persona,
  type SessionProtocol,
  type StorageState,
  revokeSession,
  safePath,
  signedOutBy,
} from "@confidee/flowreel/app"
import {
  type TargetName,
  openConfigSource,
  parseModule,
  requireKeys,
  resolveBaseUrl,
} from "@confidee/flowreel/config"
import { type Env, LoginError } from "@confidee/flowreel/core"
import type { APIRequest, Browser } from "@playwright/test"

import { type Module, type PersonaKey, flowreel } from "../../flowreel.config"

// The app under test as a flowreel AppAdapter: HOW a persona signs in and
// out. flowreel decides WHEN: once per persona per run in global setup,
// never retried (a retry feeds the app's lockout counter), every session
// revoked in global teardown (traces record the session cookie). Nothing
// here may log or throw a password or a cookie.
//
// TODO(flowreel): fill in every TODO below from your app's sign-in page.

/** TODO(flowreel): the sign-in page and where a signed-out request lands. */
const SIGN_IN_PATH = "/login"

/**
 * TODO(flowreel): a test-only sign-in endpoint for the development stage
 * (POST { email } -> 2xx and a session cookie), or null to use the sign-in
 * form locally too. A seam must exist only in test/development builds and
 * behind an explicit flag; see the Rails seam kit (rails-seam-kit.md).
 */
const LOCAL_SIGN_IN_SEAM: string | null = null

/** How a session is probed and revoked. */
export const SESSION: SessionProtocol = {
  probePath: "/",
  isSignInPath: (path) => path.startsWith(SIGN_IN_PATH),
  // TODO(flowreel): your sign-out request.
  signOut: { method: "POST", path: "/logout" },
  // TODO(flowreel): your CSRF cookie and header, or delete this line.
  // csrf: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" },
}

/**
 * TODO(flowreel): the seeded development accounts (local runs only; they
 * must never exist on staging). The local stage never reads the secrets
 * file, so these are not secrets.
 */
const LOCAL_PERSONAS: Record<PersonaKey, Persona> = {
  user: { email: "user@example.test", password: "development-only" },
  admin: { email: "admin@example.test", password: "development-only" },
}

/** One run's settings, from the process env (and on staging the secrets). */
export interface RunConfig {
  target: TargetName
  module: Module
  baseURL: string
  personas: Record<PersonaKey, Persona | null>
}

const emailKey = (key: PersonaKey) => `FLOWREEL_${key.toUpperCase()}_EMAIL`
const passwordKey = (key: PersonaKey) =>
  `FLOWREEL_${key.toUpperCase()}_PASSWORD`

/** True for a staging secret (the pipeline keeps these off development). */
export function isStagingSecret(name: string): boolean {
  return /^FLOWREEL_[A-Z0-9]+_(EMAIL|PASSWORD)$/.test(name)
}

/**
 * Reads this run's settings. Local: the seeded accounts and the loopback
 * base URL. Staging: the base URL and every persona's credentials from the
 * process env or the owner-only secrets file (throws naming what is
 * missing, never a value).
 */
export function loadRun(env: Env = process.env): RunConfig {
  const source = openConfigSource(flowreel.secrets, { env })
  const module = parseModule(
    env,
    flowreel.modules.names,
    flowreel.modules.default,
  )
  if (!source.local) {
    requireKeys(
      source,
      [
        flowreel.secrets.baseUrlKey ?? "FLOWREEL_BASE_URL",
        ...flowreel.personas.flatMap((key) => [
          emailKey(key),
          passwordKey(key),
        ]),
      ],
      flowreel.secrets,
    )
  }
  const personas = {} as Record<PersonaKey, Persona | null>
  for (const key of flowreel.personas) {
    personas[key] = source.local
      ? LOCAL_PERSONAS[key]
      : {
          email: source.get(emailKey(key))!,
          password: source.get(passwordKey(key))!,
        }
  }
  return {
    target: source.target,
    module,
    baseURL: resolveBaseUrl(source, flowreel.targets, flowreel.secrets),
    personas,
  }
}

/** The run as global setup and teardown read it. */
export function runPersonas(run: RunConfig) {
  return {
    target: run.target,
    baseURL: run.baseURL,
    module: run.module,
    keys: flowreel.personas,
    persona: (key: PersonaKey) => run.personas[key],
  }
}

/** The sign-in form, in a browser launched outside any test (untraced). */
async function formSignIn(
  browser: Browser,
  baseURL: string,
  key: PersonaKey,
  persona: Persona,
): Promise<StorageState> {
  const context = await browser.newContext({ baseURL })
  try {
    const page = await context.newPage()
    let phase = `open ${SIGN_IN_PATH}`
    try {
      await page.goto(SIGN_IN_PATH)
      // TODO(flowreel): your form's labels and button.
      phase = "enter email"
      await page.getByLabel("Email").fill(persona.email)
      phase = "enter password"
      await page.getByLabel("Password").fill(persona.password)
      phase = "submit"
      await page.getByRole("button", { name: /sign in|log in/i }).click()
      phase = `leave ${SIGN_IN_PATH}`
      await page.waitForURL((url) => !url.pathname.startsWith(SIGN_IN_PATH))
    } catch {
      // The Playwright error is not echoed: its call log can quote fill().
      throw new LoginError(
        `Sign-in as the ${key} persona (${persona.email}) failed at "${phase}" (page ${safePath(page.url())}). Check its credentials; do not retry before the app's lockout window has passed.`,
      )
    }
    return await context.storageState()
  } finally {
    await context.close()
  }
}

/** The test-only sign-in seam (development stage only). */
async function seamSignIn(
  api: APIRequest,
  baseURL: string,
  seam: string,
  key: PersonaKey,
  persona: Persona,
): Promise<StorageState> {
  const context = await api.newContext({ baseURL })
  try {
    const response = await context.post(seam, {
      data: { email: persona.email },
    })
    if (!response.ok()) {
      throw new LoginError(
        `Test sign-in as the ${key} persona (${persona.email}) returned HTTP ${response.status()}; is the local server running with its test seams enabled and the development accounts seeded?`,
      )
    }
    return await context.storageState()
  } finally {
    await context.dispose()
  }
}

export const appAdapter: AppAdapter<PersonaKey> = {
  signIn(ctx, key, persona) {
    if (ctx.target === "local" && LOCAL_SIGN_IN_SEAM) {
      return seamSignIn(ctx.api, ctx.baseURL, LOCAL_SIGN_IN_SEAM, key, persona)
    }
    if (!ctx.browser) {
      throw new LoginError(`No sign-in browser for the ${key} persona.`)
    }
    return formSignIn(ctx.browser, ctx.baseURL, key, persona)
  },
  // The form needs a browser on every target unless a local seam is set.
  needsBrowser: (target) => target === "staging" || !LOCAL_SIGN_IN_SEAM,
  signOut: (api, baseURL, state) => revokeSession(api, baseURL, state, SESSION),
  isSignedOut: signedOutBy(SIGN_IN_PATH),
  keepalivePath: "/",
  async health(api, baseURL) {
    const context = await api.newContext({ baseURL })
    try {
      // TODO(flowreel): a path that answers 200 when the app is up.
      const response = await context.get("/")
      return response.ok() ? null : `GET / returned HTTP ${response.status()}`
    } finally {
      await context.dispose()
    }
  },
  prepareLocal() {
    // TODO(flowreel): prepare the development stage's database, seeds and
    // assets, e.g. execSync("npm run db:reset", { stdio: "inherit" }).
    // Throw to stop the run. Never point this at a shared database: give
    // the pipeline a DbIsolation (e2e/flowreel/pipeline.ts) instead.
  },
}
