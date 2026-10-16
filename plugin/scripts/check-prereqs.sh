#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# flowreel prerequisite check. Read-only and fast: it never installs,
# downloads or writes anything, never blocks, and always exits 0.
#
#   check-prereqs.sh            SessionStart mode: silent unless the project
#                               uses flowreel; then one line per missing
#                               item (required, video-only or voice-only),
#                               each with the command that installs it, and
#                               a last line pointing at /flowreel:doctor.
#   check-prereqs.sh --report   every item, with its status (/flowreel:doctor).
#
# Statuses: ok, missing (required: runs need it), video-only (only the MP4s
# need it), voice-only (only the narration needs it), optional, unchecked
# (report mode only: a tool that was not run, see "Version managers" below).
#
# FLOWREEL_PREREQS=off silences the SessionStart mode; =always runs it in any
# project. The project is $CLAUDE_PROJECT_DIR (default: the working
# directory).
#
# Everything printed that comes from the project, the environment or another
# program passes through clean() first: this output reaches the model's
# context at session start, so a cloned repository must not be able to put
# arbitrary text there (a crafted package.json "version", say).
#
# Version managers. A cloned repository must not be able to make this check
# run its code. Some version managers read project files when their shim
# runs: Volta reads the project's package.json pin and .volta/hooks.json
# (which can set a download URL or run a command), mise / asdf / nodenv /
# proto read .tool-versions, .mise.toml or .prototools and may install the
# version they name. So every program this script runs (node, ffmpeg, say)
# is resolved and run from / , never from the project; and a tool that
# resolves inside the project or to a version-manager shim is not run at
# all: it is reported as `unchecked` in report mode and nothing is printed
# for it at session start. Checking the project's own pinned version is left to the user
# (the doctor asks them to run `node --version` in the project).

set -u

mode="session"
[ "${1:-}" = "--report" ] && mode="report"
project="${CLAUDE_PROJECT_DIR:-$PWD}"
os="$(cd / && uname -s 2>/dev/null || echo unknown)"
missing=0
media_gaps=0
unchecked=0
missing_names=""

# clean <value> [max]: only characters a version, a voice name or a path
# needs, cut to `max` (default 80).
clean() {
  printf '%s' "$1" | tr -cd '0-9A-Za-z._+()/ :-' | cut -c "1-${2:-80}"
}
# clean_version <value>: only a leading "major.minor[.patch][-prerelease]"
# (no spaces, prerelease at most 20 characters); empty when there is none.
clean_version() {
  printf '%s' "$1" | head -n 1 |
    sed -nE 's/^[[:space:]]*v?([0-9]{1,4}\.[0-9]{1,4}(\.[0-9]{1,6})?(-[0-9A-Za-z.]{1,20})?).*$/\1/p'
}

uses_flowreel() {
  [ -f "$project/flowreel.config.ts" ] && return 0
  [ -f "$project/e2e/flowreel.config.ts" ] && return 0
  [ -d "$project/e2e/flowreel" ] && return 0
  [ -f "$project/package.json" ] &&
    grep -q '"@confidee/flowreel"' "$project/package.json" 2>/dev/null &&
    return 0
  return 1
}

if [ "$mode" = "session" ]; then
  case "${FLOWREEL_PREREQS:-}" in
    off) exit 0 ;;
    always) ;;
    *) uses_flowreel || exit 0 ;;
  esac
fi

# resolve <tool>: the absolute path PATH gives <tool> when looked up from /
# (so a relative PATH entry such as `.` or `node_modules/.bin` cannot point
# into the project); empty when it is not found or not absolute.
resolve() {
  local p
  p="$(cd / && command -v "$1" 2>/dev/null)" || return 0
  case "$p" in
    /*) printf '%s' "$p" ;;
  esac
  return 0
}

# unsafe <path>: why running <path> could run project code (it lives in the
# project, or it is a version manager's shim); empty when it is safe to run.
unsafe() {
  case "$1" in
    "$project"/*) printf 'resolves inside the project' && return 0 ;;
  esac
  is_shim "$1" && printf 'is a version-manager shim, which can read project files when it runs'
  return 0
}

# is_shim <path>: the path (or the file its symlink names) is a version
# manager's shim, which could read project files when it runs.
is_shim() {
  local p="$1" target
  target="$(readlink "$p" 2>/dev/null || true)"
  for x in "$p" "$target"; do
    case "$x" in
      "") ;;
      */.volta/bin/* | */volta-shim | */volta-shim.exe) return 0 ;;
      */mise/shims/* | */rtx/shims/*) return 0 ;;
      */.asdf/shims/* | */asdf/shims/*) return 0 ;;
      */.nodenv/shims/* | */.proto/shims/* | */.proto/bin/*) return 0 ;;
    esac
  done
  [ -n "${VOLTA_HOME:-}" ] && case "$p" in "$VOLTA_HOME"/bin/*) return 0 ;; esac
  [ -n "${ASDF_DATA_DIR:-}" ] && case "$p" in "$ASDF_DATA_DIR"/shims/*) return 0 ;; esac
  return 1
}

# neutral <path> <args...>: run a resolved program from / with no input.
neutral() {
  (cd / && "$@" </dev/null 2>/dev/null)
}

# Printing. <how> is a pure command (copy-paste safe) unless <label> says
# otherwise; <note> is extra explanation, printed on its own line in report
# mode only.
#   ok <item> <detail>
#   miss <item> <why> <how> [note] [label]           (required)
#   media <status> <item> <why> <how> [note] [label] (video-only / voice-only)
#   optional <item> <why> <install> [note]
#   unknown <item> <why>                             (report mode only)
ok() {
  [ "$mode" = "report" ] && printf 'flowreel: ok         %s (%s)\n' "$1" "$2"
  return 0
}
note() {
  [ "$mode" = "report" ] && [ -n "${1:-}" ] && printf 'flowreel:            note: %s\n' "$1"
  return 0
}
miss() {
  missing=$((missing + 1))
  missing_names="${missing_names:+$missing_names, }$1"
  printf 'flowreel: missing    %s (%s). %s: %s\n' "$1" "$2" "${5:-Install}" "$3"
  note "${4:-}"
}
media() {
  media_gaps=$((media_gaps + 1))
  printf 'flowreel: %-10s %s (%s). %s: %s\n' "$1" "$2" "$3" "${6:-Install}" "$4"
  note "${5:-}"
}
optional() {
  if [ "$mode" = "report" ]; then
    printf 'flowreel: optional   %s (%s). Install: %s\n' "$1" "$2" "$3"
    note "${4:-}"
  fi
  return 0
}
unknown() {
  unchecked=$((unchecked + 1))
  [ "$mode" = "report" ] && printf 'flowreel: unchecked  %s (%s)\n' "$1" "$2"
  return 0
}

# version_at_least <a.b.c> <x.y>: numeric, major then minor.
version_at_least() {
  local have="$1" want="$2"
  local hmaj hmin wmaj wmin
  hmaj="${have%%.*}"; hmin="${have#*.}"; hmin="${hmin%%.*}"
  wmaj="${want%%.*}"; wmin="${want#*.}"; wmin="${wmin%%.*}"
  case "$hmaj$hmin" in *[!0-9]*|"") return 1 ;; esac
  [ "$hmaj" -gt "$wmaj" ] && return 0
  [ "$hmaj" -eq "$wmaj" ] && [ "$hmin" -ge "$wmin" ] && return 0
  return 1
}

# can_require_esm <a.b.c>: Node can require() an ES module (unflagged in
# 20.19+, 22.12+ and every 23+; never in 21).
can_require_esm() {
  local v="$1" maj
  maj="${v%%.*}"
  case "$maj" in *[!0-9]*|"") return 1 ;; esac
  [ "$maj" -ge 23 ] && return 0
  [ "$maj" -eq 22 ] && version_at_least "$v" "22.12" && return 0
  [ "$maj" -eq 20 ] && version_at_least "$v" "20.19" && return 0
  return 1
}

# The project's package.json says "type": "module" (flows load as ESM).
project_is_esm() {
  [ -f "$project/package.json" ] &&
    grep -Eq '"type"[[:space:]]*:[[:space:]]*"module"' "$project/package.json" 2>/dev/null
}

# Install commands are pure commands; explanations go in the notes. Node
# on Linux has no single safe command (distribution packages are often
# older than 20.19), so it is printed as "Steps:", not "Install:".
if [ "$os" = "Darwin" ]; then
  node_install="brew install node"
  node_label_how="Install"
  node_note=""
  ffmpeg_install="brew install ffmpeg"
  ffmpeg_note=""
  chromium_install="npx playwright install chromium"
  chromium_note=""
  psql_install="brew install libpq && brew link --force libpq"
  psql_note="libpq is keg-only: without the link psql is not on PATH"
else
  node_install="Node.js 20.19+ from your distribution, NodeSource or nvm (https://github.com/nvm-sh/nvm)"
  node_label_how="Steps"
  node_note="distribution packages are often older than 20.19; check node --version after installing"
  ffmpeg_install="sudo apt install ffmpeg"
  ffmpeg_note="or your distribution's ffmpeg package"
  chromium_install="npx playwright install --with-deps chromium"
  chromium_note="--with-deps also installs the system libraries Chromium needs, with sudo"
  psql_install="sudo apt install postgresql-client"
  psql_note=""
fi

# 1. Node.js: 20.19+ (20.x), 22.12+ (22.x) or 23+. The runtime is ESM-only;
#    a project without "type": "module" loads its flows as CommonJS, which
#    require()s the runtime, and only those versions can. An ESM project
#    also works on any 20+. Run from / , and not at all through a shim
#    (see "Version managers" above).
node_label="Node.js 20.19+ / 22.12+"
node_path="$(resolve node)"
node_unsafe="$( [ -n "$node_path" ] && unsafe "$node_path")"
if [ -n "$node_unsafe" ]; then
  unknown "$node_label" "$(clean "$node_path" 120) $node_unsafe, so it was not run; check with: node --version"
elif [ -n "$node_path" ]; then
  node_version="$(clean_version "$(neutral "$node_path" --version | sed 's/^v//')")"
  if can_require_esm "$node_version"; then
    ok "$node_label" "$node_version"
  elif version_at_least "$node_version" "20.0" && project_is_esm; then
    ok "$node_label" "$node_version; enough only because package.json has \"type\": \"module\""
  elif version_at_least "$node_version" "20.0"; then
    miss "$node_label" "found ${node_version:-an unreadable version}, which cannot require() the ESM-only runtime from a CommonJS project (no \"type\": \"module\" in package.json)" "$node_install" "$node_note" "$node_label_how"
  else
    miss "$node_label" "found ${node_version:-an unreadable version}; runs the runtime and its CLI" "$node_install" "$node_note" "$node_label_how"
  fi
else
  miss "$node_label" "runs the runtime and its CLI" "$node_install" "$node_note" "$node_label_how"
fi

# 2. @playwright/test >= 1.56 in the project
pw_pkg="$project/node_modules/@playwright/test/package.json"
if [ -f "$pw_pkg" ]; then
  pw_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$pw_pkg" | head -n 1)"
  pw_version="$(clean_version "$pw_version")"
  if version_at_least "$pw_version" "1.56"; then
    ok "@playwright/test >= 1.56" "$pw_version"
  else
    miss "@playwright/test >= 1.56" "found ${pw_version:-an unreadable version}; runs and records the flows" "npm i -D @playwright/test@latest"
  fi
else
  miss "@playwright/test >= 1.56" "runs and records the flows; not in the project's node_modules" "npm i -D @playwright/test"
fi

# 3. Playwright's Chromium (the recorded browser), in its download cache.
#    PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers inside node_modules.
if [ "${PLAYWRIGHT_BROWSERS_PATH:-}" = "0" ]; then
  pw_caches=("$project/node_modules/playwright-core/.local-browsers" "$project/node_modules/playwright/.local-browsers")
elif [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  pw_caches=("$PLAYWRIGHT_BROWSERS_PATH")
elif [ "$os" = "Darwin" ]; then
  pw_caches=("$HOME/Library/Caches/ms-playwright")
else
  pw_caches=("${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright")
fi
chromium=""
pw_cache_shown=""
for pw_cache in "${pw_caches[@]}"; do
  pw_cache_shown="${pw_cache_shown:+$pw_cache_shown or }$pw_cache"
  [ -n "$chromium" ] && continue
  chromium="$(ls -d "$pw_cache"/chromium-* "$pw_cache"/chromium_headless_shell-* 2>/dev/null | head -n 1)"
done
if [ -n "$chromium" ]; then
  ok "Playwright Chromium" "$(clean "$(basename "$chromium")" 48)"
else
  miss "Playwright Chromium" "the browser flows are recorded in; none in $(clean "$pw_cache_shown" 240)" "$chromium_install" "$chromium_note"
fi

# 4. ffmpeg + ffprobe with libx264 and AAC (videos only; never the verdict)
ffmpeg_path="$(resolve ffmpeg)"
ffmpeg_unsafe="$( [ -n "$ffmpeg_path" ] && unsafe "$ffmpeg_path")"
if [ -n "$ffmpeg_unsafe" ]; then
  unknown "ffmpeg (libx264, aac)" "$(clean "$ffmpeg_path" 120) $ffmpeg_unsafe, so it was not run; check with: ffmpeg -hide_banner -encoders"
elif [ -n "$ffmpeg_path" ]; then
  encoders="$(neutral "$ffmpeg_path" -hide_banner -encoders)"
  if printf '%s' "$encoders" | grep -q 'libx264' &&
    printf '%s' "$encoders" | grep -qE '[[:space:]]aac[[:space:]]'; then
    ok "ffmpeg (libx264, aac)" "$(clean "$ffmpeg_path" 120)"
  else
    media video-only "ffmpeg with libx264 and aac" "composes the MP4s; this build lacks an encoder; the verdict never needs it" "$ffmpeg_install" "$ffmpeg_note"
  fi
else
  media video-only "ffmpeg" "composes the MP4s; the verdict never needs it" "$ffmpeg_install" "$ffmpeg_note"
fi
ffprobe_path="$(resolve ffprobe)"
if [ -n "$ffprobe_path" ]; then
  ok "ffprobe" "$(clean "$ffprobe_path" 120)"
else
  media video-only "ffprobe" "measures clips for the videos; the verdict never needs it" "$ffmpeg_install" "$ffmpeg_note"
fi

# 5. Narration: macOS `say` and a Premium voice (macOS only; voice only)
if [ "$os" = "Darwin" ]; then
  say_path="$(resolve say)"
  say_unsafe="$( [ -n "$say_path" ] && unsafe "$say_path")"
  if [ -n "$say_unsafe" ]; then
    unknown "a Premium voice" "$(clean "$say_path" 120) $say_unsafe, so it was not run; check with: say -v '?'"
  elif [ -n "$say_path" ]; then
    premium="$(neutral "$say_path" -v '?' | grep -m 1 -i '(Premium)' | sed 's/[[:space:]]*[a-z][a-z]_[A-Z][A-Z].*//')"
    premium="$(clean "$premium" 48)"
    if [ -n "$premium" ]; then
      ok "a Premium voice" "$premium"
    else
      media voice-only "a Premium voice" "narration falls back to a standard voice" "System Settings > Accessibility > Read & Speak (Spoken Content) > System voice > Manage Voices, download e.g. Ava (Premium)" "" "Steps"
    fi
  else
    media voice-only "say" "narrates the demo videos; without it they are silent" "it ships with macOS as /usr/bin/say; make sure PATH includes /usr/bin" "" "Steps"
  fi
else
  optional "a voice engine" "narration off macOS is not built yet; videos are produced silent" "none needed"
fi

# 6. psql (optional: per-run database copies for a Postgres DbIsolation)
psql_path="$(resolve psql)"
if [ -n "$psql_path" ]; then
  ok "psql (optional)" "$(clean "$psql_path" 120)"
else
  optional "psql" "only for a Postgres per-run database copy" "$psql_install" "$psql_note"
fi

if [ "$mode" = "session" ]; then
  if [ "$missing" -gt 0 ] || [ "$media_gaps" -gt 0 ]; then
    echo "flowreel: /flowreel:doctor explains each item and installs only after you confirm (video-only and voice-only items never affect a verdict)."
  fi
fi
if [ "$mode" = "report" ]; then
  summary="flowreel: $missing of 3 required items missing"
  [ "$missing" -gt 0 ] && summary="$summary ($missing_names)"
  [ "$unchecked" -gt 0 ] && summary="$summary, $unchecked item(s) unchecked (not run: see the unchecked lines)"
  echo "$summary; required: Node.js, @playwright/test, Playwright Chromium. Video-only and voice-only items never block a run."
fi
exit 0
