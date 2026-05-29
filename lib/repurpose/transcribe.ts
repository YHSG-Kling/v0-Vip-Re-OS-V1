"use server"

// Transcribe a direct media-file URL (mp4/mp3/wav/m4a/webm) via Whisper.
// There is no YouTube/Vimeo caption extraction in this app, and Whisper accepts
// an audio/video file buffer (~25MB limit) — not a web page. So this only works
// for a directly-downloadable media file; callers fall back to a pasted
// transcript for page links (YouTube/Vimeo) or oversized files.

import { openai } from "@ai-sdk/openai"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const MAX_BYTES = 25 * 1024 * 1024 // Whisper hard limit
const MEDIA_CT = /^(audio|video)\//i

export type TranscribeResult =
  | { success: true; transcript: string }
  | { success: false; reason: "not_media" | "too_large" | "fetch_failed" | "no_speech" | "error"; message: string }

export async function transcribeFromUrl(url: string): Promise<TranscribeResult> {
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, reason: "error", message: "Invalid URL" }
  }
  if (!process.env.OPENAI_API_KEY) {
    return { success: false, reason: "error", message: "Transcription is not configured" }
  }

  try {
    const res = await callConnector<Buffer>({
      connector: "asset-download", baseUrl: "", path: "", url,
      method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
    })
    if (!res.ok || !res.data) {
      return { success: false, reason: "fetch_failed", message: `Could not fetch the URL (${res.status})` }
    }

    const contentType = res.headers["content-type"] ?? ""
    if (!MEDIA_CT.test(contentType)) {
      // HTML pages (YouTube/Vimeo links), etc. — not transcribable here.
      return { success: false, reason: "not_media", message: "That link isn't a direct audio/video file" }
    }

    if (res.data.byteLength > MAX_BYTES) {
      return { success: false, reason: "too_large", message: "File is larger than 25MB" }
    }

    const { experimental_transcribe } = await import("ai")
    const result = await experimental_transcribe({
      model: openai.transcription("whisper-1"),
      audio: new Uint8Array(res.data),
    })
    const transcript = (result.text ?? "").trim()
    if (!transcript) {
      return { success: false, reason: "no_speech", message: "No speech detected in the media" }
    }
    return { success: true, transcript }
  } catch (err) {
    return { success: false, reason: "error", message: err instanceof Error ? err.message : "Transcription failed" }
  }
}
