/**
 * /api/did/custom-llm
 *
 * D-ID Agents calls this endpoint as its LLM provider on every conversational
 * turn, for EVERY surface that mints a D-ID Agents session — portal
 * (AgentsWidget), the embeddable widget (/embed/[publicId], third-party
 * sites), and the public website (SiteChatLauncher → the same embed when a
 * live-capable widget is configured). One brain, three doors (§6) — this
 * route decides WHO is talking from the marker(s) present, never from a
 * second endpoint per surface.
 *
 * Per-session context — D-ID does NOT pass metadata. The browser widget
 * therefore prefixes its early user turns with hidden context markers:
 *   `[[CTX:contactId=<uuid>]]`      — a known contact (portal always; embed
 *                                     once lead-capture has run)
 *   `[[CTX:embedSessionId=<uuid>]]` — an embed_sessions row (public website +
 *                                     embeddable widget, BEFORE capture)
 * Both may be present. We:
 *   - extract whichever markers a message carries
 *   - strip them so neither ever reaches the LLM or transcript
 *   - resolve a tenant from whichever marker is available, contactId
 *     preferred (richer — transaction/milestone/listing context)
 *   - REFUSE (400/403) any turn that carries NEITHER marker, or whose
 *     referenced row does not resolve — an unresolvable tenant is never
 *     served uncapped (#187)
 *
 * ANONYMOUS VISITORS (public website / embed, pre-capture) used to be
 * REFUSED OUTRIGHT here — this route required contactId unconditionally, so
 * every message an unidentified visitor sent got a 400 and the widget's
 * "after_first_message" lead-capture flow could never even reach its own
 * trigger (chat() always threw before the capture form could open). Fixed by
 * accepting embedSessionId as a standalone tenant handle; the brain then
 * answers from the brokerage's FAQ/knowledge base/brand voice (never
 * contact-specific data, which does not exist yet) via the SAME
 * loadBrandVoicePrompt survivor every other AI rail uses (§6 — this route
 * used to hand-roll its own narrower buildSystemPrompt with no FAQ, no
 * objection handling, and no knowledge-base RAG; that duplicate is retired
 * here in favor of lib/ai-isa/brand-voice-prompt.ts).
 *
 * Once a contact is known (portal, or an embed visitor who has been
 * captured — embed_sessions.contact_id, the authoritative link written by
 * /api/embed/capture), the brain ALSO loads the transaction/milestone/
 * listing snapshot the portal ai-chat already exposes, on top of the same
 * brand-voice/FAQ/KB block — richer, never a different vocabulary.
 *
 * REALISM (owner ruling, wave 55/57 — the live avatar must not sound like an
 * AI creation): lib/video/realism-profile.ts's SPOKEN_REALISM_DIRECTIVE is
 * folded into the system prompt on every turn (compliance-first, not a
 * post-hoc scan — §5's own ruling for compliance applies equally to realism).
 *
 * PLATFORM DEPLOYMENT (lane 77B, owner: "the platform should also offer the
 * same ai agents like the live agent using d-id because the platform can use
 * those ai agents as a demo'd product"). A THIRD marker,
 *   `[[CTX:platformLiveSessionId=<uuid>]]` — the platform's own live-agent
 *                                            metering row (live_agent_sessions,
 *                                            minted by /api/platform/live-agent/
 *                                            session under the platform-owned
 *                                            showcase tenant)
 * routes the turn to handlePlatformTurn: the SAME brain the platform phone
 * line and the website prospect chat already run — buildPlatformReceptionPrompt
 * (channel "live") + platformReceptionTools (the prospect funnel bundle:
 * save / demo slots / book demo / signup link / human / start_subscription /
 * show_product_demo) + the platform playbook branch — on the platform's OWN
 * brand (loadBrandPlaybookContext({brokerageId: null})), never a tenant's.
 * No contact, no embed session, no tenant brand voice, no property tools;
 * brokerageId is null on the model call exactly as the prospect chat books
 * it. A marker that does not resolve to an ACTIVE platform row is refused.
 *
 * Response: OpenAI-format SSE stream piped straight back to D-ID.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadBrandVoicePrompt } from "@/lib/ai-isa/brand-voice-prompt"
import { SPOKEN_REALISM_DIRECTIVE } from "@/lib/video/realism-profile"
import { streamTextRouted, AIFairUseError, selectModelForTask } from "@/lib/ai/models"
import { batchDataIsaTools } from "@/lib/ai-isa/batchdata-isa-tools"
import { resolveToolPersona, filterRentCastToolsForPersona, selectToolsForPersona, type ToolPersona } from "@/lib/ai-isa/persona-tool-policy"
import { rentCastMcpTools } from "@/lib/external/rentcast-ai-tools"
import { buildCustomerFreeTools } from "@/lib/ai-isa/customer-context-tools"
import { buildQualificationPrompt } from "@/lib/ai-isa/qualification-playbook"
import { loadBrandPlaybookContext, type BrandPlaybookContext } from "@/lib/ai-isa/brand-playbook-context"
import { PLATFORM_LIVE_CTX_RE, resolvePlatformLiveSession } from "@/lib/did/platform-live-agent"
import { resolvePlatformReceptionContext, buildPlatformReceptionPrompt, platformReceptionTools } from "@/lib/voice/platform-reception"
import { PLATFORM_PROSPECT_TOOL_GUIDANCE } from "@/lib/platform/prospect-agent-tools"

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

// ─── Context markers ────────────────────────────────────────────────────────

const CONTACT_CTX_RE = /\[\[CTX:contactId=([0-9a-f-]{36})\]\]\s*/gi
const EMBED_CTX_RE = /\[\[CTX:embedSessionId=([0-9a-f-]{36})\]\]\s*/gi

function extractMarkers(messages: any[]): { contactId: string | null; embedSessionId: string | null; platformLiveSessionId: string | null; cleaned: any[] } {
  let contactId: string | null = null
  let embedSessionId: string | null = null
  let platformLiveSessionId: string | null = null
  const cleaned = messages.map((m) => {
    if (typeof m?.content !== "string") return m
    let content = m.content
    const cMatch = CONTACT_CTX_RE.exec(content)
    CONTACT_CTX_RE.lastIndex = 0
    if (cMatch) contactId = contactId ?? cMatch[1]
    const eMatch = EMBED_CTX_RE.exec(content)
    EMBED_CTX_RE.lastIndex = 0
    if (eMatch) embedSessionId = embedSessionId ?? eMatch[1]
    const pMatch = PLATFORM_LIVE_CTX_RE.exec(content)
    PLATFORM_LIVE_CTX_RE.lastIndex = 0
    if (pMatch) platformLiveSessionId = platformLiveSessionId ?? pMatch[1]
    content = content.replace(CONTACT_CTX_RE, "").replace(EMBED_CTX_RE, "").replace(PLATFORM_LIVE_CTX_RE, "").trim() || "(continue)"
    return { ...m, content }
  })
  return { contactId, embedSessionId, platformLiveSessionId, cleaned }
}

// ─── OpenAI-format SSE wrap — ONE writer for both deployments ─────────────────

function streamAsOpenAiSse(result: Awaited<ReturnType<typeof streamTextRouted>>, modelLabel: string): Response {
  const encoder = new TextEncoder()
  const chunkId = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
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

async function notifyAgentOfEscalation(params: {
  agentUserId: string | null
  brokerageId: string
  contactId: string | null
  contactName: string
  latestText: string
  source: "portal" | "embed"
}) {
  if (!params.agentUserId) return
  const supabase = createServiceClient()
  await sentinelWrite(supabase, supabase.from("notifications").insert({
    user_id: params.agentUserId,
    brokerage_id: params.brokerageId,
    type: params.source === "portal" ? "portal_ai_escalation" : "embed_ai_escalation",
    title: `${params.contactName} needs immediate attention`,
    body: `Live AI (${params.source}) escalation. Last message: "${params.latestText.slice(0, 200)}"`,
    entity_type: params.contactId ? "contact" : null,
    entity_id: params.contactId,
    priority: "high",
  }), { table: "notifications", flow: "route_notify", brokerageId: params.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
}

// ─── Context loader — portal-rich (contact known) ──────────────────────────

interface ContactContext {
  contactName: string
  brokerageId: string | null
  agentId: string | null
  agentUserId: string | null
  contactType: string | null
  /** contacts.contact_persona — read by resolveToolPersona (lib/ai-isa/persona-tool-
   *  policy.ts) alongside contactType/homeOwnerStatus to pick the AI-tool persona. */
  contactPersona: string | null
  homeOwnerStatus: string | null
  buyerStage: string | null
  activeTransaction: any | null
  visibleMilestones: any[]
  activeListing: any | null
}

async function loadContactContext(contactId: string): Promise<ContactContext | null> {
  const supabase = createServiceClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, agent_id, contact_type, contact_persona, buyer_stage, home_owner_status")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return null

  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agent } = await supabase
      .from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = agent?.user_id ?? null
  }

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
    contactPersona: contact.contact_persona ?? null,
    homeOwnerStatus: contact.home_owner_status ?? null,
    buyerStage: contact.buyer_stage,
    activeTransaction: txn,
    visibleMilestones,
    activeListing: listing,
  }
}

// ─── Context loader — anonymous (embed/website, no contact yet) ───────────

interface EmbedContext {
  brokerageId: string
  agentId: string | null
  agentUserId: string | null
  /** Written by /api/embed/capture the moment the visitor identifies
   *  themselves mid-conversation — read here so a captured lead gets the rich
   *  contact context on their VERY NEXT turn without the client having to
   *  resend a marker. */
  contactId: string | null
}

async function loadEmbedContext(embedSessionId: string): Promise<EmbedContext | null> {
  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("embed_sessions")
    .select("brokerage_id, contact_id, embed_widget_id")
    .eq("id", embedSessionId)
    .maybeSingle()
  if (!session?.brokerage_id) return null

  let agentId: string | null = null
  if (session.embed_widget_id) {
    const { data: w } = await supabase
      .from("embed_widgets").select("agent_id").eq("id", session.embed_widget_id).maybeSingle()
    agentId = w?.agent_id ?? null
  }
  let agentUserId: string | null = null
  if (agentId) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    agentUserId = a?.user_id ?? null
  }
  return { brokerageId: session.brokerage_id, agentId, agentUserId, contactId: session.contact_id ?? null }
}

// ─── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(input: {
  contactName: string
  isAnonymous: boolean
  ctx: ContactContext | null
  brandVoiceBlock: string
  toolPersona: ToolPersona
  brand?: BrandPlaybookContext | null
}): string {
  const lines: string[] = [
    input.isAnonymous
      ? `You are speaking with a visitor on the brokerage's live chat/video assistant. You do not yet know their name — ask for it naturally if it would help.`
      : `You are speaking with ${input.contactName} on their real estate client portal.`,
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

  const ctx = input.ctx
  if (ctx?.activeTransaction) {
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

  if (ctx?.activeListing) {
    lines.push("ACTIVE LISTING:")
    lines.push(`  Address: ${ctx.activeListing.address}, ${ctx.activeListing.city}, ${ctx.activeListing.state}`)
    lines.push(`  Status: ${ctx.activeListing.status}`)
    lines.push(`  Stage: ${ctx.activeListing.current_stage ?? "listed"}`)
    if (ctx.activeListing.list_price) lines.push(`  List price: $${Number(ctx.activeListing.list_price).toLocaleString()}`)
    lines.push("")
  }

  // THE SURVIVOR (§6) — brand voice, FAQ, objection handling, brokerage
  // knowledge-base RAG, and (when a contact is known) contact notes + extended
  // memory. This used to be a narrower, hand-rolled "BRAND VOICE GUIDANCE"
  // bullet list built from applyBrandVoice's advisory notes only; that call
  // site is retired in favor of lib/ai-isa/brand-voice-prompt.ts, the same
  // module inbound-email drafting and outbound engagement already use, so the
  // live avatar and every other AI rail answer from ONE resolved identity.
  if (input.brandVoiceBlock.trim()) {
    lines.push("BRAND VOICE, FAQ & KNOWLEDGE:")
    lines.push(input.brandVoiceBlock)
    lines.push("")
  }

  // REALISM (owner ruling, wave 55/57) — folded in on every turn, not just
  // checked after the fact.
  lines.push(SPOKEN_REALISM_DIRECTIVE)

  // Lane 74B — the shared qualification playbook (CLAUDE.md §6). No
  // active transaction/listing bound yet is exactly when this surface
  // should be doing qualification work (contact info, intent, persona,
  // property address, criteria, timeline, financing) rather than only
  // servicing an existing deal.
  if (!input.ctx?.activeTransaction && !input.ctx?.activeListing) {
    lines.push("")
    lines.push(buildQualificationPrompt({ surface: "did_avatar", persona: input.toolPersona, brand: input.brand }))
  }

  return lines.join("\n")
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

  const { contactId: markerContactId, embedSessionId, platformLiveSessionId, cleaned } = extractMarkers(body.messages)

  // PLATFORM deployment (lane 77B) — its own marker, and ONLY its own: a
  // payload that mixes a platform marker with a tenant marker is refused
  // rather than guessed at.
  if (platformLiveSessionId) {
    if (markerContactId || embedSessionId) {
      return NextResponse.json({ error: "conflicting context markers" }, { status: 400 })
    }
    return handlePlatformTurn({ liveSessionId: platformLiveSessionId, cleaned, modelLabel: body.model })
  }

  // FAIL CLOSED (#187): a turn carrying NEITHER marker is refused, never
  // served uncapped. D-ID sends no metadata of its own — a CTX marker our
  // widgets prefix is the ONLY tenant handle in the payload, and every turn
  // carries the full history so a marker sent once rides along on all of them.
  if (!markerContactId && !embedSessionId) {
    return NextResponse.json({ error: "context marker required" }, { status: 400 })
  }

  let ctx: ContactContext | null = null
  let embedCtx: EmbedContext | null = null
  let resolvedContactId = markerContactId

  if (embedSessionId) {
    embedCtx = await loadEmbedContext(embedSessionId)
    if (!embedCtx) return NextResponse.json({ error: "unresolvable session" }, { status: 403 })
    // Authoritative contact link written by /api/embed/capture, when the
    // client's own marker hasn't caught up yet (e.g. this is the very next
    // turn right after capture and the widget hasn't re-sent one).
    resolvedContactId = resolvedContactId ?? embedCtx.contactId
  }

  if (resolvedContactId) {
    ctx = await loadContactContext(resolvedContactId)
  }

  const brokerageId = ctx?.brokerageId ?? embedCtx?.brokerageId ?? null
  if (!brokerageId) {
    return NextResponse.json({ error: "unresolvable tenant" }, { status: 403 })
  }
  const agentId = ctx?.agentId ?? embedCtx?.agentId ?? null
  const agentUserId = ctx?.agentUserId ?? embedCtx?.agentUserId ?? null
  const contactName = ctx?.contactName ?? "there"
  const isAnonymous = !ctx

  const latestUserText = [...cleaned].reverse()
    .find((m) => m.role === "user")?.content ?? ""

  const brand = await loadBrandVoicePrompt({
    brokerageId,
    agentId: agentId ?? undefined,
    managerKey: "ai_isa",
    knowledgeQuery: latestUserText || undefined,
    contactId: resolvedContactId ?? undefined,
  }).catch(() => ({ systemBlock: "" }))

  // Persona DERIVED from the CALLER (resolveToolPersona) — resolved HERE
  // (before the system prompt) so buildSystemPrompt can mount the shared
  // qualification playbook persona-flavored (lane 74B).
  const toolPersona = resolveToolPersona({
    contactType: ctx?.contactType ?? null,
    contactPersona: ctx?.contactPersona ?? null,
    homeOwnerStatus: ctx?.homeOwnerStatus ?? null,
  })

  // Wave 75 — business processes/SOPs, brand KB, office hours, service
  // areas. `omitVoiceBlock: true` because `brandVoiceBlock` above ALREADY
  // carries the brand-voice cascade text — never restated twice in one
  // prompt. (loadBrandPlaybookContext's own 60s cache absorbs the cost of
  // the brand-voice query it re-runs internally — the fallback shape `brand`
  // degrades to above has no full BrandVoicePromptResult to pass through as
  // `preloadedVoice`.)
  const brandPlaybook = await loadBrandPlaybookContext({
    brokerageId, agentId: agentId ?? null, contactId: resolvedContactId ?? null,
    omitVoiceBlock: true,
    knowledgeQuery: latestUserText || null,
  }).catch(() => null)

  const systemPrompt = buildSystemPrompt({
    contactName, isAnonymous, ctx, brandVoiceBlock: brand.systemBlock ?? "", toolPersona, brand: brandPlaybook,
  })

  if (latestUserText && detectsEscalation(latestUserText)) {
    notifyAgentOfEscalation({
      agentUserId, brokerageId, contactId: resolvedContactId, contactName,
      latestText: latestUserText, source: isAnonymous ? "embed" : "portal",
    }).catch(() => {})
  }

  // ── BatchData/RentCast property-intelligence tools (wave 71, widened 73B) ──
  // Persona DERIVED from the CALLER (the resolved contact's own contact_type/
  // contact_persona/home_owner_status — resolveToolPersona, lib/ai-isa/persona-
  // tool-policy.ts), never a request body (CLAUDE.md §4). An anonymous visitor
  // (no ctx) has none of those columns and resolves to the 'buyer' default —
  // the SAME default posture lib/campaigns/contact-sources.ts already
  // documents ("an unknown type is treated as a buyer rather than dropped").
  // conversationKey scopes the page-before-preview/count ordering rule and the
  // per-persona spend budget to THIS live-avatar conversation across turns —
  // embedSessionId when the visitor is still anonymous (stable across their
  // whole embed session), else the resolved contactId. Gated: {} when
  // BatchData's MCP is unconfigured (batchDataIsaTools resolves the SAME
  // token lib/external/batchdata-mcp.ts itself uses), so a deployment with no
  // BatchData token streams exactly as before.
  const conversationKey = embedSessionId ?? resolvedContactId ?? brokerageId
  const batchDataTools = await batchDataIsaTools({
    brokerageId,
    userId: agentUserId,
    agentId,
    persona: toolPersona,
    conversationKey,
    contactId: resolvedContactId ?? null,
  })
  const rentCastTools = filterRentCastToolsForPersona(
    await rentCastMcpTools({ brokerageId, userId: agentUserId }),
    toolPersona,
  )
  const freeTools = await buildCustomerFreeTools({
    brokerageId,
    contactId: resolvedContactId ?? null,
    agentId,
    persona: toolPersona,
  })

  // ── Stream via the routed entry ─────────────────────────────────────────
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
      // Lane 74B — cost-ranked order + need-dedup (selectToolsForPersona).
      tools: selectToolsForPersona({ ...freeTools, ...batchDataTools, ...rentCastTools }),
      maxSteps: 5,
      userId: agentUserId,
      brokerageId,
      agentId,
      // wave 60 §3.2 ("instrument the turn") — same managerKey brand-voice
      // resolution above already uses, so this ai_tool_usage row and the
      // brand-voice load it prices both attribute to the manager that owns
      // the live-avatar moment. streamTextRouted stamps wall-clock latency
      // (execution_time_ms) on the row automatically.
      manager: "ai_isa",
    })
  } catch (err) {
    if (err instanceof AIFairUseError) {
      return NextResponse.json({ error: err.message }, { status: 429 })
    }
    throw err
  }

  // ── Wrap AI SDK text deltas in OpenAI chat-completion SSE format ────────
  return streamAsOpenAiSse(result, body.model ?? routedModel)
}

// ─── PLATFORM deployment (lane 77B) ─────────────────────────────────────────
// Declared AFTER the tenant handler on purpose: scripts/stream-routing-
// simulator.ts anchors the tenant deployment's fail-closed gates on the FIRST
// streamTextRouted( call in this file, and the platform branch has its own
// gate (an unresolvable platform session is refused 403 before its stream —
// scripts/platform-live-agent-guard.ts). Function declarations hoist; the
// derived constant below is only read at call time.

/** The spoken-delivery rules, DERIVED from the one realism directive
 *  (lib/video/realism-profile.ts) minus its rule 3 — "never refer to yourself
 *  as an AI" — because the platform agent is the AI product being demoed and
 *  the platform prompt requires it to say so when asked. Never a second
 *  restatement of the delivery rules (CLAUDE.md §6). */
const PLATFORM_SPOKEN_DELIVERY = SPOKEN_REALISM_DIRECTIVE
  .split("\n")
  .filter((line) => !/^3\./.test(line))
  .join("\n")

async function handlePlatformTurn(params: { liveSessionId: string; cleaned: any[]; modelLabel: string | undefined }): Promise<Response> {
  const supabase = createServiceClient()
  // FAIL CLOSED — an ACTIVE platform metering row, under the platform's own
  // brokerage; a tenant's embed row or an ended session never resolves here.
  const session = await resolvePlatformLiveSession(supabase, params.liveSessionId)
  if (!session) return NextResponse.json({ error: "unresolvable platform session" }, { status: 403 })

  const ctx = await resolvePlatformReceptionContext(supabase, { requireTwilio: false })
  if (!ctx) return NextResponse.json({ error: "platform assistant unavailable" }, { status: 503 })

  const { systemPrompt } = buildPlatformReceptionPrompt({
    brandName: ctx.brandName, tagline: ctx.tagline, tierLines: ctx.tierLines, hasTransfer: false,
    voicePitch: ctx.voicePitch, receptionGreeting: ctx.receptionGreeting, brand: ctx.brand, channel: "live",
  })
  // THE ONE prospect tool bundle — FAQ lookup + save / demo slots / book demo /
  // signup link / human / start_subscription / show_product_demo. Identity is
  // whatever email the prospect gives, resolved through the ONE writer; no
  // phone (no caller ID on a web session), no prospect id from the payload.
  const tools = await platformReceptionTools({
    source: "web:live_agent", phone: null, prospectId: null, callId: null,
    brand: ctx.productBrand, hasLiveTransfer: false,
  })

  const { model: routedModel } = selectModelForTask("live_avatar_conversation")
  let result: Awaited<ReturnType<typeof streamTextRouted>>
  try {
    result = await streamTextRouted({
      feature: "live_avatar_conversation",
      system: `${systemPrompt}\n\n${PLATFORM_PROSPECT_TOOL_GUIDANCE}\n\n${PLATFORM_SPOKEN_DELIVERY}\n(The honesty rule above wins over any line here: you ARE an AI and say so when asked.)`,
      messages: params.cleaned
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
      temperature: 0.6,
      tools,
      maxSteps: 5,
      // No tenant: uncapped platform traffic booked under the data_steward
      // manager on ai_tool_usage — the SAME posture the prospect chat takes.
      userId: null,
      brokerageId: null,
      agentId: null,
      manager: "data_steward",
    })
  } catch (err) {
    if (err instanceof AIFairUseError) return NextResponse.json({ error: err.message }, { status: 429 })
    throw err
  }
  return streamAsOpenAiSse(result, params.modelLabel ?? routedModel)
}
