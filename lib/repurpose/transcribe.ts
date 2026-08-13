"use server"

// Transcribe a direct media-file URL (mp4/mp3/wav/m4a/webm) for the REPURPOSE
// lane. There is no YouTube/Vimeo caption extraction in this app, and a
// transcription vendor accepts an audio/video file buffer — not a web page. So
// this only works for a directly-downloadable media file; callers fall back to a
// pasted transcript for page links (YouTube/Vimeo) or oversized files.
//
// THE IMPLEMENTATION MOVED, THE CONTRACT DID NOT. Everything this function used
// to do now lives in lib/repurpose/transcribe-core.ts — the ONE transcription
// primitive, shared with app/actions/ai-voice-transcription.ts:transcribeAudio,
// which had grown a second copy of the same four steps.
//
// This wrapper keeps its ORIGINAL one-argument shape on purpose. A top-level
// `"use server"` makes every export an RPC endpoint any authenticated session can
// call with any arguments, so the core's option bag — which includes the
// `brokerageId` that decides whose vendor ledger is billed — must not be
// reachable from the browser. Server code that has already resolved its own
// tenant imports the core directly instead.
//
// The repurpose lane's behaviour is UNCHANGED by the move: no host allowlist (a
// pasted external link is the whole feature), no brokerageId (so neither the
// budget gate nor the ledger engages, exactly as before), and the default vendor
// is still Whisper.

// TYPE-ONLY import, and deliberately NOT re-exported: a type re-export out of a
// "use server" module is one of the two shapes that has broken page-data
// collection in this repo before (see scripts/use-server-export-guard.ts). The
// single consumer, lib/repurpose/actions.ts, imports the function and never the
// type; anything wanting the type imports ./transcribe-core.
import type { TranscribeResult } from "./transcribe-core"

export async function transcribeFromUrl(url: string): Promise<TranscribeResult> {
  const { transcribeMediaUrl } = await import("./transcribe-core")
  return transcribeMediaUrl(url)
}
