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
  recordBuyerUtterance,
  defaultCriteriaConsent,
  type CriteriaConsent,
  type BuyerCriteria,
  type CriteriaChangeDraft,
  type CriteriaChannel,
  type UtteranceSourceKind,
} from "./buyer-criteria"
import { applyConversationTurn, type CriteriaStatement } from "./conversational-search"
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

/**
 * PURE (wave 148D, ruling 9): the statement record of one turn — the buyer's literal words, the one
 * parser's structured interpretation, its confidence, and the consent basis. Carried on every change row
 * (history) and every `said` provenance entry (the store) this turn writes.
 */
function criteriaStatementOf(parsed: ParsedBuyerCriteria, text: string, consent: CriteriaConsent | null, sourceRef: string | null): CriteriaStatement {
  return {
    literal: (text ?? "").trim().slice(0, 600),
    interpretation: {
      criteria: parsed.criteria,
      lifestyle: parsed.lifestyle.map((a) => ({ kind: a.kind, label: a.label, direction: a.direction, target: a.target })),
      dealBreakers: parsed.dealBreakers,
      gaps: parsed.gaps,
      via: parsed.via,
      signalCount: parsed.signalCount,
    },
    confidence: parsed.confidence,
    consent: consent ? { ...consent, sourceRef: consent.sourceRef ?? sourceRef } : null,
  }
}

export interface StatedTurnResult {
  /** Wave 148D: the statement record this turn wrote (literal, interpretation, confidence, consent). */
  statement?: CriteriaStatement
  parsed: ParsedBuyerCriteria
  next: BuyerCriteria
  changes: Array<CriteriaChangeDraft & { id: string | null }>
  notes: string[]
  /** Set only when a change could not be saved (a replay is not an error). */
  error: string | null
  /** Wave 148E (ruling 9): the buyer's words as recorded — null when nothing searchable was said or m916 is absent. */
  utteranceId: string | null
}

/** The source kind a channel's turn is recorded under when the door does not name one (m916 vocabulary). */
const SOURCE_KIND_BY_CHANNEL: Record<CriteriaChannel, UtteranceSourceKind> = {
  portal: "portal_turn", mobile: "portal_turn", email: "inbound_email", sms: "inbound_sms",
  voice: "call_transcript", ai_chat: "intent_interface", agent: "agent_entry", system: "system_import",
}

/**
 * The consent basis a channel PROVES by itself — and only those (consent is never fabricated): the buyer typed in their
 * own authenticated portal, or the buyer wrote to us. A call, an AI conversation, an agent's entry or a system import
 * carries whatever basis the door STATES, else none ("not stated", recorded as NULL with a note).
 */
// TOMBSTONE (wave 148, integrator): `factualConsentFor` MERGED onto lib/buyer-search/buyer-criteria.ts defaultCriteriaConsent — one
// default for one consent vocabulary (lanes 148D and 148E each wrote one; CLAUDE.md §6).

/** Did the buyer state anything searchable (criteria, a lifestyle ask, a deal-breaker)? */
const statedSomething = (p: ParsedBuyerCriteria) =>
  p.signalCount > 0 || (p.criteria.features?.length ?? 0) > 0 || p.lifestyle.length > 0 || p.dealBreakers.length > 0

/**
 * A buyer STATED something (typed, spoken, emailed, texted): parse it with THE ONE parser, merge it
 * onto the stored criteria with per-field provenance, and persist the change set under the ledger.
 * A turn that states nothing searchable changes nothing and writes nothing.
 *
 * WAVE 148E (owner ruling 9 — "buyers' words are recorded; call transcripts save to the criteria store — literal
 * wording, structured interpretation, confidence, consent; corrections keep history"): a turn that states something is
 * ALSO recorded whole (buyer_criteria_utterances, m916) — the literal words, the parse, its confidence and the consent
 * basis — idempotent on its source (the call id / message id / turn key), and each change row it produced carries
 * `evidence.utterance_id`. A turn that only CONFIRMS what was already stored (no field changes, provenance upgraded to
 * "said") is now persisted too: before, the upgraded provenance was computed and dropped.
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
    /** Wave 148E: where the words came from (defaults by channel) and its stable reference (defaults to the idempotency key). */
    source?: { kind?: UtteranceSourceKind; ref?: string | null }
    /** Wave 148D spelling of the same reference (`voice_call:<id>`); `source.ref` wins when both are given. */
    sourceRef?: string | null
    /** Wave 148E: the consent basis the door STATES (e.g. the call's recording disclosure). Never invented here. */
    consent?: CriteriaConsent | null
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
  // ONE default, ONE vocabulary (integrator merge of lanes 148D + 148E): the door's stated basis, else the channel's
  // FACTUAL default, else null ("not stated"). The same object feeds the statement view AND the utterance record.
  const sourceRef = input.source?.ref ?? input.sourceRef ?? input.idempotencyKey
  const consent: CriteriaConsent | null = input.consent !== undefined ? input.consent : defaultCriteriaConsent(input.channel, at, sourceRef, input.actor)
  const statement = criteriaStatementOf(parsed, input.text, consent, sourceRef)
  const { next, changes } = applyConversationTurn(current, parsed, { text: input.text, channel: input.channel, at, trigger: input.trigger ?? "stated", statement })
  const notes = [...parsed.notes, ...(current?.note ? [current.note] : [])]
  if (!statedSomething(parsed)) return { statement, parsed, next, changes: [], notes, error: null, utteranceId: null }

  // THE BUYER'S WORDS, recorded whole with what we understood (ruling 9).
  if (!consent) notes.push("No consent basis was stated for these words — recorded as 'not stated', never assumed.")
  const utterance = await recordBuyerUtterance(svc, {
    brokerageId: input.brokerageId,
    contactId: input.contactId,
    draft: {
      channel: input.channel,
      sourceKind: input.source?.kind ?? SOURCE_KIND_BY_CHANNEL[input.channel],
      sourceRef,
      literal: input.text,
      interpretation: {
        criteria: parsed.criteria,
        lifestyle: parsed.lifestyle.map((l) => ({ kind: l.kind, label: l.label, direction: l.direction, target: l.target, maxMinutes: l.maxMinutes, minAcres: l.minAcres ?? null, lotMinimum: l.lotMinimum ?? null, evidence: l.evidence })),
        deal_breakers: parsed.dealBreakers,
        priority: parsed.priority,
        gaps: parsed.gaps,
        via: parsed.via,
        signal_count: parsed.signalCount,
      },
      confidence: parsed.confidence,
      consent: consent ? { basis: consent.basis, ref: consent.ref ?? consent.sourceRef ?? null } : null,
      appliedChangeCount: changes.length,
      createdByUserId: input.actor.userId ?? null,
    },
  })
  if (utterance.note) notes.push(utterance.note)
  const drafts = utterance.id ? changes.map((c) => ({ ...c, evidence: { ...c.evidence, utterance_id: utterance.id } })) : changes

  const provenanceMoved = JSON.stringify(current?.provenance ?? {}) !== JSON.stringify(next.provenance ?? {})
  if (drafts.length === 0 && !provenanceMoved) return { statement, parsed, next, changes: [], notes, error: null, utteranceId: utterance.id }
  const saved = await persistCriteriaChanges(svc, {
    brokerageId: input.brokerageId, contactId: input.contactId, next, drafts, actor: input.actor,
    idempotencyKey: input.idempotencyKey, trigger: input.trigger ?? "stated", channel: input.channel,
    reasonDetail: `buyer said (${input.channel}): ${input.text}`, ledgerClient: input.ledgerClient,
  })
  notes.push(...saved.notes)
  return { statement, parsed, next, changes: drafts.map((c, i) => ({ ...c, id: saved.ids[i] ?? null })), notes, error: saved.error, utteranceId: utterance.id }
}
