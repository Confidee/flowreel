# Rails test seams for flowreel (the protocol)

> The Rails seam kit (controllers, the routes file and one request spec
> per seam) is in [`rails/`](rails/README.md), and the client that talks
> to it ships with `@confidee/flowreel/rails-inertia`:
> `HttpSeamMailDriver` (mail and jobs) and `seamSignIn` (sign-in). This
> page is the protocol both sides keep; the full reference is in
> [docs/adapters.md](../../docs/adapters.md#the-seam-protocol).

A **seam** is a test-only HTTP endpoint the development stage uses instead
of a slow or unsafe real path: signing a persona in without the password
form, reading the mail the app would have sent, running queued jobs now,
or delivering an inbound mail. Seams make the local run fast and keep it
away from real lockout counters and real mailboxes. Staging never uses
them: it signs in through the real form and checks real mail.

## The rules every seam follows

1. **Double gate.** The route exists only in the `test` and `development`
   environments, AND the controller answers only when the process runs in a
   local environment and an explicit flag is set (an env var such as
   `FLOWREEL_TEST_SEAMS=true`, set only by the development stage's web
   server). Anything else is a plain `404`, never a hint that the seam
   exists. Do not gate on "not production" alone: staging is not
   production. The controller also answers `404` unless the request comes
   from this machine with a loopback `Host` (against DNS rebinding: the
   development stage runs the app in the test environment, where Rails'
   host authorization is off) and unless a `POST` carries a JSON body
   (`Content-Type: application/json`), so no cross-site page can post to a
   seam while the flag is on.
2. **A request spec per seam** proving both 404 paths (flag off; non-local
   environment) and the happy path.
3. **No secrets out.** A seam never returns a password, token, session
   value or another user's data beyond what the flow asked for.
4. **No authorization bypass beyond its job.** The sign-in seam creates a
   session for an existing seeded account; it never creates users or
   grants roles.
5. **Listed.** Every seam is named in the project's security notes and
   covered by any route-level tripwire the app has for unauthenticated
   endpoints.

## Sign-in (`seamSignIn`)

`POST /test/sign_in_as` with JSON `{ "email": "<seeded account>" }`.

- `2xx` (`204` is typical) and the session cookie: signed in. The
  template's `seamSignIn()` in `adapter.ts` treats any other status as a
  sign-in failure and never retries it.
- `404` when the gate is closed or the account does not exist; `403` when
  the account may not sign in. Never `200` for an unknown account.

Wire it into `e2e/flowreel/adapter.ts` (`LOCAL_SIGN_IN_SEAM`) and start the
development server with the flag set (the `webServer.env` in
`e2e/flowreel/playwright.config.ts`).

## Mail and jobs (`HttpSeamMailDriver`)

The client reads outbound mail from the app's test delivery list, drains
queued jobs after every send and reply and before every poll (the test
queue adapter runs nothing by itself), and hands inbound mail to the app's
real inbound pipeline. Paths are the defaults; a project changes them with
the driver's `paths` option.

### `GET /test/mail_deliveries[?after=<cursor>]`: sent mail

Deliveries only ever append (until cleared), so the client reads by
cursor, not by clock.

- `200` JSON `{ "deliveries": [ … ], "cursor": <n> }`. Every entry
  carries a 1-based `index`; `?after=<n>` returns the entries with
  `index > n` (none = from the start), and `cursor` is the highest index
  overall (`0` when empty), which the client passes as the next `after`.
  A `cursor` lower than the one the client sent means the list was
  cleared: it starts over from the beginning.
- Each entry:

  | Field         | Type              | Notes                                                                        |
  | ------------- | ----------------- | ---------------------------------------------------------------------------- |
  | `index`       | number            | 1-based position in the delivery list                                        |
  | `messageId`   | string            | with angle brackets (`<id@host>`); stamp one if the mail has none yet        |
  | `from`        | string[]          | formatted, display name kept (`Name <a@b>`)                                  |
  | `to`, `cc`    | string[]          | bare addresses                                                               |
  | `replyTo`     | string[]          | bare addresses                                                               |
  | `subject`     | string            |                                                                              |
  | `text`        | string            | the text part, else the HTML part reduced to text                            |
  | `inReplyTo`   | string or null    | with angle brackets                                                          |
  | `references`  | string[]          | each with angle brackets                                                     |
  | `headers`     | `{ name: value }` | names lower-cased; a repeated header joined with `", "`                      |
  | `deliveredAt` | ISO 8601 string   | the message's `Date` header (second precision; the client floors to seconds) |

- Cap the response (the newest entries after the cursor, e.g. 200).
- Any status other than `200` is a failure the client reports with the
  status and body.
- Optional: `DELETE /test/mail_deliveries` clears the list (`204`), for a
  local preflight only.

### `POST /test/perform_enqueued_jobs`: run queued jobs now

- `200` JSON once every job that is ready has run (repeat passes until a
  pass finds nothing ready: jobs enqueue jobs):
  `{ "performed": <n>, "discarded": <n>, "errors": [{ "job": "<class>", "error": "<message>" }] }`.
  A job that raises is listed in `errors` and the drain carries on; the
  client records those and names them when a mail never arrives.
- Leave jobs scheduled for the future queued (running them early changes
  behaviour). Discard the inbound routing job if your inbound seam routes
  by hand, or each inbound mail is processed twice.
- Any status other than `200` is a failure, including `204`: answer `422`
  with `{ "error": "…" }` when the queue adapter is not the test adapter.
  The client's health check calls this and the deliveries seam once at
  start.

### `POST /test/inbound_emails`: deliver an inbound mail

JSON body (the client never sends a raw MIME message; the seam builds it):

| Field                           | Notes                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                          | `"support_address"`: a fresh mail to one of the app's inbound addresses (a send); `"raw"`: any inbound mail, routed by the app's real router (a reply) |
| `to`, `from`, `subject`, `body` | plain strings; `to` is required for `raw`                                                                                                              |
| `message_id`                    | the client's own, with angle brackets, so it can follow the thread                                                                                     |
| `in_reply_to`, `references`     | `raw` replies: the original's Message-ID, and the references chain (array)                                                                             |
| `headers`                       | optional `{ name: value }`: allowlist the names you accept; refuse line breaks and long values                                                         |
| `attachments`                   | optional `[ { filename, base64, mime } ]`: cap the count and size and allowlist the types                                                              |

- `201` JSON (e.g. `{ "outcome": "created", "messageId": "…" }`): the app
  stored and processed the mail.
- `422` JSON with any of `mailbox`, `outcome`, `reason`, `status`: the mail
  was not captured (not routed, dropped, a duplicate, refused extras); the
  client fails the step quoting those fields, never the mail itself.
- Anything else is a failure reported with its status and body. The
  client never retries a send: a retry can create a duplicate record.
