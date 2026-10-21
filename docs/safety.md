# Safety

flowreel drives a real browser against real environments, signs in as real
accounts and can send real email. This page lists every safety rule, why
each one exists, and what you must still do yourself. If a rule ever gets
in your way, fix the configuration. Do not work around the rule.

Most rules are **enforced by the runtime**: they hold whatever your project
code does. Some are **APIs your code must call**: flowreel ships the check,
but it applies only where your mail driver, flow, fixture or adapter calls
it. Those rows say so. The shipped mail drivers and the Rails seam kit
call the checks that apply to them (each row says which); in a driver,
flow or seam you write, those rules hold only if your code calls them. The
posture summary in [SECURITY.md](../SECURITY.md#security-posture) splits
the two.

- [Targets](#targets)
- [Mail](#mail)
- [Sign-in and retries](#sign-in-and-retries)
- [Sessions](#sessions)
- [Secrets](#secrets)
- [Shared data: the undo ledger and cleanup](#shared-data-the-undo-ledger-and-cleanup)
- [The verdict](#the-verdict)
- [Staging policies](#staging-policies)
- [Test seams](#test-seams)
- [Videos and narration](#videos-and-narration)
- [Results and retention](#results-and-retention)
- [The plugin](#the-plugin)
- [Network and telemetry](#network-and-telemetry)
- [Your responsibilities](#your-responsibilities)

## Targets

| Rule                                                                                                    | Why                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Production hosts are refused for every target, with their own message, even when the policy lists them. | A QA run creates records, changes settings and sends mail. None of that may ever touch production.           |
| Staging is an exact list of bare `https://` origins.                                                    | No wildcards and no lookalike hosts. A typo fails closed.                                                    |
| Local is a loopback host (`localhost`, `127.0.0.1`, `[::1]`) on a fixed port range.                     | The development stage points test-only seams at this host, so nothing off the machine may ever receive them. |
| URLs with credentials, a path, a query or a fragment are refused, and messages never echo credentials.  | A base URL is an origin, nothing more, and an error message must not leak a password.                        |
| The target comes from the process environment only, never from the secrets file.                        | A file can never turn a run into a staging run. Staging happens only when someone asks for it.               |
| Two names for the target, run id or module set to different values are refused.                         | An inherited `FLOWREEL_TARGET=staging` must not silently override what your own variable says.               |

## Mail

The send guard and the two inbound budgets in this table are APIs: they
apply only where a mail driver or flow calls them. The Microsoft 365 driver
(`GraphMailDriver`) calls the send guard before every send and every reply.
The HTTP seam driver (`HttpSeamMailDriver`) does not: it talks only to the
loopback local target, and the mail it sends goes into the app's own
inbound pipeline, never out of the app. Neither driver consumes the inbound
budgets; your flow or fixture calls `consume()`. The last three rows
describe the Microsoft 365 driver and its tenant setup.

| Rule                                                                                                                                                                                      | Why                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| On staging, mail can only go to one configured reply domain: one bare address, exact domain match, no subdomains, no display names.                                                       | The sender is a real mailbox, so a stray recipient would be real mail, for example to your real support address.                |
| The send guard (`assertReplyDomainRecipient`) runs **before** any network call, and a refusal (`SendRefusedError`) means nothing was sent.                                                | A refused send must be provably harmless.                                                                                       |
| A mail send is never retried. flowreel has no send retry, and your driver must not add one.                                                                                               | A re-sent mail creates a duplicate record and counts against rate limits.                                                       |
| A tour sends at most 3 inbound mails per staging run by default (`InboundMailBudget`), counted when the flow calls `inboundBudget.consume()` before each send.                            | Staging apps often rate-limit inbound mail per sender, and the tour shares that allowance with every other run.                 |
| Across runs, a sender that already sent its hourly limit (8 by default) is refused before sending (the cross-run inbound ledger).                                                         | A per-run budget cannot see the run before it. Keep the limit below your app's own cap.                                         |
| Extra headers and attachments are for the local seam only. The Microsoft 365 driver refuses both.                                                                                         | Test-only mail shapes must never reach a real mailbox.                                                                          |
| Microsoft 365 access is limited to one QA mailbox (RBAC for Applications, or an existing application access policy), and the limit is tested before the first run.                        | Application mail permissions otherwise reach every mailbox in the tenant. See [Adapters](adapters.md#mail-graph-microsoft-365). |
| Every Microsoft 365 request is bounded, body included (`requestTimeoutMs`, 30 s by default). A send that got no answer is reported as possibly sent (`mayHaveSent`) and never sent again. | A hung connection must not stall a run past its waits, and a lost answer does not prove that a mail was not sent.               |

## Sign-in and retries

| Rule                                                                                            | Why                                                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Each distinct persona signs in once per run, in global setup. Flows and fixtures never sign in. | Every sign-in feeds the app's lockout and rate-limit counters, and some of those count successful sign-ins too. |
| A failed sign-in is never retried (`LoginError`).                                               | A retry loop can lock the account. Wait for the lockout window, check the password, then run once.              |
| `retries: 0` and one worker, fixed by `createConfig()`.                                         | A retried test re-sends mail and re-signs-in. One worker keeps the order of shared-state changes deterministic. |
| Passwords are typed in a browser launched outside any test.                                     | Traces record typed values. The sign-in browser is never traced.                                                |
| Sessions are handed to workers in memory (environment variables), never written to disk.        | A storage-state file is a reusable credential.                                                                  |
| `LoginError` messages name the persona and the step, never a password.                          | Error output ends up in CI logs.                                                                                |

## Sessions

| Rule                                                                                                                                                                                                                                                                                                                                                              | Why                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Global teardown revokes every persona session, on pass and on fail, and then proves it is dead with the original cookies.                                                                                                                                                                                                                                         | Traces and HTML reports record request headers, including session cookies. A dead cookie is harmless.       |
| A revoke that fails is a loud warning naming the persona and what to do. Until it is fixed, share nothing but `summary.md`.                                                                                                                                                                                                                                       | You need to know when the files on disk still hold a live session.                                          |
| A run stopped early still signs out: the teardown waits (up to 60 s) for sign-ins still in flight, and when the teardown was cut short the summary reporter waits for its sign-out or signs the personas out itself, loudly. Not after a second Ctrl-C to the pipeline: the stage is killed 3 s later, which may be too soon; check the log's `signed out` lines. | A stop during sign-in, or a second Ctrl-C during the teardown, must not leave a live session in the traces. |
| The keepalive (one GET per session every 4 minutes) never signs in. A session the app signed out stays signed out.                                                                                                                                                                                                                                                | Keeping a session alive must never become a way to re-authenticate.                                         |
| The keepalive stops at a hard deadline: 2 hours after the run started by default (`FLOWREEL_KEEPALIVE_MAX_MIN`, 15 to 480, or to the project's `keepalive.maxMinutes` ceiling).                                                                                                                                                                                   | A hung test or a paused debugger must not hold sessions open indefinitely.                                  |
| The keepalive is off under the Playwright inspector (`PWDEBUG`).                                                                                                                                                                                                                                                                                                  | An idle debugging session should time out as usual.                                                         |

If your organisation has an idle-timeout policy, the keepalive is an
exception to it for the QA accounts only. Record it as one, with these
bounds as compensating controls.

## Secrets

| Rule                                                                                                                                                                                                                                      | Why                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A local run never reads the secrets file.                                                                                                                                                                                                 | Development needs no secrets, so it gets none.                                                 |
| The development stage's environment is stripped of `FLOWREEL_BASE_URL` and `FLOWREEL_ENV_FILE` (and their aliases), plus every variable `PipelineSpec.isSecret` matches. A custom `secrets.baseUrlKey` must be matched by `isSecret` too. | A password injected for staging must not reach the local server or its logs.                   |
| The secrets file must be owned by you and closed to group and others (`chmod 600`), checked on the open descriptor.                                                                                                                       | Other users on the machine must not be able to read it, and the file checked is the file read. |
| The recommended source is a password manager, injected for one command.                                                                                                                                                                   | No plaintext copy stays on disk.                                                               |
| Messages name missing or placeholder keys, never values. Nothing in the runtime logs a secret.                                                                                                                                            | Logs and summaries are shared.                                                                 |
| `summary.json` records a redacted description of the configuration (your `describeConfig()`).                                                                                                                                             | The evidence must show what ran without carrying credentials.                                  |

## Shared data: the undo ledger and cleanup

| Rule                                                                                                                                                                                                    | Why                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Every change a flow makes through `undo.change()` is written to the ledger **before** it is made, with the before-state and manual instructions. Route every change to shared configuration through it. | A crash between the change and its restore still leaves the instructions on disk.          |
| Restores run newest first, after the test and again at the worker's end, and must re-read the state to confirm it.                                                                                      | "The write returned" is not "restored".                                                    |
| A failed or still-pending restore makes the pipeline exit 4, which outranks every other code.                                                                                                           | Someone must act. The run must not look green while staging is left changed.               |
| The off-camera cleanup touches only records whose number has your shape **and** that this run created or marked `[QA <RUN_ID>]`.                                                                        | A real record must never be touched.                                                       |
| Cleanup should close records (a terminal status), never delete them. The closing is done by the `solve` functions you supply, so the runtime cannot enforce this: write them to close.                  | Deleting on a shared target can destroy data other systems depend on, and leaves no trail. |
| Everything a run creates is named with its run id.                                                                                                                                                      | Leftovers are easy to recognise and filter.                                                |

## The verdict

| Rule                                                                                                                                                                    | Why                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Only Playwright assertions decide PASS or FAIL.                                                                                                                         | A release gate must be reproducible and reviewable.                                                                |
| AI (the plugin's skills and agents) writes plans, flows and narration and explains results. It never decides a verdict and never edits an assertion to make a run pass. | A gate that an AI can talk into passing is not a gate. Locator fixes are allowed; assertion changes need a person. |
| Videos, narration and demo publishing run after the verdict is fixed and cannot change it.                                                                              | Presentation must never influence evidence.                                                                        |
| A run that dies before writing a summary is a FAIL. N/A is never counted as a pass.                                                                                     | Missing evidence is not success.                                                                                   |

## Staging policies

| Rule                                                                                                                                 | Why                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| A feature's staging policy is the owner's decision, recorded in the catalogue. `feature()` refuses a flow whose policy differs.      | Whether something may run against shared staging is not the flow author's call. |
| Only `feature()` skips. Hooks and `test.skip/only/fixme/fail` are refused by the static tripwire.                                    | Nothing may run before the policy is applied, and nothing may hide a feature.   |
| A flow cannot choose its target.                                                                                                     | The target comes from the run's configuration.                                  |
| On staging, every persona should be a dedicated QA account. Never use a real person's account. (Enforce this in your config loader.) | Audit trails on staging must never read as a person's actions.                  |

## Test seams

If your app exposes test-only endpoints for the development stage (sign in
as a persona, capture mail, inspect jobs), these rules apply to them. The
protocol is in [Adapters](adapters.md#the-seam-protocol). For a Rails app,
the Rails seam kit (`plugin/templates/rails/`, see
[Adapters](adapters.md#the-rails-seam-kit)) ships the seams, the gate and a
request spec per seam that keep these rules; it holds once you copy it in
and its specs pass. Seams you write yourself must keep them too:

- route them **only** in test and development, and only behind an explicit
  flag (a double gate);
- ship a request spec for each seam that proves **both** 404 paths: no
  flag, and a production-like environment;
- never let a seam weaken a real control. It may only stand in for a step
  the test cannot do locally;
- never point them at anything but loopback (the local target guarantees
  this).

## Videos and narration

| Rule                                                                                                                                        | Why                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Email cards redact reply and notify tokens, long plus tags, links and opaque strings, twice.                                                | Those tokens can thread a reply into a real record or open a portal.              |
| Narration never speaks addresses, links, run ids, QA prefixes, long tokens or your own patterns.                                            | A video is shared more widely than a log.                                         |
| On staging, table rows that do not belong to the run are blurred from their first frame, once your page fixture calls `installPrivacyMask`. | Staging can hold real people's data. Data minimisation applies to recordings too. |
| Voice text is passed to tools as an argument array, never through a shell.                                                                  | A sentence must never become a command.                                           |
| Demo videos are published automatically only from development runs. Staging runs are published on purpose.                                  | Demos should show seed data, not staging data.                                    |

## Results and retention

The results folder is **credential-bearing**:

- traces and HTML reports contain request headers, including the session
  cookies (revoked at teardown, but treat them as live until confirmed);
- saved `.eml` files can contain reply tokens;
- staging videos can show staging data, blurred or not.

So:

- git-ignore the results and demos folders (`/flowreel:init` does);
- share only `summary.md` and `pipeline.md`;
- delete run folders once their summary is filed, and keep none longer than
  30 days, for example:

```bash
find flowreel-results -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

## The plugin

- No hook installs or downloads anything. The `SessionStart` check is
  read-only and never blocks.
- `/flowreel:doctor` and `/flowreel:init` show what they will do and wait
  for your confirmation before installing or editing anything.
- Every command the plugin may run is listed in [plugin.md](plugin.md).

## Network and telemetry

flowreel sends nothing anywhere you did not configure. It talks only to:

- your local and staging targets;
- your mail provider (for example Microsoft Graph), if you configured one;
- a voice provider, if you configured one (the built-in macOS engine is
  fully local).

There is no telemetry, no analytics and no update check.

## Your responsibilities

flowreel cannot check these for you:

- `isProductionHost` must cover **every** production host name, including
  API, mail and reply subdomains.
- The reply domain must route to **staging**, never production.
- The QA mailbox must have no automatic replies, no forwarding and a
  minimal list of people with access.
- QA accounts on staging must be dedicated accounts. Record any exception
  (password sign-in without MFA, the session keepalive) in your risk
  register with its compensating controls.
- Register the accounts, the mail app and its credential in your asset
  inventory, each with an owner.
