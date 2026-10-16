import { join } from "node:path"

import {
  createVideoKit,
  defineBrand,
  defineCardCopy,
} from "@confidee/flowreel/video"

import { E2E_FLOWREEL } from "../../flowreel.config"

// The brand and words of every video card, and where the narration lines
// live. Videos never decide a verdict: a missing logo or ffmpeg means
// "video: not produced (<reason>)", nothing more.

export const BRAND = defineBrand({
  // TODO(flowreel): your product name and colours. Logos are optional:
  // logos: () => ({ onBrand: svgDataUri("<white logo>.svg"),
  //                 onLight: svgDataUri("<colour logo>.svg") }),
  name: "My App",
  colors: { primary: "#1d4ed8" },
})

let kit: ReturnType<typeof createVideoKit> | undefined

/** The video kit, built once per process. */
export function videoKit() {
  return (kit ??= createVideoKit({
    brand: BRAND,
    copy: defineCardCopy({ run: { title: "Smoke round trip" } }),
    narrationDir: join(E2E_FLOWREEL, "narration"),
  }))
}
