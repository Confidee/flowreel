// SPDX-License-Identifier: Apache-2.0

// The child command of a stage: one `playwright test` run of the module's
// projects, never with retries (a re-sent mail duplicates records, a re-run
// sign-in feeds the target's lockout counter).

/**
 * The `npx` arguments of one stage's child: `playwright test` with the
 * given config and projects, headed when asked. Never adds retries.
 */
export function stageCommand(
  config: string,
  projects: readonly string[],
  headed: boolean,
): string[] {
  return [
    "--no-install",
    "playwright",
    "test",
    `--config=${config}`,
    ...projects.map((project) => `--project=${project}`),
    ...(headed ? ["--headed"] : []),
  ]
}
