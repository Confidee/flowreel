// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Undo ledger: every change a flow makes to SHARED configuration is put
// back, and if it cannot be, a person is told exactly what to do.
//
//   const entry = await undo.change({
//     what: "Default team: Operations -> QA-<run>",
//     before: { defaultTeamId: 3 },
//     manual: "Admin > Teams: make Operations the default again.",
//     restore: async ({ as }) => { …re-read the state, put it back… },
//   })
//   …make the change…
//   await entry.restoreNow()   // global-effect changes: restore in the test
//
// change() writes the entry (what, before, manual instructions) to
// <RUN_ID>/undo.json and undo.md BEFORE it returns, so a crash between the
// change and its restore still leaves the instructions on disk. Restores run
// LIFO: the test's own entries at its teardown (pass, fail or timeout), and
// anything left at the worker's teardown. A restore re-reads the state; it is
// recorded `restored` or `FAILED` (with the error). A failed restore never
// changes a feature's verdict, but the run exits non-zero and the pipeline
// exits 4 ("undo failed: manual action needed"), listed first everywhere.
//
// Restores run after the test's own fixtures are gone, so `restore` must not
// use the test's `page` or request contexts: it gets the worker-scoped persona
// API through its argument.

export type UndoStatus = "pending" | "restored" | "FAILED"

export interface UndoEntry {
  id: string
  /** Order of recording within the run (LIFO restores go by it). */
  seq: number
  /** The feature id (e.g. "E2") or test title that made the change. */
  feature: string
  what: string
  before: unknown
  /** Human restore instructions, shown in undo.md when automation fails. */
  manual: string
  status: UndoStatus
  error: string | null
  recordedAt: string
  restoredAt: string | null
}

export interface UndoFile {
  runId: string
  entries: UndoEntry[]
}

export interface UndoChange<C> {
  what: string
  /** The recorded before-state (JSON-able; shown in undo.md). */
  before: unknown
  manual: string
  restore: (context: C) => Promise<void>
}

export interface UndoHandle {
  readonly id: string
  /** Restores now (in the test), recording the outcome; idempotent. */
  restoreNow(): Promise<void>
}

export interface UndoStore {
  read(): UndoFile
  write(file: UndoFile): void
}

export const UNDO_JSON = "undo.json"
export const UNDO_MD = "undo.md"

/** The wording of undo.md that a project may tailor to its own records. */
export interface UndoCopy {
  /** The sentence above the MANUAL ACTION NEEDED list. */
  manualIntro: string
}

export const DEFAULT_UNDO_COPY: UndoCopy = {
  manualIntro:
    "These changes to shared configuration (or records the run's cleanup could not close) were not (or not yet) put back. Do each one, newest first:",
}

/** The run folder's undo.json + undo.md, rewritten atomically on every change. */
export function fileUndoStore(
  dir: string,
  runId: string,
  copy: UndoCopy = DEFAULT_UNDO_COPY,
): UndoStore {
  const json = join(dir, UNDO_JSON)
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(json, "utf8")) as Partial<UndoFile>
        return {
          runId: raw.runId ?? runId,
          entries: Array.isArray(raw.entries) ? raw.entries : [],
        }
      } catch {
        return { runId, entries: [] }
      }
    },
    write(file) {
      write(json, `${JSON.stringify(file, null, 2)}\n`)
      write(join(dir, UNDO_MD), undoMarkdown(file, copy))
    },
  }
}

/** pending + FAILED: the entries a person must still check by hand. */
export function unresolved(file: UndoFile): UndoEntry[] {
  return file.entries.filter((e) => e.status !== "restored")
}

export interface UndoSummary {
  total: number
  restored: number
  failed: number
  pending: number
  /** Failed or still pending at the end of the run: manual action needed. */
  manual: UndoEntry[]
}

export function summarizeUndo(file: UndoFile | null): UndoSummary {
  const entries = file?.entries ?? []
  // A malformed entry (null, not an object) is not known to be restored, so
  // it counts as manual action needed: a damaged ledger fails closed.
  const manual = entries.filter((e) => e?.status !== "restored")
  return {
    total: entries.length,
    restored: entries.length - manual.length,
    failed: entries.filter((e) => e?.status === "FAILED").length,
    pending: entries.filter((e) => e?.status === "pending").length,
    manual,
  }
}

const json = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function undoMarkdown(
  file: UndoFile,
  copy: UndoCopy = DEFAULT_UNDO_COPY,
): string {
  const open = unresolved(file).sort((a, b) => b.seq - a.seq)
  const out = [`# Undo ledger ${file.runId}`, ""]
  if (open.length > 0) {
    out.push(
      "## MANUAL ACTION NEEDED",
      "",
      copy.manualIntro,
      "",
      ...open.map(
        (e) =>
          `1. **${e.what}** (${e.feature}, ${e.status}${e.error ? `: ${e.error}` : ""})\n   - Before: \`${json(e.before)}\`\n   - Restore: ${e.manual}`,
      ),
      "",
    )
  } else {
    out.push(
      file.entries.length === 0
        ? "No shared configuration was changed."
        : "Every change was restored.",
      "",
    )
  }
  if (file.entries.length > 0) {
    out.push(
      "| # | Feature | Change | Status | Restored at |",
      "|---|---|---|---|---|",
    )
    for (const e of [...file.entries].sort((a, b) => a.seq - b.seq)) {
      out.push(
        `| ${e.seq} | ${e.feature} | ${e.what.replace(/\|/g, "\\|")} | ${e.status} | ${e.restoredAt ?? "—"} |`,
      )
    }
    out.push("")
  }
  return out.join("\n")
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.slice(0, 300) ?? "error"

/**
 * One worker's ledger. Entries live in the shared store (the run folder), the
 * restore closures in memory: an entry whose closure was lost (the worker
 * crashed) stays `pending` and is reported as manual action.
 */
export class UndoLedger<C> {
  private readonly restorers = new Map<string, (context: C) => Promise<void>>()
  private counter = 0

  constructor(
    private readonly store: UndoStore,
    private readonly context: () => C,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records the change BEFORE the caller makes it (write-ahead) and returns
   * a handle to restore it early. `feature` names the test.
   */
  async change(feature: string, change: UndoChange<C>): Promise<UndoHandle> {
    const file = this.store.read()
    const seq = file.entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1
    const id = `u${seq}-${process.pid}-${++this.counter}`
    file.entries.push({
      id,
      seq,
      feature,
      what: change.what,
      before: change.before,
      manual: change.manual,
      status: "pending",
      error: null,
      recordedAt: this.now().toISOString(),
      restoredAt: null,
    })
    this.store.write(file)
    this.restorers.set(id, change.restore)
    return { id, restoreNow: () => this.restoreOne(id) }
  }

  private async restoreOne(id: string): Promise<void> {
    const restore = this.restorers.get(id)
    if (!restore) return // already restored (or never ours)
    this.restorers.delete(id)
    let status: UndoStatus = "restored"
    let error: string | null = null
    try {
      await restore(this.context())
    } catch (e) {
      status = "FAILED"
      error = firstLine(e)
    }
    const file = this.store.read()
    const entry = file.entries.find((e) => e.id === id)
    if (entry) {
      entry.status = status
      entry.error = error
      entry.restoredAt = this.now().toISOString()
      this.store.write(file)
    }
  }

  /**
   * Records an outcome that needs no restore closure: an off-camera cleanup
   * of the run's own records (the CleanupAdapter). A failure (`error` set) is
   * written as FAILED under `key`, once per key per run (a later failure
   * updates its error); a later success marks that entry restored. A success
   * with no earlier failure writes nothing.
   */
  recordOutcome(
    feature: string,
    key: string,
    entry: Pick<UndoChange<C>, "what" | "before" | "manual">,
    error: string | null,
  ): void {
    const id = `k:${key}`
    const file = this.store.read()
    const existing = file.entries.find((e) => e.id === id)
    if (!existing && error === null) return
    const now = this.now().toISOString()
    if (existing) {
      existing.status = error === null ? "restored" : "FAILED"
      existing.error = error
      existing.restoredAt = now
    } else {
      file.entries.push({
        id,
        seq: file.entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1,
        feature,
        what: entry.what,
        before: entry.before,
        manual: entry.manual,
        status: "FAILED",
        error,
        recordedAt: now,
        restoredAt: now,
      })
    }
    this.store.write(file)
  }

  /**
   * Restores, newest first, every entry this ledger still holds (all of
   * them, or only `feature`'s). Never throws: each outcome is recorded.
   * Returns how many failed.
   */
  async flush(feature?: string): Promise<number> {
    const file = this.store.read()
    const ids = file.entries
      .filter(
        (e) =>
          this.restorers.has(e.id) &&
          (feature === undefined || e.feature === feature),
      )
      .sort((a, b) => b.seq - a.seq)
      .map((e) => e.id)
    for (const id of ids) await this.restoreOne(id)
    const after = this.store.read()
    return after.entries.filter(
      (e) => ids.includes(e.id) && e.status === "FAILED",
    ).length
  }
}
