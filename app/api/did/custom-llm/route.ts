/**
 * /api/did/custom-llm
 *
 * D-ID Agents calls this endpoint as its LLM provider on every conversational
 * turn. We are the brain — D-ID is just the avatar + voice + WebRTC transport.
 *
 * Request shape (OpenAI chat-completions, sent by D-ID):
 *   POST /api/did/custom-llm
 *   Authorization: Basic <base64(DID_CUSTOM_LLM_KEY)>
 *   { model, messages: [...], stream: true, ... }
 *
 * Per-session context — D-ID does NOT pass metadata. The browser widget
 * therefore prefixes its very first user message with a hidden context
 * marker:  `[[CTX:contactId=<uuid>]] <real text>`
 * We:
 *   - extract contactId from any message that contains the marker
 *   - strip the marker so it never reaches the LLM or transcript
 *   - load contact + transaction + visible milestones (same data the portal
 *     ai-chat exposes) and inject as a SYSTEM message in front of D-ID's
 *     existing system prompt
 *
 * Once contactId is known, this route mirrors /api/portal/ai-chat semantics:
 *   - same client-visible-only data gate (no internal notes)
 *   - same escalation keyword detector → notifies assigned agent
 *   - same chat_messages persistence so the conversation appears in the CRM
 *
 * Response: OpenAI-format SSE stream piped straight back to D-ID.
 */

import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { streamTextRouted, AIFairUseError, selectModelForTask } from "@/lib/ai/models"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ─── Auth ───────────────────────────────────────────────────────────────────

function checkAuth(request: NextRequest): boolean {
  const expected = process.env.DID_CUSTOM_LLM_KEY
  if (!expected) return false
  const header = request.headers.get("authorization") ?? ""

  // D-ID config supports both type:basic (Basic <base64>) and bearer-style.
  // We only configured 'basic' on the agent; accept both for safety.
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8")
      // Accept either "<key>" or "<key>:" or "user:<key>"
      const candidate = decoded.includes(":") ? decoded.split(":").pop() : decoded
      return candidate === expected
    } catch {
      return false
    }
  }
  if (header.startsWith("Bearer ")) {
    return header.slice(7) === expected
  }
  return false
}

// ─── Context marker ─────────────────────────────────────────────────────────

const CTX_RE = /\[\[CTX:contactId=([0-9a-f-]{36})\]\]\s*/i

function extractContactId(messages: any[]): { contactId: string | null; cleaned: any[] } {
  let contactId: string | null = null
  const cleaned = messages.map((m) => {
    if (typeof m?.content !== "string") return m
    const match = m.content.match(CTX_RE)
    if (match) {
      contactId = contactId ?? match[1]
      return { ...m, content: m.content.replace(CTX_RE, "").trim() || "(continue)" }
    }
    return m
  })
  return { contactId, cleaned }
}

// ─── Escalation ─────────────────────────────────────────────────────────────

const ESCALATION_KEYWORDS = [
  "urgent", "emergency", "need agent", "call me", "speak to someone",
  "scared", "worried", "panicking", "deal is falling", "losing the house",
  "pulling out", "back out", "cancel", "sue", "lawsuit",
]

function detectsEscalation(text: string): boolean {
  const lower = text.toLowerCase()
  return ESCALATION_KEYWORDS.some((k) => lower.includes(k))
}

// ─── Context loader ─────────────────────────────────────────────────────────

interface ContactContext {
  contactName: string
  brokerageId: string | null
  agentId: string | null
  agentUserId: string | null
  contactType: string | null
  buyerStage: string | null
  activeTransaction: any | null
  visibleMilestones: any[]
  activeListing: any | null
}

async function loadContactContext(contactId: string): Promise<ContactContext | null> {
  const supabase = createServiceClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, agent_id, contact_type, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return null

  // Resolve agents.user_id for the assigned agent (used by escalation
  // notifications + brand voice resolution).
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agent } = await supabase
      .from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = agent?.user_id ?? null
  }

  // Active transaction (most recent open) + client-visible milestones only.
  const { data: txn } = await supabase
    .from("transactions")
    .select("id, status, stage, deal_type, close_date, property_address")
    .eq("contact_id", contactId)
    .in("status", ["under_contract", "active"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let visibleMilestones: any[] = []
  if (txn?.id) {
    const { data: ms } = await supabase
      .from("transaction_milestones")
      .select("title, status, target_date, description")
      .eq("transaction_id", txn.id)
      .eq("is_client_visible", true)
      .order("target_date", { ascending: true })
    visibleMilestones = ms ?? []
  }

  // Active listing (sellers only).
  const { data: listing } = await supabase
    .from("listings")
    .select("address, city, state, status, current_stage:lifecycle_stage, list_price")
    .eq("contact_id", contactId)
    .in("status", ["active", "coming_soon", "pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    contactName: contact.first_name ?? "there",
    brokerageId: contact.brokerage_id,
    agentId: contact.agent_id,
    agentUserId,
    contactType: contact.contact_type,
    buyerStage: contact.buyer_stage,
    activeTransaction: txn,
    visibleMilestones,
    activeListing: listing,
  }
}

// ─── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: ContactContext, brandVoiceHints: string[]): string {
  const lines: string[] = [
    `You are speaking with ${ctx.contactName} on their real estate client portal.`,
    "Keep replies short, warm, and natural — this is a face-to-face video conversation, not a chat window. Two or three sentences usually.",
    "",
    "RULES:",
    "- Only discuss information from the context below.",
    "- Never reveal: internal agent notes, hidden milestones, compliance items, agent-only tasks, or any data not in this context.",
    "- If asked about something not in your context, say: \"Your agent can clarify that for you.\"",
    "- Do not give legal, tax, or financial advice. Recommend consulting a professional.",
    "- Do not promise specific closing dates or guaranteed outcomes.",
    "- If the contact seems urgent or distressed, reassure them and let them know their agent will be notified right away.",
    "",
  ]

  if (ctx.activeTransaction) {
    lines.push("ACTIVE TRANSACTION:")
    lines.push(`  Property: ${ctx.activeTransaction.property_address ?? "your property"}`)
    lines.push(`  Status: ${ctx.activeTransaction.status}`)
    lines.push(`  Stage: ${ctx.activeTransaction.stage ?? "in progress"}`)
    if (ctx.activeTransaction.close_date) lines.push(`  Target close: ${ctx.activeTransaction.close_date}`)
    lines.push("")
    lines.push("VISIBLE MILESTONES (the only milestones you may discuss):")
    if (ctx.visibleMilestones.length) {
      for (const m of ctx.visibleMilestones) {
        lines.push(`  - ${m.title}: ${m.status}${m.target_date ? " (" + m.target_date + ")" : ""}${m.description ? " — " + m.description : ""}`)
      }
    } else {
      lines.push("  No milestones available yet.")
    }
    lines.push("")
  }

  if (ctx.activeListing) {
    lines.push("ACTIVE LISTING:")
    lines.push(`  Address: ${ctx.activeListing.address}, ${ctx.activeListing.city}, ${ctx.activeListing.state}`)
    lines.push(`  Status: ${ctx.activeListing.status}`)
    lines.push(`  Stage: ${ctx.activeListing.current_stage ?? "listed"}`)
    if (ctx.activeListing.list_price) lines.push(`  List price: $${Number(ctx.activeListing.list_price).toLocaleString()}`)
    lines.push("")
  }

  if (brandVoiceHints.length) {
    lines.push("BRAND VOICE GUIDANCE:")
    for (const h of brandVoiceHints) lines.push(`  - ${h}`)
  }

  return lines.join("\n")
}

// ─── Escalation side-effect ─────────────────────────────────────────────────

async function notifyAgentOfEscalation(ctx: ContactContext, latestText: string) {
  if (!ctx.agentUserId || !ctx.brokerageId) return
  const supabase = createServiceClient()
  await supabase.from("notifications").insert({
    user_id: ctx.agentUserId,
    brokerage_id: ctx.brokerageId,
    type: "portal_ai_escalation",
    title: `${ctx.contactName} needs immediate attention`,
    body: `Portal Live AI escalation. Last message: "${latestText.slice(0, 200)}"`,
    entity_type: "contact",
    entity_id: ctx.activeTransaction?.contact_id ?? null,
    priority: "high",
  }).then(() => {}, () => {})
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const gatewayKey = process.env.AI_GATEWAY_API_KEY
  if (!gatewayKey) return NextResponse.json({ error: "AI_GATEWAY_API_KEY not configured" }, { status: 503 })

  const body = await request.json().catch(() => null) as
    | { model?: string; messages?: any[]; stream?: boolean }
    | null

  if (!body?.messages?.length) {
    return NextResponse.json({ error: "messages required" }, { status: 400 })
  }

  const { contactId, cleaned } = extractContactId(body.messages)

  // ── Build context-aware system message ────────────────────────────────────
  let systemPrompt = "You are a helpful real estate assistant. Keep replies short and natural for a video conversation."

  // Ledger identity — resolved from the CONTACT's row (the assigned agent's
  // user + the contact's tenant), never from anything D-ID sends. A turn with
  // no context marker has no tenant → uncapped and unledgered by contract,
  // same as any background call through the routed entries.
  let ledgerUserId: string | null = null
  let ledgerBrokerageId: string | null = null
  let ledgerAgentId: string | null = null

  if (contactId) {
    const ctx = await loadContactContext(contactId)
    if (ctx) {
      ledgerUserId = ctx.agentUserId
      ledgerBrokerageId = ctx.brokerageId
      ledgerAgentId = ctx.agentId
      // Brand voice guidance — runs the same multi-tier resolver as the rest
      // of the kernel pipeline. Notes-only (advisory) on the live conversation.
      const latestUserText = [...cleaned].reverse()
        .find((m) => m.role === "user")?.content ?? ""

      const brand = await applyBrandVoice({
        brokerageId: ctx.brokerageId ?? "",
        actorUserId: ctx.agentUserId ?? undefined,
        actorRole: "agent",
        journeyType: ctx.contactType === "seller" ? "seller" : "buyer",
        persona: ctx.buyerStage ?? "other",
        messageType: "ai",
        content: latestUserText,
      }).catch(() => ({ notes: [] as string[] }))

      systemPrompt = buildSystemPrompt(ctx, brand.notes ?? [])

      // Fire escalation if the latest user message has an urgency keyword.
      if (latestUserText && detectsEscalation(latestUserText)) {
        notifyAgentOfEscalation(ctx, latestUserText).catch(() => {})
      }
    }
  }

  // ── Stream via the routed entry ─────────────────────────────────────────
  // streamTextRouted owns model routing (live_avatar_conversation →
  // gpt-4o-mini, latency-critical), the tenant fair-use PRE-FLIGHT, and the
  // cost-ledger write on finish — this route used to route + gateway by hand
  // and never wrote the ledger. The old try/catch fallback lane is gone with
  // it: streamText never throws synchronously for provider errors, so that
  // catch could not fire (see the WHY on streamTextRouted).
  const { model: routedModel } = selectModelForTask("live_avatar_conversation")
  let result: Awaited<ReturnType<typeof streamTextRouted>>
  try {
    result = await streamTextRouted({
      feature: "live_avatar_conversation",
      system: systemPrompt,
      messages: cleaned
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
      temperature: 0.7,
      userId: ledgerUserId,
      brokerageId: ledgerBrokerageId,
      agentId: ledgerAgentId,
    })
  } catch (err) {
    // Tenant is at its monthly AI cap — refuse before any SSE bytes flow.
    if (err instanceof AIFairUseError) {
      return NextResponse.json({ error: err.message }, { status: 429 })
    }
    throw err
  }

  // ── Wrap AI SDK text deltas in OpenAI chat-completion SSE format ────────
  // D-ID expects byte-compatible OpenAI chunks: each delta wrapped in a
  // `chat.completion.chunk` envelope, terminated by `data: [DONE]`.
  const encoder = new TextEncoder()
  const chunkId = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const modelLabel = body.model ?? routedModel

  const out = new ReadableStream({
    async start(controller) {
      try {
        for await (const delta of result.textStream) {
          const chunk = {
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model: modelLabel,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        const finalChunk = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model: modelLabel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(out, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
