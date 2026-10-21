// SPDX-License-Identifier: Apache-2.0

// The public API surface: every entry point in package.json "exports" maps to
// a src barrel, and each barrel exports exactly the names listed here. A
// rename or accidental removal fails this test before it reaches a release.

import { readFileSync } from "node:fs"

import { expect, test } from "@playwright/test"

import * as root from "../src/index.js"
import * as b0 from "../src/core/index.js"
import * as b1 from "../src/mail/index.js"
import * as b2 from "../src/video/index.js"
import * as b3 from "../src/voice/index.js"
import * as b4 from "../src/narration/index.js"
import * as b5 from "../src/reporter/index.js"
import * as b6 from "../src/demos/index.js"
import * as b7 from "../src/config/index.js"
import * as b8 from "../src/app/index.js"
import * as b9 from "../src/run/index.js"
import * as b10 from "../src/pipeline/index.js"
import * as b11 from "../src/tour/index.js"
import * as b12 from "../src/cli/index.js"
import * as b13 from "../src/rails-inertia/index.js"
import * as b14 from "../src/mail-graph/index.js"

const SURFACE: Record<string, string[]> = {
  core: [
    "ConfigError",
    "DEFAULT_SENDER_HOURLY_LIMIT",
    "DEFAULT_UNDO_COPY",
    "ENV_PREFIX",
    "InboundBudgetError",
    "LoginError",
    "ROLLING_WINDOW_MS",
    "SendRefusedError",
    "TimeoutError",
    "UNDO_JSON",
    "UNDO_MD",
    "UndoLedger",
    "consumeInbound",
    "envName",
    "envNames",
    "envValue",
    "envVar",
    "fileInboundLedger",
    "fileUndoStore",
    "poll",
    "recentSends",
    "registerEnvAliases",
    "summarizeUndo",
    "undoMarkdown",
    "unresolved",
    "withInboundLedger",
  ],
  mail: [
    "DEFAULT_SEND_GUARD_COPY",
    "addressOf",
    "assertReplyDomainRecipient",
    "describeCandidates",
    "describeQuery",
    "matchMessage",
    "matchesQuery",
    "replyDomainTarget",
  ],
  video: [
    "APP_RECT",
    "APP_VIEWPORT",
    "AREA_INTRO_SEC",
    "AUDIO_RATE",
    "BASE_NEVER_SPEAK",
    "CARD_LEAD_SEC",
    "CARD_PAD_SEC",
    "CHAPTER_ALONE_SEC",
    "COMPARISON_SEC",
    "DEFAULT_CARD_COPY",
    "DEFAULT_NARRATION_COPY",
    "DEFAULT_SLOW_FACTOR",
    "DEFAULT_TIMELINE",
    "FEATURE_STATUSES",
    "FPS",
    "FRAME",
    "NARRATION_GAP_SEC",
    "NEUTRAL_BRAND",
    "NEUTRAL_COLORS",
    "NO_LOGOS",
    "OPAQUE_TOKEN",
    "OUTPUT",
    "OUTPUT_SCALE",
    "PIPELINE_CHAPTER_SEC",
    "PIPELINE_INTRO_SEC",
    "REEL_FILE",
    "SCOREBOARD_ROWS",
    "SCOREBOARD_SEC",
    "STANDIN_SEC",
    "TITLE_SEC",
    "TOUR_CHAPTER_SEC",
    "TOUR_INTRO_SEC",
    "TOUR_VIDEO_MANIFEST",
    "VIDEO_LOG_ATTACHMENT",
    "VideoLog",
    "addSilenceArgs",
    "areaVideoName",
    "areasOf",
    "asSentence",
    "brandGradient",
    "buildTimeline",
    "cardArea",
    "cardHoldSec",
    "cardKey",
    "cardLineData",
    "cardName",
    "cardPage",
    "combinedFileName",
    "comparisonData",
    "compose",
    "composeArgs",
    "composeProgram",
    "concatArgs",
    "concatList",
    "concatSegments",
    "createCards",
    "createNarration",
    "createTourCards",
    "createVideoKit",
    "defineBrand",
    "defineCardCopy",
    "defineNarrationCopy",
    "escapeHtml",
    "everyMatch",
    "excerpt",
    "failureCategory",
    "failureKind",
    "failureLine",
    "featureComparison",
    "featureFallback",
    "featureSegments",
    "ffmpegProblem",
    "formatUtc",
    "hasAudio",
    "hasReel",
    "loadNarration",
    "mailCard",
    "narrateReel",
    "narrateTimeline",
    "narrationDecision",
    "narrationForcedOff",
    "neverSpeakOf",
    "parseVideoLog",
    "placeSegments",
    "planAreaVideo",
    "planTourVideo",
    "playedSec",
    "probeDuration",
    "produceCombinedTourVideo",
    "produceCombinedVideo",
    "produceTourVideos",
    "produceVideo",
    "programArgs",
    "programSec",
    "readReel",
    "readTourVideoManifest",
    "redactAddress",
    "redactText",
    "reelInput",
    "reelTexts",
    "renderPngs",
    "rgba",
    "scoreRows",
    "seconds",
    "segmentBadges",
    "settingHintName",
    "slowFactorOf",
    "sortFeatures",
    "stageReel",
    "stageTourBody",
    "stateless",
    "svgDataUri",
    "timelineOptionsFor",
    "tourLabel",
    "tourNarrationModule",
    "tourVideoName",
    "videoBlocker",
    "videoEnabled",
    "videoFileName",
    "videoOffReason",
    "videoPaceFor",
    "videoPaceOf",
    "waitCaptions",
  ],
  voice: [
    "CLIP_FORMAT_VERSION",
    "DEFAULT_RATE",
    "ENGINES",
    "FALLBACK_WARNING",
    "PREFERRED_VOICES",
    "cacheKey",
    "clipFormat",
    "defaultNarrationLog",
    "defaultVoiceCacheDir",
    "engineFor",
    "macosEngine",
    "narrationLine",
    "noneEngine",
    "normalizeArgs",
    "parseVoiceList",
    "prepareNarration",
    "runTool",
    "sayArgs",
    "selectVoice",
    "synthesizeAll",
    "voiceRate",
  ],
  narration: [
    "BASE_NEVER_SPEAK",
    "DEFAULT_NARRATION_COPY",
    "DEFAULT_SLOW_FACTOR",
    "OPAQUE_TOKEN",
    "asSentence",
    "createNarration",
    "defineNarrationCopy",
    "everyMatch",
    "failureCategory",
    "failureKind",
    "failureLine",
    "featureFallback",
    "loadNarration",
    "narrationDecision",
    "narrationForcedOff",
    "neverSpeakOf",
    "settingHintName",
    "slowFactorOf",
    "timelineOptionsFor",
    "tourNarrationModule",
    "videoPaceFor",
    "videoPaceOf",
  ],
  reporter: [
    "COULD_NOT_CHECK_ANNOTATION",
    "DEFAULT_DEV_ONLY_PREFIX",
    "DEFAULT_LOG_PREFIX",
    "FACT_ANNOTATION",
    "FAILED_STATUSES",
    "NO_FEATURE_REASON",
    "SKIP_ANNOTATION",
    "SummaryReporter",
    "cell",
    "duration",
    "featureStatus",
    "featureTable",
    "installStageGuard",
    "modulesByKind",
    "parseFeatureAnnotation",
    "planStepIds",
    "stepFailureLocation",
    "stepOutcome",
    "tourVerdict",
  ],
  demos: [
    "DEMOS_MANIFEST",
    "areaDemoName",
    "areaVerdict",
    "demoPublisher",
    "demosReadme",
    "keepPassing",
    "parseRunIdArg",
    "planDemos",
    "publishDemos",
    "stagingSkip",
  ],
  config: [
    "LOOPBACK_HOSTS",
    "TARGETS",
    "agreedEnvValue",
    "assertNoPlaceholders",
    "assertPrivateFile",
    "assertSafeBaseUrl",
    "assertTargetPolicy",
    "createConfig",
    "defaultLocalPort",
    "defineConfig",
    "localBaseUrl",
    "localWebServer",
    "openConfigSource",
    "parseEnvFile",
    "parseLocalPort",
    "parseModule",
    "parsePositiveInt",
    "parseTarget",
    "readPrivateFile",
    "readTarget",
    "reportDir",
    "requireKeys",
    "resolveBaseUrl",
    "resultsDir",
    "settleEnvValue",
  ],
  app: [
    "KEEPALIVE_INTERVAL_MS",
    "KEEPALIVE_MAX_MS",
    "STATE_ENV_PREFIX",
    "SessionKeepalive",
    "createGlobalSetup",
    "createGlobalTeardown",
    "createPersonaApis",
    "distinctSessions",
    "isSessionSignedOut",
    "keepaliveDeadline",
    "personaOf",
    "refuseRepeats",
    "requireStorageState",
    "revokeSession",
    "safePath",
    "signInAll",
    "signOutAll",
    "signedOutBy",
    "stateEnvKey",
    "storageStateFromEnv",
  ],
  run: [
    "DEFAULT_RUN_ID_PREFIXES",
    "cleanUpRunRecords",
    "cleanupCandidates",
    "cleanupLine",
    "currentRunId",
    "fileCounter",
    "fillRunId",
    "interpolateText",
    "jsonTexts",
    "makePipelineId",
    "makeRunId",
    "nextRoundRobin",
    "runMarker",
    "runStartOf",
    "runSubject",
    "stampedId",
  ],
  pipeline: [
    "ABORTED_REASON",
    "EXIT",
    "STAGES",
    "STOP_REASONS",
    "UsageError",
    "cloneKey",
    "commandDbIsolation",
    "configProblemOf",
    "deadlineAt",
    "developmentDecision",
    "parseDeadline",
    "parsePipelineArgs",
    "pipelineOutcome",
    "playwrightLauncher",
    "preferredEnvName",
    "processIo",
    "readUndoLedger",
    "resolvePlaywrightCli",
    "runPipeline",
    "runPipelineCli",
    "sleepSync",
    "stageCommand",
    "stageEnv",
    "stageJson",
    "stageLabel",
    "stageVerdictFrom",
    "stagingDecision",
  ],
  tour: [
    "DEV_ONLY_PREFIX",
    "FEATURE_ANNOTATION",
    "GRAVATAR_URLS",
    "InboundMailBudget",
    "PACES",
    "PACE_PAUSE_MS",
    "PACE_SLOW_MO",
    "POLICIES",
    "PRIVACY_MASK_CSS",
    "STAGING_INBOUND_MAX",
    "assertCataloguePolicy",
    "checkDeclaredFeatures",
    "declareFeature",
    "defineTourManifest",
    "detectModule",
    "featureDecision",
    "fileBudgetStore",
    "installPrivacyMask",
    "parseCatalogue",
    "parsePace",
    "pauseFor",
    "privacyKeepList",
    "rowKept",
    "scanAreaSpec",
    "scanAreaSupport",
    "swapPersona",
    "tourFixtures",
    "tourModuleFrom",
  ],
  cli: ["demosCli"],
  "rails-inertia": [
    "DEFAULT_SEAM_PATHS",
    "HttpSeamMailDriver",
    "INERTIA_ACCEPT",
    "INERTIA_RAILS_CSRF",
    "InertiaPropsReader",
    "asInertiaPage",
    "decodeHtmlEntities",
    "parseInitialPage",
    "pathnameOf",
    "seamDeliveryToMailMessage",
    "seamHttpFromFetch",
    "seamHttpFromRequest",
    "seamSignIn",
  ],
  "mail-graph": [
    "DEFAULT_GRAPH_DRIVER_COPY",
    "GRAPH_BASE",
    "GraphHttpError",
    "GraphMailDriver",
    "GraphRequestError",
    "GraphRequestTimeoutError",
    "GraphTransportError",
    "headerAddresses",
    "toMailMessage",
  ],
}

const MODULES: Record<string, object> = {
  core: b0,
  mail: b1,
  video: b2,
  voice: b3,
  narration: b4,
  reporter: b5,
  demos: b6,
  config: b7,
  app: b8,
  run: b9,
  pipeline: b10,
  tour: b11,
  cli: b12,
  "rails-inertia": b13,
  "mail-graph": b14,
}

// Subpaths the root entry deliberately does not re-export: the stack adapters.
const ADAPTERS = ["rails-inertia", "mail-graph"]
// Barrels folded into another entry: narration is exported through ./video.
const FOLDED = ["narration"]

function exportsMap(): string[] {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> }
  return Object.keys(pkg.exports)
}

test.describe("public API surface", () => {
  test("every subpath in package.json exports has a barrel with a pinned surface", () => {
    const subpaths = exportsMap()
      .filter((key) => key !== "." && key !== "./package.json")
      .map((key) => key.slice(2))
    expect(subpaths.every((s) => s in SURFACE)).toBe(true)
    const covered = Object.keys(SURFACE).filter((s) => !FOLDED.includes(s))
    expect([...covered].sort()).toEqual([...subpaths].sort())
  })

  for (const name of Object.keys(SURFACE)) {
    test("./" + name + " exports exactly its documented names", () => {
      expect(Object.keys(MODULES[name]!).sort()).toEqual(
        [...SURFACE[name]!].sort(),
      )
    })
  }

  test("the root entry is the union of the core barrels and excludes the adapters", () => {
    const rootNames = Object.keys(root).sort()
    const expected = Object.keys(SURFACE)
      .filter(
        (s) =>
          !ADAPTERS.includes(s) &&
          !FOLDED.includes(s) &&
          s !== "reporter" &&
          s !== "demos",
      )
      .flatMap((s) => SURFACE[s]!)
    expect(rootNames).toEqual([...new Set(expected)].sort())
    for (const adapter of ADAPTERS) {
      for (const n of SURFACE[adapter]!) expect(rootNames).not.toContain(n)
    }
  })

  test("the video barrel includes the narration names and root includes both", () => {
    for (const n of SURFACE.narration!) {
      expect(SURFACE.video).toContain(n)
      expect(Object.keys(root)).toContain(n)
    }
  })

  test("exported values are defined (no accidental undefined re-exports)", () => {
    for (const [name, mod] of Object.entries(MODULES)) {
      for (const [key, value] of Object.entries(mod)) {
        expect(value, name + "." + key).not.toBeUndefined()
      }
    }
  })
})
