/**
 * remotion.config.ts
 *
 * Remotion CLI / render config. Used by both `npx remotion studio` (dev
 * preview of compositions) and the render endpoint via @remotion/bundler.
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
