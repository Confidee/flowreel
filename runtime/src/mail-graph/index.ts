// SPDX-License-Identifier: Apache-2.0

// @confidee/flowreel/mail-graph: the MailDriver for one Microsoft 365
// mailbox via Microsoft Graph, app-only (client credentials). Every send
// and reply passes the reply-domain send guard before any request. The
// tenant setup (permissions, the mailbox scope, the order of the admin
// steps) is in docs/adapters.md "mail-graph".

export {
  DEFAULT_GRAPH_DRIVER_COPY,
  type FetchLike,
  GRAPH_BASE,
  type GraphDriverCopy,
  GraphHttpError,
  GraphMailDriver,
  type GraphMailDriverOptions,
  headerAddresses,
  toMailMessage,
} from "./graph.js"
