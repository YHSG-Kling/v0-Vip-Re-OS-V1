/**
 * lib/elevenlabs/conv-ai.ts
 *
 * ElevenLabs Conversational AI helpers — real-time voice assistant for staff
 * (the "on-the-go AI assistant" behind the floating mic FAB).
 *
 * Architecture:
 *   staff browser
 *      │  WebSocket, via @elevenlabs/client SDK
 *      ▼
 *   ElevenLabs Conv AI
 *      │  HTTPS webhook, per tool invocation
 *      ▼
 *   /api/agent-assistant/tool-call  ◄─── our kernel-OS-validated tools
 *
 * One Conv-AI agent is provisioned per real-estate-agent (cached on
 * agents.conv_ai_agent_id). System prompt is the agent's brand voice + a
 * standard "you are X's assistant" preamble. Tools are registered at agent
 * creation so ElevenLabs knows to call our webhook when it wants to act.
 *
 * The master ELEVENLABS_API_KEY never leaves the server. The browser SDK
 * connects with a short-lived signed_url issued from /v1/convai/conversation
 * /get_signed_url.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io"

export interface EnsureAssistantAgentParams {
  /** agents.id (NOT users.id) — the real-estate agent who owns this assistant. */
  agentId: string
  agentName: string
  /** ElevenLabs voice_id for the agent's cloned voice. Falls back to a default
   *  if not set. */
  voiceId?: string | null
  /** Brokerage / team / agent brand voice — appended to the base system prompt. */
  brandVoice?: string | null
}

export type EnsureAssistantAgentResult =
  | { ok: true; convAiAgentId: string; created: boolean }
  | { ok: false; error: string }

/**
 * Provision (or reuse) the ElevenLabs Conv-AI agent for a real-estate agent.
 * Caches the conv_ai_agent_id on agents.conv_ai_agent_id.
 *
 * Re-provisioning is rare — only when the cached id is missing OR when the
 * voice_id changes. We don't auto-update the agent's tools here; that's a
 * separate `syncAssistantTools()` flow when we add new tools.
 */
export async function ensureAssistantAgent(
  params: EnsureAssistantAgentParams,
): Promise<EnsureAssistantAgentResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY not configured" }

  const supabase = createServiceClient()

  // Cache hit?
  const { data: agentRow } = await supabase
    .from("agents")
    .select("conv_ai_agent_id")
    .eq("id", params.agentId)
    .maybeSingle()

  if (agentRow?.conv_ai_agent_id) {
    return { ok: true, convAiAgentId: agentRow.conv_ai_agent_id, created: false }
  }

  const systemPrompt = buildSystemPrompt(params)
  const toolsConfig = buildToolsConfig()
  const firstMessage = `Hey ${params.agentName.split(" ")[0]}, what can I help you with?`

  const body = {
    name: `${params.agentName} — On-the-Go Assistant`,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: {
          prompt: systemPrompt,
          // ElevenLabs routes the LLM through their gateway; we register tools
          // here so they call our webhook when the model wants to act.
          tools: toolsConfig,
        },
      },
      tts: {
        voice_id: params.voiceId ?? defaultVoiceId(),
        // Lower latency mode — staff want fast turn-taking, not high fidelity.
        optimize_streaming_latency: 3,
      },
    },
  }

  const res = await fetch(`${ELEVENLABS_API_BASE}/v1/convai/agents/create`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.agent_id) {
    return {
      ok: false,
      error: data?.detail?.message ?? data?.message ?? `ElevenLabs agent create failed (${res.status})`,
    }
  }

  // Persist the cache
  await supabase
    .from("agents")
    .update({ conv_ai_agent_id: data.agent_id })
    .eq("id", params.agentId)

  return { ok: true, convAiAgentId: data.agent_id, created: true }
}

// ─── Track C — Objection-training scenario agents ───────────────────────────

export interface EnsureScenarioAgentParams {
  scenarioKey: string
  scenarioLabel: string
  /** First line the prospect speaks — anchors the conversation. */
  openingLine: string
  /** System prompt — defines the prospect persona + how to push back. */
  systemPrompt: string
}

export type EnsureScenarioAgentResult =
  | { ok: true; convAiAgentId: string; created: boolean }
  | { ok: false; error: string }

/**
 * Provisions (or reuses) a Conv-AI agent that *plays the prospect* for an
 * objection-training scenario. Distinct from the on-the-go assistant agents
 * (Track B) — these have NO tools, never act on the CRM, and use a neutral
 * voice (NOT the agent's cloned voice, since the agent is talking *to* this
 * prospect, not *as* them).
 *
 * Cache key: scenario_key. Six scenarios today; cache is tiny.
 */
export async function ensureScenarioAgent(
  params: EnsureScenarioAgentParams,
): Promise<EnsureScenarioAgentResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY not configured" }

  const supabase = createServiceClient()

  const { data: cached } = await supabase
    .from("objection_scenario_agents")
    .select("conv_ai_agent_id")
    .eq("scenario_key", params.scenarioKey)
    .maybeSingle()

  if (cached?.conv_ai_agent_id) {
    return { ok: true, convAiAgentId: cached.conv_ai_agent_id, created: false }
  }

  const body = {
    name: `Practice prospect — ${params.scenarioLabel}`,
    conversation_config: {
      agent: {
        first_message: params.openingLine,
        language: "en",
        prompt: {
          prompt: `${params.systemPrompt}

You are role-playing a real estate prospect for training purposes. STAY IN CHARACTER no matter what — even if the agent breaks character, asks meta questions, or tries to coach you. Push back realistically based on the persona. Do NOT call any CRM tools (you have none). Keep responses short and conversational, as if on a phone call.`,
          // No tools — pure roleplay.
          tools: [],
        },
      },
      tts: {
        voice_id: scenarioVoiceId(),
        optimize_streaming_latency: 3,
      },
    },
  }

  const res = await fetch(`${ELEVENLABS_API_BASE}/v1/convai/agents/create`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.agent_id) {
    return {
      ok: false,
      error: data?.detail?.message ?? data?.message ?? `ElevenLabs scenario agent create failed (${res.status})`,
    }
  }

  await supabase
    .from("objection_scenario_agents")
    .upsert({
      scenario_key: params.scenarioKey,
      conv_ai_agent_id: data.agent_id,
      updated_at: new Date().toISOString(),
    })

  return { ok: true, convAiAgentId: data.agent_id, created: true }
}

function scenarioVoiceId(): string {
  // Adam — neutral male voice. Different from the default agent voice (Rachel)
  // so the agent can hear the prospect distinctly. Override per-scenario later
  // if we want different voices for FSBO seller vs investor, etc.
  return process.env.ELEVENLABS_PROSPECT_VOICE_ID ?? "pNInz6obpgDQGcFmaJgB"
}

// ─── Signed URL for the browser SDK ──────────────────────────────────────────

export interface IssueAssistantSessionParams {
  convAiAgentId: string
}

export type IssueAssistantSessionResult =
  | { ok: true; signedUrl: string }
  | { ok: false; error: string }

/**
 * Returns a short-lived signed URL the @elevenlabs/client SDK uses to open the
 * WebSocket. The master API key never reaches the browser.
 */
export async function issueAssistantSession(
  params: IssueAssistantSessionParams,
): Promise<IssueAssistantSessionResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY not configured" }

  const url = new URL(`${ELEVENLABS_API_BASE}/v1/convai/conversation/get_signed_url`)
  url.searchParams.set("agent_id", params.convAiAgentId)

  const res = await fetch(url.toString(), {
    headers: { "xi-api-key": apiKey, Accept: "application/json" },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.signed_url) {
    return {
      ok: false,
      error: data?.detail?.message ?? `ElevenLabs signed-url failed (${res.status})`,
    }
  }
  return { ok: true, signedUrl: data.signed_url as string }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function defaultVoiceId(): string {
  // Rachel — default ElevenLabs voice. Used when an agent hasn't cloned theirs.
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM"
}

function buildSystemPrompt(params: EnsureAssistantAgentParams): string {
  const brand = params.brandVoice?.trim()
    ? `\n\nThis agent's brand voice: ${params.brandVoice.trim()}`
    : ""
  return `You are ${params.agentName}'s personal AI assistant for their real estate business. \
You help them get things done in the field — between showings, after a call, on the way to a closing. \
Keep responses short and spoken-style; the user is listening, not reading.

You can take actions on their CRM via tools — look up contacts, get today's schedule, list active listings or open transactions, \
review pending offers, catch up on recent messages, log activity, schedule appointments, update contact status, and send portal messages. \
Always confirm a destructive or outbound action ("I'm about to send X to Sarah, sound good?") before invoking the tool.

Never invent contact data — if you don't know something, use lookup_contact first. If a tool fails, say so plainly and suggest the next step.${brand}`
}

/**
 * Tool definitions registered with ElevenLabs at agent creation. ElevenLabs
 * stores these and POSTs to our webhook when the LLM invokes one. The webhook
 * URL is built from NEXT_PUBLIC_APP_URL + /api/agent-assistant/tool-call.
 *
 * Auth: ElevenLabs sends x-elevenlabs-tool-secret header (configured here +
 * checked by the webhook). The header value MUST match
 * AGENT_ASSISTANT_TOOL_SECRET on our side.
 */
function buildToolsConfig() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const toolSecret = process.env.AGENT_ASSISTANT_TOOL_SECRET ?? ""
  const webhookUrl = `${appUrl}/api/agent-assistant/tool-call`
  const auth = {
    type: "header" as const,
    headers: { "x-elevenlabs-tool-secret": toolSecret },
  }

  return [
    {
      type: "webhook",
      name: "lookup_contact",
      description: "Find a contact by name, phone, or email. Returns up to 5 matches with id, name, type, and last activity.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        query: { type: "string", description: "Name, phone number, or email — partial match allowed" },
      },
      required: ["query"],
    },
    {
      type: "webhook",
      name: "get_today_schedule",
      description: "Return the agent's appointments and key deadlines for today, in chronological order.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {},
      required: [],
    },
    {
      type: "webhook",
      name: "get_contact_details",
      description: "Get full intel on a specific contact — last contact, intent, transactions, recent activity.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Contact UUID (from lookup_contact)" },
      },
      required: ["contact_id"],
    },
    {
      type: "webhook",
      name: "log_activity",
      description: "Log a new activity (call, note, meeting outcome) to a contact. Use after wrapping up a conversation.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Contact UUID" },
        activity_type: { type: "string", description: "One of: call, note, meeting, email, sms" },
        notes: { type: "string", description: "What happened — keep it factual, one or two sentences" },
      },
      required: ["contact_id", "activity_type", "notes"],
    },
    {
      type: "webhook",
      name: "create_task",
      description: "Create a follow-up task. Use when the agent says \"remind me to…\".",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        title: { type: "string", description: "Short task title" },
        due_date: { type: "string", description: "ISO date (YYYY-MM-DD); omit for no specific deadline" },
        contact_id: { type: "string", description: "Optional contact this task relates to" },
      },
      required: ["title"],
    },
    {
      type: "webhook",
      name: "send_portal_message",
      description: "Send a message to a contact through their portal. Always confirm with the user before invoking. Goes through kernel-OS compliance + brand voice.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Contact UUID" },
        body: { type: "string", description: "Message body — kernel will apply brand voice + compliance before sending" },
      },
      required: ["contact_id", "body"],
    },
    {
      type: "webhook",
      name: "get_active_listings",
      description: "List the agent's active listings (status='active' or 'coming_soon'). Returns up to 10 with address, price, beds/baths, sqft, and lifecycle stage.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {},
      required: [],
    },
    {
      type: "webhook",
      name: "get_pending_offers",
      description: "List offers awaiting response — pending or countered. Includes price, contact, listing address, and response deadline.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {},
      required: [],
    },
    {
      type: "webhook",
      name: "get_transactions_in_progress",
      description: "List the agent's open transactions — anything under contract through closing prep. Returns deal name, status, close date, and the contact.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {},
      required: [],
    },
    {
      type: "webhook",
      name: "get_recent_messages",
      description: "Recent portal messages — last 10 if no contact_id, or last 10 with a specific contact. Use to catch up before reaching out.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Optional contact UUID to scope the messages" },
      },
      required: [],
    },
    {
      type: "webhook",
      name: "update_contact_status",
      description: "Change a contact's status field (e.g., 'active', 'cold', 'closed', 'unsubscribed'). Confirm with the user before invoking.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Contact UUID" },
        status: { type: "string", description: "New status value" },
      },
      required: ["contact_id", "status"],
    },
  ]
}
