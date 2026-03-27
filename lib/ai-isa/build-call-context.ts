'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'

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
  const [personRow, agentRow, identityRows, brandVoice] = await Promise.all([
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

    params.agentId
      ? supabase
          .from('agents')
          .select('first_name, last_name')
          .eq('id', params.agentId)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),

    supabase
      .from('ai_identity_profiles')
      .select(
        'scope_type, scope_id, assistant_name, persona_label, tone, formality_level, ' +
          'faq_knowledge, objection_library, escalation_rules, prohibited_language, ' +
          'voice_provider, elevenlabs_voice_id, voice_stability, voice_similarity_boost'
      )
      .eq('brokerage_id', params.brokerageId)
      .eq('active', true)
      .then((r) => r.data ?? []),

    loadBrandVoicePrompt({
      brokerageId: params.brokerageId,
      agentId: params.agentId ?? null,
      teamId: params.teamId ?? null,
    }),
  ])

  // ── Hard blocks ────────────────────────────────────────────────────────────
  if (!personRow) return { ...BLOCKED_EMPTY, blockReason: 'contact_not_found' }
  if (personRow.call_stop_flag) return { ...BLOCKED_EMPTY, blockReason: 'call_stop_flag' }

  // ── Resolve identity: agent > team > brokerage ─────────────────────────────
  const SCOPE_ORDER: Record<string, number> = { agent: 0, team: 1, brokerage: 2 }
  const scopeIds = [params.agentId, params.teamId, params.brokerageId].filter(Boolean)
  const identity =
    (identityRows as any[])
      .filter((i) => scopeIds.includes(i.scope_id))
      .sort(
        (a, b) => (SCOPE_ORDER[a.scope_type] ?? 9) - (SCOPE_ORDER[b.scope_type] ?? 9)
      )[0] ?? null

  // ── Resolve display values ─────────────────────────────────────────────────
  const assistantName = identity?.assistant_name ?? brandVoice.assistantName ?? 'your real estate assistant'
  const tone = brandVoice.tone ?? identity?.tone ?? 'professional'
  const formality = brandVoice.formalityLevel ?? identity?.formality_level ?? 'semi_formal'
  const agentFirstName = agentRow?.first_name ?? 'your agent'
  const agentFullName = [agentRow?.first_name, agentRow?.last_name].filter(Boolean).join(' ')
  const contactFirstName = (personRow as any).first_name ?? 'there'
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
  const systemPrompt = [
    `You are ${assistantName}, an AI real estate assistant calling on behalf of ${agentFullName}.`,
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

  return {
    blocked: false,
    assistantName,
    personaLabel: identity?.persona_label ?? brandVoice.personaLabel ?? 'AI Real Estate Specialist',
    firstMessage: `Hi ${contactFirstName}, this is ${assistantName} reaching out on behalf of ${agentFirstName}. Do you have just a moment?`,
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
    voiceConfig: identity?.elevenlabs_voice_id
      ? {
          provider: identity.voice_provider ?? 'elevenlabs',
          voiceId: identity.elevenlabs_voice_id,
          stability: identity.voice_stability ?? 0.7,
          similarityBoost: identity.voice_similarity_boost ?? 0.8,
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
