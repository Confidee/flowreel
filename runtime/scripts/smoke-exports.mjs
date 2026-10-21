// SPDX-License-Identifier: Apache-2.0

// Resolves and loads every public entry point of the BUILT package (dist/)
// the way a consumer would: through the package name and its exports map,
// with both import() and require(). require() of this ESM package needs
// Node's require(esm) (Node >= 20.19 / >= 22.12); older Node consumers use
// import. Run after `npm run build`.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const consumer = mkdtempSync(join(tmpdir(), "flowreel-exports-"))
const failures = []
try {
  // Link the package under its own published name (scope/name from
  // package.json), so a rename can never leave this smoke test behind.
  const [scopeName, baseName] = pkg.name.split("/")
  const scope = join(consumer, "node_modules", scopeName)
  mkdirSync(scope, { recursive: true })
  symlinkSync(root, join(scope, baseName), "dir")
  // import() resolves from the consumer's own file, so a tiny module there
  // does the importing.
  const entry = join(consumer, "consumer.mjs")
  writeFileSync(entry, "export const load = (specifier) => import(specifier)\n")
  const { load } = await import(pathToFileURL(entry).href)
  const require = createRequire(entry)

  // A few names each subpath must carry (a broken index would load empty).
  const expected = {
    "./reporter": ["SummaryReporter", "modulesByKind", "planStepIds"],
    "./demos": ["demoPublisher", "planDemos", "parseRunIdArg"],
    "./rails-inertia": [
      "InertiaPropsReader",
      "parseInitialPage",
      "HttpSeamMailDriver",
      "seamSignIn",
    ],
    "./mail-graph": [
      "GraphMailDriver",
      "GraphHttpError",
      "GraphRequestError",
      "GraphTransportError",
      "toMailMessage",
    ],
  }

  const subpaths = Object.keys(pkg.exports).filter(
    (key) => key !== "./package.json",
  )
  for (const subpath of subpaths) {
    const specifier =
      subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`
    const conditions = pkg.exports[subpath]
    for (const condition of ["types", "import", "default"]) {
      if (typeof conditions[condition] !== "string") {
        failures.push(`${specifier}: no "${condition}" condition`)
      }
    }
    try {
      const loaded = await load(specifier)
      for (const name of expected[subpath] ?? []) {
        if (!(name in loaded)) failures.push(`${specifier}: no export ${name}`)
      }
    } catch (error) {
      failures.push(
        `${specifier}: import() failed: ${error.code ?? error.message}`,
      )
    }
    try {
      require(specifier)
    } catch (error) {
      failures.push(
        `${specifier}: require() failed: ${error.code ?? error.message}`,
      )
    }
  }
  try {
    require(`${pkg.name}/package.json`)
  } catch (error) {
    failures.push(
      `package.json: require() failed: ${error.code ?? error.message}`,
    )
  }
  // A deep path outside the exports map stays private.
  try {
    require(`${pkg.name}/dist/core/undo.js`)
    failures.push("a deep dist/ path resolved: the exports map is not closed")
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      failures.push(`deep path: unexpected ${error.code ?? error.message}`)
    }
  }
  console.log(
    failures.length === 0
      ? `exports smoke: ${subpaths.length} entry points load with import() and require()`
      : `exports smoke FAILED:\n  ${failures.join("\n  ")}`,
  )
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
process.exit(failures.length === 0 ? 0 : 1)
