// SPDX-License-Identifier: Apache-2.0

import {
  type AppAdapter,
  type Persona,
  type SessionProtocol,
  type StorageState,
  revokeSession,
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
import type {
  APIRequest,
  APIRequestContext,
  APIResponse,
} from "@playwright/test"

import config, { PERSONAS, type PersonaKey } from "../../flowreel.config"

// The Notes app as flowreel sees it: the run's settings (target, base URL,
// personas), the AppAdapter (how to sign in and out, what "signed out"
// looks like) and the persona API client the fixtures hand to flows and to
// undo restores. Nothing here logs a password or a cookie.

// ---------------------------------------------------------------------------
// The run's settings
// ---------------------------------------------------------------------------

/** One run: where it points and who it signs in as. */
export interface NotesRun {
  target: TargetName
  baseURL: string
  module: string
  personas: Record<PersonaKey, Persona>
}

/**
 * The development stage signs in as the Notes app's seeded users (a toy
 * app: never commit a real password). A staging run reads each persona
 * from FLOWREEL_<PERSONA>_EMAIL and FLOWREEL_<PERSONA>_PASSWORD in the
 * process environment or the secrets file instead.
 */
const LOCAL_PERSONAS: Record<PersonaKey, Persona> = {
  editor: { email: "editor@example.test", password: "flowreel-demo" },
  admin: { email: "admin@example.test", password: "flowreel-demo" },
}

/** A persona's staging variables, as docs/configuration.md names them. */
const personaKeys = (key: PersonaKey) => {
  const upper = key.toUpperCase()
  return {
    email: `FLOWREEL_${upper}_EMAIL`,
    password: `FLOWREEL_${upper}_PASSWORD`,
  }
}

/**
 * Reads the run's settings. The target comes from FLOWREEL_TARGET (process
 * environment only, default "local"); the base URL is checked against the
 * allowlist in flowreel.config.ts before anything uses it.
 */
export function loadRun(env: Env = process.env): NotesRun {
  const source = openConfigSource(config.secrets, { env })
  // Checked against the allowlist in flowreel.config.ts (production refused).
  const baseURL = resolveBaseUrl(source, config.targets)
  const module = parseModule(env, config.modules.names, config.modules.default)
  if (source.local) {
    return { target: source.target, baseURL, module, personas: LOCAL_PERSONAS }
  }
  const keys = PERSONAS.flatMap((key) => Object.values(personaKeys(key)))
  requireKeys(source, keys, config.secrets)
  const persona = (key: PersonaKey): Persona => ({
    email: source.get(personaKeys(key).email)!,
    password: source.get(personaKeys(key).password)!,
  })
  return {
    target: source.target,
    baseURL,
    module,
    personas: { editor: persona("editor"), admin: persona("admin") },
  }
}

/** What summary.json records about the run: never a password. */
export function describeRun(run: NotesRun) {
  return {
    target: run.target,
    baseURL: run.baseURL,
    module: run.module,
    personas: Object.fromEntries(
      PERSONAS.map((key) => [key, run.personas[key].email]),
    ),
  }
}

// ---------------------------------------------------------------------------
// The AppAdapter
// ---------------------------------------------------------------------------

/** How a Notes session is probed and revoked. */
export const NOTES_SESSION: SessionProtocol = {
  probePath: "/notes",
  isSignInPath: (path) => path === "/sign-in",
  signOut: { method: "DELETE", path: "/session" },
}

/**
 * Signs a persona in through the app's own sign-in form, posted from the
 * request API: one POST /session, no browser and so no trace that could
 * record the password. Never retried (flowreel calls it once per persona).
 */
async function formSignIn(
  api: APIRequest,
  baseURL: string,
  key: PersonaKey,
  persona: Persona,
): Promise<StorageState> {
  const context = await api.newContext({ baseURL })
  try {
    const response = await context.post("/session", {
      form: { email: persona.email, password: persona.password },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    const location = response.headers().location ?? ""
    if (response.status() !== 303 || !location.endsWith("/notes")) {
      throw new LoginError(
        `Sign-in as the ${key} persona (${persona.email}) returned HTTP ${response.status()}; is the Notes server running on ${baseURL}?`,
      )
    }
    return await context.storageState()
  } finally {
    await context.dispose()
  }
}

/**
 * The Notes app as a flowreel AppAdapter. A real app usually signs in
 * through a test-only seam locally and through its real sign-in page on
 * staging (in ctx.browser, launched outside any test); the toy app's form
 * is simple enough to post on both.
 */
export const notesApp: AppAdapter<PersonaKey> = {
  signIn: (ctx, key, persona) => formSignIn(ctx.api, ctx.baseURL, key, persona),
  needsBrowser: () => false,
  signOut: (api, baseURL, state) =>
    revokeSession(api, baseURL, state, NOTES_SESSION),
  // A signed-out page request is sent to /sign-in; the API answers 401.
  isSignedOut: signedOutBy("/sign-in"),
  keepalivePath: "/api/me",
  async health(api, baseURL) {
    const context = await api.newContext({ baseURL })
    try {
      const response = await context.get("/up")
      return response.ok() ? null : `GET /up returned HTTP ${response.status()}`
    } finally {
      await context.dispose()
    }
  },
}

/** One run's personas, as flowreel's global setup and teardown read them. */
export function runPersonas(run: NotesRun) {
  return {
    target: run.target,
    baseURL: run.baseURL,
    module: run.module,
    keys: PERSONAS,
    persona: (key: PersonaKey) => run.personas[key],
  }
}

// ---------------------------------------------------------------------------
// The persona API client
// ---------------------------------------------------------------------------

export interface NotesUser {
  email: string
  name: string
  role: "editor" | "admin"
}

export interface NotesSettings {
  greeting: string
}

export interface Note {
  id: number
  title: string
  body: string
  author: string
}

/**
 * The Notes JSON API as one persona (the fixtures' `as(persona)`). Flows
 * use it to set up and check state off camera; undo restores use it to put
 * shared settings back and read them again.
 */
export class NotesApi {
  constructor(
    private readonly request: APIRequestContext,
    readonly persona: PersonaKey,
  ) {}

  async me(): Promise<NotesUser> {
    return this.json<NotesUser>("GET /api/me", this.request.get("/api/me"))
  }

  async settings(): Promise<NotesSettings> {
    return this.json<NotesSettings>(
      "GET /api/settings",
      this.request.get("/api/settings"),
    )
  }

  async updateSettings(settings: NotesSettings): Promise<NotesSettings> {
    return this.json<NotesSettings>(
      "PUT /api/settings",
      this.request.put("/api/settings", { data: settings }),
    )
  }

  async createNote(note: Pick<Note, "title" | "body">): Promise<Note> {
    return this.json<Note>(
      "POST /api/notes",
      this.request.post("/api/notes", { data: note }),
    )
  }

  private async json<T>(what: string, call: Promise<APIResponse>) {
    const response = await call
    if (!response.ok()) {
      throw new Error(
        `${what} as the ${this.persona} persona returned HTTP ${response.status()}.`,
      )
    }
    return (await response.json()) as T
  }
}
