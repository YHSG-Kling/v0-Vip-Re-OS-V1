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
// ── THE GATE IS ON (owner ruling: "yes that gate STT needs to be turned on; any
//    ai use is vercel ai gateway") ───────────────────────────────────────────
// This lane used to call the primitive with NO options, so `checkVendorBudget`
// never pre-flighted and `vendor_usage_tracking` never recorded — the repurpose
// lane spent on Whisper without appearing on any ledger, while its sibling
// transcribeAudio was fully gated and metered through the same primitive. That
// is now closed: every call here supplies a `brokerageId`, which is the single
// switch that turns ON both the budget pre-flight and the ledger write inside
// transcribe-core.ts. (The primitive's FAIL-OPEN contract is untouched: only a
// MEASURED `allowed: false` refuses; an unreadable ledger or plan tier still
// transcribes.)
//
// ── WHY THE SIGNATURE IS STILL ONE ARGUMENT ─────────────────────────────────
// A top-level `"use server"` makes every export an RPC endpoint any session can
// call with any arguments. `brokerageId` decides WHOSE vendor ledger is billed,
// so accepting it as a parameter would hand the browser a cross-tenant write
// knob — bill another brokerage, or aim the refusal at a tenant that is already
// at its ceiling. The tenant is therefore resolved SERVER-SIDE, from
// `getAgentContext()`, which reads the session cookie through
// `supabase.auth.getUser()` and then `users.brokerage_id` /
// `user_role_assignments` — none of which is reachable from an argument. (It
// also honours the platform-staff act-as seam, so an impersonated run bills the
// tenant being acted for, the same as every other action.)
//
// An unresolvable tenant REFUSES rather than falling through ungated. A gate you
// can skip by calling the endpoint without a session is not a gate, and this
// export is reachable without going through lib/repurpose/actions.ts, which does
// its own auth check. Both in-repo call sites (lib/repurpose/actions.ts:677 and
// :785) already sit behind `ctx.brokerageId`, so the refusal is unreachable on
// the real paths.
//
// ── THE HOST ALLOWLIST: DELIBERATELY NOT PASSED, AND HERE IS THE REASONING ───
// The primitive's `allowedHosts` is a HOST allowlist — it admits a named set and
// fails closed on everything else, including on an empty set. There is no
// "any public host" spelling of it, so the choice here is binary:
//
//   · Pass `platformAudioHostRules()` (what transcribeAudio passes) and the
//     feature dies. That set is the hosts THIS system produces or stores audio
//     on — our Supabase bucket, Vercel Blob, Twilio, Zoom. The repurpose lane
//     exists to transcribe a link the AGENT PASTED: their own webinar recording
//     on someone else's CDN, a competitor's clip, a podcast host. Every one of
//     those is refused by that set. An allowlist here does not tighten the
//     feature, it deletes it — and it is the feature the owner is paying for.
//   · Pass nothing, and accept that the server issues a GET at an address the
//     user chose.
//
// This lane passes NOTHING, and the residual is named rather than smoothed over.
// What actually bounds it, all of it already in the primitive:
//
//   1. THE CONTENT-TYPE CAP is the load-bearing one for exfiltration. The
//      response must match `^(audio|video)/` or the call returns `not_media`
//      BEFORE any vendor sees a byte. An internal service answering `text/html`
//      or `application/json` — the shape of nearly everything an SSRF probe is
//      aimed at — can never become a transcript handed back to the caller.
//   2. THE 25MB BYTE CAP bounds what one call can pull.
//   3. `auth: { style: "none" }` on the `asset-download` connector: no platform
//      credential is attached to the fetch, so a hostile URL cannot harvest one.
//   4. THE BUDGET GATE, as of this change, meters it. Blind probing used to be
//      free and invisible; it now costs the probing tenant's own vendor budget
//      and lands on their ledger with `system_source = "repurpose_transcription"`.
//
// What is NOT closed, stated plainly so nobody reads this comment as a
// clearance: the primitive accepts `http://` as well as `https://` here (it only
// requires `^https?://`), and neither it nor the connector gateway refuses
// RFC1918 / link-local / loopback targets — the gateway has no private-address
// blocklist. A blind request to an internal address will still LEAVE; it just
// cannot return anything to the caller unless that address answers with an
// audio/video content-type. Closing that properly means a scheme + private-range
// refusal on the egress gateway, which is every `asset-download` call site's
// problem and not this lane's to invent — it is recorded here as the open edge
// rather than left for someone to rediscover.

// TYPE-ONLY import, and deliberately NOT re-exported: a type re-export out of a
// "use server" module is one of the two shapes that has broken page-data
// collection in this repo before (see scripts/use-server-export-guard.ts). The
// single consumer, lib/repurpose/actions.ts, imports the function and never the
// type; anything wanting the type imports ./transcribe-core.
import type { TranscribeResult } from "./transcribe-core"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function transcribeFromUrl(url: string): Promise<TranscribeResult> {
  // TENANT FROM THE SESSION, NEVER FROM THE ARGUMENTS — see the header.
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) {
    return {
      success: false,
      reason: "error",
      message: "No brokerage context — transcription is metered per brokerage",
    }
  }

  const { transcribeMediaUrl } = await import("./transcribe-core")
  return transcribeMediaUrl(url, {
    // Supplying the tenant is what turns ON the budget pre-flight and the vendor
    // ledger inside the primitive. No allowlist: see the header for why, and for
    // what bounds the fetch instead.
    brokerageId,
    systemSource: "repurpose_transcription",
  })
}
