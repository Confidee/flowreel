#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Checks the scaffold exactly as /flowreel:init writes it, in both shapes:
#
#   tour     every template except the *.no-tour.ts variants;
#   no-tour  the tour-only files left out and each *.no-tour.ts copied over
#            its base name (flowreel.config.no-tour.ts -> flowreel.config.ts).
#
# Each shape is assembled in a temporary folder, typechecked with tsc
# against the runtime SOURCE (tsconfig "paths"), and its browser-free unit
# suite (e2e/flowreel/unit.config.ts) is run with Playwright. Run from
# anywhere in the flowreel repository; it needs the runtime's dev
# dependencies (typescript, @playwright/test, @types/node) installed in
# runtime/node_modules (`npm ci` in runtime/). It never looks in a folder
# above the repository. It writes only to the temporary folder, which it
# removes.
#
#   check-templates.sh            both shapes, typecheck + unit suite
#   check-templates.sh --no-unit  typecheck only

set -euo pipefail

run_unit=1
[ "${1:-}" = "--no-unit" ] && run_unit=0

plugin="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$(cd "$plugin/../runtime" && pwd)"
templates="$plugin/templates"

# The files only a tour scaffold has (keep in step with
# skills/init/reference/scaffold.md, "Tour only").
TOUR_ONLY=(
  e2e/flowreel/tour.ts
  e2e/flowreel/CATALOGUE.md
  e2e/flowreel/flows/tour
  e2e/flowreel/plans/tour-a.md
  e2e/flowreel/texts/tour-a.json
  e2e/flowreel/narration/tour-a.json
  e2e/flowreel/unit/tour.spec.ts
)

modules="$runtime/node_modules"
if [ ! -x "$modules/.bin/tsc" ] || [ ! -d "$modules/@playwright/test" ]; then
  echo "check-templates: no typescript and @playwright/test in $modules (run npm ci in runtime/)." >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/flowreel-templates.XXXXXX")"
trap 'rm -rf "$work"' EXIT

assemble() {
  local shape="$1" dest="$work/$1"
  mkdir -p "$dest"
  (
    cd "$templates"
    find . -type f ! -name README.md ! -name tsconfig.json ! -name rails-seam-kit.md ! -name '*.no-tour.ts' |
      while read -r file; do
        mkdir -p "$dest/$(dirname "$file")"
        cp "$file" "$dest/$file"
      done
    if [ "$shape" = "no-tour" ]; then
      for path in "${TOUR_ONLY[@]}"; do rm -rf "${dest:?}/$path"; done
      find . -type f -name '*.no-tour.ts' | while read -r variant; do
        cp "$variant" "$dest/${variant%.no-tour.ts}.ts"
      done
    fi
  )
  ln -s "$modules" "$dest/node_modules"
  cat >"$dest/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true,
    "paths": {
      "@confidee/flowreel": ["$runtime/src/index.ts"],
      "@confidee/flowreel/*": ["$runtime/src/*/index.ts"]
    }
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
JSON
}

status=0
for shape in tour no-tour; do
  assemble "$shape"
  echo "check-templates: $shape: tsc"
  if ! (cd "$work/$shape" && "$modules/.bin/tsc" -p tsconfig.json); then
    status=1
    continue
  fi
  if [ "$run_unit" = 1 ]; then
    echo "check-templates: $shape: unit suite"
    if ! (cd "$work/$shape" && "$modules/.bin/playwright" test --config e2e/flowreel/unit.config.ts); then
      status=1
    fi
  fi
done
[ "$status" = 0 ] && echo "check-templates: both shapes pass."
exit "$status"
