/**
 * lib/ai-isa/brand-voice-prompt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the resolved brand voice profile AND ai_identity_profiles for a
 * brokerage/agent scope and returns a system-prompt block suitable for
 * injection into AI SDK generateText calls.
 *
 * Merge order (lowest → highest priority):
 *   brokerage brand_voice_profile
 *   → brokerage ai_identity_profile
 *   → team ai_identity_profile
 *   → agent brand_voice_profile
 *   → agent ai_identity_profile
 *
 * Used by: handle-inbound-email.ts, vapi webhook post-call follow-up
 */

import { createServiceClient } from "@/lib/supabase/service"
import { composeTeammateContext, isManagerKey } from "@/lib/kernel/ai-teammates"

export interface BrandVoicePromptContext {
  brokerageId: string
  agentId?: string | null
  teamId?: string | null
  /**
   * Which built-in manager's domain this draft belongs to — used to thread the
   * tenant's ACTIVE custom AI teammates (tenant_ai_teammates) whose base
   * manager covers that domain into the system block. Defaults to "ai_isa"
   * (every current caller is the ISA drafting rail: inbound email, engagement,
   * call context). Pass the owning manager key for other rails.
   */
  managerKey?: string
}

export interface BrandVoicePromptResult {
  /** Injected as a paragraph at the end of the base system prompt */
  systemBlock: string
  /** Raw values for use in other contexts */
  tone: string | null
  formalityLevel: string | null
  prohibitedWords: string[]
  preferredWords: string[]
  tagline: string | null
  /** From ai_identity_profiles — used by callers to address the AI */
  assistantName: string
  personaLabel: string | null
  faqKnowledge: Array<{ question: string; answer: string }>
  objectionLibrary: Array<{ objection: string; response: string; category: string }>
  escalationRules: Record<string, boolean>
  followupStyle: string
  /** The tenant's custom AI teammate answering for this domain, when one is
   *  chartered and active — callers may surface the name in attributions. */
  teammate: { name: string; roleTitle: string; baseManagerKey: string } | null
}

export async function loadBrandVoicePrompt(
  ctx: BrandVoicePromptContext
): Promise<BrandVoicePromptResult> {
  const supabase = createServiceClient()

  // ── Load brand_voice_profile (existing table) ─────────────────────────
  const { data: brokVoice } = await supabase
    .from("brand_voice_profile")
    .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement")
    .eq("brokerage_id", ctx.brokerageId)
    .is("agent_id", null)
    .is("team_id", null)
    .maybeSingle()

  let agentVoice: typeof brokVoice = null
  if (ctx.agentId) {
    const { data } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement")
      .eq("agent_id", ctx.agentId)
      .maybeSingle()
    agentVoice = data
  }

  // ── Load ai_identity_profiles (new table) ─────────────────────────────
  const scopeQueries = [
    supabase.from("ai_identity_profiles").select("*").eq("scope_type", "brokerage").eq("scope_id", ctx.brokerageId).maybeSingle(),
  ]
  if (ctx.teamId) {
    scopeQueries.push(
      supabase.from("ai_identity_profiles").select("*").eq("scope_type", "team").eq("scope_id", ctx.teamId).maybeSingle()
    )
  }
  if (ctx.agentId) {
    scopeQueries.push(
      supabase.from("ai_identity_profiles").select("*").eq("scope_type", "agent").eq("scope_id", ctx.agentId).maybeSingle()
    )
  }
  const identityResults = await Promise.all(scopeQueries)
  const [brokIdentity, teamIdentity, agentIdentity] = identityResults.map((r) => r.data)

  // ── Tenant-chartered AI teammates (tenant_ai_teammates) ────────────────
  // ACTIVE custom teammates whose base manager covers this draft's domain —
  // their charter is injected below so the tenant's own mandate genuinely
  // shapes the copy (paused/retired teammates never speak).
  const domainKey = ctx.managerKey ?? "ai_isa"
  type TeammateRow = { name: string; role_title: string; charter: string; focus_tags: string[] | null; base_manager_key: string }
  let domainTeammates: TeammateRow[] = []
  if (isManagerKey(domainKey)) {
    const { data: tmRows } = await supabase
      .from("tenant_ai_teammates")
      .select("name, role_title, charter, focus_tags, base_manager_key")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("status", "active")
      .eq("base_manager_key", domainKey)
      .order("created_at", { ascending: true })
      .limit(3)
    domainTeammates = (tmRows ?? []) as TeammateRow[]
  }

  // ── Merge: lower scopes override higher where non-null ─────────────────
  // Priority order: brokVoice < brokIdentity < teamIdentity < agentVoice < agentIdentity
  const resolvedTone =
    agentIdentity?.tone ??
    agentVoice?.tone ??
    teamIdentity?.tone ??
    brokIdentity?.tone ??
    brokVoice?.tone ??
    null

  const resolvedFormality =
    agentIdentity?.formality_level ??
    agentVoice?.formality_level ??
    teamIdentity?.formality_level ??
    brokIdentity?.formality_level ??
    brokVoice?.formality_level ??
    null

  const prohibitedWords: string[] = [
    ...(brokVoice?.prohibited_words ?? []),
    ...(brokIdentity?.prohibited_language ?? []),
    ...(teamIdentity?.prohibited_language ?? []),
    ...(agentVoice?.prohibited_words ?? []),
    ...(agentIdentity?.prohibited_language ?? []),
  ]

  const preferredWords: string[] = [
    ...(brokVoice?.preferred_words ?? []),
    ...(agentVoice?.preferred_words ?? []),
  ]

  const keyBrandMessages: string[] = [
    ...(brokVoice?.key_brand_messages ?? []),
    ...(agentVoice?.key_brand_messages ?? []),
  ]

  const tagline = agentVoice?.tagline ?? brokVoice?.tagline ?? null
  const missionStatement = agentVoice?.mission_statement ?? brokVoice?.mission_statement ?? null

  // Resolved identity values from ai_identity_profiles
  // A configured identity-profile name wins; otherwise the tenant's chartered
  // teammate for this domain lends its name before the generic fallback —
  // the AI team answers as THEIRS, not as "Your AI Assistant".
  const assistantName: string =
    agentIdentity?.assistant_name ??
    teamIdentity?.assistant_name ??
    brokIdentity?.assistant_name ??
    domainTeammates[0]?.name ??
    "Your AI Assistant"

  const personaLabel: string | null =
    agentIdentity?.persona_label ??
    teamIdentity?.persona_label ??
    brokIdentity?.persona_label ??
    domainTeammates[0]?.role_title ??
    null

  // Merge FAQs: parent + child (child appends)
  const faqKnowledge: Array<{ question: string; answer: string }> = [
    ...(brokIdentity?.faq_knowledge ?? []),
    ...(teamIdentity?.faq_knowledge ?? []),
    ...(agentIdentity?.faq_knowledge ?? []),
  ]

  const objectionLibrary: Array<{ objection: string; response: string; category: string }> = [
    ...(brokIdentity?.objection_library ?? []),
    ...(teamIdentity?.objection_library ?? []),
    ...(agentIdentity?.objection_library ?? []),
  ]

  // Escalation rules: most specific scope wins entirely if set
  const escalationRules: Record<string, boolean> =
    (agentIdentity?.escalation_rules && Object.keys(agentIdentity.escalation_rules).length > 0)
      ? agentIdentity.escalation_rules
      : (teamIdentity?.escalation_rules && Object.keys(teamIdentity.escalation_rules).length > 0)
      ? teamIdentity.escalation_rules
      : brokIdentity?.escalation_rules ?? {}

  const followupStyle: string =
    agentIdentity?.followup_style ??
    teamIdentity?.followup_style ??
    brokIdentity?.followup_style ??
    "warm_persistent"

  // ── Build system prompt block ─────────────────────────────────────────
  const parts: string[] = []

  parts.push(`You are ${assistantName}${personaLabel ? `, ${personaLabel}` : ""}.`)

  // The tenant's charters for this domain — injected ONCE here so every rail
  // that builds its prompt from this block (inbound email drafts, engagement
  // outreach, call context) genuinely composes under the teammate's mandate.
  for (const t of domainTeammates) {
    parts.push(composeTeammateContext({
      name: t.name,
      roleTitle: t.role_title,
      charter: t.charter,
      focusTags: t.focus_tags,
      baseManagerKey: t.base_manager_key,
    }))
  }

  if (resolvedTone) {
    parts.push(`Write in a ${resolvedTone} tone.`)
  }
  if (resolvedFormality) {
    parts.push(`Formality level: ${resolvedFormality.replace("_", "-")}.`)
  }
  if (tagline) {
    parts.push(`Brand tagline (use accurately or not at all): "${tagline}".`)
  }
  if (missionStatement) {
    parts.push(`Brand mission: "${missionStatement}".`)
  }
  if (preferredWords.length > 0) {
    parts.push(`Preferred vocabulary: ${preferredWords.join(", ")}.`)
  }
  if (prohibitedWords.length > 0) {
    parts.push(`NEVER use these words or phrases: ${prohibitedWords.join(", ")}.`)
  }
  if (keyBrandMessages.length > 0) {
    parts.push(`Reinforce these brand messages where natural: ${keyBrandMessages.join(" | ")}.`)
  }
  if (faqKnowledge.length > 0) {
    const faqBlock = faqKnowledge
      .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
      .join("\n\n")
    parts.push(`When relevant, use these FAQ answers:\n${faqBlock}`)
  }
  if (objectionLibrary.length > 0) {
    const objBlock = objectionLibrary
      .map((o) => `Objection (${o.category}): "${o.objection}" → Response: "${o.response}"`)
      .join("\n")
    parts.push(`Handle these objections with the prepared responses:\n${objBlock}`)
  }

  return {
    systemBlock: parts.join(" "),
    tone: resolvedTone,
    formalityLevel: resolvedFormality,
    prohibitedWords,
    preferredWords,
    tagline,
    assistantName,
    personaLabel,
    faqKnowledge,
    objectionLibrary,
    escalationRules,
    followupStyle,
    teammate: domainTeammates[0]
      ? { name: domainTeammates[0].name, roleTitle: domainTeammates[0].role_title, baseManagerKey: domainTeammates[0].base_manager_key }
      : null,
  }
}
