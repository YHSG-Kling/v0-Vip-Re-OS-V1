// lib/contacts/accessibility-preferences.ts
//
// ACCESSIBILITY PREFERENCES — WHAT THE PERSON SAID THEY NEED (wave 145, lane 145H; owner ruling 18, 2026-10-27:
// "Should be added as fields if important and necessary." — explicit, user-controllable fields with real readers AND
// writers; never inferred from age or demographics). Contract C3: lane E's welcome composition and this lane's
// education delivery read them through `readAccessibilityPreferences` ONLY.
//
// WHERE IT LIVES. `contacts.accessibility_preferences` (jsonb, m868), held by the CHECK function
// `contact_accessibility_preferences_valid` whose arrays equal the vocabulary below (scripts/accessibility-preferences-
// guard.ts holds the two equal). LANGUAGE is NOT stored here: `contacts.preferred_language` (m620's CHECK, the ONE
// language vocabulary at lib/video/language-vocabulary.ts) is the survivor, and this module reads and writes it through
// that vocabulary instead of opening a second language field (CLAUDE.md §6).
//
// WHO WRITES. Exactly two doors (app/actions/contacts/accessibility-preferences.ts): the contact themselves in the
// portal, and an agent / staff member AT THE CONTACT'S REQUEST (the door refuses a staff write that does not attest
// the request). Each write stamps field provenance (THE store, lib/enrichment/field-provenance-store.ts) with who set
// it. Nothing else writes the column — no enrichment, no import, no model.
//
// NEVER INFERRED. This module has no input but the person's own statement. It reads no age, birthday, age band,
// generation, income or any other demographic column, and it never derives a disability from anything. "Nothing
// stated" is its own answer (`stated: false`) and maps to ONE default for everyone — never to a band's guess.
//
// WHO READS (each field has a reader; a field without one is not added):
//   communication_format → education delivery (lib/agents/education-delivery-producer.ts — the lesson's format;
//                          lib/kernel/education.ts — the plan's primary format) and lane E's welcome composition.
//   captions / transcript → the education producer (recorded on the assignment and told to the human approver beside
//                          the lesson reel) and lane E's welcome video.
//   text_size / high_contrast / reduce_motion → the client portal's display (app/portal/[contactId]/layout.tsx via
//                          portalDisplayFor); reduce_motion also keeps lesson video from auto-playing.
//   portal_modality      → the education plan's presentation (screen_reader → text-first with transcripts, never
//                          auto-play; audio → narrated video first).
//
// Pure except `readAccessibilityPreferences` / `writeAccessibilityPreferences`. No "server-only" import: the education
// producer imports this module and its proofs run without the react-server condition; the writer reaches the
// server-only provenance store through a dynamic import.

import type { SupabaseClient } from "@supabase/supabase-js"
import { localeToElevenLabsLanguage } from "@/lib/video/language-vocabulary"

type Svc = SupabaseClient<any, any, any>

// ── THE VOCABULARY (ONE spelling — m868's CHECK function holds the same arrays) ─────────────────────────────────

export const COMMUNICATION_FORMATS = ["text", "video", "audio"] as const
export type CommunicationFormat = (typeof COMMUNICATION_FORMATS)[number]

export const TEXT_SIZES = ["standard", "large", "extra_large"] as const
export type TextSize = (typeof TEXT_SIZES)[number]

export const PORTAL_MODALITIES = ["standard", "screen_reader", "audio"] as const
export type PortalModality = (typeof PORTAL_MODALITIES)[number]

/** The boolean fields. */
export const ACCESSIBILITY_FLAGS = ["captions", "transcript", "high_contrast", "reduce_motion"] as const
export type AccessibilityFlag = (typeof ACCESSIBILITY_FLAGS)[number]

/** Every key the column may hold — the CHECK refuses any other. */
export const ACCESSIBILITY_PREFERENCE_KEYS = ["communication_format", "text_size", "portal_modality", ...ACCESSIBILITY_FLAGS] as const
type AccessibilityPreferenceKey = (typeof ACCESSIBILITY_PREFERENCE_KEYS)[number]

/** What the person stated. Every field is optional: an absent field was not stated. */
export interface AccessibilityPreferences {
  communication_format?: CommunicationFormat
  text_size?: TextSize
  portal_modality?: PortalModality
  captions?: boolean
  transcript?: boolean
  high_contrast?: boolean
  reduce_motion?: boolean
}

export const COMMUNICATION_FORMAT_LABEL: Record<CommunicationFormat, string> = {
  text: "Written (email / text)", video: "Video", audio: "Audio / voice",
}
export const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  standard: "Standard", large: "Large", extra_large: "Extra large",
}
export const PORTAL_MODALITY_LABEL: Record<PortalModality, string> = {
  standard: "Standard", screen_reader: "Screen reader friendly (text first, no auto-play)", audio: "Listen (narrated content first)",
}
export const ACCESSIBILITY_FLAG_LABEL: Record<AccessibilityFlag, string> = {
  captions: "Captions on videos", transcript: "A written transcript with videos and audio",
  high_contrast: "Higher contrast in the portal", reduce_motion: "Reduce motion (no auto-play or animation)",
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v)

/** The option lists a settings form renders, built from the ONE vocabulary above (a "use client" form receives these as
 *  props from its server page, so it never retypes a value — CLAUDE.md §6). */
export interface AccessibilityOptionLists {
  formats: Array<{ value: CommunicationFormat; label: string }>
  textSizes: Array<{ value: TextSize; label: string }>
  modalities: Array<{ value: PortalModality; label: string }>
  flags: Array<{ value: AccessibilityFlag; label: string }>
}

/** PURE. The settings form's options (portal + CRM pages pass them to app/components/contact/AccessibilityPreferencesCard.tsx). */
export function accessibilityPreferenceOptions(): AccessibilityOptionLists {
  return {
    formats: COMMUNICATION_FORMATS.map((value) => ({ value, label: COMMUNICATION_FORMAT_LABEL[value] })),
    textSizes: TEXT_SIZES.map((value) => ({ value, label: TEXT_SIZE_LABEL[value] })),
    modalities: PORTAL_MODALITIES.map((value) => ({ value, label: PORTAL_MODALITY_LABEL[value] })),
    flags: ACCESSIBILITY_FLAGS.map((value) => ({ value, label: ACCESSIBILITY_FLAG_LABEL[value] })),
  }
}

/**
 * PURE. A stored / received value → the preferences it validly states. Unknown keys and out-of-vocabulary values are
 * DROPPED here (a READ must never fail on a legacy shape); the WRITE path uses `validateAccessibilityInput`, which
 * refuses them instead. Non-objects read as nothing stated. Module-private: every reader goes through
 * readAccessibilityPreferences (contract C3); the guard proves it through the read.
 */
function parseAccessibilityPreferences(raw: unknown): AccessibilityPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: AccessibilityPreferences = {}
  if (has(COMMUNICATION_FORMATS, r.communication_format)) out.communication_format = r.communication_format
  if (has(TEXT_SIZES, r.text_size)) out.text_size = r.text_size
  if (has(PORTAL_MODALITIES, r.portal_modality)) out.portal_modality = r.portal_modality
  for (const f of ACCESSIBILITY_FLAGS) if (typeof r[f] === "boolean") out[f] = r[f] as boolean
  return out
}

/** PURE. Whether the person stated anything at all. Module-private: readers get `stated` off the read / the adaptations. */
function accessibilityStated(p: AccessibilityPreferences): boolean {
  return Object.keys(p).length > 0
}

/** The write input: every field the door may set. `null` CLEARS a field (back to "not stated"). */
type AccessibilityInput = { [K in keyof AccessibilityPreferences]?: AccessibilityPreferences[K] | null } & {
  /** ISO 639-1 / BCP-47 language — written to contacts.preferred_language through THE language vocabulary. null clears. */
  language?: string | null
}

/**
 * PURE. Validate a write. FAILS CLOSED: an unknown key or a value outside the vocabulary refuses the WHOLE write
 * (a silently dropped field would read to the person as "saved" while nothing changed). Returns the merged next
 * preferences (current ⊕ input, null clears) and the normalized language when one was given. Module-private: the
 * writer below is its one caller (proved through the writer by scripts/accessibility-preferences-guard.ts).
 */
function validateAccessibilityInput(
  current: AccessibilityPreferences,
  input: unknown,
):
  | { ok: true; next: AccessibilityPreferences; changed: AccessibilityPreferenceKey[]; language?: { value: string | null } }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Nothing to save." }
  // The door's argument is attacker-controlled (a "use server" export) — typed as the declared input only AFTER the
  // unknown-key check below has run over every key it carries.
  const r = input as AccessibilityInput & Record<string, unknown>
  const allowed = new Set<string>([...ACCESSIBILITY_PREFERENCE_KEYS, "language"])
  const unknown = Object.keys(r).filter((k) => !allowed.has(k))
  if (unknown.length) return { ok: false, error: `Unknown accessibility field(s): ${unknown.join(", ")}` }
  const next: Record<string, unknown> = { ...current }
  const changed: AccessibilityPreferenceKey[] = []
  const setOrClear = (k: AccessibilityPreferenceKey, v: unknown, valid: boolean, label: string): string | null => {
    if (v === undefined) return null
    if (v === null) { if (k in next) { delete next[k]; changed.push(k) } return null }
    if (!valid) return `"${String(v)}" is not a valid ${label}.`
    if (next[k] !== v) { next[k] = v; changed.push(k) }
    return null
  }
  const errs = [
    setOrClear("communication_format", r.communication_format, has(COMMUNICATION_FORMATS, r.communication_format), "communication format"),
    setOrClear("text_size", r.text_size, has(TEXT_SIZES, r.text_size), "text size"),
    setOrClear("portal_modality", r.portal_modality, has(PORTAL_MODALITIES, r.portal_modality), "portal mode"),
    ...ACCESSIBILITY_FLAGS.map((f) => setOrClear(f, r[f], typeof r[f] === "boolean", ACCESSIBILITY_FLAG_LABEL[f].toLowerCase())),
  ].filter((e): e is string => !!e)
  if (errs.length) return { ok: false, error: errs[0] }
  let language: { value: string | null } | undefined
  if (r.language !== undefined) {
    if (r.language === null || r.language === "") language = { value: null }
    else {
      const mapped = typeof r.language === "string" ? localeToElevenLabsLanguage(r.language) : null
      if (!mapped) return { ok: false, error: `"${String(r.language)}" is not a supported language.` }
      language = { value: mapped }
    }
  }
  return { ok: true, next: parseAccessibilityPreferences(next), changed, ...(language ? { language } : {}) }
}

// ── THE ADAPTATIONS — what a reader does with the statement (one deterministic table, no model) ──────────────────

/**
 * What every reader applies. `stated: false` = the ONE default for everyone (the same delivery every client got
 * before this wave: a written guide first, no auto-play, standard text). Nothing here reads a person's age.
 */
export interface AccessibilityAdaptations {
  stated: boolean
  /** The format the person asked for, or null (= the material's own format). */
  format: CommunicationFormat | null
  captions: boolean
  transcript: boolean
  textSize: TextSize
  highContrast: boolean
  /** Never auto-play video / animate: reduce_motion, or a screen-reader portal. */
  noAutoplay: boolean
  modality: PortalModality
}

/** PURE. The statement → the adaptations every reader applies. A screen-reader portal implies a transcript and no auto-play. */
export function accessibilityAdaptations(p: AccessibilityPreferences | null | undefined): AccessibilityAdaptations {
  const prefs = p ?? {}
  const modality = prefs.portal_modality ?? "standard"
  return {
    stated: accessibilityStated(prefs),
    format: prefs.communication_format ?? null,
    captions: prefs.captions === true,
    transcript: prefs.transcript === true || modality === "screen_reader",
    textSize: prefs.text_size ?? "standard",
    highContrast: prefs.high_contrast === true,
    noAutoplay: prefs.reduce_motion === true || modality === "screen_reader",
    modality,
  }
}

/**
 * PURE. The client portal's display for the stated preferences — read by app/portal/[contactId]/layout.tsx. Text size
 * scales the whole portal (CSS zoom scales rem-based sizes too, unlike a font-size class); high contrast and reduced
 * motion are utility classes. Nothing stated → no class, no style: the portal renders exactly as before.
 */
export function portalDisplayFor(p: AccessibilityPreferences | null | undefined): { className: string; style: { zoom?: number } } {
  const a = accessibilityAdaptations(p)
  const classes: string[] = []
  if (a.highContrast) classes.push("contrast-125")
  if (a.noAutoplay) classes.push("[&_*]:animate-none!", "[&_*]:transition-none!")
  const zoom = a.textSize === "large" ? 1.125 : a.textSize === "extra_large" ? 1.25 : undefined
  return { className: classes.join(" "), style: zoom ? { zoom } : {} }
}

// ── THE READER (contract C3) ──────────────────────────────────────────────────────────────────────────────────

export type AccessibilityRead =
  | { ok: true; preferences: AccessibilityPreferences; stated: boolean; language: string | null }
  | { ok: false; error: string; notApplied?: boolean }

/**
 * THE reader (contract C3). Tenant-pinned (id AND brokerage_id — the caller's brokerage comes from its session or its
 * own tenant-verified row, never a body). A refused read is `ok:false`, never "nothing stated": a caller then uses the
 * default AND records that it could not look. Before m868 is applied the column is absent (42703 / PGRST204): that is
 * `ok:false, notApplied:true`.
 */
export async function readAccessibilityPreferences(svc: Svc, brokerageId: string, contactId: string): Promise<AccessibilityRead> {
  if (!brokerageId || !contactId) return { ok: false, error: "no brokerage / contact to read accessibility preferences for" }
  const { data, error } = await svc
    .from("contacts")
    .select("accessibility_preferences, preferred_language")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) {
    const code = String((error as { code?: string }).code ?? "")
    return { ok: false, error: `accessibility preferences could not be read: ${error.message}`, notApplied: code === "42703" || code === "PGRST204" }
  }
  if (!data) return { ok: false, error: "contact not found in this brokerage" }
  const row = data as { accessibility_preferences?: unknown; preferred_language?: string | null }
  const preferences = parseAccessibilityPreferences(row.accessibility_preferences)
  return { ok: true, preferences, stated: accessibilityStated(preferences), language: row.preferred_language ?? null }
}

// ── THE WRITER ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccessibilityWriter {
  userId: string
  /** 'contact' = the person in their own portal; 'staff_on_request' = an agent / staff member at the person's request. */
  kind: "contact" | "staff_on_request"
}

/**
 * THE writer. Called ONLY by the two gated doors (app/actions/contacts/accessibility-preferences.ts), which resolve the
 * tenant and the writer from the SESSION. Read-modify-write, tenant-pinned; the UPDATE is `.select()`ed and COUNTED
 * (an UPDATE matching nothing also resolves — CLAUDE.md §3). Provenance is stamped afterwards through THE store; a
 * provenance refusal is returned as a warning, never as a failed save (the value is already written).
 */
export async function writeAccessibilityPreferences(
  svc: Svc,
  args: { brokerageId: string; contactId: string; input: unknown; writer: AccessibilityWriter },
): Promise<{ ok: true; preferences: AccessibilityPreferences; changed: string[]; provenanceWarning?: string } | { ok: false; error: string }> {
  const { brokerageId, contactId, writer } = args
  if (!brokerageId || !contactId || !writer?.userId) return { ok: false, error: "missing tenant, contact or writer" }
  const current = await readAccessibilityPreferences(svc, brokerageId, contactId)
  if (!current.ok) {
    return { ok: false, error: current.notApplied ? "Accessibility preferences are not available yet (migration m868 is not applied) — nothing was saved." : current.error }
  }
  const v = validateAccessibilityInput(current.preferences, args.input)
  if (!v.ok) return v
  const patch: Record<string, unknown> = { accessibility_preferences: v.next, updated_at: new Date().toISOString() }
  const changed: string[] = [...v.changed]
  if (v.language && v.language.value !== current.language) { patch.preferred_language = v.language.value; changed.push("preferred_language") }
  if (changed.length === 0) return { ok: true, preferences: current.preferences, changed: [] }
  const { data: written, error } = await svc
    .from("contacts")
    .update(patch)
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) return { ok: false, error: `accessibility preferences were not saved: ${error.message}` }
  if (!written || written.length === 0) return { ok: false, error: "accessibility preferences were not saved — the contact is not in this brokerage" }

  let provenanceWarning: string | undefined
  try {
    const { stampFieldProvenance } = await import("@/lib/lead-pipeline/enrichment-column-map")
    const { persistFieldProvenance } = await import("@/lib/enrichment/field-provenance-store")
    const fields = ["accessibility_preferences", ...(changed.includes("preferred_language") ? ["preferred_language"] : [])]
    const prov = await persistFieldProvenance(svc, { table: "contacts", id: contactId, brokerageId },
      stampFieldProvenance(fields, {
        source: writer.kind === "contact" ? "contact" : "staff",
        capability: writer.kind === "contact" ? "contact.accessibility.self_edit" : "contact.accessibility.staff_on_request",
        purpose: writer.kind === "contact" ? "self_service" : "staff_edit",
        actor: writer.userId,
      }))
    if (!prov.ok) provenanceWarning = `provenance not recorded: ${prov.error}`
  } catch (e) {
    provenanceWarning = `provenance not recorded: ${(e as Error).message}`
  }
  return { ok: true, preferences: v.next, changed, ...(provenanceWarning ? { provenanceWarning } : {}) }
}
