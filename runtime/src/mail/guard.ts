// SPDX-License-Identifier: Apache-2.0

import { SendRefusedError } from "../core/errors.js"

// The staging send guard. On staging the sender is a real mailbox, so a
// stray recipient would be real mail: above all the product's real support
// address, which may feed production support. On staging flowreel therefore
// only ever mails the reply domain (an inbound-parse domain routed to
// staging): the support address as `<local part>@<reply domain>` and the
// `reply+<token>@` address of a reply. Exact domain match: no subdomains,
// no lookalikes, no display names, one recipient only.

// One bare address: no whitespace, angle brackets, commas, quotes or a
// second "@" anywhere.
const BARE_ADDRESS = /^([^@\s<>,;:"()[\]\\]+)@([^@\s<>,;:"()[\]\\]+)$/

/** The wording of a refusal that a project may tailor. */
export interface SendGuardCopy {
  /** The setting that holds the reply domain (named when it is unset). */
  domainSetting: string
  /** A real mailbox the guard protects, named as the example. */
  realMailbox: string
}

export const DEFAULT_SEND_GUARD_COPY: SendGuardCopy = {
  domainSetting: "FLOWREEL_REPLY_DOMAIN",
  realMailbox: "your production support address",
}

/**
 * Returns `to` trimmed and lower-cased when its domain is exactly
 * `replyDomain`; otherwise throws SendRefusedError naming the domain it
 * expected. Call it before any network request.
 */
export function assertReplyDomainRecipient(
  to: string,
  replyDomain: string,
  copy: SendGuardCopy = DEFAULT_SEND_GUARD_COPY,
): string {
  const expected = replyDomain.trim().toLowerCase()
  const address = to.trim().toLowerCase()
  const match = BARE_ADDRESS.exec(address)
  if (expected !== "" && match?.[2] === expected) return address
  throw new SendRefusedError(
    `Refusing to send to ${JSON.stringify(to)}: on staging the harness only mails a single bare address on the reply domain ${expected || "(unset)"} (${copy.domainSetting}), never a real mailbox such as ${copy.realMailbox}.`,
  )
}

/**
 * "<local part of supportAddress>@<replyDomain>", what a first inbound mail
 * is sent to on staging.
 */
export function replyDomainTarget(
  supportAddress: string,
  replyDomain: string,
  copy: SendGuardCopy = DEFAULT_SEND_GUARD_COPY,
): string {
  const local = supportAddress.trim().toLowerCase().split("@")[0]
  return assertReplyDomainRecipient(
    `${local}@${replyDomain}`,
    replyDomain,
    copy,
  )
}
