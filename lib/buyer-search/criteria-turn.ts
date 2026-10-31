/**
 * lib/buyer-search/criteria-turn.ts — THE ONE LEDGERED WRITER OF A BUYER'S CRITERIA CHANGE
 * (wave 147, lane 147C, contract C10: "preferences persist across portal, mobile, email and AI
 * conversation" — one store, and therefore one way into it).
 *
 * Every channel that hears a buyer state what they want ends here:
 *   · the portal turn (typed or tap-to-talk)  app/actions/buyer-search/conversational-search.ts
 *   · inbound email and SMS                    lib/buyer-search/written-criteria-alert.ts
 *   · corrections, feedback, accepted/undone changes (persistCriteriaChanges, same doors)
 * and the telephony voice sweep joins through one line recorded in the lane-147C notes
 * (lib/voice/call-analysis.ts is another lane's file).
 *
 * LAW 5: the store write and its change records run under withActionLedger
 * (`buyer_search.criteria.update`, reason CONVERSATION_RESPONSE, an idempotency key the caller
 * derives from the turn) — a re-delivered webhook or a double tap REPLAYS instead of applying twice,
 * and a refused claim does not write. TENANT: `brokerageId` is always the caller's verified tenant
 * (the portal gate's, or the inbound router's number/contact resolution) — never a body field.
 *
 * NOT server-only, deliberately (like search-engine.ts): scripts/conversational-buyer-guard.ts
 * drives it on the in-memory supabase. Nothing here is exported to a client.
 */
import { withActionLedger } from "@/lib/kernel/action-ledger"
import {
  loadBuyerCriteria,
  saveBuyerCriteria,
  recordCriteriaChanges,
  type BuyerCriteria,
  type CriteriaChangeDraft,
  type CriteriaChannel,
} from "./buyer-criteria"
import { applyConversationTurn } from "./conversational-search"
import type { ParsedBuyerCriteria } from "./parse-buyer-criteria"

type Svc = Parameters<typeof loadBuyerCriteria>[0]

export interface CriteriaActor { type: "user" | "system"; userId?: string | null }

export interface PersistResult { acted: boolean; ids: string[]; notes: string[]; error: string | null }

/**
 * Persist the next criteria + the change drafts that produced them, under the action ledger.
 * `acted:false, error:null` is a REPLAY (this exact change was already saved) — not a failure.
 */
export async function persistCriteriaChanges(
  svc: Svc,
  input: {
    brokerageId: string
    contactId: string
    next: BuyerCriteria
    drafts: CriteriaChangeDraft[]
    actor: CriteriaActor
    idempotencyKey: string
    trigger: string
    channel: CriteriaChannel
    reasonDetail: string
    /** The ledger's client — the in-memory proof passes its own; production uses the service client. */
    ledgerClient?: unknown
  },
): Promise<PersistResult> {
  const { brokerageId, contactId, next, drafts } = input
  return withActionLedger<PersistResult>(
    {
      brokerageId,
      action: "buyer_search.criteria.update",
      actor: { type: input.actor.type, userId: input.actor.userId ?? null },
      subject: { type: "contact", id: contactId },
      reasonCode: "CONVERSATION_RESPONSE",
      reasonDetail: input.reasonDetail.slice(0, 300),
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "buyer_conversation",
      detail: { fields: drafts.map((d) => d.field), trigger: input.trigger, statuses: drafts.map((d) => d.status) },
    },
    async () => {
      const notes: string[] = []
      const saved = await saveBuyerCriteria(svc, { brokerageId, contactId, criteria: next })
      if (!saved.ok) return { acted: false, ids: [], notes, error: saved.error }
      if (saved.note) notes.push(saved.note)
      const rec = await recordCriteriaChanges(svc, { brokerageId, contactId, changes: drafts, actorUserId: input.actor.userId ?? null })
      if (rec.note) notes.push(rec.note)
      return { acted: true, ids: rec.ids, notes, error: null }
    },
    {
      settle: (r) => r.acted
        ? { status: "executed", outcome: `criteria_saved:${drafts.length}` }
        : { status: "failed", outcome: "criteria_not_saved", error: r.error },
      replay: (claim) => ({
        acted: false, ids: [], notes: [],
        error: claim.kind === "replay" ? null : claim.kind === "refused" ? claim.error : "An identical update is already being saved",
      }),
    },
    input.ledgerClient ? { client: input.ledgerClient as never } : undefined,
  )
}

export interface StatedTurnResult {
  parsed: ParsedBuyerCriteria
  next: BuyerCriteria
  changes: Array<CriteriaChangeDraft & { id: string | null }>
  notes: string[]
  /** Set only when a change could not be saved (a replay is not an error). */
  error: string | null
}

/**
 * A buyer STATED something (typed, spoken, emailed, texted): parse it with THE ONE parser, merge it
 * onto the stored criteria with per-field provenance, and persist the change set under the ledger.
 * A turn that states nothing searchable changes nothing and writes nothing.
 */
export async function recordStatedCriteriaTurn(
  svc: Svc,
  input: {
    brokerageId: string
    contactId: string
    text: string
    channel: CriteriaChannel
    actor: CriteriaActor
    idempotencyKey: string
    trigger?: "stated" | "feedback"
    /** false → rules only (inbound messages: no model spend on every "thanks!"). */
    allowModelAssist?: boolean
    ledgerClient?: unknown
  },
): Promise<StatedTurnResult> {
  const { parseBuyerCriteria } = await import("./parse-buyer-criteria")
  const parsed = await parseBuyerCriteria(input.text, {
    brokerageId: input.brokerageId,
    userId: input.actor.userId ?? null,
    allowModelAssist: input.allowModelAssist,
  })
  const current = await loadBuyerCriteria(svc, input.contactId, { brokerageId: input.brokerageId })
  const at = new Date().toISOString()
  const { next, changes } = applyConversationTurn(current, parsed, { text: input.text, channel: input.channel, at, trigger: input.trigger ?? "stated" })
  const notes = [...parsed.notes, ...(current?.note ? [current.note] : [])]
  if (changes.length === 0) return { parsed, next, changes: [], notes, error: null }
  const saved = await persistCriteriaChanges(svc, {
    brokerageId: input.brokerageId, contactId: input.contactId, next, drafts: changes, actor: input.actor,
    idempotencyKey: input.idempotencyKey, trigger: input.trigger ?? "stated", channel: input.channel,
    reasonDetail: `buyer said (${input.channel}): ${input.text}`, ledgerClient: input.ledgerClient,
  })
  notes.push(...saved.notes)
  return { parsed, next, changes: changes.map((c, i) => ({ ...c, id: saved.ids[i] ?? null })), notes, error: saved.error }
}
