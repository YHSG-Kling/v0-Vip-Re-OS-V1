// lib/ai-isa/build-call-context.ts
// Library service layer — NOT a Server Action entrypoint.
// Safe to import from both lib/ and app/actions/.

import { createServiceClient } from '@/lib/supabase/service'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import { resolveProvider } from '@/lib/kernel/providers'

export interface CallContext {
  blocked: boolean
  blockReason?: 'call_stop_flag' | 'dnc' | 'contact_not_found'
  assistantName: string
  personaLabel: string
  firstMessage: string
  systemPrompt: string
  temperature: number
  variables: Record<string, string>
  voiceConfig?: {
    provider: string
    voiceId: string
    stability: number
    similarityBoost: number
  }
  escalationRules: {
    escalateOnRequest: boolean
    escalateOnLegal: boolean
    escalateOnComplaint: boolean
    transferScript: string
  }
}

// ── Persona guidance injected into the system prompt ───────────────────────
const PERSONA_GUIDANCE: Record<string, string> = {
  first_time_buyer: 'Be warm, patient, educational. Major milestone for them.',
  investor: 'Be concise, data-driven. ROI and timeline over pleasantries.',
  luxury_buyer: 'Be sophisticated, never rushed. Quality over speed.',
  motivated_seller: 'Acknowledge their timeline. Net proceeds and certainty matter most.',
  downsizing_seller: 'Be empathetic. Emotional transition, not just a transaction.',
  relocating: 'Help with neighborhoods, schools, commute, local feel.',
  fsbo: 'Respectful, educational. Offer genuine value without pressure.',
  divorce: 'Professional, neutral, practical. Focus on immediate needs.',
}

// ── Purpose-specific scripts ────────────────────────────────────────────────
const PURPOSE_SCRIPTS: Record<string, (agentFirstName: string) => string> = {
  isa_qualification: (a) =>
    `Qualify naturally. Find: (1) actively looking or exploring? (2) budget? (3) timeline in months? (4) motivation? (5) spoken with lender? If qualified (motivated + within 6 months): invite to speak with ${a}. If not ready: agree follow-up time, end warmly. Never pressure.`,
  isa_followup: (a) =>
    `Brief follow-up. Check if timeline or situation changed. If ready: book consultation with ${a}.`,
  ghost_recovery: (_) =>
    'Warm re-engagement, no pressure. Ask if situation changed. Offer value. If not interested: respect immediately.',
  appointment_confirm: (a) =>
    `Confirm upcoming appointment with ${a}: date, time, format. Get advance questions.`,
  post_close: (a) =>
    `Warm post-closing check-in. Congratulate. Ask how the move is going. ${a} is their lifetime real estate resource.`,
}

// ── Blocked sentinel — returned early without further processing ─────────────
const BLOCKED_EMPTY: CallContext = {
  blocked: true,
  assistantName: '',
  personaLabel: '',
  firstMessage: '',
  systemPrompt: '',
  temperature: 0.65,
  variables: {},
  escalationRules: {
    escalateOnRequest: true,
    escalateOnLegal: true,
    escalateOnComplaint: false,
    transferScript: '',
  },
}

export async function buildCallContext(params: {
  brokerageId: string
  teamId?: string | null
  agentId?: string | null
  leadId?: string | null
  contactId?: string | null
  callPurpose:
    | 'isa_qualification'
    | 'isa_followup'
    | 'ghost_recovery'
    | 'appointment_confirm'
    | 'post_close'
}): Promise<CallContext> {
  const supabase = createServiceClient()

  // ── Parallel fetches ───────────────────────────────────────────────────────
  const [personRow, agentRow, identityRows, brandVoice, brokerageRow] = await Promise.all([
    // Prefer contact over lead — contact record has richer opt-out state
    params.contactId
      ? supabase
          .from('contacts')
          .select(
            'first_name, last_name, call_stop_flag, preferred_channel, contact_persona'
          )
          .eq('id', params.contactId)
          .maybeSingle()
          .then((r) => r.data)
      : params.leadId
      ? supabase
          .from('leads')
          .select(
            'first_name, last_name, call_stop_flag, preferred_channel, persona, lifecycle_state'
          )
          .eq('id', params.leadId)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),

    // DEFENSIVE IDENTITY RESOLVE — agentId is an agents.id, but a caller can mistakenly pass a
    // users.id (the exact bug that left a contact's call with no agent voice). Try agents.id
    // first; if that misses, fall back to a user_id lookup so the agent's cloned voice/avatar
    // still resolves instead of silently degrading to the generic brokerage voice.
    params.agentId
      ? (async () => {
          const sel = 'voice_id, users(first_name, last_name, email, phone)'
          const byId = await supabase.from('agents').select(sel).eq('id', params.agentId).maybeSingle().then((r) => r.data)
          if (byId) return byId
          return supabase.from('agents').select(sel).eq('user_id', params.agentId).maybeSingle().then((r) => r.data)
        })()
      : Promise.resolve(null),

    supabase
      .from('ai_identity_profiles')
      .select(
        'scope_type, scope_id, assistant_name, persona_label, tone, formality_level, ' +
          'faq_knowledge, objection_library, escalation_rules, prohibited_language, ' +
          'voice_provider, voice_mode, elevenlabs_voice_id'
      )
      .eq('brokerage_id', params.brokerageId)
      .eq('active', true)
      .then((r) => r.data ?? []),

    loadBrandVoicePrompt({
      brokerageId: params.brokerageId,
      agentId: params.agentId ?? null,
      teamId: params.teamId ?? null,
      // Extend the AI's knowledge to cover THIS contact on the voice rail too.
      contactId: params.contactId ?? undefined,
    }),

    // Brokerage row — name (display) + default_isa_voice_id (voice fallback)
    supabase
      .from('brokerages')
      .select('name, default_isa_voice_id')
      .eq('id', params.brokerageId)
      .maybeSingle()
      .then((r) => r.data),
  ])

  // ── Hard blocks ────────────────────────────────────────────────────────────
  if (!personRow) return { ...BLOCKED_EMPTY, blockReason: 'contact_not_found' }
  if (personRow.call_stop_flag) return { ...BLOCKED_EMPTY, blockReason: 'call_stop_flag' }

  // ── Resolve identity: pre-assignment vs post-assignment ────────────────────
  //
  // Pre-assignment (no agentId provided — ISA is qualifying a raw/unconsented
  // lead): identify as the BROKERAGE or TEAM. Voice mode must NOT be `clone`
  // here — projecting a specific agent's identity to someone who hasn't been
  // assigned to that agent yet is misleading and can violate disclosure rules.
  // Use 'front_office' (generic brokerage receptionist persona) or 'assistant'
  // (named virtual assistant) at the brokerage/team scope.
  //
  // Post-assignment (agentId provided — qualified lead now belongs to a
  // specific agent, OR existing contact's known agent): identify as the
  // ASSIGNED AGENT. Voice mode = 'clone' so the ISA speaks in the agent's
  // own cloned voice (per ElevenLabs voice clone setup).
  const SCOPE_ORDER: Record<string, number> = { agent: 0, team: 1, brokerage: 2 }
  const allScopeIds = [params.agentId, params.teamId, params.brokerageId].filter(Boolean)
  const isPreAssignment = !params.agentId
  const eligibleProfiles = (identityRows as any[]).filter((i) =>
    allScopeIds.includes(i.scope_id)
  )

  let identity: any = null
  if (isPreAssignment) {
    // Filter to non-clone profiles only; prefer team > brokerage scope
    const preAssignmentEligible = eligibleProfiles.filter(
      (i) => i.voice_mode === 'front_office' || i.voice_mode === 'assistant' || !i.voice_mode
    )
    identity =
      preAssignmentEligible.sort(
        (a, b) => (SCOPE_ORDER[a.scope_type] ?? 9) - (SCOPE_ORDER[b.scope_type] ?? 9)
      )[0] ?? null
  } else {
    // Post-assignment: prefer agent-scoped clone profile; fall back to team/brokerage
    identity =
      eligibleProfiles.sort(
        (a, b) => (SCOPE_ORDER[a.scope_type] ?? 9) - (SCOPE_ORDER[b.scope_type] ?? 9)
      )[0] ?? null
  }

  // ── Resolve display values ─────────────────────────────────────────────────
  const assistantName = identity?.assistant_name ?? brandVoice.assistantName ?? 'your real estate assistant'
  const tone = brandVoice.tone ?? identity?.tone ?? 'professional'
  const formality = brandVoice.formalityLevel ?? identity?.formality_level ?? 'semi_formal'
  const agentFirstName = (agentRow as any)?.users?.first_name ?? 'one of our agents'
  const agentFullName = [(agentRow as any)?.users?.first_name, (agentRow as any)?.users?.last_name].filter(Boolean).join(' ')
  const contactFirstName = (personRow as any).first_name ?? 'there'

  // Brokerage display name for pre-assignment intros (already loaded in parallel above)
  const brokerageName = (brokerageRow as any)?.name ?? 'our brokerage'
  // contacts use contact_persona; leads use persona
  const persona =
    (personRow as any).contact_persona ?? (personRow as any).persona ?? ''

  const prohibitedWords: string[] = [
    ...(brandVoice.prohibitedWords ?? []),
    ...((identity?.prohibited_language as string[]) ?? []),
  ]
  const faqs: any[] = (identity?.faq_knowledge as any[]) ?? brandVoice.faqKnowledge ?? []
  const objections: any[] = (identity?.objection_library as any[]) ?? brandVoice.objectionLibrary ?? []
  const escalation: any = identity?.escalation_rules ?? brandVoice.escalationRules ?? {}

  // ── Tone and formality guides ──────────────────────────────────────────────
  const toneGuide: Record<string, string> = {
    warm: 'Be genuinely warm and encouraging.',
    professional: 'Be professional, clear, and efficient.',
    conversational: 'Keep it relaxed and natural.',
    luxury: 'Be refined and sophisticated. Never rushed.',
    friendly: 'Be upbeat and approachable.',
  }
  const formalityGuide: Record<string, string> = {
    formal: 'Use formal language. Avoid contractions.',
    semi_formal: 'Professional but warm and approachable.',
    casual: 'Conversational. Contractions are fine.',
  }

  // ── Build system prompt ────────────────────────────────────────────────────
  // Identity disclosure changes based on assignment state:
  //   - Pre-assignment: identify as the brokerage's virtual assistant (NOT
  //     a specific agent — that agent hasn't been assigned yet)
  //   - Post-assignment: identify as calling on behalf of the assigned agent
  const identityLine = isPreAssignment
    ? `You are ${assistantName}, the virtual assistant for ${brokerageName}.`
    : `You are ${assistantName}, an AI real estate assistant calling on behalf of ${agentFullName}.`
  const systemPrompt = [
    identityLine,
    toneGuide[tone] ?? 'Be professional and helpful.',
    formalityGuide[formality] ?? 'Be professional.',
    persona && PERSONA_GUIDANCE[persona]
      ? `Contact context: ${PERSONA_GUIDANCE[persona]}`
      : '',
    '',
    'YOUR TASK:',
    (PURPOSE_SCRIPTS[params.callPurpose] ?? PURPOSE_SCRIPTS.isa_qualification)(agentFirstName),
    '',
    brandVoice.systemBlock || '',
    faqs.length > 0
      ? `\nFAQ:\n${faqs.map((f: any) => `Q: ${f.question}\nA: ${f.answer}`).join('\n')}`
      : '',
    objections.length > 0
      ? `\nOBJECTIONS:\n${objections
          .map((o: any) => `"${o.objection}" → ${o.response}`)
          .join('\n')}`
      : '',
    `\nAlways transfer if they ask for ${agentFirstName}.`,
    escalation.escalate_on_legal ? 'Escalate on legal/liability questions.' : '',
    prohibitedWords.length > 0
      ? `Never say: ${prohibitedWords.join(', ')}.`
      : '',
    'Never make price guarantees. Follow Fair Housing at all times.',
    'If they say stop calling or remove me: acknowledge, apologize, end immediately.',
  ]
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Voice VENDOR is platform-tier (system-only) — resolved once for the whole
  // app (superadmin override or the 'elevenlabs' default), never per-tenant. The
  // per-agent voice ASSET (elevenlabs_voice_id / agents.voice_id /
  // default_isa_voice_id) remains tenant-scoped below.
  const { providerKey: voiceVendor } = await resolveProvider({
    providerType: 'voice_clone',
    actorContext: { userId: '', brokerageId: params.brokerageId },
  })

  return {
    blocked: false,
    assistantName,
    personaLabel: identity?.persona_label ?? brandVoice.personaLabel ?? 'AI Real Estate Specialist',
    firstMessage: isPreAssignment
      ? `Hi ${contactFirstName}, this is ${assistantName} from ${brokerageName}. Do you have just a moment?`
      : `Hi ${contactFirstName}, this is ${assistantName} reaching out on behalf of ${agentFirstName}. Do you have just a moment?`,
    systemPrompt,
    temperature: ['luxury', 'authoritative'].includes(tone)
      ? 0.5
      : ['conversational', 'friendly'].includes(tone)
      ? 0.8
      : 0.65,
    variables: {
      assistant_name: assistantName,
      agent_first_name: agentFirstName,
      agent_full_name: agentFullName,
      contact_first_name: contactFirstName,
      contact_persona: persona,
    },
    // Voice resolution priority:
    //   1. Identity profile elevenlabs_voice_id (set via Voice & Avatar Setup) —
    //      most specific (agent → team → brokerage scope, picked above)
    //   2. agents.voice_id — the agent's own voice clone (post-assignment only;
    //      pre-assignment must NOT project a specific agent's identity)
    //   3. brokerages.default_isa_voice_id — brokerage's chosen ISA voice
    //      (covers pre-assignment and any case where neither above is set)
    //   4. undefined → VAPI uses its default voice (last resort)
    voiceConfig: identity?.elevenlabs_voice_id
      ? {
          provider: voiceVendor,
          voiceId: identity.elevenlabs_voice_id,
          stability: 0.7,
          similarityBoost: 0.8,
        }
      : !isPreAssignment && (agentRow as any)?.voice_id
      ? {
          provider: voiceVendor,
          voiceId: (agentRow as any).voice_id as string,
          stability: 0.7,
          similarityBoost: 0.8,
        }
      : (brokerageRow as any)?.default_isa_voice_id
      ? {
          provider: voiceVendor,
          voiceId: (brokerageRow as any).default_isa_voice_id as string,
          stability: 0.7,
          similarityBoost: 0.8,
        }
      : undefined,
    escalationRules: {
      escalateOnRequest: true,
      escalateOnLegal: escalation.escalate_on_legal ?? true,
      escalateOnComplaint: escalation.escalate_on_complaint ?? false,
      transferScript: `Let me connect you directly with ${agentFirstName}.`,
    },
  }
}
