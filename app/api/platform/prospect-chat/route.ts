import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePlatformReceptionContext, buildPlatformReceptionPrompt, platformReceptionTools } from "@/lib/voice/platform-reception"
import { checkPublicRateLimit, publicCallerIp } from "@/lib/security/public-rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * /api/platform/prospect-chat — THE WEBSITE PROSPECT CHAT (lane 76B).
 *
 * Owner (wave 76): "this goes for the platform ai agents … the platform
 * 'potential' customers are being saved/created as 'potential' subscribers
 * and if they do decide to setup a demo or want to purchase a subscription
 * we have a way for the agents to create a demo appointment or given a way
 * to either sign up online or with a human."
 *
 * Before this lane the platform's ONLY AI-agent surface was the phone line
 * (lib/voice/platform-reception.ts + twilio-voice.ts's platform branch); the
 * public site (/get-started, /demo, /pricing) had forms and no conversation.
 * app/api/did/custom-llm and app/api/widget/message are TENANT surfaces
 * (keyed by embedSessionId/contactId to a brokerage) and must stay so. This
 * route is the SAME platform brain on the web: the same
 * buildPlatformReceptionPrompt (channel:"chat"), the same live brand/tier
 * context, the same buildQualificationPrompt platform branch, and the SAME
 * tool bundle (platformReceptionTools — FAQ lookup + save_prospect /
 * find_demo_slots / book_demo_appointment / send_signup_link /
 * request_human_handoff). One brain, two doors (§6).
 *
 * PUBLIC + UNAUTHENTICATED by design (a prospect has no account). Throttled
 * per caller IP through the SAME limiter the coupon check uses
 * (lib/security/public-rate-limit.ts). No tenant: brokerageId is null on the
 * model call (uncapped platform traffic, booked under the data_steward
 * manager on ai_tool_usage). Identity: the prospect is resolved by the email
 * THEY give, through the ONE writer — no prospect id ever rides the body.
 */

const MAX_MESSAGES = 30
const MAX_CHARS = 2000

interface ChatMessage { role: "user" | "assistant"; content: string }

function parseBody(raw: unknown): ChatMessage[] | null {
  const b = raw as { messages?: unknown } | null
  if (!b || !Array.isArray(b.messages) || b.messages.length === 0) return null
  const out: ChatMessage[] = []
  for (const m of b.messages.slice(-MAX_MESSAGES)) {
    const role = (m as { role?: unknown })?.role
    const content = (m as { content?: unknown })?.content
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null
    const text = content.trim().slice(0, MAX_CHARS)
    if (!text) continue
    out.push({ role, content: text })
  }
  if (out.length === 0 || out[out.length - 1]!.role !== "user") return null
  return out
}

export async function POST(request: NextRequest) {
  const verdict = checkPublicRateLimit("platform-prospect-chat", await publicCallerIp(), { limit: 30, windowMs: 5 * 60_000 })
  if (!verdict.allowed) {
    return NextResponse.json({ error: "Too many messages — give it a moment." }, { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } })
  }
  const messages = parseBody(await request.json().catch(() => null))
  if (!messages) return NextResponse.json({ error: "bad request" }, { status: 400 })

  const svc = createServiceClient()
  const ctx = await resolvePlatformReceptionContext(svc, { requireTwilio: false })
  if (!ctx) return NextResponse.json({ error: "assistant unavailable" }, { status: 503 })

  const { systemPrompt, firstMessage } = buildPlatformReceptionPrompt({
    brandName: ctx.brandName, tagline: ctx.tagline, tierLines: ctx.tierLines, hasTransfer: false,
    voicePitch: ctx.voicePitch, receptionGreeting: ctx.receptionGreeting, brand: ctx.brand, channel: "chat",
  })
  const tools = await platformReceptionTools({
    source: "web:prospect_chat", phone: null, prospectId: null, callId: null,
    brand: ctx.productBrand, hasLiveTransfer: false,
  })

  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { PLATFORM_PROSPECT_TOOL_GUIDANCE } = await import("@/lib/platform/prospect-agent-tools")
    const { text } = await generateTextRouted({
      feature: "platform_prospect_chat",
      system: `${systemPrompt}\n\n${PLATFORM_PROSPECT_TOOL_GUIDANCE}\nReply in plain prose (no JSON) — two or three short sentences, one question at a time.`,
      messages: [{ role: "assistant", content: firstMessage }, ...messages],
      temperature: 0.4, maxTokens: 400,
      tools, maxSteps: 4,
      brokerageId: null, userId: null, manager: "data_steward",
    })
    const reply = text.trim() || "Sorry — could you say that once more?"
    return NextResponse.json({ reply })
  } catch (e) {
    console.error("[platform-prospect-chat] turn failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ reply: "Sorry — I hit a snag. You can book a demo at /demo or start a free trial at /get-started, and a person will follow up." })
  }
}
