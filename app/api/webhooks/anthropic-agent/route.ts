/**
 * Anthropic Managed Agents — webhook handler.
 *
 * Receives session.* events for sessions we started (deal_coordinator, etc.). Anthropic
 * signs deliveries with HMAC-SHA256 using ANTHROPIC_WEBHOOK_SIGNING_KEY. We route the
 * event back through the kernel event bus so the agent's actions show up in the same
 * surfaces as human actions (transparency_updates, notifications, sequences) — single
 * downstream contract, no special-case rendering.
 *
 * Event types we handle:
 *   - `session.status_idled`     — agent finished its turn. Fetch the latest agent.message
 *                                  via list-events; persist to last_agent_message; emit
 *                                  AGENT_MESSAGE_RECEIVED kernel event.
 *   - `session.status_terminated`— agent done (end_turn or retries_exhausted). Mark the
 *                                  managed_agent_sessions row as ended.
 *   - everything else            — log + ack.
 */
import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const ANTHROPIC_BASE = "https://api.anthropic.com"
const ANTHROPIC_BETA = "managed-agents-2026-04-01"
const ANTHROPIC_VERSION = "2023-06-01"

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY
  if (!secret) {
    console.warn("[anthropic-webhook] ANTHROPIC_WEBHOOK_SIGNING_KEY not set — rejecting")
    return false
  }
  if (!signature) return false
  // Anthropic uses hex-encoded HMAC-SHA256 per their webhook docs.
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed)
    const b = Buffer.from(signature)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

interface SessionEvent {
  id?:           string
  type?:         string
  content?:      Array<{ type?: string; text?: string }>
  stop_reason?:  { type?: string } | string | null
}

async function fetchLatestAgentMessage(sessionId: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  const res = await callConnector<{ data?: SessionEvent[] }>({
    connector: "anthropic-managed-agents",
    baseUrl:   ANTHROPIC_BASE,
    path:      `/v1/sessions/${sessionId}/events`,
    method:    "GET",
    query:     { limit: "20" },
    headers:   {
      "x-api-key":         key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta":    ANTHROPIC_BETA,
    },
    timeoutMs: 30_000,
  })
  if (!res.ok) return null
  const events = res.data?.data ?? []
  // Newest-first: walk back to find the most recent agent.message text block.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === "agent.message" && Array.isArray(ev.content)) {
      const text = ev.content.find(b => b?.type === "text")?.text
      if (text) return text
    }
  }
  return null
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature =
    request.headers.get("x-anthropic-signature")
    ?? request.headers.get("anthropic-webhook-signature")

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let body: { type?: string; data?: { type?: string; id?: string }; id?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const eventType = body.data?.type
  const sessionId = body.data?.id
  if (!eventType || !sessionId) {
    return NextResponse.json({ received: true, action: "ignored", reason: "missing type/id" })
  }

  const svc = createServiceClient()
  const { data: sessionRow } = await svc
    .from("managed_agent_sessions")
    .select("id, brokerage_id, entity_type, entity_id, status")
    .eq("anthropic_session_id", sessionId)
    .maybeSingle()

  // Not our session — ack and move on (shared webhook endpoint with other Anthropic
  // services would land here; the rest of the dispatcher table can route them).
  if (!sessionRow) {
    return NextResponse.json({ received: true, action: "ignored", reason: "session not tracked" })
  }

  const now = new Date().toISOString()

  switch (eventType) {
    case "session.status_run_started":
      await svc.from("managed_agent_sessions")
        .update({ status: "running", last_event_at: now })
        .eq("id", sessionRow.id)
      break

    case "session.status_idled": {
      // Fetch the latest agent.message so we can persist + emit. Best-effort; if the
      // list-events call fails we still mark the session idle.
      const text = await fetchLatestAgentMessage(sessionId)
      await svc.from("managed_agent_sessions")
        .update({
          status:             "idle",
          last_agent_message: text,
          last_event_at:      now,
        })
        .eq("id", sessionRow.id)

      // ── RUNTIME COMPLIANCE GATE ─────────────────────────────────────────────
      // The agent's system prompt names the compliance gates (Fair Housing, Them-
      // First, TCPA) and instructs the agent to self-filter — but the prompt is
      // advisory. THIS is the runtime enforcement: every agent message passes
      // through lib/kernel/compliance.ts:evaluateOutbound before it can hit the
      // canonical kernel emitter (and therefore before it can reach transparency_
      // updates / portal cards / sequences). A blocked message logs a
      // compliance_event and is NOT emitted. The agent can re-draft on its next
      // idle if the agent's tooling tells it so.
      let complianceAllowed = true
      let complianceViolations: string[] = []
      if (text) {
        try {
          const { evaluateOutbound } = await import("@/lib/kernel/compliance")
          // Best-effort load of the contact so the gate runs the per-contact
          // checks (DNC / TCPA / suppression) when the session entity is a contact.
          // For transaction/listing entities, contact stays undefined and only the
          // brokerage-level gates (Fair Housing, brand voice, Them-First) run.
          let contact: import("@/lib/kernel/types").KernelContact | undefined
          let personaKey: string = "first_time_buyer"
          if (sessionRow.entity_type === "contact") {
            const { data: c } = await svc
              .from("contacts")
              .select("*")
              .eq("id", sessionRow.entity_id as string)
              .maybeSingle()
            if (c) {
              contact = c as unknown as import("@/lib/kernel/types").KernelContact
              personaKey = ((c as { contact_persona?: string | null }).contact_persona) ?? personaKey
            }
          }
          const result = await evaluateOutbound({
            // ActorContext on the kernel uses ActorRole; agent-authored messages run
            // through the gate under the 'isa' role (closest match — automated outbound
            // on behalf of the brokerage). The session's brokerage scopes the
            // brokerage-level gates (brand voice, Fair Housing patterns, signature).
            actorContext: {
              userId:      "system",
              role:        "isa",
              brokerageId: sessionRow.brokerage_id as string,
            } as import("@/lib/kernel/types").ActorContext,
            journeyType:  sessionRow.entity_type === "listing" ? "seller" : "buyer",
            // Persona is the KernelContact contact_persona when entity is a contact;
            // otherwise we use a safe default that won't trigger persona-specific
            // overrides (the brokerage-level gates still apply).
            persona:      personaKey as import("@/lib/kernel/types").Persona,
            messageType:  "email",  // agent drafts are review-then-send; email is the
                                    // gate's narrative-equivalent — closest semantic match.
            content:      text,
            contact,
          })
          complianceAllowed   = result.allowed
          complianceViolations = result.violations ?? []
        } catch (err) {
          console.error("[anthropic-webhook] compliance evaluate failed:", err)
          // Fail closed — if the gate itself errored, treat the agent's draft as blocked.
          complianceAllowed   = false
          complianceViolations = ["compliance evaluator error — message held"]
        }
      }

      // Route through the canonical kernel emitter ONLY when compliance allowed.
      if (text && complianceAllowed) {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        await emitKernelEvent({
          event:       "agent_message_received",
          brokerageId: sessionRow.brokerage_id as string,
          entityType:  sessionRow.entity_type as string,
          entityId:    sessionRow.entity_id as string,
          metadata: {
            anthropic_session_id: sessionId,
            agent_kind:           "deal_coordinator",
            message_preview:      text.slice(0, 400),
            compliance_passed:    true,
          },
        })
      } else if (text && !complianceAllowed) {
        // Log the block. The agent's next idle can re-draft (the agent will see
        // last_agent_message as null after this update — TODO follow-up: surface
        // the violations back to the agent's next session.events.send so it can
        // self-correct). Persist on the session row so admin UI can show why a
        // draft was held.
        await svc.from("managed_agent_sessions")
          .update({
            last_agent_message: `[blocked by compliance] ${complianceViolations.join("; ")}`,
          })
          .eq("id", sessionRow.id)
        console.warn(`[anthropic-webhook] agent draft BLOCKED (session=${sessionId}):`, complianceViolations)
      }
      break
    }

    case "session.status_terminated":
      await svc.from("managed_agent_sessions")
        .update({ status: "terminated", last_event_at: now, ended_at: now })
        .eq("id", sessionRow.id)
      break

    default:
      // Other event types (e.g. session.thread_*, outcome_evaluation_*) are noted but
      // not actioned in the current handler. They can be added incrementally.
      break
  }

  return NextResponse.json({ received: true, eventType, sessionId })
}
