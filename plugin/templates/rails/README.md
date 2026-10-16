# The Rails seam kit

Test-only HTTP endpoints ("seams") for a Rails app, so flowreel's
development stage can sign a persona in without the password form, read
the mail the app sent, run queued jobs now and deliver inbound mail. They
speak the protocol of `HttpSeamMailDriver` and `seamSignIn` from
`@confidee/flowreel/rails-inertia` (the protocol is in
[docs/adapters.md](../../../docs/adapters.md#the-seam-protocol)).

Staging never uses them: the routes do not exist there, and the staging
stage signs in through the real form and reads a real mailbox.

## What is here

| File                                                 | Seam                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `app/controllers/concerns/test/e2e_seam_gate.rb`     | the controller half of the double gate (every seam includes it)       |
| `app/controllers/test/sessions_controller.rb`        | `POST /test/sign_in_as`: sign a seeded account in                     |
| `app/controllers/test/mail_deliveries_controller.rb` | `GET`/`DELETE /test/mail_deliveries`: the mail the app sent           |
| `app/controllers/test/enqueued_jobs_controller.rb`   | `POST /test/perform_enqueued_jobs`: run queued jobs now               |
| `app/controllers/test/inbound_emails_controller.rb`  | `POST /test/inbound_emails`: deliver an inbound mail (Action Mailbox) |
| `config/routes/flowreel_seams.rb`                    | the route half of the double gate                                     |
| `spec/requests/test/*_spec.rb`                       | one request spec per seam: both 404 paths and the protocol            |
| `spec/requests/test/seam_gate_spec.rb`               | tripwire: `/test/` routes are gated, gated seams stay under `/test/`  |
| `spec/support/flowreel_seams.rb`                     | the shared contexts the specs use (the flag; a staging-like env)      |

Take only the seams your flows need. Every seam needs Rails 7.1 or later
(`Rails.env.local?`), Ruby 3.1 or later (the templates use hash shorthand
and endless methods) and RSpec (`rspec-rails`). Any Rack version works: the
kit answers `422` by number, because the status symbol changed name in
Rack 3.1 (`:unprocessable_entity` became `:unprocessable_content`). The
inbound seam also needs Action Mailbox (`bin/rails action_mailbox:install`).

## Install

1. Copy the files into the same paths in your app.
2. In `config/routes.rb`, inside `Rails.application.routes.draw do … end`:

   ```ruby
   draw(:flowreel_seams)
   ```

3. Fill in every `TODO(flowreel)`: the flag name (if your app already has
   one), and in `sessions_controller.rb` the auth callback to skip, how an
   account is found and how a session starts. Make the sign-in seam refuse
   whatever your real sign-in refuses.
4. Make sure `spec/rails_helper.rb` loads `spec/support/**/*.rb`, then run
   the specs: `bundle exec rspec spec/requests/test`. Every seam's 404
   examples must pass before you use it.
5. Start the development stage's server with the flag, in
   `e2e/flowreel/playwright.config.ts`:

   ```ts
   webServer: localWebServer({
     command: "bin/rails server -e test -b 127.0.0.1 -p 3100",
     env: { FLOWREEL_TEST_SEAMS: "true" },
     // …
   })
   ```

   The test environment is what makes the drain work: its job adapter is
   the in-memory `:test` adapter and its mail delivery method is `:test`.
   The drain and the inbound seam both answer `422` under any other job
   adapter (a development server running async or Solid Queue, say):
   there the routing job that storing an inbound mail enqueues would run as
   well, and the mailbox would process the mail twice.

6. In `e2e/flowreel/adapter.ts`, sign in through the seam on the local
   target and use the seam mail driver there:

   ```ts
   import {
     HttpSeamMailDriver,
     seamHttpFromRequest,
     seamSignIn,
   } from "@confidee/flowreel/rails-inertia"

   // AppAdapter.signIn, local target:
   return seamSignIn(ctx.api, ctx.baseURL, { body: { email: persona.email } })

   // a MailDriver for the local target (`request` is a Playwright request
   // context created with the base URL):
   new HttpSeamMailDriver({
     http: seamHttpFromRequest(request),
     defaultTimeoutMs: 60_000,
   })
   ```

## The rules these seams keep

1. **Double gate.** The routes exist only in `test` and `development`, and
   every controller answers 404 unless `Rails.env.local?` AND the flag is
   `"true"`. Never gate on "not production": a deployed staging is not
   production. The gate also answers 404 unless the request comes from
   this machine (`request.local?`) with a loopback Host (`localhost`,
   `127.0.0.1`, `::1`), which stops a DNS-rebinding page, and unless a POST
   carries a JSON body, which stops a cross-site form or no-body post from
   any page the developer opens while the flag is on. If your app runs in
   a container and the browser reaches it through a forwarded port, the
   client address is not loopback: adapt `e2e_seam_local_request?` for
   that setup rather than removing it.
2. **A request spec per seam** proves both 404 paths (no flag; a
   staging-like environment with the flag set) and the happy path. The
   gate tripwire fails when a `/test/` route has no gate (or no
   controller), and when a gated controller is routed outside `/test/`.
3. **Under `/test/` only.** Route every seam, including any you add or
   move, under `/test/`: the tripwire covers paths with a `test/` segment
   (inside a scope or a mounted engine too) and nothing else.
   If you change a seam's path in the client (the `paths` option of
   `HttpSeamMailDriver`, the `path` option of `seamSignIn`), keep it under
   `/test/`.
4. **No secrets out.** No seam returns a password, a token or a session
   value; the mail seam returns only what this process sent.
5. **No authorization bypass beyond its job.** The sign-in seam signs in an
   existing account and refuses one the real sign-in would refuse; it never
   creates users or grants roles. The gate answers only a JSON POST, so a
   cross-site HTML form cannot sign the developer's browser in (login
   CSRF), inject inbound mail or drain the queue: keep that check when you
   fill in the TODOs. The inbound seam goes through the real router and
   mailboxes.
6. **Bounded inputs.** Inbound extras are allowlisted (header names, file
   count, size and type), and a file carrying the anti-malware test
   signature is refused before anything is stored.
7. **Listed.** Name every seam in your security notes and in any route-level
   tripwire your app has for unauthenticated endpoints.
