// SPDX-License-Identifier: Apache-2.0

// Types for sync-agent-skill.mjs, so runtime/test/agent-skill.spec.ts can
// import it.

export declare const SKILL_DIR: string
export declare const ALLOWED_FIELDS: string[]
export declare function portable(text: string, source: string): string
export declare function generate(): Map<string, string>
export declare function parseFrontmatter(
  text: string,
): Record<string, string | Record<string, string>>
export declare function validate(dir: string, text?: string): string[]
