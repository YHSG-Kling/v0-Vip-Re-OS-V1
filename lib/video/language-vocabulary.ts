/**
 * lib/video/language-vocabulary.ts — THE language vocabulary (PURE, zero imports).
 *
 * Split out of lib/video/multilingual-reel.ts (wave 52) because that file reaches
 * server-only modules through its lazy `await import(...)` calls (video-director →
 * remotion registry, the service client), and scripts/client-server-only-guard.ts
 * follows dynamic imports too — so a "use client" language selector
 * (app/crm/components/contact-header-card.tsx) importing it would have put
 * service-role logic in a browser bundle. This module imports NOTHING; every
 * value here is a constant or a pure function, safe for any bundle.
 *
 * multilingual-reel.ts RE-EXPORTS every name below, so its existing importers are
 * unchanged and there is still ONE definition of each (§6): DEFAULT_LANGUAGE is
 * defined here and nowhere else.
 */

// ─── Default language (owner ruling, wave 51, verbatim: "the default language is
// ─── english") ────────────────────────────────────────────────────────────────

/**
 * THE default language — every language/locale resolution in the codebase that hits
 * an unknown/null value falls back to this ONE constant, never a second "en"/"eng"/
 * "english" literal (CLAUDE.md §6). Also the ElevenLabs language_code for English
 * (matches LOCALE_TO_ELEVENLABS_LANGUAGE["en"] below — kept as one value, not two).
 */
export const DEFAULT_LANGUAGE = "en"

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
export const LOCALE_TO_ELEVENLABS_LANGUAGE: Record<string, string> = {
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
  return lang !== null && lang !== DEFAULT_LANGUAGE
}

/**
 * Human-readable language names for the same 23 codes
 * LOCALE_TO_ELEVENLABS_LANGUAGE resolves to — used in translation prompts
 * (translateReelScript's `targetLanguageName`) and in any writing-prompt
 * directive that tells a model "write this in ${language}" (generatePersonaCopy,
 * the intro-video-reactor draft prompt). ONE map for "what do we call this
 * language" — a second copy of this list anywhere else would be the exact §6
 * defect (two spellings of the same idea, timeline/video-status/vendor-category
 * already paid for).
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German",
  it: "Italian", zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic",
  hi: "Hindi", pl: "Polish", nl: "Dutch", ru: "Russian", tr: "Turkish",
  uk: "Ukrainian", sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
  id: "Indonesian", tl: "Tagalog", vi: "Vietnamese",
}

/** languageName — PURE. Human-readable name for a resolved language code (the
 *  ElevenLabs-mapped code, not a raw BCP-47 locale). Unmapped codes return the
 *  code itself so a prompt never renders "undefined". */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code
}

/**
 * LANGUAGE_OPTIONS — PURE, derived from LANGUAGE_NAMES (§6 — the ONE
 * vocabulary; never a second `{code, label}` list hand-typed at a UI call
 * site). The exact 23 codes contacts.preferred_language's CHECK constraint
 * (m620) admits, in the same order LANGUAGE_NAMES declares them (English
 * first). Every language-selector UI — the contact's own portal preference,
 * the agent-side contact edit — imports THIS, never re-enumerates the map.
 */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; name: string }> =
  Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))
