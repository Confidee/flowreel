// SPDX-License-Identifier: Apache-2.0

// "Notes": the tiny app the minimal flowreel example tests. Plain HTML and a
// little JavaScript, served by Node's own http module (no dependencies).
// Everything lives in memory and starts from the same seed on every start,
// so each run sees the same app. It listens on 127.0.0.1 only.
//
//   node app/server.mjs [--port 3179]
//
// Pages:  /sign-in, /notes (list + search), /notes/new (form), /notes/:id
//         (detail + delete), /settings (admin only: the workspace greeting)
// API:    GET /api/me, GET/PUT /api/settings, GET/POST /api/notes,
//         DELETE /api/notes/:id
// Session: POST /session (sign in), DELETE /session (sign out), /up (health)
//
// A toy, not a pattern for real authentication: the two users and their
// password are fixed below so the example runs with nothing to configure.

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = "127.0.0.1"

/** @typedef {{ email: string, name: string, role: "editor" | "admin" }} User */
/** @typedef {{ id: number, title: string, body: string, author: string }} Note */

/** The seeded users (password: DEMO_PASSWORD). */
const DEMO_PASSWORD = "flowreel-demo"
/** @type {User[]} */
const USERS = [
  { email: "editor@example.test", name: "Erin Editor", role: "editor" },
  { email: "admin@example.test", name: "Avery Admin", role: "admin" },
]

/** @type {Map<string, User>} session id -> user */
const sessions = new Map()
const settings = { greeting: "Welcome to the team notebook." }
/** @type {Note[]} */
const notes = [
  {
    id: 1,
    title: "Kick-off agenda",
    body: "Goals, owners and the first milestone.",
    author: "Avery Admin",
  },
  {
    id: 2,
    title: "Release checklist",
    body: "Changelog, smoke test, announce.",
    author: "Erin Editor",
  },
  {
    id: 3,
    title: "Customer feedback",
    body: "Three requests for a dark theme.",
    author: "Erin Editor",
  },
]
let nextId = notes.length + 1

/** @param {string} value */
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/**
 * @param {string} title
 * @param {string} body
 * @param {User | null} user
 */
function layout(title, body, user) {
  const nav = user
    ? `<nav aria-label="Main">
        <a href="/notes">Notes</a>
        ${user.role === "admin" ? '<a href="/settings">Settings</a>' : ""}
        <span class="who">${escape(user.name)}</span>
        <form method="post" action="/sign-out"><button type="submit">Sign out</button></form>
      </nav>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Notes</title>
<link rel="stylesheet" href="/assets/style.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<header><span class="brand">Notes</span>${nav}</header>
<main>${body}</main>
</body>
</html>`
}

/** @param {string} cookieHeader */
function sessionId(cookieHeader) {
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === "notes_session") return rest.join("=")
  }
  return null
}

/** @param {import("node:http").IncomingMessage} req */
function currentUser(req) {
  const id = sessionId(req.headers.cookie ?? "")
  return id ? (sessions.get(id) ?? null) : null
}

/** @param {import("node:http").IncomingMessage} req */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (req)) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error("body too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** @param {string} raw @returns {Record<string, string>} */
const formOf = (raw) => Object.fromEntries(new URLSearchParams(raw))

/** @param {string} raw @returns {Record<string, unknown>} */
function jsonOf(raw) {
  try {
    const value = /** @type {unknown} */ (JSON.parse(raw))
    return value && typeof value === "object"
      ? /** @type {Record<string, unknown>} */ (value)
      : {}
  } catch {
    return {}
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
  res.end(html)
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} location
 * @param {Record<string, string>} [headers]
 */
function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...headers })
  res.end()
}

/** @param {string | null} error */
function signInPage(error) {
  return layout(
    "Sign in",
    `<h1>Sign in</h1>
    ${error ? `<p role="alert">${escape(error)}</p>` : ""}
    <form method="post" action="/session" class="card">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>`,
    null,
  )
}

/** @param {User} user @param {string | null} status */
function listPage(user, status) {
  const rows = notes
    .map(
      (n) =>
        `<tr><td><a href="/notes/${n.id}">${escape(n.title)}</a></td><td>${escape(n.author)}</td></tr>`,
    )
    .join("")
  return layout(
    "Notes",
    `<p class="greeting" role="status" aria-label="Greeting">${escape(settings.greeting)}</p>
    ${status ? `<p class="flash" role="status">${escape(status)}</p>` : ""}
    <div class="bar">
      <h1>Notes</h1>
      <a class="button" href="/notes/new">New note</a>
    </div>
    <label class="search">Search notes <input type="search" name="q" data-filter="notes"></label>
    <table id="notes">
      <thead><tr><th>Title</th><th>Author</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="empty" hidden>No note matches.</p>`,
    user,
  )
}

/** @param {User} user @param {string | null} error */
function newNotePage(user, error) {
  return layout(
    "New note",
    `<h1>New note</h1>
    ${error ? `<p role="alert">${escape(error)}</p>` : ""}
    <form method="post" action="/notes" class="card">
      <label>Title <input name="title" required maxlength="120"></label>
      <label>Body <textarea name="body" rows="5" maxlength="2000"></textarea></label>
      <button type="submit">Save note</button>
    </form>`,
    user,
  )
}

/** @param {User} user @param {Note} note */
function notePage(user, note) {
  return layout(
    note.title,
    `<article class="card">
      <h1>${escape(note.title)}</h1>
      <p class="meta">By ${escape(note.author)}</p>
      <p>${escape(note.body)}</p>
    </article>
    <div class="bar">
      <a href="/notes">Back to notes</a>
      <form method="post" action="/notes/${note.id}/delete"><button type="submit" class="danger">Delete note</button></form>
    </div>`,
    user,
  )
}

/** @param {User} user @param {string | null} status */
function settingsPage(user, status) {
  return layout(
    "Settings",
    `<h1>Workspace settings</h1>
    ${status ? `<p class="flash" role="status">${escape(status)}</p>` : ""}
    <form method="post" action="/settings" class="card">
      <label>Workspace greeting <input name="greeting" value="${escape(settings.greeting)}" required maxlength="160"></label>
      <button type="submit">Save settings</button>
    </form>`,
    user,
  )
}

/** @param {string} title @param {string} body @param {User} user */
function addNote(title, body, user) {
  const note = { id: nextId++, title, body, author: user.name }
  notes.push(note)
  return note
}

/** @param {string} path */
function staticAsset(path) {
  const files = /** @type {Record<string, string>} */ ({
    "/assets/style.css": "text/css; charset=utf-8",
    "/assets/app.js": "text/javascript; charset=utf-8",
  })
  const type = files[path]
  return type
    ? {
        type,
        body: readFileSync(join(HERE, "public", path.slice(8)), "utf8"),
      }
    : null
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}`)
  const path = url.pathname
  const method = req.method ?? "GET"
  const user = currentUser(req)

  if (path === "/up") return sendHtml(res, 200, "ok")
  const asset = method === "GET" ? staticAsset(path) : null
  if (asset) {
    res.writeHead(200, { "content-type": asset.type })
    return res.end(asset.body)
  }

  // Signing in and out.
  if (path === "/sign-in" && method === "GET") {
    return sendHtml(res, 200, signInPage(null))
  }
  if (path === "/session" && method === "POST") {
    const form = formOf(await readBody(req))
    const found = USERS.find(
      (u) => u.email === (form.email ?? "").trim().toLowerCase(),
    )
    if (!found || form.password !== DEMO_PASSWORD) {
      return sendHtml(
        res,
        401,
        signInPage("That email and password do not match."),
      )
    }
    const id = randomBytes(24).toString("hex")
    sessions.set(id, found)
    return redirect(res, "/notes", {
      "set-cookie": `notes_session=${id}; Path=/; HttpOnly; SameSite=Lax`,
    })
  }
  if (path === "/session" && method === "DELETE") {
    const id = sessionId(req.headers.cookie ?? "")
    if (id) sessions.delete(id)
    res.writeHead(204, { "set-cookie": "notes_session=; Path=/; Max-Age=0" })
    return res.end()
  }
  if (path === "/sign-out" && method === "POST") {
    const id = sessionId(req.headers.cookie ?? "")
    if (id) sessions.delete(id)
    return redirect(res, "/sign-in", {
      "set-cookie": "notes_session=; Path=/; Max-Age=0",
    })
  }

  // The JSON API (401 when signed out).
  if (path.startsWith("/api/")) {
    if (!user) return sendJson(res, 401, { error: "signed out" })
    if (path === "/api/me" && method === "GET") return sendJson(res, 200, user)
    if (path === "/api/settings" && method === "GET") {
      return sendJson(res, 200, settings)
    }
    if (path === "/api/settings" && method === "PUT") {
      if (user.role !== "admin") return sendJson(res, 403, { error: "admin" })
      const body = jsonOf(await readBody(req))
      if (typeof body.greeting !== "string" || !body.greeting.trim()) {
        return sendJson(res, 422, { error: "greeting is required" })
      }
      settings.greeting = body.greeting.trim()
      return sendJson(res, 200, settings)
    }
    if (path === "/api/notes" && method === "GET") {
      return sendJson(res, 200, notes)
    }
    if (path === "/api/notes" && method === "POST") {
      const body = jsonOf(await readBody(req))
      if (typeof body.title !== "string" || !body.title.trim()) {
        return sendJson(res, 422, { error: "title is required" })
      }
      const text = typeof body.body === "string" ? body.body : ""
      return sendJson(res, 201, addNote(body.title.trim(), text, user))
    }
    const apiNote = /^\/api\/notes\/(\d+)$/.exec(path)
    if (apiNote && method === "DELETE") {
      const index = notes.findIndex((n) => n.id === Number(apiNote[1]))
      if (index < 0) return sendJson(res, 404, { error: "not found" })
      notes.splice(index, 1)
      res.writeHead(204)
      return res.end()
    }
    return sendJson(res, 404, { error: "not found" })
  }

  // Pages (a signed-out visitor is sent to the sign-in page).
  if (!user) return redirect(res, "/sign-in")
  if (path === "/" && method === "GET") return redirect(res, "/notes")
  if (path === "/notes" && method === "GET") {
    const status = url.searchParams.get("deleted") ? "Note deleted." : null
    return sendHtml(res, 200, listPage(user, status))
  }
  if (path === "/notes/new" && method === "GET") {
    return sendHtml(res, 200, newNotePage(user, null))
  }
  if (path === "/notes" && method === "POST") {
    const form = formOf(await readBody(req))
    const title = (form.title ?? "").trim()
    if (!title) {
      return sendHtml(res, 422, newNotePage(user, "A note needs a title."))
    }
    const note = addNote(title, (form.body ?? "").trim(), user)
    return redirect(res, `/notes/${note.id}`)
  }
  const show = /^\/notes\/(\d+)$/.exec(path)
  if (show && method === "GET") {
    const note = notes.find((n) => n.id === Number(show[1]))
    return note
      ? sendHtml(res, 200, notePage(user, note))
      : sendHtml(res, 404, layout("Not found", "<h1>Not found</h1>", user))
  }
  const remove = /^\/notes\/(\d+)\/delete$/.exec(path)
  if (remove && method === "POST") {
    const index = notes.findIndex((n) => n.id === Number(remove[1]))
    if (index >= 0) notes.splice(index, 1)
    return redirect(res, "/notes?deleted=1")
  }
  if (path === "/settings") {
    if (user.role !== "admin") {
      return sendHtml(
        res,
        403,
        layout("Settings", "<h1>Only an admin can change settings</h1>", user),
      )
    }
    if (method === "GET") {
      const status = url.searchParams.get("saved") ? "Settings saved." : null
      return sendHtml(res, 200, settingsPage(user, status))
    }
    if (method === "POST") {
      const greeting = (formOf(await readBody(req)).greeting ?? "").trim()
      if (greeting) settings.greeting = greeting
      return redirect(res, "/settings?saved=1")
    }
  }
  return sendHtml(res, 404, layout("Not found", "<h1>Not found</h1>", user))
}

const portArg = process.argv.indexOf("--port")
const port = Number(
  portArg > 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 3179),
)

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error)
    if (!res.headersSent) sendHtml(res, 500, "Something went wrong.")
    else res.end()
  })
}).listen(port, HOST, () => {
  console.log(`Notes is running on http://${HOST}:${port}`)
})
