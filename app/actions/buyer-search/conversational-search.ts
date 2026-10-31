"use server"

/**
 * app/actions/buyer-search/conversational-search.ts — THE BUYER'S CONVERSATION DOORS (wave 147,
 * lane 147C, owner ruling 16, contract C10).
 *
 * The SEARCH itself stays at app/actions/portal-nl-search.ts portalNaturalSearchAction (the one
 * buyer search door, gated, paid-call-after-gate). These are the conversational halves that were
 * missing around it — each a distinct capability, none a second search:
 *
 *   buyerConversationTurnAction   a typed or spoken sentence → criteria with per-field provenance,
 *                                 persisted to THE one store, "what you didn't say" questions back
 *   buyerHomeFeedbackAction       saved / not-for-me / tour / a note → the existing kernel reaction
 *                                 (recordBuyerPropertyAction) + learned changes WITH REASONS
 *   decideCriteriaChangeAction    accept a proposal, or undo a change (applied or proposed)
 *   editBuyerCriteriaAction       the buyer corrects one field directly
 *   loadBuyerCriteriaStateAction  criteria chips + open proposals + recent changes (any device)
 *   explainHomeForBuyerAction     "why this home?" in a neighbour's voice, grounded on the fit
 *
 * EVERY EXPORT IS A PUBLIC HTTP ENDPOINT (CLAUDE.md §4) and every one authorizes the same way the
 * search door does: requireContactAccess(contactId) FIRST — the contact themselves (linked user,
 * matching email, accepted invite) or staff in the contact's own brokerage — then the service
 * client, with the TENANT the gate resolved written into every read and write. No tenant, user or
 * agent id is ever taken from the request body.
 *
 * LAW 5: a criteria write is a consequential action (it changes what alerts send and what the AI
 * says), so it runs under withActionLedger (`buyer_search.criteria.update`,
 * `buyer_search.criteria_change.decide`, `buyer_search.home.react`) with a WHY and an idempotency
 * key; a double-submitted turn replays instead of applying twice. A refused claim does not act.
 *
 * THE HUMAN AGENT is told through the manager bus (publishManagerSignal → shopping_agent,
 * `qualification_criteria_captured`, deduped to ONE open signal per contact) and only when
 * shouldNotifyAgent says the change is material or the buyer asked for a tour or for them — never
 * per keystroke.
 */

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess, accessRefusal } from "@/lib/portal/require-contact-access"
import { withActionLedger } from "@/lib/kernel/action-ledger"
import { persistCriteriaChanges, recordStatedCriteriaTurn } from "@/lib/buyer-search/criteria-turn"
import {
  loadBuyerCriteria,
  saveBuyerCriteria,
  loadCriteriaChanges,
  settleCriteriaChange,
  CRITERIA_FIELDS,
  CRITERIA_CHANNELS,
  type BuyerCriteria,
  type CriteriaChannel,
  type CriteriaChangeDraft,
  type CriteriaChangeRow,
  type CriteriaField,
} from "@/lib/buyer-search/buyer-criteria"
import {
  applyConversationTurn,
  applyAcceptedChange,
  applyCorrection,
  applyLearnedChanges,
  revertChange,
  learnFromBehaviour,
  shouldNotifyAgent,
  criteriaChips,
  nextBestExperiences,
  narrateFitExplanation,
  type CriteriaChip,
  type HomeSignal,
  type NextExperience,
} from "@/lib/buyer-search/conversational-search"
import type { ClarifyingQuestion } from "@/lib/buyer-search/conversation-criteria"
import type { CriteriaFit } from "@/lib/buyer-search/explanation-generator"

type Svc = ReturnType<typeof createServiceClient>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A turn's public answer. */
export type ConversationTurnOutcome =
  | {
      ok: true
      criteria: CriteriaChip[]
      changes: Array<CriteriaChangeDraft & { id: string | null }>
      clarifications: ClarifyingQuestion[]
      nextBest: NextExperience[]
      /** Plain sentences: asks no feed filters on, persistence that is waiting on a migration. */
      notes: string[]
      agentNotified: boolean
    }
  | { ok: false; error: string }

interface GateOk { ok: true; svc: Svc; brokerageId: string; actorUserId: string; agentId: string | null }

/**
 * The shared gate (NOT exported — a "use server" file's non-exported helpers are not endpoints).
 * Authorization first; then the contact read bounded by the tenant the gate resolved, with its
 * error read (supabase-js RESOLVES a refusal).
 */
async function gateBuyer(contactId: string): Promise<GateOk | { ok: false; error: string }> {
  if (!UUID_RE.test(contactId ?? "")) return { ok: false, error: accessRefusal("Contact not found") }
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }
  const svc = createServiceClient()
  const { data: contact, error } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id").eq("id", contactId).eq("brokerage_id", access.brokerageId).maybeSingle()
  if (error) {
    console.error("[buyer-conversation] contact read refused:", error.message)
    return { ok: false, error: "We couldn't reach your account just now — please try again." }
  }
  if (!contact) return { ok: false, error: accessRefusal("Contact not found") }
  // users.id → actor_user_id (the ledger's users-class column); agents.id stays agents-class.
  return { ok: true, svc, brokerageId: access.brokerageId, actorUserId: access.userId, agentId: (contact as { agent_id: string | null }).agent_id }
}

const channelOf = (c: unknown): CriteriaChannel =>
  (CRITERIA_CHANNELS as readonly string[]).includes(String(c)) ? (c as CriteriaChannel) : "portal"

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

/** The bus line to the buyer's Shopping Agent — deduped by the bus to one open signal per contact. */
async function tellShoppingAgent(svc: Svc, brokerageId: string, contactId: string, message: string, payload: Record<string, unknown>): Promise<boolean> {
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const r = await publishManagerSignal({
    brokerageId,
    fromManager: "ai_isa",
    toManager: "shopping_agent",
    signalType: "qualification_criteria_captured",
    message,
    entityType: "contact",
    entityId: contactId,
    contactId,
    payload: { source: "buyer_portal_conversation", ...payload },
  }, svc)
  if (!r.ok) console.error("[buyer-conversation] shopping agent signal refused:", r.reason)
  return r.ok
}

/** The ONE ledgered criteria writer (lib/buyer-search/criteria-turn.ts), with this door's actor. */
function persistCriteria(
  g: GateOk, contactId: string, next: BuyerCriteria, drafts: CriteriaChangeDraft[],
  meta: { idempotencyKey: string; trigger: string; channel: CriteriaChannel; reasonDetail: string },
) {
  return persistCriteriaChanges(g.svc, {
    brokerageId: g.brokerageId, contactId, next, drafts, actor: { type: "user", userId: g.actorUserId }, ...meta,
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE TURN
// ═════════════════════════════════════════════════════════════════════════════

export async function buyerConversationTurnAction(input: {
  contactId: string
  text: string
  channel?: "portal" | "mobile" | "voice"
}): Promise<ConversationTurnOutcome> {
  const text = (input.text ?? "").trim().slice(0, 600)
  if (text.length < 2) return { ok: false, error: "Tell me a little about the home you want — area, price, bedrooms, how you live." }
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const channel = channelOf(input.channel)
  const at = new Date().toISOString()

  // THE ONE PARSER + THE ONE LEDGERED WRITER (rules first; the model fills a concrete gap only,
  // booked to the session tenant). The same sentence within the same minute is one turn.
  const turn = await recordStatedCriteriaTurn(g.svc, {
    brokerageId: g.brokerageId, contactId: input.contactId, text, channel,
    actor: { type: "user", userId: g.actorUserId },
    idempotencyKey: `buyer_search.criteria.update:${input.contactId}:${hashOf(text)}:${at.slice(0, 16)}`,
  })
  if (turn.error) return { ok: false, error: "I understood that, but couldn't save it to your search just now — please try again." }
  const { parsed, next, changes, notes } = turn

  const verdict = shouldNotifyAgent({ changes })
  const agentNotified = verdict.notify
    ? await tellShoppingAgent(g.svc, g.brokerageId, input.contactId, `Buyer updated their search in the portal (${verdict.reason})`, { fields: changes.map((c) => c.field), channel })
    : false

  return {
    ok: true,
    criteria: criteriaChips(next),
    changes,
    clarifications: parsed.clarifications.slice(0, channel === "voice" ? 1 : 2),
    nextBest: nextBestExperiences({ resultsCount: 1, clarifications: parsed.clarifications, criteria: next }),
    notes,
    agentNotified,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. FEEDBACK ON A HOME → the kernel reaction + learned changes with reasons
// ═════════════════════════════════════════════════════════════════════════════

export type HomeFeedbackOutcome =
  | {
      ok: true
      applied: Array<CriteriaChangeDraft & { id: string | null }>
      proposals: Array<CriteriaChangeDraft & { id: string | null }>
      criteria: CriteriaChip[]
      /** Where the BBA-gated showing request lives (tour asks only). */
      showingRequestPath: string | null
      agentNotified: boolean
      notes: string[]
    }
  | { ok: false; error: string }

export async function buyerHomeFeedbackAction(input: {
  contactId: string
  /** listings.id, or the search engine's synthetic `ext_<source>_<id>` for a market listing. */
  listingId: string
  kind: "saved" | "dismissed" | "tour_requested" | "feedback"
  /** The buyer's own words ("too small", "no HOA please") — parsed as a SAID turn. */
  note?: string
  channel?: "portal" | "mobile" | "voice"
}): Promise<HomeFeedbackOutcome> {
  const listingId = (input.listingId ?? "").trim()
  if (!listingId || listingId.length > 200) return { ok: false, error: "Which home was that about?" }
  if (!["saved", "dismissed", "tour_requested", "feedback"].includes(input.kind)) return { ok: false, error: "That reaction isn't one I know." }
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const channel = channelOf(input.channel)
  const at = new Date().toISOString()
  const note = (input.note ?? "").trim().slice(0, 400)
  const notes: string[] = []

  // The reaction itself rides the EXISTING kernel writer (saved_properties + lifecycle event +
  // its behaviour-learning hook), ledgered as the buyer's action. A refused claim does not act.
  if (input.kind !== "feedback") {
    const { recordBuyerPropertyAction } = await import("@/lib/kernel/forms")
    const reacted = await withActionLedger(
      {
        brokerageId: g.brokerageId,
        action: "buyer_search.home.react",
        actor: { type: "user", userId: g.actorUserId },
        subject: { type: "contact", id: input.contactId, ref: listingId },
        reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `buyer marked ${input.kind}`,
        idempotencyKey: `buyer_search.home.react:${input.contactId}:${listingId}:${input.kind}:${at.slice(0, 16)}`,
        channel,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "buyer_portal_conversation",
        detail: { listing: listingId, kind: input.kind },
      },
      () => recordBuyerPropertyAction({
        contact_id: input.contactId, listing_id: listingId, interest_level: input.kind as "saved" | "dismissed" | "tour_requested",
        notes: note || undefined, brokerage_id: g.brokerageId, agent_id: g.agentId ?? "",
      }),
      {
        settle: (r) => r.success ? { status: "executed", outcome: input.kind } : { status: "failed", outcome: "reaction_refused", error: r.error ?? null },
        replay: (claim) => ({ success: claim.kind === "replay", error: claim.kind === "refused" ? claim.error : claim.kind === "replay" ? undefined : "Already being saved" }),
      },
    )
    if (!reacted.success) return { ok: false, error: reacted.error ?? "That didn't save — please try again." }
  }

  // ── LEARNING: the buyer's history → changes with reasons ──────────────────
  let current = (await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })) ?? null
  const { data: rows, error: histError } = await g.svc.from("saved_properties")
    .select("id, listing_id, external_property_id, list_price, city, property_type, dismissed, added_to_tour")
    .eq("contact_id", input.contactId).eq("brokerage_id", g.brokerageId)
    .order("saved_at", { ascending: false }).limit(60)
  if (histError) notes.push("Your saved-home history couldn't be read just now, so nothing new was learned from it.")
  const history: HomeSignal[] = ((rows ?? []) as Array<Record<string, any>>).map((r) => ({
    kind: r.dismissed ? "dismissed" : r.added_to_tour ? "toured" : "saved",
    price: typeof r.list_price === "number" ? r.list_price : null,
    city: r.city ?? null,
    propertyType: r.property_type ?? null,
    listingRef: String(r.listing_id ?? r.external_property_id ?? r.id),
  }))
  const prior = await loadCriteriaChanges(g.svc, { brokerageId: g.brokerageId, contactId: input.contactId, statuses: ["proposed", "rejected"], limit: 50 })
  if (prior.note) notes.push(prior.note)

  let drafts: CriteriaChangeDraft[] = []
  if (note) {
    // Their WORDS about a home are a said turn ("needs 4 bedrooms", "no HOA").
    const { parseBuyerCriteria } = await import("@/lib/buyer-search/parse-buyer-criteria")
    const parsed = await parseBuyerCriteria(note, { brokerageId: g.brokerageId, userId: g.actorUserId, allowModelAssist: false })
    const turn = applyConversationTurn(current, parsed, { text: note, channel, at, trigger: "feedback" })
    current = turn.next
    drafts.push(...turn.changes)
  }
  const learned = current
    ? learnFromBehaviour(current, history, { channel, prior: prior.rows.map((r) => ({ field: r.field, proposed: r.proposed, status: r.status })) })
    : []
  drafts.push(...learned)
  const next = current ? applyLearnedChanges(current, learned, at) : null

  let ids: string[] = []
  if (next && drafts.length > 0) {
    const saved = await persistCriteria(g, input.contactId, next, drafts, {
      idempotencyKey: `buyer_search.criteria.update:${input.contactId}:feedback:${hashOf(`${listingId}:${input.kind}:${note}`)}:${at.slice(0, 16)}`,
      trigger: input.kind, channel, reasonDetail: `buyer ${input.kind} ${listingId}${note ? `: ${note}` : ""}`,
    })
    if (saved.error) notes.push("Your reaction was saved, but the search update couldn't be — your agent can adjust it.")
    else { ids = saved.ids; notes.push(...saved.notes) }
  }
  drafts = drafts.map((d, i) => ({ ...d, id: ids[i] ?? null })) as Array<CriteriaChangeDraft & { id: string | null }>

  const verdict = shouldNotifyAgent({ changes: drafts, requested: input.kind === "tour_requested" ? "showing" : null })
  const agentNotified = verdict.notify
    ? await tellShoppingAgent(g.svc, g.brokerageId, input.contactId, `Buyer ${input.kind === "tour_requested" ? "wants to tour a home" : "updated their search"} (${verdict.reason})`, { listing: listingId, kind: input.kind })
    : false

  const withIds = drafts as Array<CriteriaChangeDraft & { id: string | null }>
  return {
    ok: true,
    applied: withIds.filter((d) => d.status === "applied"),
    proposals: withIds.filter((d) => d.status === "proposed"),
    criteria: next ? criteriaChips(next) : [],
    showingRequestPath: input.kind === "tour_requested" ? `/portal/${input.contactId}/showings` : null,
    agentNotified,
    notes,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. ACCEPT / UNDO A CHANGE
// ═════════════════════════════════════════════════════════════════════════════

export async function decideCriteriaChangeAction(input: {
  contactId: string
  changeId: string
  decision: "accept" | "reject"
}): Promise<{ ok: true; criteria: CriteriaChip[]; agentNotified: boolean } | { ok: false; error: string }> {
  if (!UUID_RE.test(input.changeId ?? "")) return { ok: false, error: "That change could not be found." }
  if (input.decision !== "accept" && input.decision !== "reject") return { ok: false, error: "Choose accept or undo." }
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g

  const { data: row, error: rowError } = await g.svc.from("buyer_criteria_changes")
    .select("id, field, previous_value, proposed_value, reason, status, channel")
    .eq("id", input.changeId).eq("brokerage_id", g.brokerageId).eq("contact_id", input.contactId).maybeSingle()
  if (rowError) return { ok: false, error: "Your change history isn't available just now." }
  if (!row) return { ok: false, error: "That change could not be found." }
  const change = row as { field: CriteriaField; previous_value: unknown; proposed_value: unknown; reason: string; status: string; channel: CriteriaChannel }
  if (change.status !== "proposed" && change.status !== "applied") return { ok: false, error: "That change was already decided." }

  const at = new Date().toISOString()
  type Out = { ok: boolean; criteria: BuyerCriteria | null; error: string | null }
  const result = await withActionLedger<Out>(
    {
      brokerageId: g.brokerageId,
      action: "buyer_search.criteria_change.decide",
      actor: { type: "user", userId: g.actorUserId },
      subject: { type: "contact", id: input.contactId, ref: input.changeId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `buyer ${input.decision === "accept" ? "accepted" : "undid"}: ${change.reason}`.slice(0, 300),
      idempotencyKey: `buyer_search.criteria_change.decide:${input.changeId}:${input.decision}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "buyer_portal_conversation",
      detail: { field: change.field, decision: input.decision, prior_status: change.status },
    },
    async () => {
      const settled = await settleCriteriaChange(g.svc, {
        brokerageId: g.brokerageId, contactId: input.contactId, changeId: input.changeId,
        status: input.decision === "accept" ? "accepted" : "rejected", decidedByUserId: g.actorUserId,
      })
      if (!settled.ok) return { ok: false, criteria: null, error: settled.error }
      const current = await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })
      if (!current) return { ok: false, criteria: null, error: "Your saved criteria could not be read" }
      let next: BuyerCriteria = current
      if (input.decision === "accept" && change.status === "proposed") {
        next = applyAcceptedChange(current, { field: change.field, proposed: change.proposed_value, reason: change.reason }, at, change.channel)
      } else if (input.decision === "reject" && change.status === "applied") {
        next = revertChange(current, { field: change.field, previous: change.previous_value, proposed: change.proposed_value }, at, change.channel)
      }
      if (next !== current) {
        const saved = await saveBuyerCriteria(g.svc, { brokerageId: g.brokerageId, contactId: input.contactId, criteria: next })
        if (!saved.ok) return { ok: false, criteria: null, error: saved.error }
      }
      return { ok: true, criteria: next, error: null }
    },
    {
      settle: (r) => r.ok ? { status: "executed", outcome: input.decision } : { status: "failed", outcome: "decision_not_applied", error: r.error },
      replay: (claim) => ({ ok: false, criteria: null, error: claim.kind === "refused" ? claim.error : "That decision was already recorded" }),
    },
  )
  if (!result.ok || !result.criteria) return { ok: false, error: result.error ?? "That didn't save — please try again." }
  // An accepted proposal is now an applied, said value — material fields reach the agent.
  const verdict = shouldNotifyAgent({ changes: input.decision === "accept" && change.status === "proposed" ? [{ field: change.field, status: "applied", provenance: "said" }] : [] })
  const agentNotified = verdict.notify
    ? await tellShoppingAgent(g.svc, g.brokerageId, input.contactId, `Buyer accepted a search change (${verdict.reason})`, { field: change.field })
    : false
  return { ok: true, criteria: criteriaChips(result.criteria), agentNotified }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. A DIRECT CORRECTION
// ═════════════════════════════════════════════════════════════════════════════

/** PURE validation of a buyer-supplied value for one field — shape only, never a tenant or id. */
function validFieldValue(field: CriteriaField, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const list = (max: number) => Array.isArray(value) && value.length <= max && value.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 60)
  switch (field) {
    case "minPrice": case "maxPrice":
      return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000_000) ? { ok: true, value } : { ok: false, error: "Use a price in dollars." }
    case "minBeds": case "minBaths":
      return value === null || (typeof value === "number" && value >= 0 && value <= 20) ? { ok: true, value } : { ok: false, error: "Use a number from 0 to 20." }
    case "listingType":
      return value === "sale" || value === "rent" ? { ok: true, value } : { ok: false, error: "Choose buying or renting." }
    case "zipCodes":
      return Array.isArray(value) && value.length <= 10 && value.every((z) => typeof z === "string" && /^\d{5}$/.test(z)) ? { ok: true, value } : { ok: false, error: "Use five-digit ZIP codes." }
    case "cities": case "propertyTypes": case "mustHaveFeatures": case "dealBreakers":
      return list(10) ? { ok: true, value: (value as string[]).map((v) => v.trim()) } : { ok: false, error: "Use up to 10 short entries." }
    case "lifestyle":
      return { ok: false, error: "Lifestyle asks change by telling me — or remove one by undoing its change." }
  }
}

export async function editBuyerCriteriaAction(input: {
  contactId: string
  field: string
  value: unknown
}): Promise<{ ok: true; criteria: CriteriaChip[]; agentNotified: boolean } | { ok: false; error: string }> {
  if (!(CRITERIA_FIELDS as readonly string[]).includes(input.field)) return { ok: false, error: "That isn't a search field." }
  const field = input.field as CriteriaField
  const checked = validFieldValue(field, input.value)
  if (!checked.ok) return checked
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const at = new Date().toISOString()
  const current = await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })
  const { next, change } = applyCorrection(current, field, checked.value, at, "portal")
  if (!change) return { ok: true, criteria: criteriaChips(next), agentNotified: false }
  const saved = await persistCriteria(g, input.contactId, next, [change], {
    idempotencyKey: `buyer_search.criteria.update:${input.contactId}:edit:${field}:${hashOf(JSON.stringify(checked.value))}:${at.slice(0, 16)}`,
    trigger: "corrected", channel: "portal", reasonDetail: `buyer edited ${field}`,
  })
  if (saved.error) return { ok: false, error: "That didn't save — please try again." }
  const verdict = shouldNotifyAgent({ changes: [change] })
  const agentNotified = verdict.notify
    ? await tellShoppingAgent(g.svc, g.brokerageId, input.contactId, `Buyer edited their search (${verdict.reason})`, { field })
    : false
  return { ok: true, criteria: criteriaChips(next), agentNotified }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE STATE ON ANY DEVICE
// ═════════════════════════════════════════════════════════════════════════════

export async function loadBuyerCriteriaStateAction(input: { contactId: string }): Promise<
  | { ok: true; criteria: CriteriaChip[]; proposals: CriteriaChangeRow[]; recent: CriteriaChangeRow[]; notes: string[] }
  | { ok: false; error: string }
> {
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const current = await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })
  const changes = await loadCriteriaChanges(g.svc, { brokerageId: g.brokerageId, contactId: input.contactId })
  const notes = [current?.note, changes.note].filter((n): n is string => !!n)
  if (current?.saidOverridesColumn?.length) {
    notes.push(`Kept what you said for ${current.saidOverridesColumn.join(", ")} — a learned estimate had replaced it in the saved columns.`)
  }
  return {
    ok: true,
    criteria: current ? criteriaChips(current) : [],
    proposals: changes.rows.filter((r) => r.status === "proposed"),
    recent: changes.rows.filter((r) => r.status === "applied").slice(0, 8),
    notes,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5b. "KEEP WATCHING FOR ME" — the EXISTING alert proposal rail, never a self-activating alert
// ═════════════════════════════════════════════════════════════════════════════

export async function buyerKeepWatchingAction(input: { contactId: string }): Promise<
  { ok: true; proposed: boolean; message: string } | { ok: false; error: string }
> {
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const criteria = await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })
  // The proposal leads with the buyer's OWN words (the said evidence) — the approval card's proof
  // the criteria were stated, not inferred (the no-steering line in conversation-criteria.ts).
  const quotes = Array.from(new Set(Object.values(criteria?.provenance ?? {})
    .filter((p) => p?.source === "said" && typeof p.evidence === "string" && !/^(Accepted:|Edited by|You undid)/.test(p.evidence))
    .map((p) => p!.evidence as string)))
  if (quotes.length === 0) return { ok: false, error: "Tell me what you're looking for first — area, price, bedrooms — and I'll keep watching." }
  let agentUserId: string | null = null
  if (g.agentId) {
    const { data: agentRow, error: agentError } = await g.svc.from("agents").select("user_id").eq("id", g.agentId).maybeSingle()
    if (agentError) console.error("[buyer-conversation] agent read refused:", agentError.message)
    agentUserId = (agentRow as { user_id: string | null } | null)?.user_id ?? null
  }
  const body = quotes.join(". ")
  const ref = `portal-${hashOf(body)}`
  const { proposeWrittenCriteriaAlert } = await import("@/lib/buyer-search/written-criteria-alert")
  // Evidence for the proposal (LAW 5). It stays INACTIVE until the agent approves it on the
  // approval rail; the ledger key is the criteria text, so a double click proposes once.
  const proposed = await withActionLedger<boolean>(
    {
      brokerageId: g.brokerageId,
      action: "buyer_search.alert.propose",
      actor: { type: "user", userId: g.actorUserId },
      subject: { type: "contact", id: input.contactId, ref },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: "buyer asked to keep watching for new matches",
      idempotencyKey: `buyer_search.alert.propose:${input.contactId}:${ref}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "buyer_portal_conversation",
      detail: { said_quotes: quotes.length },
    },
    () => proposeWrittenCriteriaAlert(g.svc, { brokerageId: g.brokerageId, contactId: input.contactId, agentUserId, messageRef: ref, body, channel: "portal" }),
    {
      settle: (ok) => ok ? { status: "executed", outcome: "alert_proposed" } : { status: "skipped", outcome: "not_proposed" },
      // WAVE 147 (147Z — census II.2): a REFUSED claim proposed nothing (fail closed) and is logged as a refusal, never a quiet "no".
      replay: (claim) => { if (claim.kind === "refused") console.error(`[buyerKeepWatching] alert proposal not recorded — the action ledger refused: ${claim.error}`); return false },
    },
  )
  return {
    ok: true,
    proposed,
    message: proposed
      ? "Done — your agent will approve the alert, and new matches will reach you first."
      : "I need at least two concrete details (like area and price) to set up an alert — or one is already waiting for your agent.",
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. "WHY THIS HOME?" — one of OUR listings, in a neighbour's voice
// ═════════════════════════════════════════════════════════════════════════════

export async function explainHomeForBuyerAction(input: { contactId: string; listingId: string }): Promise<
  | { ok: true; headline: string; narrative: string; unknownsSentence: string | null; fit: CriteriaFit; via: "model" | "deterministic"; note: string | null }
  | { ok: false; error: string }
> {
  // Market (external) listings are display-only and not stored; their result already carries its
  // deterministic fit + explanation from the search. Only our own listings are re-read here.
  if (!UUID_RE.test(input.listingId ?? "")) return { ok: false, error: "The explanation shown with this home is the full one for market listings." }
  const g = await gateBuyer(input.contactId)
  if (!g.ok) return g
  const { buyerShoppableListingStatuses } = await import("@/lib/buyer-search/search-engine")
  const { data: listing, error } = await g.svc.from("listings")
    .select("id, address, city, zip, price:list_price, bedrooms, bathrooms, square_feet:sqft, property_type, status, has_pool, has_septic, hoa_dues, lot_size, year_built, public_remarks")
    .eq("id", input.listingId).in("status", buyerShoppableListingStatuses()).is("deleted_at", null).maybeSingle()
  if (error) return { ok: false, error: "That home couldn't be read just now." }
  if (!listing) return { ok: false, error: "That home isn't available to explain." }
  const criteria = await loadBuyerCriteria(g.svc, input.contactId, { brokerageId: g.brokerageId })
  const { explainCriteriaFit } = await import("@/lib/buyer-search/explanation-generator")
  const { emptyCriteria } = await import("@/lib/buyer-search/conversational-search")
  const l = listing as Record<string, any>
  const fit = explainCriteriaFit(l as never, criteria ?? emptyCriteria())
  const facts = { price: l.price, bedrooms: l.bedrooms, bathrooms: l.bathrooms, square_feet: l.square_feet, property_type: l.property_type, city: l.city, year_built: l.year_built }
  const told = await narrateFitExplanation({ brokerageId: g.brokerageId, userId: g.actorUserId, listingLabel: l.address || l.city || "This home", fit, facts })
  return { ok: true, headline: told.headline, narrative: told.narrative, unknownsSentence: told.unknownsSentence, fit, via: told.via, note: told.note }
}
