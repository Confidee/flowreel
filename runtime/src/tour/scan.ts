// SPDX-License-Identifier: Apache-2.0

import type TS from "typescript"

import type { TourManifest } from "./manifest.js"

// The tour's static policy tripwire. The staging policy of a feature is the
// owner's (the catalogue) and only feature() applies it, so every area
// spec's test() must start with feature(test, { id, policy }) whose id and
// slug are the title's and whose policy is the catalogue's, and nothing may
// run or skip outside it (no hooks, no test.skip / only / fixme, no
// in-body skip in a test or an area helper). A project's unit test calls
// these over its flow files. The TypeScript compiler API is passed in (the
// project's own `typescript`), so the runtime has no dependency on it: the
// exported signatures take it structurally (TypeScriptApi), so the
// published .d.ts never imports `typescript` either.

/**
 * The TypeScript compiler API, i.e. `import ts from "typescript"` (any 5.x
 * or later), passed in by the project. Typed structurally on purpose.
 */
export interface TypeScriptApi {
  createSourceFile: (...args: never[]) => unknown
  ScriptTarget: object
}

/** What one test() in an area spec declares. */
export interface DeclaredFeature {
  title: string
  id: string | null
  policy: string | null
  line: number
}

/** Hook / modifier calls that would run code (or skip) outside feature(). */
const FORBIDDEN_TEST_MEMBERS = new Set([
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
  "skip",
  "fixme",
  "only",
  "fail",
  "slow",
])

/**
 * Modifiers that skip, expect-to-fail or stretch a test from INSIDE its body
 * (`test.skip(…)`, `test.info().fixme(…)`, `testInfo.fail(…)`): only
 * feature() may skip, so none of them may appear in a tour test body or in
 * an area's support file.
 */
const FORBIDDEN_IN_BODY = new Set(["skip", "fixme", "fail", "slow", "only"])

function stringOf(ts: typeof TS, node: TS.Node | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

/** feature(test, { id: "…", policy: "…" }) -> its id and policy literals. */
function featureCall(
  ts: typeof TS,
  statement: TS.Statement | undefined,
): { id: string | null; policy: string | null } | null {
  if (!statement) return null
  let call: TS.Expression | undefined
  if (ts.isExpressionStatement(statement)) call = statement.expression
  else if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.length === 1
  ) {
    call = statement.declarationList.declarations[0].initializer
  }
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "feature" ||
    call.arguments.length !== 2 ||
    !ts.isIdentifier(call.arguments[0]) ||
    call.arguments[0].text !== "test" ||
    !ts.isObjectLiteralExpression(call.arguments[1])
  ) {
    return null
  }
  const props = new Map<string, string | null>()
  for (const p of call.arguments[1].properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      props.set(p.name.text, stringOf(ts, p.initializer))
    }
  }
  return { id: props.get("id") ?? null, policy: props.get("policy") ?? null }
}

/**
 * Every in-body modifier call under `root`: `test.<m>(…)`,
 * `test.info().<m>(…)` and `<testInfo>.<m>(…)` for the test function's
 * second parameter.
 */
function bodyModifiers(
  ts: typeof TS,
  root: TS.Node,
  testInfoName: string | null,
): { member: string; node: TS.Node }[] {
  const found: { member: string; node: TS.Node }[] = []
  const visit = (node: TS.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      FORBIDDEN_IN_BODY.has(node.expression.name.text)
    ) {
      const target = node.expression.expression
      const isTest = ts.isIdentifier(target) && target.text === "test"
      const isTestInfo =
        (ts.isIdentifier(target) && target.text === testInfoName) ||
        (ts.isCallExpression(target) &&
          ts.isPropertyAccessExpression(target.expression) &&
          ts.isIdentifier(target.expression.expression) &&
          target.expression.expression.text === "test" &&
          target.expression.name.text === "info")
      if (isTest || isTestInfo) {
        found.push({ member: node.expression.name.text, node })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** Walks an area spec: its test() declarations and anything forbidden. */
export function scanAreaSpec(
  api: TypeScriptApi,
  file: string,
  text: string,
): { tests: DeclaredFeature[]; problems: string[] } {
  const ts = api as unknown as typeof TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const tests: DeclaredFeature[] = []
  const problems: string[] = []
  const lineOf = (node: TS.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const visitStatements = (statements: TS.NodeArray<TS.Statement>) => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement)) continue
      const call = statement.expression
      if (!ts.isCallExpression(call)) continue
      const callee = call.expression
      if (ts.isIdentifier(callee) && callee.text === "test") {
        const title = stringOf(ts, call.arguments[0]) ?? "<non-literal title>"
        const body = call.arguments[1]
        const first =
          body &&
          (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
          ts.isBlock(body.body)
            ? body.body.statements[0]
            : undefined
        const declared = featureCall(ts, first)
        if (!declared) {
          problems.push(
            `${file}:${lineOf(call)} test("${title}") does not start with feature(test, { id, policy })`,
          )
        }
        if (
          body &&
          (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
        ) {
          const info = body.parameters[1]?.name
          for (const found of bodyModifiers(
            ts,
            body.body,
            info && ts.isIdentifier(info) ? info.text : null,
          )) {
            problems.push(
              `${file}:${lineOf(found.node)} .${found.member}(…) inside test("${title}") (only feature() skips)`,
            )
          }
        }
        tests.push({
          title,
          id: declared?.id ?? null,
          policy: declared?.policy ?? null,
          line: lineOf(call),
        })
        continue
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "test"
      ) {
        const member = callee.name.text
        if (member === "describe") {
          const body = call.arguments[1]
          if (
            body &&
            (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
            ts.isBlock(body.body)
          ) {
            visitStatements(body.body.statements)
          }
        } else if (FORBIDDEN_TEST_MEMBERS.has(member)) {
          problems.push(
            `${file}:${lineOf(call)} test.${member}(…) runs outside feature() (only feature() skips; no hooks in a tour area)`,
          )
        }
      }
    }
  }
  visitStatements(source.statements)
  return { tests, problems }
}

/** An area support file: no in-body modifier anywhere (it runs inside tests). */
export function scanAreaSupport(
  api: TypeScriptApi,
  file: string,
  text: string,
): string[] {
  const ts = api as unknown as typeof TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  return bodyModifiers(ts, source, null).map(
    ({ member, node }) =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} .${member}(…) in an area helper (only feature() skips)`,
  )
}

/**
 * The catalogue checks over what scanAreaSpec read from the spec of area
 * `letter`: titles "<id> <slug>", ids of that area and in the catalogue,
 * the catalogue's slug and policy, and each id tested once (`seen` carries
 * ids across files).
 */
export function checkDeclaredFeatures(
  manifest: Pick<TourManifest, "catalogue" | "letters">,
  file: string,
  letter: string,
  tests: DeclaredFeature[],
  seen = new Map<string, string>(),
): string[] {
  const problems: string[] = []
  const titleRe = new RegExp(`^([${manifest.letters}]\\d{1,2})\\s+(\\S.*)$`)
  for (const t of tests) {
    const where = `${file}:${t.line} test("${t.title}")`
    const m = titleRe.exec(t.title)
    if (!m) {
      problems.push(`${where}: title is not "<id> <slug>"`)
      continue
    }
    const [, id, slug] = m
    const entry = manifest.catalogue[id]
    if (!id.startsWith(letter)) {
      problems.push(`${where}: ${id} does not belong in area ${letter}`)
    }
    if (!entry) {
      problems.push(`${where}: ${id} is not in the catalogue`)
      continue
    }
    if (slug !== entry.slug) {
      problems.push(`${where}: slug must be "${entry.slug}"`)
    }
    if (t.id !== null && t.id !== id) {
      problems.push(`${where}: feature() declares id ${t.id}`)
    }
    if (t.policy === null && t.id !== null) {
      problems.push(`${where}: feature() policy is not a string literal`)
    } else if (t.policy !== null && t.policy !== entry.policy) {
      problems.push(
        `${where}: feature() declares policy "${t.policy}", the catalogue says "${entry.policy}"`,
      )
    }
    const twice = seen.get(id)
    if (twice) problems.push(`${where}: ${id} is also tested at ${twice}`)
    seen.set(id, where)
  }
  return problems
}
