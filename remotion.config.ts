/**
 * remotion.config.ts
 *
 * Remotion CLI / Studio config. THIS FILE DOES NOT CONFIGURE PRODUCTION
 * RENDERS.
 *
 * A comment here used to say it was "used by both `npx remotion studio` (dev
 * preview of compositions) and the render endpoint via @remotion/bundler."
 * The second half is false, and it is the half anyone opening this file to
 * change render quality would act on. The config file is loaded ONLY by the
 * CLI — `node_modules/@remotion/cli/dist/load-config.js` is the sole loader in
 * the installed tree, and `@remotion/renderer` does not even depend on
 * `@remotion/cli` (its package.json lists execa, remotion, @remotion/streaming,
 * source-map, ws, @remotion/licensing). `bundle()` compiles the composition
 * tree; it does not carry these settings, and `renderMedia()` takes its
 * settings as arguments.
 *
 * WHAT THAT MEANS IN PRACTICE. The three production render paths —
 * app/api/internal/remotion/render-just-listed, render-newsletter-video and
 * render-composition — each pass `codec: "h264"` and `concurrency: 1` to
 * renderMedia explicitly, so those two agree with the lines below by
 * repetition rather than by inheritance. `crf` is NOT passed, so production
 * renders use the renderer's own h264 default of 18
 * (node_modules/@remotion/renderer/dist/crf.js, defaultCrfMap.h264), not the
 * 20 set here. Lower is higher quality, so production is slightly ABOVE this
 * target, not below it — which is why nobody noticed.
 *
 * Changing a number here therefore changes the Studio preview and `npx
 * remotion render` only. To change what the app ships, change the renderMedia
 * call sites.
 */
import { Config } from "@remotion/cli/config"

// H.264 with web-streaming-friendly metadata so the rendered MP4 can play
// in-browser from Supabase Storage without a download step.
Config.setVideoImageFormat("jpeg")
Config.setCodec("h264")
Config.setCrf(20)            // visual quality target (lower = higher quality)
Config.setNumberOfGifLoops(0)
Config.setConcurrency(1)     // one chrome instance per render — safer on
                             // serverless where memory is bounded.
