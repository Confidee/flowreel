// SPDX-License-Identifier: Apache-2.0

// Types for check-leaks.mjs, so runtime/test/tripwire.spec.ts can import it.

export interface LeakPattern {
  name: string
  pattern: RegExp
}

export type LeakEnv = Record<string, string | undefined>

export declare const PACKAGE_ROOT: string
export declare const BUILT_IN: readonly LeakPattern[]
export declare const ROOTS: readonly string[]
export declare class PatternsError extends Error {}
export declare function projectPatterns(env?: LeakEnv): LeakPattern[]
export declare function activePatterns(env?: LeakEnv): LeakPattern[]
export declare function scannedFiles(root?: string): string[]
export declare function violations(
  file: string,
  text: string,
  patterns?: readonly LeakPattern[],
): string[]
export declare function checkLeaks(
  root?: string,
  env?: LeakEnv,
): {
  files: string[]
  patterns: number
  hits: string[]
}
