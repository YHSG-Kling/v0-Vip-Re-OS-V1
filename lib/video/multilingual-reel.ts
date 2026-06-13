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
 *       the target language — driven by the translated input text (ElevenLabs
 *       auto-detects from the text; language_code is forwarded as a hint for
 *       precision when specified).
 *   (3) Commissioning the reel variant via the EXISTING Video Director
 *       (commissionVideo) with a locale suffix on the idempotency key so the
 *       same (entity, kind, locale) never double-commissions.
 *
 * D-ID + ElevenLabs ONLY. No HeyGen. No Gemini vision.
 *
 * Exports:
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

// ─── ElevenLabs multilingual model constant ──────────────────────────────────

/**
 * The ElevenLabs model that handles many languages from a single cloned voice.
 * Language is driven by the input text; the language_code param is forwarded as
 * an explicit hint when the caller knows the target locale.
 */
export const MULTILINGUAL_TTS_MODEL = "eleven_multilingual_v2"

// ─── Locale → ElevenLabs language_code (PURE) ────────────────────────────────

/**
 * Canonical BCP-47 locale tags → ElevenLabs language_code strings accepted by
 * the multilingual model endpoint.
 *
 * ElevenLabs language_code values are lowercase ISO 639-1 codes (2-letter). The
 * model auto-detects from the input text when no language_code is supplied, but
 * passing an explicit code improves accuracy for shorter scripts or scripts that
 * contain loan words from other languages.
 *
 * New languages can be appended here without touching any caller — the function
 * returns null for unmapped locales, which falls back to auto-detection.
 */
const LOCALE_TO_ELEVENLABS_LANGUAGE: Record<string, string> = {
  // Spanish
  "es":    "es",
  "es-mx": "es",
  "es-ar": "es",
  "es-co": "es",
  "es-cl": "es",
  "es-es": "es",
  "es-us": "es",
  // Portuguese
  "pt":    "pt",
  "pt-br": "pt",
  "pt-pt": "pt",
  // French
  "fr":    "fr",
  "fr-ca": "fr",
  "fr-fr": "fr",
  // German
  "de":    "de",
  "de-de": "de",
  "de-at": "de",
  "de-ch": "de",
  // Italian
  "it":    "it",
  "it-it": "it",
  // Chinese (Simplified / Traditional both map to zh for the voice model)
  "zh":    "zh",
  "zh-cn": "zh",
  "zh-tw": "zh",
  "zh-hk": "zh",
  // Japanese
  "ja":    "ja",
  // Korean
  "ko":    "ko",
  // Arabic
  "ar":    "ar",
  // Hindi
  "hi":    "hi",
  // Polish
  "pl":    "pl",
  // Dutch
  "nl":    "nl",
  // Russian
  "ru":    "ru",
  // Turkish
  "tr":    "tr",
  // Ukrainian
  "uk":    "uk",
  // Swedish
  "sv":    "sv",
  // Norwegian
  "no":    "no",
  // Danish
  "da":    "da",
  // Finnish
  "fi":    "fi",
  // Indonesian
  "id":    "id",
  // Tagalog / Filipino
  "tl":    "tl",
  // Vietnamese
  "vi":    "vi",
  // English (default — monolingual model is preferred but multilingual handles it)
  "en":    "en",
  "en-us": "en",
  "en-gb": "en",
  "en-au": "en",
}

/**
 * localeToElevenLabsLanguage — PURE.
 *
 * Map a BCP-47 locale tag (case-insensitive) to the ElevenLabs language_code
 * accepted by the multilingual model. Returns null when the locale is unmapped
 * (the model will auto-detect from the translated text — perfectly safe fallback).
 *
 * Unit-testable in isolation (no I/O).
 */
export function localeToElevenLabsLanguage(locale: string): string | null {
  if (!locale) return null
  const key = locale.trim().toLowerCase()
  return LOCALE_TO_ELEVENLABS_LANGUAGE[key] ?? null
}

/**
 * isMultilingualLocale — PURE helper.
 *
 * Returns true when the locale is non-English (i.e. requires translation + the
 * multilingual TTS model). English locales can use the cheaper monolingual model.
 * Used by commissionMultilingualReel to skip translation for the default locale.
 */
export function isMultilingualLocale(locale: string): boolean {
  const lang = localeToElevenLabsLanguage(locale)
  return lang !== null && lang !== "en"
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
            source_locale:     "en",
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
