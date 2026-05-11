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
  /** ElevenLabs voice_id resolved by the caller via lib/voice/voice-resolver
   *  (honors the agent's voice_preference: 'clone' uses voice_id, 'generic'
   *  uses assistant_voice_id, never a hardcoded platform default in the
   *  hot path — falls back only to the platform sentinel when the user
   *  hasn't picked yet). REQUIRED. */
  voiceId: string
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
        voice_id: params.voiceId,
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
  /** agents.id of the real-estate agent practicing this scenario. The cache
   *  key is (scenario_key, agent_id) so each agent's prospect_voice_id can
   *  drive a separate cached scenario agent. */
  agentId: string
  /** ElevenLabs voice_id the prospect speaks in. Resolved by the caller from
   *  agents.prospect_voice_id (with a platform sentinel fallback). REQUIRED. */
  voiceId: string
}

export type EnsureScenarioAgentResult =
  | { ok: true; convAiAgentId: string; created: boolean }
  | { ok: false; error: string }

/**
 * Provisions (or reuses) a Conv-AI agent that plays the prospect for one
 * objection-training scenario, scoped to a specific real-estate agent.
 * Distinct from the on-the-go assistant agents (Track B) — these have NO
 * tools, never act on the CRM, and use the agent's chosen prospect voice
 * (must differ from their own voice).
 *
 * Cache key: (scenario_key, agent_id). When the agent changes their
 * prospect_voice_id we re-provision so the cached agent reflects the new
 * voice.
 */
export async function ensureScenarioAgent(
  params: EnsureScenarioAgentParams,
): Promise<EnsureScenarioAgentResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY not configured" }

  const supabase = createServiceClient()

  const { data: cached } = await supabase
    .from("objection_scenario_agents")
    .select("conv_ai_agent_id, prospect_voice_id")
    .eq("scenario_key", params.scenarioKey)
    .eq("agent_id", params.agentId)
    .maybeSingle()

  // Cache hit only if the cached voice still matches the agent's preference.
  if (cached?.conv_ai_agent_id && cached.prospect_voice_id === params.voiceId) {
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
          tools: [],
        },
      },
      tts: {
        voice_id: params.voiceId,
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
      agent_id: params.agentId,
      conv_ai_agent_id: data.agent_id,
      prospect_voice_id: params.voiceId,
      updated_at: new Date().toISOString(),
    })

  return { ok: true, convAiAgentId: data.agent_id, created: true }
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
    {
      type: "webhook",
      name: "stage_listing_packet",
      description: "Pre-stage a NEW listing wizard from what the agent just said. The wizard opens prefilled (address, price, seller name, type) for the agent to review and submit. Does NOT submit — only stages. Use when the agent says \"create a listing\", \"start a new listing at...\", or \"list a property at...\". Always speak the open_url back so the agent knows where to find it.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        address: { type: "string", description: "Street address — required" },
        city: { type: "string", description: "City" },
        state: { type: "string", description: "Two-letter state code" },
        zip: { type: "string", description: "ZIP code" },
        list_price: { type: "number", description: "Asking price in dollars" },
        seller_name: { type: "string", description: "Seller / homeowner name" },
        property_type: { type: "string", description: "Single Family, Condo, Townhome, Multi-Family, Land, etc." },
        notes: { type: "string", description: "Anything else the agent mentioned" },
      },
      required: ["address"],
    },
    {
      type: "webhook",
      name: "stage_offer_packet",
      description: "Pre-stage a NEW offer wizard for a specific contact (buyer) on a property. Use when the agent says \"write an offer for [contact] on [property] at $X\". Look up the contact first with lookup_contact if you don't already have the contact_id. Always speak the open_url back so the agent knows where to find it.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        contact_id: { type: "string", description: "Buyer contact UUID — required" },
        address: { type: "string", description: "Property address — required" },
        city: { type: "string", description: "City" },
        state: { type: "string", description: "Two-letter state code" },
        zip: { type: "string", description: "ZIP code" },
        offer_price: { type: "number", description: "Offer amount in dollars" },
        financing_type: { type: "string", description: "Cash, Conventional, FHA, VA, USDA, etc." },
        earnest_money: { type: "number", description: "Earnest money in dollars" },
        closing_date: { type: "string", description: "Desired closing date (YYYY-MM-DD)" },
        notes: { type: "string", description: "Contingencies or terms the agent mentioned" },
      },
      required: ["contact_id", "address"],
    },
    {
      type: "webhook",
      name: "stage_newsletter_draft",
      description: "Stage a NEW newsletter draft when the agent says 'create a newsletter about X' or 'send a newsletter on [topic]'. Returns open_url to the newsletter editor — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        title: { type: "string", description: "Newsletter campaign name — required" },
        subject_line: { type: "string", description: "Email subject line — defaults to title" },
        topic: { type: "string", description: "What the newsletter is about — seeded into the intro section" },
      },
      required: ["title"],
    },
    {
      type: "webhook",
      name: "stage_email_campaign",
      description: "Stage a NEW email campaign draft. Use when the agent says 'send an email blast', 'create an email campaign about X'. Returns open_url to the email editor — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        campaign_name: { type: "string", description: "Internal campaign name — required" },
        subject_line: { type: "string", description: "Email subject line" },
        content: { type: "string", description: "Initial body copy if dictated" },
        send_date: { type: "string", description: "ISO date/time for scheduled send" },
      },
      required: ["campaign_name"],
    },
    {
      type: "webhook",
      name: "stage_open_house",
      description: "Schedule an open house on a listing. Use when the agent says 'schedule an open house for [listing] on [date]'. Look up the listing first with get_active_listings if you don't have the listing_id.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        listing_id: { type: "string", description: "Listing UUID — required" },
        date: { type: "string", description: "YYYY-MM-DD — required" },
        start_time: { type: "string", description: "HH:MM 24-hour — required" },
        end_time: { type: "string", description: "HH:MM 24-hour — required" },
        max_attendees: { type: "number", description: "Optional attendee cap" },
        notes: { type: "string", description: "Agent-internal notes" },
        public_description: { type: "string", description: "Public-facing description used in invites" },
      },
      required: ["listing_id", "date", "start_time", "end_time"],
    },
    {
      type: "webhook",
      name: "stage_blog_draft",
      description: "Stage a NEW blog post draft. Use when the agent says 'write a blog post about X', 'draft a blog on [topic]'. Returns open_url to the blog editor — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        title: { type: "string", description: "Blog post title — required" },
        topic: { type: "string", description: "What the post should cover — seeded into the body" },
        category: { type: "string", description: "market_insights | buyer_guides | seller_guides | local_lifestyle | community" },
      },
      required: ["title"],
    },
    {
      type: "webhook",
      name: "stage_podcast_episode",
      description: "Stage a NEW podcast episode draft. Use when the agent says 'start a podcast on X', 'record an episode about [topic]'. Returns open_url to the podcast studio — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        title: { type: "string", description: "Episode title — required" },
        description: { type: "string", description: "Show notes / episode description" },
        script: { type: "string", description: "Initial script if dictated" },
        category: { type: "string", description: "market_update | how_to | interview | story | educational" },
        keywords: { type: "string", description: "Comma-separated keywords for SEO" },
      },
      required: ["title"],
    },
    {
      type: "webhook",
      name: "stage_video_project",
      description: "Stage a NEW video project. Use when the agent says 'create a video about X', 'film a market update', 'make a walkthrough for [listing]'. Returns open_url to the video studio — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        title: { type: "string", description: "Video title — required" },
        script: { type: "string", description: "Initial script if dictated" },
        video_type: { type: "string", description: "listing_walkthrough | market_update | testimonial | educational" },
        format: { type: "string", description: "vertical | horizontal | square" },
        duration_seconds: { type: "number", description: "Target duration" },
        listing_id: { type: "string", description: "Linked listing UUID for walkthroughs" },
      },
      required: ["title"],
    },
    {
      type: "webhook",
      name: "stage_direct_mail_campaign",
      description: "Stage a NEW direct mail campaign. Use when the agent says 'send postcards to past clients', 'launch a direct mail campaign', 'mail thank-you notes'. Returns open_url to the campaigns dashboard — speak it back.",
      url: webhookUrl,
      method: "POST",
      auth,
      parameters: {
        campaign_name: { type: "string", description: "Internal name — required" },
        target_audience: { type: "string", description: "Who to mail to (past_clients, sphere, farm_zip_xxxx, etc.) — required" },
        piece_type: { type: "string", description: "postcard_4x6 | postcard_6x9 | postcard_6x11 | letter | handwritten | thank_you_note" },
        budget: { type: "number", description: "Budget in dollars (determines quantity)" },
        send_date: { type: "string", description: "Mailing date (YYYY-MM-DD)" },
        copy_text: { type: "string", description: "Initial copy if dictated" },
      },
      required: ["campaign_name", "target_audience"],
    },
  ]
}
