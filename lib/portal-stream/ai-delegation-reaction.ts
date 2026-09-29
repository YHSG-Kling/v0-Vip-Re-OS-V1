/**
 * lib/portal-stream/ai-delegation-reaction.ts — THE reaction to `agent.delegated_to_ai`
 * (wave 89, lane 89E — census round 34, event-flow known gap → handler BUILT).
 *
 * THE DEFECT. The agent action queue offers "AI do it" on a portal card
 * (dispositionPortalEventAction mode 'ai_delegate'). The action flipped the row to
 * completed_ai, wrote an activities audit row, and inserted an `agent.delegated_to_ai`
 * lifecycle_events row straight into the table with the comment "so AI ISA / draft
 * generators can pick it up" — but the insert never reached the orchestrator and no
 * handler existed. "AI do it" did nothing; the card just went away.
 *
 * THE REACTION. The AI ISA DRAFTS the delegated reply and PROPOSES it through the ONE
 * governed client-message loop (lib/agents/agent-client-messages.ts::proposeClientMessage
 * — status 'proposed', a human approves in the Command Center, approving sends). Nothing
 * reaches the client without the agent; the agent delegated the WRITING, not the send.
 *
 * COMPLIANCE-FIRST (CLAUDE.md §5): fair housing is in the WRITING prompt, not only in
 * the post-hoc scan; proposeClientMessage appends the outbound-eval findings for the
 * approver and approveClientMessage runs evaluateOutbound before dispatch.
 *
 * SPEND: one generateTextRouted call per delegation (feature portal_ai_delegation,
 * tenant-attributed — ai_tool_usage is the cost ledger).
 *
 * SHAPE (template lib/portal/journey-event-handlers.ts): server-only, service client,
 * tenant = the EVENT row's brokerage_id; the portal row and the contact are read INSIDE
 * that tenant; every refusal is returned, never dropped.
 */
import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { proposeClientMessage } from "@/lib/agents/agent-client-messages"

export interface AiDelegationPayload {
  portal_event_stream_id?: string | null
  source_event_type?: string | null
  agent_action_label?: string | null
}

export interface AiDelegationOutcome { success: boolean; messageId?: string; error?: string }

type PortalRow = {
  id: string
  contact_id: string | null
  transaction_id: string | null
  event_type: string | null
  agent_copy: string | null
  customer_copy: string | null
  agent_action_label: string | null
}

/** PURE: the audience the proposal is addressed to, from the contact's type (CHECK: agent|buyer|lead|seller). */
export function audienceForContactType(contactType: string | null | undefined): "buyer" | "seller" {
  return contactType === "seller" ? "seller" : "buyer"
}

/** PURE: the writing brief — compliance-first, grounded on the card, never salesy. */
export function buildDelegationPrompt(input: {
  contactName: string | null
  audience: "buyer" | "seller"
  agentActionLabel: string | null
  agentCopy: string | null
  customerCopy: string | null
  sourceEventType: string | null
}): { system: string; prompt: string } {
  return {
    system:
      "You are the brokerage's AI ISA drafting a short portal message on behalf of a licensed real estate agent. " +
      "Write in plain, warm, professional language: 2–4 sentences, one clear next step, no pressure, no hype. " +
      "FAIR HOUSING: never reference or imply race, color, religion, national origin, sex, familial status, disability, " +
      "or any protected class; never steer toward or away from neighborhoods or describe who 'belongs' anywhere; " +
      "describe properties and process only. Never quote a home value, commission, or a number the card does not contain. " +
      "Never promise an outcome. Output only the message body.",
    prompt:
      `Client: ${input.contactName ?? "the client"} (${input.audience}).\n` +
      `The agent delegated this action to you: ${input.agentActionLabel ?? "reply to the client"}.\n` +
      `What happened (agent's view): ${input.agentCopy ?? "(none)"}\n` +
      `What the client saw: ${input.customerCopy ?? "(none)"}\n` +
      `Event: ${input.sourceEventType ?? "(unknown)"}\n` +
      "Draft the reply.",
  }
}

/** agent.delegated_to_ai — draft the delegated reply and PROPOSE it (gated, never sent here). */
export async function reactToAgentDelegatedToAi(
  svc: any,
  brokerageId: string,
  payload: AiDelegationPayload,
  deps: { draft?: (brief: { system: string; prompt: string }) => Promise<string> } = {},
): Promise<AiDelegationOutcome> {
  if (!brokerageId) return { success: false, error: "No brokerageId — a delegated reply is never drafted untenanted" }
  const rowId = payload?.portal_event_stream_id ?? null
  if (!rowId) return { success: false, error: "No portal_event_stream_id on the agent.delegated_to_ai event" }

  const { data: row, error: rowErr } = await svc
    .from("portal_event_stream")
    .select("id, contact_id, transaction_id, event_type, agent_copy, customer_copy, agent_action_label")
    .eq("id", rowId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (rowErr) return { success: false, error: `portal_event_stream read refused: ${rowErr.message}` }
  const portal = row as PortalRow | null
  if (!portal) return { success: false, error: `portal event ${rowId} is not in brokerage ${brokerageId}` }
  if (!portal.contact_id) return { success: false, error: "the delegated card has no contact — nothing to draft a client message for" }

  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type")
    .eq("id", portal.contact_id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (contactErr) return { success: false, error: `contact read refused: ${contactErr.message}` }
  if (!contact) return { success: false, error: `contact ${portal.contact_id} is not in brokerage ${brokerageId}` }
  const c = contact as { id: string; first_name: string | null; last_name: string | null; contact_type: string | null }
  const audience = audienceForContactType(c.contact_type)
  const contactName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null

  const brief = buildDelegationPrompt({
    contactName,
    audience,
    agentActionLabel: payload?.agent_action_label ?? portal.agent_action_label,
    agentCopy: portal.agent_copy,
    customerCopy: portal.customer_copy,
    sourceEventType: payload?.source_event_type ?? portal.event_type,
  })

  let body: string
  try {
    body = deps.draft
      ? await deps.draft(brief)
      : (await generateTextRouted({ feature: "portal_ai_delegation", brokerageId, system: brief.system, prompt: brief.prompt, maxTokens: 400 })).text
  } catch (e) {
    return { success: false, error: `draft refused: ${(e as Error).message}` }
  }
  body = (body ?? "").trim()
  if (!body) return { success: false, error: "the model returned an empty draft — nothing proposed" }

  const proposed = await proposeClientMessage(
    {
      brokerageId,
      agentKind: "ai_isa",
      entityType: "portal_event_stream",
      entityId: portal.id,
      recipientContactId: c.id,
      audience,
      channel: "portal",
      subject: payload?.agent_action_label ?? portal.agent_action_label ?? "A quick update",
      body,
      rationale:
        `Agent delegated "${payload?.agent_action_label ?? portal.agent_action_label ?? "this card"}" to the AI ISA ` +
        `(portal event ${portal.id}, ${payload?.source_event_type ?? portal.event_type ?? "event"}). Drafted from the card's facts only; ` +
        "gated — the agent approves before anything reaches the client.",
    },
    svc,
  )
  if (!proposed.ok) return { success: false, error: `proposal refused: ${proposed.error ?? "unknown"}` }
  return { success: true, messageId: proposed.id }
}
