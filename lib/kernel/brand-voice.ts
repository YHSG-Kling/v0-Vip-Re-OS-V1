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

import { createHash } from "node:crypto"
import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
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

/** The scope a brand_voice_profile row (or the team's member_overrides_json) was read at. */
type BrandVoiceScopeName = "brokerage" | "team_overrides" | "team" | "agent"

interface ResolvedBrandVoice {
  tone: string | null
  formalityLevel: string | null
  keyBrandMessages: string[]
  prohibitedWords: string[]
  preferredWords: string[]
  tagline: string | null
  missionStatement: string | null
  // ── wave 151 (lane 151I) — the rest of what the live brand_voice_profile row says about HOW this sender writes. These
  //    columns existed (the Wave 36.5 distiller writes tone_examples from the agent's own published pieces) and no reader
  //    put them in front of a writer; the sender-voice brief below does. All optional-by-construction (an older fake
  //    client that returns a partial row still merges), most-specific scope wins, examples accumulate most-specific first.
  toneExamples: string[]
  writingStyleNotes: string | null
  customInstructions: string | null
  contentGuidelines: string | null
  brandPersonality: string | null
  style: string | null
  targetAudience: string | null
  /** Which scopes supplied a row (provenance for the brief's version + stamp). */
  scopes: BrandVoiceScopeName[]
  /** Which scope the resolved tagline came from. */
  taglineScope: BrandVoiceScopeName | null
}

const EMPTY_VOICE: ResolvedBrandVoice = {
  tone: null,
  formalityLevel: null,
  keyBrandMessages: [],
  prohibitedWords: [],
  preferredWords: [],
  tagline: null,
  missionStatement: null,
  toneExamples: [],
  writingStyleNotes: null,
  customInstructions: null,
  contentGuidelines: null,
  brandPersonality: null,
  style: null,
  targetAudience: null,
  scopes: [],
  taglineScope: null,
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function mergeVoice(base: ResolvedBrandVoice, override: Partial<ResolvedBrandVoice>, scope?: BrandVoiceScopeName): ResolvedBrandVoice {
  return {
    tone: override.tone ?? base.tone,
    formalityLevel: override.formalityLevel ?? base.formalityLevel,
    keyBrandMessages: override.keyBrandMessages?.length ? override.keyBrandMessages : base.keyBrandMessages,
    // Prohibited words accumulate — both levels apply
    prohibitedWords: Array.from(new Set([...base.prohibitedWords, ...(override.prohibitedWords ?? [])])),
    // Preferred words accumulate — both levels apply. The MORE SPECIFIC scope's words lead (wave 151I): a writer reading
    // the sender's brief sees the agent's own phrases before the brokerage's house phrases (a set either way for the gate).
    preferredWords: Array.from(new Set([...(override.preferredWords ?? []), ...base.preferredWords])),
    tagline: override.tagline ?? base.tagline,
    missionStatement: override.missionStatement ?? base.missionStatement,
    // The sender's own sentences come first — a more specific scope's examples lead the base's.
    toneExamples: Array.from(new Set([...(override.toneExamples ?? []), ...base.toneExamples])),
    writingStyleNotes: override.writingStyleNotes ?? base.writingStyleNotes,
    customInstructions: override.customInstructions ?? base.customInstructions,
    contentGuidelines: override.contentGuidelines ?? base.contentGuidelines,
    brandPersonality: override.brandPersonality ?? base.brandPersonality,
    style: override.style ?? base.style,
    targetAudience: override.targetAudience ?? base.targetAudience,
    scopes: scope ? [...base.scopes, scope] : base.scopes,
    taglineScope: override.tagline ? (scope ?? base.taglineScope) : base.taglineScope,
  }
}

const strOrUndef = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [])

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
    toneExamples: strList(row.tone_examples),
    writingStyleNotes: strOrUndef(row.writing_style_notes),
    customInstructions: strOrUndef(row.custom_instructions),
    contentGuidelines: strOrUndef(row.content_guidelines),
    brandPersonality: strOrUndef(row.brand_personality),
    style: strOrUndef(row.style),
    targetAudience: strOrUndef(row.target_audience),
  }
}

// ─── HIERARCHY LOADER ────────────────────────────────────────────────────────

/** The narrow client surface the core reads through — a cookie client, a service client or a
 *  test double all satisfy it. */
export type BrandVoiceReadClient = Pick<SupabaseClient, "from">

interface BrandVoiceScope {
  brokerageId: string
  teamId?: string
  actorUserId?: string
}

// Wave 151 (lane 151I): the seven voice columns the live row ALSO carries — read by the ONE cascade, so every reader
// of the resolved voice (and the sender-voice brief below) sees the sender's examples and notes, not a subset.
const BV_COLUMNS = "tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement, tone_examples, writing_style_notes, custom_instructions, content_guidelines, brand_personality, style, target_audience"

/**
 * THE CORE (lane 86C). Load and merge brand voice settings from all three scopes through the
 * client the caller hands it, with EVERY read pinned to `scope.brokerageId`.
 *
 * WHY A CLIENT SEAM. brand_voice_profile's one policy is `brokerage_id =
 * current_user_brokerage_id()` (live, 2026-09-27). The pre-86C loader built the COOKIE client
 * internally, so every sessionless caller — the voice webhook's stage creators
 * (lib/kernel/content-creators.ts), the sequence cron (lib/campaign-sequences/render-step.ts),
 * every cron that reaches evaluateOutbound — read as anon and got NO ROWS: the tenant's
 * prohibited words were never checked and the call reported "no violations". Degraded, never
 * refused, which is the silent shape CLAUDE.md §3 warns about.
 *
 * The session door (applyBrandVoice with no client) still reads through the cookie client, so
 * RLS keeps a signed-in caller inside its own tenant. The sessionless door lives in the
 * server-only module lib/kernel/tenant-config-reads.ts, which binds the SERVICE client and takes
 * the tenant from the caller's verified context. Both call this one function.
 *
 * Tenant pins the service client needs (RLS supplied them before): the team and agent profile
 * reads now carry `.eq("brokerage_id", …)`, and the agent scope reads an agents row only — the
 * pre-86C `agentRow?.id ?? actorUserId` fallback wrote a USERS id into an agents-class predicate
 * (CLAUDE.md §3: disjoint id spaces), which matched nothing at best.
 */
export async function resolveBrandVoiceCore(
  client: BrandVoiceReadClient,
  scope: BrandVoiceScope,
): Promise<ResolvedBrandVoice> {
  const { brokerageId, teamId, actorUserId } = scope
  let resolved: ResolvedBrandVoice = { ...EMPTY_VOICE }
  if (!brokerageId) return resolved

  const note = (what: string, error: { message?: string } | null | undefined) => {
    if (error) console.error(`[brand-voice] ${what} read refused — that scope's voice is NOT applied:`, error.message)
  }

  // ── 1. BROKERAGE LEVEL ───────────────────────────────────────────────────
  const { data: brokerageProfile, error: brokerageErr } = await client
    .from("brand_voice_profile")
    .select(BV_COLUMNS)
    .eq("brokerage_id", brokerageId)
    .is("agent_id", null)
    .is("team_id", null)
    .maybeSingle()
  note("brokerage brand_voice_profile", brokerageErr)
  if (brokerageProfile) {
    resolved = mergeVoice(resolved, rowToVoice(brokerageProfile), "brokerage")
  }

  // ── 2. TEAM LEVEL ────────────────────────────────────────────────────────
  // Teams store overrides in member_overrides_json (jsonb) at .brand_voice.
  if (teamId) {
    const { data: team, error: teamErr } = await client
      .from("teams")
      .select("member_overrides_json")
      .eq("id", teamId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    note("teams.member_overrides_json", teamErr)

    const teamBrandVoice = (team?.member_overrides_json as any)?.brand_voice
    if (teamBrandVoice) {
      resolved = mergeVoice(resolved, rowToVoice(teamBrandVoice), "team_overrides")
    }

    const { data: teamProfile, error: teamProfileErr } = await client
      .from("brand_voice_profile")
      .select(BV_COLUMNS)
      .eq("team_id", teamId)
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .maybeSingle()
    note("team brand_voice_profile", teamProfileErr)
    if (teamProfile) {
      resolved = mergeVoice(resolved, rowToVoice(teamProfile), "team")
    }
  }

  // ── 3. AGENT LEVEL ───────────────────────────────────────────────────────
  // actorUserId is a USERS id; brand_voice_profile.agent_id is agents-class. Cross via
  // agents.user_id inside this tenant, and read nothing when no agents row exists.
  if (actorUserId) {
    const { data: agentRow, error: agentErr } = await client
      .from("agents")
      .select("id")
      .eq("user_id", actorUserId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    note("agents", agentErr)

    const agentId = (agentRow as { id?: string } | null)?.id
    if (agentId) {
      const { data: agentProfile, error: agentProfileErr } = await client
        .from("brand_voice_profile")
        .select(BV_COLUMNS)
        .eq("agent_id", agentId)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      note("agent brand_voice_profile", agentProfileErr)
      if (agentProfile) {
        resolved = mergeVoice(resolved, rowToVoice(agentProfile), "agent")
      }
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

/** PURE. The sender's own formality setting against a text — exported (wave 151I) so the final phase can name a drift. */
export function checkFormalityViolations(content: string, formalityLevel: string): string[] {
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
  params: ApplyBrandVoiceParams,
  opts?: { client?: BrandVoiceReadClient },
): Promise<BrandVoiceResult> {
  // No client = the SESSION door: the cookie client, so RLS holds the caller to its own tenant.
  // A sessionless caller passes the service client through lib/kernel/tenant-config-reads.ts.
  const client: BrandVoiceReadClient = opts?.client ?? (await createClient())
  const voice = await resolveBrandVoiceCore(client, {
    brokerageId: params.brokerageId,
    teamId: params.teamId,
    actorUserId: params.actorUserId,
  })

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

// ═════════════════════════════════════════════════════════════════════════════
// THE SENDER-VOICE BRIEF (wave 151, lane 151I — owner, verbatim: "AI takes the user's added words, tagline, from their
// settings, and creates the copy from the user's tone and word choices so it helps to have the copy sound like the user
// and humanized — but gear it to them (contact or geared audience persona) first methodology.")
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS. ONE versioned description of how THIS sender writes, compiled from the sender's APPROVED settings and
// AUTHORIZED writing examples — never from a guess. It is handed to a writer BEFORE the first draft (the copy engine
// lib/kernel/ai-copy.ts, the AI-agent cascade lib/ai-isa/brand-voice-prompt.ts, the pipeline lib/ai/pipeline.ts, the
// Managed-Agent kickoff lib/agents/brokerage-context.ts, the video-script gate lib/video/script-compliance.ts, the content
// creators, ads, books, lead magnets, podcasts, client education). Humanization is NOT a rewrite of generic copy.
//
// WHY HERE. This file is THE brand-voice reader (resolveBrandVoiceCore — the brokerage → team → agent cascade, every read
// tenant-pinned, every refusal read). The brief is that cascade widened to the rest of what the settings say (the
// sender's own sentences, style notes, signature, positioning, local areas) and VERSIONED, not a second reader (LAW 2):
// lib/ai/pipeline.ts's private three-row read now delegates here (its tombstone names this function).
//
// WHAT IT NEVER DOES. It never pretends to know unstated vocabulary: a sender with no writing sample gets the settings
// they actually set and the explicit line NO_WRITING_SAMPLE_LINE; a refused read is NAMED in `readErrors` (the brief says
// what it could not see — it does not fill the gap). It never carries legal text — required disclosures ride the final
// phase's `verbatim`/`disclosures` (lib/marketing/humanize-final.ts) and go out word for word.
//
// VERSION. `version` is `v<schema>:<sha12>` over every setting the brief was compiled from; a changed tagline, a new
// signature or a new approved example is a new version. The stamp (voiceSourceStamp) is what a produced asset records
// (distribution_finals.findings.voice_source) beside who asked for it, which tenant, and its approval status.
// ═════════════════════════════════════════════════════════════════════════════

const SENDER_VOICE_BRIEF_SCHEMA = 1 as const

interface SenderVoiceWritingSample {
  text: string
  /** Where the sentence came from: the sender's own approved edit, or the distilled examples from their published pieces. */
  source: string
}

export interface SenderVoiceBrief {
  schema: typeof SENDER_VOICE_BRIEF_SCHEMA
  /** `v1:<sha12>` — a hash of every setting the brief was compiled from; a changed setting is a new version. */
  version: string
  compiledAt: string
  scope: { brokerageId: string; teamId: string | null; agentUserId: string | null; agentId: string | null }
  sender: { name: string | null; brandName: string | null; teamName: string | null; level: "agent" | "team" | "brokerage" }
  tone: string | null
  formality: string | null
  personality: string | null
  style: string | null
  tagline: string | null
  taglineSource: "agent" | "team" | "brokerage" | null
  missionStatement: string | null
  keyMessages: string[]
  /** Words and phrases the sender STATED they use (brand_voice_profile.preferred_words at every scope). Never inferred. */
  preferredWords: string[]
  prohibitedWords: string[]
  /** The signature the ONE email assembler appends (users.email_signature → team → brokerage) — plain text, so a writer knows not to draft a second one. */
  signature: { text: string | null; source: "user" | "team" | "brokerage" | null }
  writingSamples: SenderVoiceWritingSample[]
  hasWritingSample: boolean
  styleNotes: string | null
  customInstructions: string | null
  contentGuidelines: string | null
  targetAudience: string | null
  positioning: { bio: string | null; specializations: string[]; languages: string[]; licenseLine: string | null }
  localExpertise: { areas: string[]; cityState: string | null }
  identity: { personaLabel: string | null; followupStyle: string | null }
  /** Every setting the brief carries, as table.column@scope — the evidence the provenance stamp records. */
  sources: string[]
  /** Reads that were refused — the brief says what it could NOT see; it never guesses a voice. */
  readErrors: string[]
}

/** What a produced asset records about the voice it was written in (distribution_finals.findings.voice_source). */
export interface VoiceSourceStamp {
  schema: typeof SENDER_VOICE_BRIEF_SCHEMA
  version: string
  compiledAt: string
  scope: SenderVoiceBrief["scope"]
  sources: string[]
  hasWritingSample: boolean
  readErrors: string[]
}

const NO_WRITING_SAMPLE_LINE =
  "No writing sample is on file for this sender. Use ONLY the stated settings above; do not imitate a style you were not shown and do not invent signature phrases, slang or vocabulary for them."

/** The rows the brief reads beside the cascade (named types — a `typeof` on a `let x: T | null = null` narrows to null). */
interface AgentRowForBrief { id: string; user_id: string | null; team_id: string | null; bio: string | null; specializations: unknown; languages: unknown; license_number: string | null; license_state: string | null }
interface UserRowForBrief { first_name: string | null; last_name: string | null; email_signature: string | null; team_id: string | null }
interface TeamRowForBrief { name?: string | null; tagline?: string | null; branding_override?: Record<string, unknown> | null }
interface IdentityRowForBrief { persona_label?: string | null; followup_style?: string | null }

/** How long a compiled brief is reused in-process before the settings are re-read (a changed setting is a new version either way). */
const SENDER_VOICE_BRIEF_TTL_MS = 2 * 60 * 1000
const senderVoiceBriefCache = new Map<string, { brief: SenderVoiceBrief; expiresAt: number }>()

/** Drop cached briefs — for one tenant, or all (the pipeline's invalidateBrandVoiceCache calls this). */
export function invalidateSenderVoiceBriefCache(brokerageId?: string): void {
  if (!brokerageId) { senderVoiceBriefCache.clear(); return }
  for (const k of [...senderVoiceBriefCache.keys()]) if (k.startsWith(`${brokerageId}:`)) senderVoiceBriefCache.delete(k)
}

const plainText = (html: string | null | undefined) =>
  String(html ?? "").replace(/<(?:br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim() || null

/** PURE. The brief's content hash — over everything a writer is told, nothing that merely dates the compile. */
function briefVersion(b: Omit<SenderVoiceBrief, "version" | "compiledAt" | "readErrors">): string {
  const canonical = JSON.stringify(b, Object.keys(b).sort())
  return `v${SENDER_VOICE_BRIEF_SCHEMA}:${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12)}`
}

/** PURE. The provenance a produced asset records. */
export function voiceSourceStamp(b: SenderVoiceBrief): VoiceSourceStamp {
  return { schema: b.schema, version: b.version, compiledAt: b.compiledAt, scope: b.scope, sources: [...b.sources], hasWritingSample: b.hasWritingSample, readErrors: [...b.readErrors] }
}

/**
 * Load the sender-voice brief for a scope, through the client the caller holds (session client = RLS keeps the caller
 * in its tenant; a sessionless caller passes the service client and the tenant from its VERIFIED context — every read
 * here is pinned to `scope.brokerageId`). `agentUserId` is a users.id; `agentId` an agents.id (the two are disjoint,
 * CLAUDE.md §3) — each is read ONLY in its own predicate; a caller that cannot classify its token passes it in both
 * slots and the agents row that answers (by user_id, else by id) classifies it. Never throws: a refused read is NAMED in
 * readErrors and the brief is compiled from what WAS readable.
 */
export async function loadSenderVoiceBrief(
  client: BrandVoiceReadClient,
  scope: { brokerageId: string; teamId?: string | null; agentUserId?: string | null; agentId?: string | null },
  opts: { cache?: boolean; now?: Date } = {},
): Promise<SenderVoiceBrief> {
  const now = opts.now ?? new Date()
  const cacheKey = `${scope.brokerageId}:${scope.teamId ?? ""}:${scope.agentUserId ?? ""}:${scope.agentId ?? ""}`
  if (opts.cache !== false) {
    const hit = senderVoiceBriefCache.get(cacheKey)
    if (hit && hit.expiresAt > now.getTime()) return hit.brief
  }
  const readErrors: string[] = []
  const sources: string[] = []
  const refused = (what: string, error: { message?: string } | null | undefined) => {
    if (error) readErrors.push(`${what} read refused: ${error.message ?? "unknown"}`)
    return !!error
  }

  // ── the agent (users ⇄ agents, inside this tenant) ───────────────────────────────────────────
  // STRICT ID SPACES (CLAUDE.md §3): `agentUserId` is only ever a users.id (agents.user_id predicate), `agentId` only ever
  // an agents.id (agents.id predicate). A caller holding a token it cannot classify hands it to BOTH slots and the row that
  // answers classifies it — never one variable in two predicates.
  let agentUserId: string | null = scope.agentUserId ?? null
  let agentId: string | null = scope.agentId ?? null
  let agentRow: AgentRowForBrief | null = null
  const AGENT_COLS = "id, user_id, team_id, bio, specializations, languages, license_number, license_state"
  if (agentUserId) {
    const { data, error } = await client.from("agents").select(AGENT_COLS).eq("user_id", agentUserId).eq("brokerage_id", scope.brokerageId).maybeSingle()
    if (!refused("agents (by user)", error)) agentRow = (data as AgentRowForBrief | null) ?? null
  }
  if (!agentRow && agentId) {
    const { data, error } = await client.from("agents").select(AGENT_COLS).eq("id", agentId).eq("brokerage_id", scope.brokerageId).maybeSingle()
    if (!refused("agents (by id)", error)) agentRow = (data as AgentRowForBrief | null) ?? null
  }
  if (agentRow) { agentId = agentRow.id; agentUserId = agentRow.user_id ?? agentUserId }
  else if (agentUserId && agentId && agentUserId === agentId) { agentId = null } // one unclassifiable token, no agents row answered: it names no agent

  // ── the user (name, signature, team) ────────────────────────────────────────────────────────
  let userRow: UserRowForBrief | null = null
  if (agentUserId) {
    const { data, error } = await client.from("users").select("first_name, last_name, email_signature, team_id").eq("id", agentUserId).maybeSingle()
    if (!refused("users", error)) userRow = (data as UserRowForBrief | null) ?? null
  }
  const teamId = scope.teamId ?? userRow?.team_id ?? agentRow?.team_id ?? null

  // ── the voice cascade — THE ONE reader (brokerage base → team overlay → agent overlay) ─────────
  const voice = await resolveBrandVoiceCore(client, { brokerageId: scope.brokerageId, teamId: teamId ?? undefined, actorUserId: agentUserId ?? undefined })
  for (const s of voice.scopes) sources.push(`brand_voice_profile@${s === "brokerage" ? "brokerage base" : s === "agent" ? "agent overlay" : s === "team" ? "team overlay" : "team member_overrides"}`)

  // ── brokerage, team, brand settings, identity, territories ─────────────────────────────────
  const { data: bk, error: bkErr } = await client.from("brokerages").select("name, city, state").eq("id", scope.brokerageId).maybeSingle()
  refused("brokerages", bkErr)
  const brokerage = (bk ?? null) as { name?: string | null; city?: string | null; state?: string | null } | null

  let team: TeamRowForBrief | null = null
  if (teamId) {
    const { data, error } = await client.from("teams").select("name, tagline, branding_override").eq("id", teamId).eq("brokerage_id", scope.brokerageId).maybeSingle()
    if (!refused("teams", error)) team = (data as TeamRowForBrief | null) ?? null
  }
  const { data: bs, error: bsErr } = await client.from("brokerage_brand_settings").select("tagline, email_signature_html").eq("brokerage_id", scope.brokerageId).maybeSingle()
  refused("brokerage_brand_settings", bsErr)
  const brandSettings = (bs ?? null) as { tagline?: string | null; email_signature_html?: string | null } | null

  let identity: IdentityRowForBrief | null = null
  if (agentId) {
    const { data, error } = await client.from("ai_identity_profiles").select("persona_label, followup_style").eq("scope_type", "agent").eq("scope_id", agentId).eq("brokerage_id", scope.brokerageId).maybeSingle()
    if (!refused("ai_identity_profiles", error)) identity = (data as IdentityRowForBrief | null) ?? null
  }

  const areas: string[] = []
  if (agentId) {
    const { data, error } = await client.from("farm_territories").select("name, city, state, zip_codes").eq("brokerage_id", scope.brokerageId).eq("agent_id", agentId).eq("is_active", true).limit(8)
    if (!refused("farm_territories", error)) {
      for (const t of (data ?? []) as Array<{ name?: string | null; city?: string | null; state?: string | null; zip_codes?: unknown }>) {
        const zips = strList(t.zip_codes).slice(0, 6)
        const label = [t.name, [t.city, t.state].filter(Boolean).join(", "), zips.length ? `ZIPs ${zips.join(" ")}` : null].filter(Boolean).join(" — ")
        if (label) areas.push(label)
      }
      if (areas.length) sources.push("farm_territories@agent")
    }
  }

  // ── AUTHORIZED writing samples: the sender's OWN approved edits first, then the distilled examples ─
  const samples: SenderVoiceWritingSample[] = []
  if (agentUserId) {
    const { data, error } = await client.from("distribution_finals").select("final_text, authored_by, status")
      .eq("brokerage_id", scope.brokerageId).eq("created_by", agentUserId).eq("authored_by", "human").in("status", ["approved", "published"])
      .order("created_at", { ascending: false }).limit(3)
    if (!refused("distribution_finals (approved edits)", error)) {
      for (const r of (data ?? []) as Array<{ final_text?: string | null }>) {
        const t = plainText(r.final_text)
        if (t) samples.push({ text: t.slice(0, 240), source: "distribution_finals (the sender's own approved edit)" })
      }
      if (samples.length) sources.push("distribution_finals.final_text@agent(human, approved)")
    }
  }
  for (const ex of voice.toneExamples.slice(0, 4)) samples.push({ text: ex.slice(0, 240), source: "brand_voice_profile.tone_examples (distilled from the sender's published pieces)" })
  if (voice.toneExamples.length) sources.push("brand_voice_profile.tone_examples")

  // ── the signature — the same waterfall the ONE email assembler walks (user → team → brokerage) ─
  let signature: SenderVoiceBrief["signature"] = { text: null, source: null }
  const userSig = plainText(userRow?.email_signature)
  const teamSig = plainText((team?.branding_override as { email_signature_html?: string } | null | undefined)?.email_signature_html)
  const brokerageSig = plainText(brandSettings?.email_signature_html)
  if (userSig) { signature = { text: userSig, source: "user" }; sources.push("users.email_signature") }
  else if (teamSig) { signature = { text: teamSig, source: "team" }; sources.push("teams.branding_override.email_signature_html") }
  else if (brokerageSig) { signature = { text: brokerageSig, source: "brokerage" }; sources.push("brokerage_brand_settings.email_signature_html") }

  // ── the tagline — the cascade's answer, then the team's, then the brand settings' (resolveBrandContext's order) ─
  let tagline: string | null = voice.tagline?.trim() || null
  let taglineSource: SenderVoiceBrief["taglineSource"] = tagline ? (voice.taglineScope === "agent" ? "agent" : voice.taglineScope === "team" || voice.taglineScope === "team_overrides" ? "team" : "brokerage") : null
  if (!tagline && team?.tagline?.trim()) { tagline = team.tagline.trim(); taglineSource = "team"; sources.push("teams.tagline") }
  if (!tagline && brandSettings?.tagline?.trim()) { tagline = brandSettings.tagline.trim(); taglineSource = "brokerage"; sources.push("brokerage_brand_settings.tagline") }
  if (tagline && voice.tagline) sources.push(`brand_voice_profile.tagline@${taglineSource}`)

  for (const [k, v] of [["tone", voice.tone], ["formality_level", voice.formalityLevel], ["preferred_words", voice.preferredWords.length ? "set" : null], ["prohibited_words", voice.prohibitedWords.length ? "set" : null], ["key_brand_messages", voice.keyBrandMessages.length ? "set" : null], ["mission_statement", voice.missionStatement], ["writing_style_notes", voice.writingStyleNotes], ["custom_instructions", voice.customInstructions], ["content_guidelines", voice.contentGuidelines], ["brand_personality", voice.brandPersonality], ["style", voice.style], ["target_audience", voice.targetAudience]] as const) {
    if (v) sources.push(`brand_voice_profile.${k}`)
  }
  if (agentRow?.bio) sources.push("agents.bio")
  if (strList(agentRow?.specializations).length) sources.push("agents.specializations")
  if (strList(agentRow?.languages).length) sources.push("agents.languages")
  if (agentRow?.license_number && agentRow?.license_state) sources.push("agents.license_number/license_state")
  if (identity?.persona_label || identity?.followup_style) sources.push("ai_identity_profiles@agent")

  const name = userRow ? [userRow.first_name, userRow.last_name].filter(Boolean).join(" ").trim() || null : null
  const body: Omit<SenderVoiceBrief, "version" | "compiledAt" | "readErrors"> = {
    schema: SENDER_VOICE_BRIEF_SCHEMA,
    scope: { brokerageId: scope.brokerageId, teamId, agentUserId, agentId },
    sender: { name, brandName: brokerage?.name?.trim() || null, teamName: team?.name?.trim() || null, level: agentRow || agentUserId ? "agent" : teamId ? "team" : "brokerage" },
    tone: voice.tone, formality: voice.formalityLevel, personality: voice.brandPersonality, style: voice.style,
    tagline, taglineSource, missionStatement: voice.missionStatement,
    keyMessages: [...voice.keyBrandMessages], preferredWords: [...voice.preferredWords], prohibitedWords: [...voice.prohibitedWords],
    signature, writingSamples: samples, hasWritingSample: samples.length > 0,
    styleNotes: voice.writingStyleNotes, customInstructions: voice.customInstructions, contentGuidelines: voice.contentGuidelines, targetAudience: voice.targetAudience,
    positioning: {
      bio: agentRow?.bio?.trim() || null, specializations: strList(agentRow?.specializations), languages: strList(agentRow?.languages),
      licenseLine: agentRow?.license_number && agentRow?.license_state ? `${String(agentRow.license_state).toUpperCase()} License # ${agentRow.license_number}` : null,
    },
    localExpertise: { areas, cityState: [brokerage?.city, brokerage?.state].filter(Boolean).join(", ") || null },
    identity: { personaLabel: identity?.persona_label ?? null, followupStyle: identity?.followup_style ?? null },
    sources: [...new Set(sources)],
  }
  const brief: SenderVoiceBrief = { ...body, version: briefVersion(body), compiledAt: now.toISOString(), readErrors }
  if (opts.cache !== false) senderVoiceBriefCache.set(cacheKey, { brief, expiresAt: now.getTime() + SENDER_VOICE_BRIEF_TTL_MS })
  return brief
}

/**
 * PURE. The brief as the writer reads it — the FIRST block of a system prompt, before any rule or task. Deterministic for
 * a given brief (the same version renders the same text). Says only what the settings say; names what was not readable.
 */
export function renderSenderVoiceBrief(b: SenderVoiceBrief): string {
  const who = b.sender.name ?? b.sender.teamName ?? b.sender.brandName ?? "the sender"
  const lines: string[] = [
    `SENDER VOICE BRIEF ${b.version} — write AS this sender from the first word. This is who is speaking; it is not a polish step and the reader is never told an AI wrote it.`,
    `Sender: ${who}${b.sender.brandName && who !== b.sender.brandName ? ` · ${b.sender.brandName}` : ""}${b.sender.teamName && who !== b.sender.teamName ? ` · team: ${b.sender.teamName}` : ""} (${b.sender.level} voice)`,
  ]
  const voiceBits = [b.tone ? `Tone: ${b.tone}` : null, b.formality ? `Formality: ${b.formality}` : null, b.personality ? `Personality: ${b.personality}` : null, b.style ? `Style: ${b.style}` : null].filter(Boolean)
  lines.push(voiceBits.length ? voiceBits.join(" · ") : "Tone and formality: not set by the sender — plain, warm and specific; do not invent a persona.")
  lines.push(b.preferredWords.length ? `Their words and phrases (use them where they fit naturally; never force or pile them up): ${b.preferredWords.join(", ")}` : "Their words and phrases: none stated — use plain language; do not invent catchphrases for them.")
  if (b.prohibitedWords.length) lines.push(`Never use (their own list): ${b.prohibitedWords.join(", ")}`)
  lines.push(b.tagline ? `Tagline (exact wording or not at all; the final phase places it): "${b.tagline}"` : "Tagline: none set — do not invent one.")
  lines.push(b.signature.text
    ? `Signature: the system appends the sender's signature after the body — do NOT write one; end at the closing line. On file: "${b.signature.text.split("\n")[0].slice(0, 80)}${b.signature.text.includes("\n") || b.signature.text.length > 80 ? "…" : ""}"`
    : "Signature: do NOT draft one — the system appends the sender's signature when one is set.")
  if (b.missionStatement) lines.push(`What they stand for: ${b.missionStatement}`)
  if (b.keyMessages.length) lines.push(`Key messages (reinforce where natural, never as a list): ${b.keyMessages.join(" | ")}`)
  if (b.hasWritingSample) {
    lines.push("How they write — their own sentences (match the rhythm, length and word choice; never copy a sentence):")
    for (const s of b.writingSamples.slice(0, 5)) lines.push(`  · "${s.text}" (${s.source})`)
  } else {
    lines.push(NO_WRITING_SAMPLE_LINE)
  }
  if (b.styleNotes) lines.push(`Writing notes from their settings: ${b.styleNotes}`)
  if (b.customInstructions) lines.push(`Their standing instructions: ${b.customInstructions}`)
  if (b.contentGuidelines) lines.push(`Their content guidelines: ${b.contentGuidelines}`)
  if (b.targetAudience) lines.push(`Who they write for (their stated audience): ${b.targetAudience}`)
  const positioning = [b.positioning.licenseLine, b.positioning.bio, b.positioning.specializations.length ? `specializes in ${b.positioning.specializations.join(", ")}` : null, b.positioning.languages.length ? `speaks ${b.positioning.languages.join(", ")}` : null].filter(Boolean)
  if (positioning.length) lines.push(`Professional positioning you may state as fact (nothing beyond it): ${positioning.join(" · ")}`)
  if (b.localExpertise.areas.length || b.localExpertise.cityState) lines.push(`Local expertise (the areas they actually serve — never a claim about who lives there): ${[...b.localExpertise.areas, b.localExpertise.cityState].filter(Boolean).join("; ")}`)
  if (b.identity.personaLabel || b.identity.followupStyle) lines.push(`Their AI identity settings: ${[b.identity.personaLabel ? `persona "${b.identity.personaLabel}"` : null, b.identity.followupStyle ? `follow-up style ${b.identity.followupStyle}` : null].filter(Boolean).join(", ")}`)
  lines.push(`Voice sources: ${b.sources.length ? b.sources.join(", ") : "none readable — brokerage name only"} (${b.scope.agentUserId ? "brokerage base + team overlay + agent overlay" : b.scope.teamId ? "brokerage base + team overlay" : "brokerage base"}).`)
  if (b.readErrors.length) lines.push(`Settings that could NOT be read (do not guess them): ${b.readErrors.join("; ")}`)
  lines.push("Legal and required disclosure text is not yours to write — it is added word for word by the final phase.")
  return lines.join("\n")
}
