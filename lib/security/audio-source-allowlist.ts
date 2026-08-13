// lib/security/audio-source-allowlist.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE HOST ALLOWLIST FOR SERVER-SIDE AUDIO FETCHES. Pure — no I/O, no network,
// no database — so the whole decision is unit-testable and negative-controllable.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────
// `app/actions/ai-voice-transcription.ts:transcribeAudio` takes an `audioUrl`
// FROM THE CALLER and hands it to the connector gateway with `auth: none`. It is
// the ONLY `asset-download` call site in this repo that does that — every other
// one (lib/documents/ocr-pdf.ts, lib/offers/offer-extractor.ts,
// lib/ai/image-generation.ts, lib/social/publisher.ts, lib/did/index.ts,
// lib/video/composite-attribution.ts, lib/listings/photo-intelligence.ts,
// lib/integrations/providers/docusign-provider.ts, lib/documents/listing-brochure.ts)
// passes a URL a PROVIDER or OUR OWN STORAGE returned. So an authenticated
// caller could make the server issue a GET at any address it can reach, and then
// pay a transcription vendor to read whatever came back.
//
// The owner's ruling ("transcribeaudio is necessary") settles WHETHER the action
// exists. It does not say the server should fetch arbitrary addresses, so the
// URL is constrained here instead.
//
// ── HOW THE SET WAS DERIVED (call sites, not guesses) ────────────────────────
// The question is not "what hosts serve audio" — it is "what hosts does THIS
// system produce or store call audio on". Each rule below names the code that
// puts audio there. Nothing is included on reputation.
//
//   1. THE SUPABASE STORAGE BUCKETS — `lib/storage/buckets.ts:48,53`
//      (getPublicUrl / createSignedUrl) and `lib/providers/dispatch.ts:1124-1130`,
//      which uploads the ISA/voicedrop mp3 to the `media` bucket and hands the
//      public URL onward. The host is the deployment's OWN project host, read
//      from NEXT_PUBLIC_SUPABASE_URL — derived from the environment, never
//      hardcoded, so it is correct on every deployment including previews.
//      lib/providers/tenancy-matrix.ts:122-126 states the rule this implements:
//      "ALL tenant media lives on OUR Supabase buckets".
//
//   2. VERCEL BLOB (public) — `lib/direct-mail/render-letter-audio.ts:112-118`
//      puts `letter-audio/<brokerage>/<campaign>.mp3` with `access: "public"`;
//      `app/actions/podcast-generation.ts` and
//      `lib/listing-presentation/section-narration-orchestrator.ts:115` do the
//      same for podcast + narration audio. @vercel/blob public URLs are always
//      served from `<store>.public.blob.vercel-storage.com`. The migration to
//      Supabase buckets (rule 1) is in progress and NOT finished, so both are
//      live producers today.
//
//   3. TWILIO — `api.twilio.com`. Twilio is the telephony provider
//      (lib/providers/tenancy-matrix.ts:38-42, `platform_subaccount`), the
//      `twilio` connector's baseUrl at ~20 call sites, and Twilio serves call
//      recordings from `api.twilio.com/2010-04-01/Accounts/<Sid>/Recordings/<Sid>`.
//      HONEST CAVEAT, recorded rather than smoothed over: there is no `<Record>`
//      verb in the repo today and NO in-repo writer of `voice_calls.recording_url`
//      — the column is read (app/dashboard/voice/review/[callId]/page.tsx:282
//      plays it, three more dashboards render it) and never written. So this rule
//      is derived from WHICH VENDOR THE COLUMN IS FOR, not from a live row. It is
//      the one rule here that anticipates rather than records, and it is named as
//      such so a later reader can delete it if recordings never land.
//
//   4. ZOOM — `*.zoom.us`. `lib/connections/zoom-transcripts.ts:111-117` already
//      downloads a Zoom-returned recording asset through the gateway, and the
//      row it attaches to is a `voice_calls` row with `call_type='zoom_meeting'`
//      (an admitted value of the live CHECK) — the SAME ledger `transcribeAudio`
//      keys off. A zoom_meeting call's audio comes from the host that lane
//      already fetches from.
//
// DELIBERATELY ABSENT — ELEVENLABS / D-ID / OPENAI. The TTS provider returns
// AUDIO BYTES, never a URL: `lib/voice/elevenlabs-tts.ts:97-113` and
// `lib/providers/dispatch.ts:1107-1117` both use `responseType: "arraybuffer"`
// and the bytes are re-hosted on rule 1 or rule 2 before anything else sees them.
// Adding `api.elevenlabs.io` would widen the allowlist for a URL this system
// never produces.
//
// ── FAIL-CLOSED, ON PURPOSE ──────────────────────────────────────────────────
// If NO rule resolves (NEXT_PUBLIC_SUPABASE_URL unset in a context where the
// static rules are also disabled) the verdict is REFUSE, not allow. An allowlist
// that degrades to "everything" the moment its configuration is missing is the
// defect it was written to close.

// NO `import "server-only"`, deliberately, and for the reason lib/connections/scope.ts
// gives for the same choice: this module is PURE — no I/O, no Supabase client, no
// secret — so the cascade and the gating are unit-tested directly rather than
// asserted about from the outside. The only environment it reads is
// NEXT_PUBLIC_SUPABASE_URL, which is public by construction.

/** One allowlist entry. `why` is carried into the refusal detail so a rejected
 *  fetch can be explained without reading this file. */
export type AudioHostRule =
  | { kind: "exact"; host: string; why: string }
  | { kind: "suffix"; suffix: string; why: string }

export type AudioSourceVerdict =
  | { allowed: true; host: string; rule: string }
  | {
      allowed: false
      reason:
        | "not_absolute_https"
        | "url_credentials"
        | "non_default_port"
        | "no_rules_resolved"
        | "host_not_allowed"
      detail: string
    }

/** Static half of the allowlist — the hosts that do not depend on deployment env. */
export const STATIC_AUDIO_HOST_RULES: readonly AudioHostRule[] = [
  {
    kind: "suffix",
    suffix: "public.blob.vercel-storage.com",
    why: "Vercel Blob public store — lib/direct-mail/render-letter-audio.ts puts letter audio there; podcast + narration audio follow the same path",
  },
  {
    kind: "exact",
    host: "api.twilio.com",
    why: "Twilio call recordings — the telephony provider (lib/providers/tenancy-matrix.ts) and the vendor voice_calls.recording_url points at",
  },
  {
    kind: "suffix",
    suffix: "zoom.us",
    why: "Zoom cloud recordings — lib/connections/zoom-transcripts.ts already downloads Zoom-returned recording assets for voice_calls rows with call_type='zoom_meeting'",
  },
] as const

/**
 * The full rule set for a deployment: the static rules plus THIS deployment's
 * own Supabase storage host, derived from NEXT_PUBLIC_SUPABASE_URL.
 *
 * `env` is a parameter so the derivation is testable without mutating
 * process.env, and so a caller can prove the fail-closed branch.
 */
export function platformAudioHostRules(
  // Indexed rather than a single optional key: `{ NEXT_PUBLIC_SUPABASE_URL?: string }`
  // is a WEAK type (all properties optional), and `process.env` resolves here to
  // Next's `ProcessEnv` augmentation, which shares no property with it — so TS
  // rejects the default with TS2559. An index signature turns off weak-type
  // detection and keeps the parameter injectable, which is the whole point: a
  // caller can pass `{}` to prove the fail-closed branch without touching
  // process.env. Cast-free on purpose.
  env: { readonly [key: string]: string | undefined } = process.env,
): AudioHostRule[] {
  const rules: AudioHostRule[] = [...STATIC_AUDIO_HOST_RULES]
  const raw = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()
  if (raw) {
    try {
      const host = new URL(raw).hostname.toLowerCase()
      if (host) {
        rules.unshift({
          kind: "exact",
          host,
          why: "this deployment's own Supabase Storage host (lib/storage/buckets.ts, lib/providers/dispatch.ts media bucket)",
        })
      }
    } catch {
      // A malformed NEXT_PUBLIC_SUPABASE_URL yields NO storage rule rather than a
      // guessed one. The remaining rules still stand; if the caller passed an
      // empty static set too, checkAudioSourceUrl refuses with no_rules_resolved.
    }
  }
  return rules
}

/** Suffix match on a LABEL BOUNDARY — `evilpublic.blob.vercel-storage.com` must
 *  not satisfy a `public.blob.vercel-storage.com` rule. */
function matchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase()
  return host === s || host.endsWith(`.${s}`)
}

/**
 * Is this URL one the platform itself produced or stored audio at?
 *
 * Refuses, in this order, and says which:
 *   · anything that is not an absolute https URL (http, data:, file:, gopher:,
 *     a relative path). Plain http is refused too — every producer above serves
 *     https, and http is the scheme an SSRF probe reaches internal services on.
 *   · a URL carrying credentials (`https://user:pass@host/`). WHATWG parsing puts
 *     the real host last so this is not a parser bypass, but a credentialed URL
 *     is never something this platform produced, and refusing it removes a whole
 *     family of "which half is the host" arguments.
 *   · an explicit non-443 port — `https://<allowed-host>:9200/` is an allowed
 *     name pointed at a different service.
 *   · an empty rule set (fail-closed; see the header).
 *   · a host no rule admits.
 */
export function checkAudioSourceUrl(
  url: string,
  rules: readonly AudioHostRule[],
): AudioSourceVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "not_absolute_https", detail: "audioUrl is not an absolute URL" }
  }
  if (parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: "not_absolute_https",
      detail: `audioUrl scheme "${parsed.protocol.replace(":", "")}" is not https`,
    }
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: "url_credentials", detail: "audioUrl carries embedded credentials" }
  }
  if (parsed.port && parsed.port !== "443") {
    return { allowed: false, reason: "non_default_port", detail: `audioUrl targets port ${parsed.port}` }
  }
  if (rules.length === 0) {
    return {
      allowed: false,
      reason: "no_rules_resolved",
      detail: "no audio-source hosts are configured for this deployment; refusing rather than fetching",
    }
  }

  // Trailing-dot hosts ("host.com.") resolve identically and must not slip past
  // an exact match.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
  for (const rule of rules) {
    if (rule.kind === "exact" && host === rule.host.toLowerCase()) {
      return { allowed: true, host, rule: rule.why }
    }
    if (rule.kind === "suffix" && matchesSuffix(host, rule.suffix)) {
      return { allowed: true, host, rule: rule.why }
    }
  }
  return {
    allowed: false,
    reason: "host_not_allowed",
    detail:
      `audioUrl host "${host}" is not one this system stores audio on ` +
      `(allowed: ${rules.map((r) => (r.kind === "exact" ? r.host : `*.${r.suffix}`)).join(", ")})`,
  }
}
