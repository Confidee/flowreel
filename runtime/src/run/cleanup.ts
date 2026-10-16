// SPDX-License-Identifier: Apache-2.0

import { runMarker } from "./texts.js"

// Off-camera cleanup of the records a feature created ("solve what you
// opened"): after EVERY feature (pass, fail or timeout), outside the
// recording, a run leaves no open QA record behind on a shared target.
//
// Which records: the ones the flow recorded as it created them, plus a
// sweep of each persona's open-records listing for subjects carrying this
// run's "[QA <RUN_ID>]" marker (records a flow made through the UI or by
// mail). A record is touched only when its number has the adapter's shape
// AND (it was recorded OR its subject carries the marker), so a real record
// is never touched. Records already done or gone are left alone. The
// project's CleanupAdapter says what a record number looks like and which
// statuses need nothing more; the deps do the reading and solving.

/** The project's side: record numbers and terminal statuses. */
export interface CleanupAdapter {
  /** True for a record number the cleanup may touch at all. */
  isRecordNumber(number: string): boolean
  /** Statuses that need nothing more (already solved, closed, …). */
  doneStatuses: ReadonlySet<string>
}

/**
 * One row of a persona's open-records listing, as the project's
 * {@link CleanupDeps.listOpen} functions return it: the record number and
 * its subject (the run marker "[QA <RUN_ID>]" decides whether it is this
 * run's).
 */
export interface OpenRow {
  number: string
  subject: string
}

/**
 * How the off-camera cleanup reads and solves records: built by the
 * project per feature over its personas' API clients and passed to
 * {@link cleanUpRunRecords} by its cleanup fixture after every feature
 * (pass, fail or timeout), outside the recording.
 *
 * Each function list is tried persona by persona: a listOpen function that
 * throws is ignored (the others still count); status and solve go to the
 * next persona when one throws. Nothing here is retried beyond that, and
 * only records passing the CleanupAdapter's shape test and the run-marker
 * or tracked rule are ever touched.
 */
export interface CleanupDeps {
  /** Record numbers the feature recorded as it created them. */
  tracked: string[]
  /** Numbers to leave alone (an earlier feature already gave up on them). */
  skip?: ReadonlySet<string>
  /**
   * Each persona's open rows whose subject contains the run id (one
   * function per persona; a failing one is ignored, the others still count).
   */
  listOpen: (() => Promise<OpenRow[]>)[]
  /**
   * The record's status through each persona in turn (the first that can
   * see it wins). Throws when that persona cannot read it.
   */
  status: ((number: string) => Promise<string>)[]
  /** Solve attempts in order. Each throws on refusal. */
  solve: ((number: string) => Promise<void>)[]
}

/**
 * What one cleanup did, per record number. The cleanup never throws: every
 * record lands in exactly one list, and `failed` ones are the caller's to
 * report (the undo ledger's manual entries, which make the run exit
 * non-zero).
 */
export interface CleanupResult {
  /** Solved by this cleanup. */
  solved: string[]
  /** Already in a done status. */
  done: string[]
  /** Readable by no persona (deleted or restricted): reported, never solved. */
  unreadable: string[]
  /** Could not be solved: a person must (the undo ledger's manual entry). */
  failed: { number: string; error: string }[]
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.slice(0, 300) ?? "error"

/** The numbers to look at: tracked first, then swept rows of this run. */
export function cleanupCandidates(
  adapter: Pick<CleanupAdapter, "isRecordNumber">,
  runId: string,
  tracked: string[],
  rows: OpenRow[],
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const marker = runMarker(runId)
  const out: string[] = []
  const add = (number: string) => {
    if (
      adapter.isRecordNumber(number) &&
      !out.includes(number) &&
      !skip.has(number)
    )
      out.push(number)
  }
  for (const number of tracked) add(number)
  for (const row of rows) if (row.subject.includes(marker)) add(row.number)
  return out
}

/**
 * Solves every open QA record of the feature (and of the run). Never
 * throws: every outcome is in the result, so a cleanup problem can never
 * change a feature's verdict.
 */
export async function cleanUpRunRecords(
  adapter: CleanupAdapter,
  runId: string,
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const rows: OpenRow[] = []
  for (const list of deps.listOpen) {
    try {
      rows.push(...(await list()))
    } catch {
      // That persona's listing is unavailable; the tracked numbers and the
      // other personas still cover the run.
    }
  }
  const result: CleanupResult = {
    solved: [],
    done: [],
    unreadable: [],
    failed: [],
  }
  for (const number of cleanupCandidates(
    adapter,
    runId,
    deps.tracked,
    rows,
    deps.skip,
  )) {
    let status: string | null = null
    for (const read of deps.status) {
      try {
        status = await read(number)
        break
      } catch {
        // Not visible to this persona; try the next.
      }
    }
    if (status === null) {
      result.unreadable.push(number)
      continue
    }
    if (adapter.doneStatuses.has(status)) {
      result.done.push(number)
      continue
    }
    let error = "no persona could solve it"
    let solved = false
    for (const solve of deps.solve) {
      try {
        await solve(number)
        solved = true
        break
      } catch (e) {
        error = firstLine(e)
      }
    }
    if (solved) result.solved.push(number)
    else result.failed.push({ number, error })
  }
  return result
}

export interface CleanupLineOptions {
  /** The log prefix, shown as "[<logPrefix>]" (default "flowreel"). */
  logPrefix?: string
  /** What the records are called (default "QA records"). */
  noun?: string
}

/** One line for the run log. */
export function cleanupLine(
  feature: string,
  result: CleanupResult,
  options: CleanupLineOptions = {},
): string {
  const parts = [
    result.solved.length > 0 ? `solved ${result.solved.join(", ")}` : null,
    result.failed.length > 0
      ? `COULD NOT SOLVE ${result.failed.map((f) => `${f.number} (${f.error})`).join(", ")}`
      : null,
    result.unreadable.length > 0
      ? `not readable by any QA persona (deleted or restricted) ${result.unreadable.join(", ")}`
      : null,
  ].filter(Boolean)
  return `[${options.logPrefix ?? "flowreel"}] ${feature}: ${options.noun ?? "QA records"} off camera: ${parts.length > 0 ? parts.join("; ") : "nothing open"}.`
}
