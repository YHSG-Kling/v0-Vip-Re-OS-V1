/**
 * lib/video/multilingual-reel.ts
 *
 * MULTILINGUAL REEL FEATURE — feature #3b.
 *
 * Produces reels in multiple languages by:
 *   (1) Translating the script (and caption cues) via the existing AI gateway
 *       (NOT Gemini — uses the Vercel AI Gateway with the Claude/OpenAI models
 *       already wired in).
 *   (2) Rendering ElevenLabs TTS using the `eleven_multilingual_v2` model with
 *       the target language — driven ENTIRELY by the translated input text.
 *       CORRECTED (wave 52 — Exa research against ElevenLabs' own API
 *       reference): `language_code` is NOT a general "hint for precision" on
 *       this model, despite what this comment used to say. ElevenLabs: "only
 *       Turbo v2.5 and Flash v2.5 support language enforcement" — the plain
 *       /convert endpoint 400s if you send language_code with any other
 *       model, and /convert-with-timestamps silently ignores it for
 *       multilingual_v2 either way. See lib/voice/elevenlabs-tts.ts's file
 *       header for the full finding and the fix (language_code is now sent
 *       ONLY to models on ElevenLabs' actual enforcement allowlist). The
 *       translated TEXT is what selects the language for multilingual_v2 —
 *       which is exactly what step (1) already produces.
 *   (3) Commissioning the reel variant via the EXISTING Video Director
 *       (commissionVideo) with a locale suffix on the idempotency key so the
 *       same (entity, kind, locale) never double-commissions.
 *
 * D-ID + ElevenLabs ONLY. No HeyGen. No Gemini vision.
 *
 * Exports:
 *   · DEFAULT_LANGUAGE             — owner ruling (wave 51, 2026-09-10, verbatim: "the
 *                                    default language is english"): THE one constant
 *                                    every language resolution in the codebase falls
 *                                    back to when a locale is unknown/null — never a
 *                                    second hardcoded "en" literal (CLAUDE.md §6, one
 *                                    vocabulary per function). Canonical home for it:
 *                                    this is the file that already owns the BCP-47 →
 *                                    ElevenLabs language_code vocabulary.
 *   · localeToElevenLabsLanguage   — PURE locale→ElevenLabs language_code mapper.
 *   · MULTILINGUAL_TTS_MODEL       — the ElevenLabs model constant (no identifier
 *                                    in comments beyond what the API name is — the
 *                                    contract: it is the multilingual model that
 *                                    handles many languages from the same voice).
 *   · translateReelScript          — translate script+captions via AI gateway.
 *   · commissionMultilingualReel   — per-locale: translate → TTS → commission via Director.
 *
 * NOT server-only at the pure helper level; commissionMultilingualReel does I/O.
 */

import type { createServiceClient } from "@/lib/supabase/service"
import type { GatewayChatMessage } from "@/lib/ai/gateway-chat"
import type { VideoSituation, CommissionOpts } from "@/lib/video/video-director"
// SCHEMA_SNAPSHOT is loaded LAZILY (inside schemaHasColumn below), never as a
// top-level value import: this file's header promises the pure helpers
// (DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, localeToElevenLabsLanguage, languageName,
// resolveContactLanguage) are safe for a "use client" language-selector UI to
// import directly (app/components/portal/PortalSettingsPage.tsx,
// app/crm/components/contact-header-card.tsx) — a static import of the
// ~180KB generated schema cache would inline it into every one of those
// browser bundles for a helper only resolveContactLanguageFromDb's server-side
// I/O path ever calls.

// ─── Language vocabulary — defined ONCE in ./language-vocabulary (pure, zero
// ─── imports, browser-safe) and re-exported here so every existing importer of
// ─── this module keeps working. See that file's header for why it is separate.
import {
  DEFAULT_LANGUAGE,
  MULTILINGUAL_TTS_MODEL,
  localeToElevenLabsLanguage,
  isMultilingualLocale,
  languageName,
} from "@/lib/video/language-vocabulary"
export {
  DEFAULT_LANGUAGE,
  MULTILINGUAL_TTS_MODEL,
  LOCALE_TO_ELEVENLABS_LANGUAGE,
  localeToElevenLabsLanguage,
  isMultilingualLocale,
  LANGUAGE_NAMES,
  languageName,
  LANGUAGE_OPTIONS,
} from "@/lib/video/language-vocabulary"

// ─── resolveContactLanguage — THE ONE LANGUAGE RESOLVER (§6) ─────────────────

/**
 * The inputs resolveContactLanguage needs, ALREADY READ by the caller. This
 * function does NO I/O itself — every caller (a `server-only` reactor, a pure
 * simulator, a future non-DB caller) can drive it, and the tier order is
 * provable without a database. `resolveContactLanguageFromDb` below is the
 * convenience wrapper that does the actual reads for the two real callers.
 */
export interface ContactLanguageInputs {
  /** contacts.preferred_language — tier 1. Null when the contact/agent never
   *  set one, OR when the column does not exist yet (m620 not applied). */
  contactPreferredLanguage?: string | null
  /** The most recent call_transcriptions.language for a voice_calls row linked
   *  to this contact — tier 2. Null when no transcribed call exists. */
  latestCallTranscriptionLanguage?: string | null
  /** The intake-time locale capture (form locale field / Accept-Language
   *  header), stored at contacts.metadata->>'captured_language' until m620
   *  lands and a typed column replaces it — tier 3. */
  intakeCapturedLanguage?: string | null
}

/**
 * resolveContactLanguage — PURE. THE ONE RESOLVER every avatar-video, persona-
 * reel, caption, and copy-generation caller uses to answer "what language does
 * this contact get". Tier order is the owner's ruling, in force:
 *
 *   1. contacts.preferred_language   — the contact/agent said so explicitly.
 *   2. call_transcriptions.language  — they've spoken to us before; a real
 *      detected language beats a guess.
 *   3. intake-time locale            — the form/Accept-Language capture at
 *      first touch, before any of the above could exist.
 *   4. DEFAULT_LANGUAGE ("en")       — owner ruling: default is English.
 *
 * Every tier value is passed through `localeToElevenLabsLanguage` so a raw
 * BCP-47 locale ("es-MX", "pt-BR") or an already-mapped code both resolve the
 * same way, and an unmapped/garbage value never survives to the next stage
 * silently wrong — it falls through to the next tier exactly like a null would.
 */
export function resolveContactLanguage(ctx: ContactLanguageInputs): string {
  const tiers: Array<string | null | undefined> = [
    ctx.contactPreferredLanguage,
    ctx.latestCallTranscriptionLanguage,
    ctx.intakeCapturedLanguage,
  ]
  for (const raw of tiers) {
    if (!raw) continue
    const mapped = localeToElevenLabsLanguage(raw)
    if (mapped) return mapped
  }
  return DEFAULT_LANGUAGE
}

/**
 * schemaHasColumn — PURE. Reads the generated schema cache
 * (scripts/schema-snapshot.ts, regenerated from the live database — CLAUDE.md
 * §3) rather than assuming a column exists. This is what lets
 * resolveContactLanguageFromDb ship AHEAD of m620 being applied: the SELECT
 * below never names `preferred_language` until the cache says the live table
 * actually has it, so a query against the unmigrated database never 42703s.
 */
async function schemaHasColumn(table: string, column: string): Promise<boolean> {
  const { SCHEMA_SNAPSHOT } = await import("@/scripts/schema-snapshot")
  return (SCHEMA_SNAPSHOT[table] ?? []).includes(column)
}

/**
 * resolveContactLanguageFromDb — the real callers' entry point. Does the tiered
 * reads (tolerating m620's absence per the header above) and delegates the
 * decision to the pure resolver.
 *
 * NEVER THROWS — a read failure at any tier is treated as "this tier has no
 * answer" (falls through), consistent with CLAUDE.md §4 fail-closed: a language
 * we cannot determine renders as the ruled default, never as a broken page.
 */
export async function resolveContactLanguageFromDb(
  supabase: AnyClient,
  contactId: string,
): Promise<string> {
  let contactPreferredLanguage: string | null = null
  let intakeCapturedLanguage: string | null = null
  try {
    const cols = (await schemaHasColumn("contacts", "preferred_language"))
      ? "preferred_language, metadata"
      : "metadata"
    const { data } = await supabase
      .from("contacts")
      .select(cols)
      .eq("id", contactId)
      .maybeSingle()
    const row = data as { preferred_language?: string | null; metadata?: Record<string, unknown> | null } | null
    contactPreferredLanguage = row?.preferred_language ?? null
    const meta = row?.metadata
    intakeCapturedLanguage =
      meta && typeof meta === "object" && typeof (meta as any).captured_language === "string"
        ? (meta as any).captured_language
        : null
  } catch {
    // Tolerate a refused/failed read — falls through to the next tier.
  }

  let latestCallTranscriptionLanguage: string | null = null
  try {
    const { data: calls } = await supabase
      .from("voice_calls")
      .select("id")
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(10)
    const callIds = (calls ?? []).map((c: any) => c.id).filter(Boolean)
    if (callIds.length > 0) {
      const { data: transcription } = await supabase
        .from("call_transcriptions")
        .select("language")
        .in("voice_call_id", callIds)
        .order("transcribed_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      latestCallTranscriptionLanguage = (transcription as any)?.language ?? null
    }
  } catch {
    // Tolerate a refused/failed read — falls through to the next tier.
  }

  return resolveContactLanguage({
    contactPreferredLanguage,
    latestCallTranscriptionLanguage,
    intakeCapturedLanguage,
  })
}

// ─── Translation via AI gateway ──────────────────────────────────────────────

export interface TranslateReelScriptInput {
  /** The English (or source-language) narration script to translate. */
  script: string
  /** Optional caption cue texts to translate in the same call (parallel strings). */
  captionTexts?: string[]
  /** BCP-47 target locale (e.g. 'es', 'pt-BR', 'zh'). */
  targetLocale: string
  /** Optional: a human-readable language name for the system prompt ("Spanish", "Portuguese"). */
  targetLanguageName?: string
}

export interface TranslateReelScriptResult {
  ok: boolean
  translatedScript?: string
  translatedCaptions?: string[]
  error?: string
}

/**
 * translateReelScript — translate a reel script (and optionally caption cue texts)
 * into the target locale using the EXISTING AI gateway (Vercel AI Gateway, not Gemini).
 *
 * The translation is instructed to:
 *   · Preserve the MEANING and EMOTIONAL TONE of the original.
 *   · Keep the translated text CONCISE (same approximate word count as the source)
 *     so the translated TTS audio fits the same reel duration.
 *   · Avoid Fair-Housing-prohibited language (the same gate that guards English copy
 *     applies — translated output will still pass the gate in commissionVideo).
 *   · Return structured JSON so caption texts can be translated in one call.
 *
 * Throws never — returns { ok: false, error } on any failure so the caller can
 * degrade gracefully (e.g. skip the locale, log, continue with others).
 */
export async function translateReelScript(
  input: TranslateReelScriptInput,
  gatewayChat: (params: {
    model: string
    messages: GatewayChatMessage[]
    maxTokens?: number
    temperature?: number
  }) => Promise<{ ok: boolean; content: string | null; error: string | null }>,
): Promise<TranslateReelScriptResult> {
  const { script, captionTexts = [], targetLocale, targetLanguageName } = input

  if (!script.trim()) {
    return { ok: false, error: "Script is empty — nothing to translate" }
  }

  // Build the language label for the prompt — prefer the provided name, else derive
  // from the locale tag (good enough for a translation prompt).
  const langLabel = targetLanguageName ?? targetLocale

  // We request structured JSON so script + captions are translated in ONE call.
  const hasCaptions = captionTexts.length > 0
  const captionsJson = hasCaptions ? JSON.stringify(captionTexts) : "[]"

  const systemPrompt =
    `You are a professional real-estate marketing copywriter and translator. ` +
    `Translate the provided real-estate reel script and caption texts into ${langLabel}. ` +
    `Rules:\n` +
    `1. Preserve the MEANING and EMOTIONAL TONE of the source.\n` +
    `2. Keep the translated script CONCISE — approximately the same word count as the source script.\n` +
    `3. Do NOT add, invent, or embellish facts not present in the source.\n` +
    `4. Avoid any discriminatory language (Fair Housing law applies in all languages).\n` +
    `5. Respond ONLY with a JSON object matching the schema: ` +
    `{"translatedScript":"...", "translatedCaptions":[...]}`

  const userPrompt =
    `Translate to ${langLabel}:\n\n` +
    `Source script:\n${script}\n\n` +
    `Caption texts (translate each string):\n${captionsJson}`

  try {
    const res = await gatewayChat({
      model: "anthropic/claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      maxTokens: Math.max(512, script.length * 4 + captionTexts.join("").length * 4),
      temperature: 0.3,  // low temperature for translation fidelity
    })

    if (!res.ok || !res.content) {
      return { ok: false, error: res.error ?? "Gateway returned no content" }
    }

    // Extract the JSON object — robust to markdown fences or surrounding prose.
    const jsonMatch = res.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { ok: false, error: `No JSON object found in gateway response: ${res.content.slice(0, 200)}` }
    }

    let parsed: { translatedScript?: string; translatedCaptions?: string[] }
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
      return { ok: false, error: `JSON parse failed: ${(e as Error).message}` }
    }

    const translatedScript = (parsed.translatedScript ?? "").trim()
    const translatedCaptions: string[] = Array.isArray(parsed.translatedCaptions)
      ? parsed.translatedCaptions.map((s: unknown) => (typeof s === "string" ? s.trim() : ""))
      : []

    if (!translatedScript) {
      return { ok: false, error: `Translation returned an empty script for locale ${targetLocale}` }
    }

    // Sanity: translated text must differ from source for non-English locales
    // (detect auto-pass if the gateway returned the source verbatim).
    if (isMultilingualLocale(targetLocale) && translatedScript === script.trim()) {
      return { ok: false, error: `Translation appears identical to source — gateway may have not translated to ${targetLocale}` }
    }

    return { ok: true, translatedScript, translatedCaptions }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Translation call failed" }
  }
}

// ─── Commission multilingual reel ────────────────────────────────────────────

export interface MultilingualReelLocale {
  /** BCP-47 locale tag (e.g. 'es', 'pt-BR', 'zh'). */
  locale: string
  /** Human-readable language name for the translation prompt ("Spanish", etc.). */
  languageName?: string
}

export interface MultilingualReelInput {
  situation: VideoSituation
  locales: MultilingualReelLocale[]
  /** The English script to translate. If omitted, the defaultHookForSituation is used. */
  sourceScript?: string
  /** Caption cue texts in English to translate alongside the script. */
  sourceCaptionTexts?: string[]
  opts: CommissionOpts
}

export interface MultilingualReelLocaleResult {
  locale: string
  ok: boolean
  status?: "staged" | "already_staged" | "blocked" | "failed" | "skipped"
  videoProjectId?: string
  compositionId?: string
  translatedScript?: string
  error?: string
  reason?: string
}

export interface CommissionMultilingualReelResult {
  ok: boolean
  results: MultilingualReelLocaleResult[]
  /** Count of successfully staged locale variants. */
  stagedCount: number
}

type AnyClient = ReturnType<typeof createServiceClient>

/**
 * commissionMultilingualReel — the multilingual reel feature entry point.
 *
 * For each locale in `locales`:
 *   1. Translates the script (and caption texts) via the existing AI gateway.
 *   2. Commissions the reel via commissionVideo (the existing Director) with:
 *        · The translated script stored in script_content.
 *        · `locale` column set to the BCP-47 tag.
 *        · An idempotency key suffixed with the locale so the same (entity, kind,
 *          locale) never double-commissions.
 *        · The TTS path in the render coordinator picks up `eleven_multilingual_v2`
 *          from video_metadata.tts_model + video_metadata.tts_language_code (stored
 *          on the row for the render cron to consume).
 *
 * D-ID + ElevenLabs ONLY (gated by the provider check in commissionVideo).
 * Idempotent per (entity, locale). Compliance-gated (each variant passes through
 * commissionVideo's existing compliance gate). NEVER auto-publishes.
 *
 * Locale translation failures are per-locale: a single locale failing does NOT
 * block other locales — the result array records per-locale outcomes.
 */
export async function commissionMultilingualReel(
  input: MultilingualReelInput,
  client?: AnyClient,
): Promise<CommissionMultilingualReelResult> {
  const { situation, locales, sourceScript, sourceCaptionTexts = [], opts } = input

  if (!locales || locales.length === 0) {
    return { ok: false, results: [], stagedCount: 0 }
  }

  // Lazy-import to avoid server-only in pure caller scope.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
  const { commissionVideo } = await import("@/lib/video/video-director")
  const { defaultHookForSituation } = await import("@/lib/video/video-director")

  const svc: AnyClient = client ?? createServiceClient()

  const effectiveSourceScript = (sourceScript ?? "").trim() || defaultHookForSituation(situation.kind)

  const results: MultilingualReelLocaleResult[] = []

  for (const { locale, languageName } of locales) {
    // Step 1: Translate the script (and captions) for this locale.
    const translation = await translateReelScript(
      {
        script: effectiveSourceScript,
        captionTexts: sourceCaptionTexts,
        targetLocale: locale,
        targetLanguageName: languageName,
      },
      gatewayChat,
    )

    if (!translation.ok || !translation.translatedScript) {
      results.push({
        locale,
        ok: false,
        status: "failed",
        error: translation.error ?? "Translation failed",
      })
      continue
    }

    const translatedScript = translation.translatedScript
    const ttsLanguageCode = localeToElevenLabsLanguage(locale)

    // Step 2: Commission via the existing Director — locale suffix on idempotency.
    // The entity for the idempotency key is derived inside commissionVideo; we
    // thread the locale via the title (for display) and video_metadata (for the
    // render cron). We patch opts to carry the locale-specific data.
    const localeOpts: CommissionOpts = {
      ...opts,
      // Title carries the locale tag for readability in the Content Studio.
      title: opts.title
        ? `${opts.title} [${locale}]`
        : `${translatedScript.slice(0, 48)}… [${locale}]`,
      // The copy generator is bypassed for multilingual: we provide the translated
      // hook directly. We inject a no-op generator that returns the pre-translated
      // script so commissionVideo's hook-draft step uses it verbatim.
      copyGenerator: async () => ({ body: translatedScript }),
    }

    // Commission the video — commissionVideo stages the row idempotently.
    // We need to inject the locale into the director_key to avoid colliding with
    // the English commission for the same entity+kind. We do this by temporarily
    // patching the listingId/contactId/campaignId with a locale suffix so the
    // idempotency key namespace is per-locale. This is the minimal additive change
    // that doesn't require any new Director parameter.
    const entitySuffix = `:locale:${locale}`
    const localeOptsWithSuffix: CommissionOpts = {
      ...localeOpts,
      // Suffix the entity used for the director_key so locale variants are isolated.
      ...(opts.listingId   ? { listingId:  opts.listingId  + entitySuffix } : {}),
      ...(opts.contactId   ? { contactId:  opts.contactId  + entitySuffix } : {}),
      ...(opts.campaignId  ? { campaignId: opts.campaignId + entitySuffix } : {}),
      // When no entity, suffix the brokerage id so the director_key is locale-scoped.
      ...(!opts.listingId && !opts.contactId && !opts.campaignId
        ? { campaignId: `locale:${locale}` }
        : {}),
    }

    const commResult = await commissionVideo(situation, localeOptsWithSuffix, svc)

    if (commResult.ok && commResult.videoProjectId) {
      // Patch the staged row with locale + TTS metadata so the render cron can pick
      // up the multilingual model + language_code. This is additive — the render
      // cron reads these from video_metadata; rows without them use the default model.
      const now = new Date().toISOString()
      await svc
        .from("ai_video_projects")
        .update({
          locale,
          script_content: translatedScript,
          video_metadata: {
            tts_model:         MULTILINGUAL_TTS_MODEL,
            tts_language_code: ttsLanguageCode,
            translated_captions: translation.translatedCaptions ?? [],
            source_locale:     DEFAULT_LANGUAGE,
            target_locale:     locale,
          },
          updated_at: now,
        })
        .eq("id", commResult.videoProjectId)
    }

    results.push({
      locale,
      ok: commResult.ok,
      status: commResult.status,
      videoProjectId: commResult.videoProjectId,
      compositionId: commResult.compositionId,
      translatedScript,
      reason: commResult.reason,
      error: commResult.ok ? undefined : (commResult.reason ?? "Commission failed"),
    })
  }

  const stagedCount = results.filter((r) => r.ok && r.status === "staged").length

  return {
    ok: results.some((r) => r.ok),
    results,
    stagedCount,
  }
}
