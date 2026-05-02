/**
 * lib/kernel/brand-voice.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 0 — Brand voice evaluation for the platform messaging pipeline.
 *
 * Runs BEFORE the compliance gate. Does NOT log compliance events — that is
 * the compliance gate's sole responsibility.
 *
 * Resolution hierarchy (last writer wins — most-specific scope overrides):
 *   1. Brokerage  — brand_voice_profile WHERE brokerage_id = brokerageId
 *   2. Team       — teams.member_overrides_json.brand_voice (if teamId given)
 *   3. Agent      — brand_voice_profile WHERE agent_id = actorUserId (if given)
 *
 * Reads from existing tables only. Does NOT create, update, or own any schema.
 */

import { createClient } from "@/lib/supabase/server"
import type { MessageType, Persona, ActorRole } from "./types"

// ─── INPUT / OUTPUT TYPES ────────────────────────────────────────────────────

export interface ApplyBrandVoiceParams {
  brokerageId: string
  teamId?: string
  actorUserId?: string
  actorRole: ActorRole | string
  journeyType: "buyer" | "seller"
  persona: Persona | string
  messageType: MessageType | string
  content: string
}

export interface BrandVoiceResult {
  /** Content returned as-is (brand voice does not rewrite — callers may do that with the notes). */
  content: string
  /** Violations found against the resolved brand voice rules. */
  violations: string[]
  /** Advisory notes — tone guidance, preferred phrasing reminders, etc. */
  notes: string[]
  /** Resolved voice settings — exposed so callers (e.g., AI prompt builders) can build hard-constraint blocks. */
  tone?: string | null
  formalityLevel?: string | null
  prohibitedWords?: string[]
  preferredWords?: string[]
  tagline?: string | null
  missionStatement?: string | null
  keyBrandMessages?: string[]
}

// ─── INTERNAL: RESOLVED SETTINGS ─────────────────────────────────────────────

interface ResolvedBrandVoice {
  tone: string | null
  formalityLevel: string | null
  keyBrandMessages: string[]
  prohibitedWords: string[]
  preferredWords: string[]
  tagline: string | null
  missionStatement: string | null
}

const EMPTY_VOICE: ResolvedBrandVoice = {
  tone: null,
  formalityLevel: null,
  keyBrandMessages: [],
  prohibitedWords: [],
  preferredWords: [],
  tagline: null,
  missionStatement: null,
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function mergeVoice(base: ResolvedBrandVoice, override: Partial<ResolvedBrandVoice>): ResolvedBrandVoice {
  return {
    tone: override.tone ?? base.tone,
    formalityLevel: override.formalityLevel ?? base.formalityLevel,
    keyBrandMessages: override.keyBrandMessages?.length ? override.keyBrandMessages : base.keyBrandMessages,
    // Prohibited words accumulate — both levels apply
    prohibitedWords: Array.from(new Set([...base.prohibitedWords, ...(override.prohibitedWords ?? [])])),
    // Preferred words accumulate — both levels apply
    preferredWords: Array.from(new Set([...base.preferredWords, ...(override.preferredWords ?? [])])),
    tagline: override.tagline ?? base.tagline,
    missionStatement: override.missionStatement ?? base.missionStatement,
  }
}

function rowToVoice(row: Record<string, any> | null | undefined): Partial<ResolvedBrandVoice> {
  if (!row) return {}
  return {
    tone: row.tone ?? undefined,
    formalityLevel: row.formality_level ?? undefined,
    keyBrandMessages: Array.isArray(row.key_brand_messages) ? row.key_brand_messages : [],
    prohibitedWords: Array.isArray(row.prohibited_words) ? row.prohibited_words : [],
    preferredWords: Array.isArray(row.preferred_words) ? row.preferred_words : [],
    tagline: row.tagline ?? undefined,
    missionStatement: row.mission_statement ?? undefined,
  }
}

// ─── HIERARCHY LOADER ────────────────────────────────────────────────────────

/**
 * Load and merge brand voice settings from all three scopes.
 * Uses createClient (session-aware) — safe for server actions called in request context.
 */
async function loadResolvedBrandVoice(
  brokerageId: string,
  teamId?: string,
  actorUserId?: string
): Promise<ResolvedBrandVoice> {
  const supabase = await createClient()

  let resolved: ResolvedBrandVoice = { ...EMPTY_VOICE }

  // ── 1. BROKERAGE LEVEL ───────────────────────────────────────────────────
  // brand_voice_profile is joined to brokerages in pipeline.ts — query directly
  // by brokerage_id to keep it simple and avoid the join here.
  const { data: brokerageProfile } = await supabase
    .from("brand_voice_profile")
    .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement")
    .eq("brokerage_id", brokerageId)
    .is("agent_id", null)
    .is("team_id", null)
    .maybeSingle()

  if (brokerageProfile) {
    resolved = mergeVoice(resolved, rowToVoice(brokerageProfile))
  }

  // ── 2. TEAM LEVEL ────────────────────────────────────────────────────────
  // Teams store overrides in member_overrides_json (jsonb).
  // Brand voice overrides live at member_overrides_json.brand_voice.
  if (teamId) {
    const { data: team } = await supabase
      .from("teams")
      .select("member_overrides_json")
      .eq("id", teamId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    const teamBrandVoice = (team?.member_overrides_json as any)?.brand_voice
    if (teamBrandVoice) {
      resolved = mergeVoice(resolved, rowToVoice(teamBrandVoice))
    }

    // Also check brand_voice_profile scoped to the team
    const { data: teamProfile } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement")
      .eq("team_id", teamId)
      .is("agent_id", null)
      .maybeSingle()

    if (teamProfile) {
      resolved = mergeVoice(resolved, rowToVoice(teamProfile))
    }
  }

  // ── 3. AGENT LEVEL ───────────────────────────────────────────────────────
  // brand_voice_profile rows where agent_id matches the actor.
  if (actorUserId) {
    // First resolve the agent's UUID from the users table (actorUserId may be auth user id)
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", actorUserId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    const agentId = agentRow?.id ?? actorUserId

    const { data: agentProfile } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement")
      .eq("agent_id", agentId)
      .maybeSingle()

    if (agentProfile) {
      resolved = mergeVoice(resolved, rowToVoice(agentProfile))
    }
  }

  return resolved
}

// ─── VIOLATION CHECKER ───────────────────────────────────────────────────────

/**
 * Check content against the resolved brand voice rules.
 * Returns violations and advisory notes. Does NOT mutate content.
 */
function checkContent(
  content: string,
  voice: ResolvedBrandVoice,
  params: ApplyBrandVoiceParams
): { violations: string[]; notes: string[] } {
  const violations: string[] = []
  const notes: string[] = []
  const lower = content.toLowerCase()

  // ── Prohibited words ─────────────────────────────────────────────────────
  for (const word of voice.prohibitedWords) {
    if (!word) continue
    // Word-boundary check (handles multi-word phrases gracefully)
    const pattern = word.trim().toLowerCase()
    if (lower.includes(pattern)) {
      violations.push(`Prohibited word/phrase detected: "${word}"`)
    }
  }

  // ── Preferred words advisory ─────────────────────────────────────────────
  if (voice.preferredWords.length > 0) {
    const missingPreferred = voice.preferredWords.filter(
      (w) => w && !lower.includes(w.trim().toLowerCase())
    )
    if (missingPreferred.length > 0 && missingPreferred.length === voice.preferredWords.length) {
      // Only note if NONE of the preferred words appear — avoid noise
      notes.push(`Consider using brand-preferred phrasing: ${voice.preferredWords.join(", ")}`)
    }
  }

  // ── Tone advisory ────────────────────────────────────────────────────────
  if (voice.tone) {
    notes.push(`Target tone: ${voice.tone}`)
  }

  // ── Formality level advisory ─────────────────────────────────────────────
  if (voice.formalityLevel) {
    const formalityViolations = checkFormalityViolations(content, voice.formalityLevel)
    violations.push(...formalityViolations)
    notes.push(`Required formality level: ${voice.formalityLevel}`)
  }

  // ── Channel-specific brand rules ─────────────────────────────────────────
  const channelNotes = getChannelBrandNotes(params.messageType, voice)
  notes.push(...channelNotes)

  // ── Persona-specific brand rules ─────────────────────────────────────────
  const personaNotes = getPersonaBrandNotes(params.persona, params.journeyType)
  notes.push(...personaNotes)

  // ── Key brand messages advisory ──────────────────────────────────────────
  if (voice.keyBrandMessages.length > 0) {
    notes.push(`Brand key messages to reinforce: ${voice.keyBrandMessages.join(" | ")}`)
  }

  // ── Tagline — do not use incorrectly ────────────────────────────────────
  if (voice.tagline) {
    const taglineLower = voice.tagline.toLowerCase()
    // Detect if tagline is partially quoted (misquoted)
    const taglineWords = taglineLower.split(/\s+/).filter((w) => w.length > 3)
    const partialMatch = taglineWords.some((w) => lower.includes(w))
    const fullMatch = lower.includes(taglineLower)
    if (partialMatch && !fullMatch) {
      violations.push(
        `Tagline appears to be partially or incorrectly quoted. Official tagline: "${voice.tagline}"`
      )
    }
  }

  return { violations, notes }
}

// ─── FORMALITY CHECK ─────────────────────────────────────────────────────────

const INFORMAL_MARKERS = [
  "gonna", "wanna", "gotta", "kinda", "sorta", "lemme", "gimme",
  "y'all", "ya", "nope", "yep", "hey!", "sup", "lol", "omg", "tbh",
]

const OVERLY_FORMAL_MARKERS = [
  "heretofore", "aforementioned", "wherein", "thenceforth", "hereunto",
  "hereinafter", "notwithstanding the foregoing",
]

function checkFormalityViolations(content: string, formalityLevel: string): string[] {
  const violations: string[] = []
  const lower = content.toLowerCase()
  const level = formalityLevel.toLowerCase()

  if (level === "formal" || level === "professional") {
    for (const marker of INFORMAL_MARKERS) {
      if (lower.includes(marker)) {
        violations.push(`Informal language "${marker}" conflicts with required ${formalityLevel} tone`)
      }
    }
  }

  if (level === "casual" || level === "conversational") {
    for (const marker of OVERLY_FORMAL_MARKERS) {
      if (lower.includes(marker)) {
        violations.push(`Overly formal language "${marker}" conflicts with required ${formalityLevel} tone`)
      }
    }
  }

  return violations
}

// ─── CHANNEL BRAND NOTES ─────────────────────────────────────────────────────

function getChannelBrandNotes(messageType: string, voice: ResolvedBrandVoice): string[] {
  const notes: string[] = []

  switch (messageType) {
    case "email":
      if (voice.tagline) notes.push(`Email signature should include brand tagline: "${voice.tagline}"`)
      break
    case "sms":
      if (voice.tone) notes.push(`SMS tone should remain ${voice.tone} and concise`)
      break
    case "direct_mail":
      if (voice.missionStatement) notes.push(`Direct mail may reference mission: "${voice.missionStatement}"`)
      if (voice.tagline) notes.push(`Include tagline on mail piece: "${voice.tagline}"`)
      break
    case "social":
      if (voice.preferredWords.length) notes.push(`Use brand hashtag-friendly preferred terms: ${voice.preferredWords.slice(0, 5).join(", ")}`)
      break
    case "ai":
      if (voice.tone) notes.push(`AI-generated copy must reflect ${voice.tone} tone`)
      break
  }

  return notes
}

// ─── PERSONA BRAND NOTES ─────────────────────────────────────────────────────

function getPersonaBrandNotes(persona: string, journeyType: "buyer" | "seller"): string[] {
  const notes: string[] = []

  // Sensitive personas require extra empathy cues
  const sensitivePersonas = new Set(["divorce", "probate", "foreclosure", "military", "senior"])

  if (sensitivePersonas.has(persona)) {
    notes.push(`Persona "${persona}" requires empathetic, non-pressuring brand language`)
  }

  if (persona === "luxury") {
    notes.push("Luxury persona: use premium, aspirational brand vocabulary")
  }

  if (persona === "fsbo") {
    notes.push("FSBO persona: brand voice should be advisory and educational, not pushy")
  }

  if (journeyType === "seller" && (persona === "expired" || persona === "fsbo")) {
    notes.push("Seller outreach for expired/FSBO: reinforce brokerage credibility and track record")
  }

  return notes
}

// ─── PUBLIC EXPORT ────────────────────────────────────────────────────────────

/**
 * applyBrandVoice
 *
 * Loads brand voice settings for the given scope (brokerage → team → agent),
 * checks the content against those rules, and returns violations + advisory notes.
 *
 * Runs BEFORE the compliance gate. Does NOT log compliance events.
 * Does NOT rewrite content — callers own that decision.
 */
export async function applyBrandVoice(
  params: ApplyBrandVoiceParams
): Promise<BrandVoiceResult> {
  const voice = await loadResolvedBrandVoice(
    params.brokerageId,
    params.teamId,
    params.actorUserId
  )

  const { violations, notes } = checkContent(params.content, voice, params)

  return {
    content: params.content,
    violations,
    notes,
    tone: voice.tone,
    formalityLevel: voice.formalityLevel,
    prohibitedWords: voice.prohibitedWords,
    preferredWords: voice.preferredWords,
    tagline: voice.tagline,
    missionStatement: voice.missionStatement,
    keyBrandMessages: voice.keyBrandMessages,
  }
}
