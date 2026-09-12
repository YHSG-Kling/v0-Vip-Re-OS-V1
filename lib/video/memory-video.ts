/**
 * lib/video/memory-video.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY VIDEO — the offer, and the capture of the seller's own words.
 *
 * OWNER RULING, verbatim: "memory video is for sellers that have been in their
 * home more than 20 years which is a seller dictated video going over the history
 * of the house so the family has it (this is a special service that can be
 * offered)."
 *
 * ORPHAN DOCTRINE §1.2 — the capability is wanted and no duplicate existed, so
 * the missing halves are BUILT. Before m565 the product was one word on a CHECK
 * and one persona predicate: `memory_video` was admitted by
 * ai_video_projects_video_type_check and nothing in the tree ever wrote it except
 * (a) the anniversary reactor, which was borrowing the name for a different
 * product, and (b) the manual video wizard, which would have had a MODEL write
 * the script — the one thing this product may never be. There was no eligibility
 * rule, no offer, no capture, and no consumer.
 *
 * WHAT THIS FILE OWNS
 *   offerMemoryVideo            — the OFFER. Gated agent proposal, never a send.
 *   recordMemoryVideoDictation  — the CAPTURE. The seller's words become the row.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *   · The eligibility rule and the authorship boundary are PURE and live in
 *     lib/video/memory-video-gate.ts, so a guard can exercise every arm of them
 *     without a database. This file does I/O and calls them.
 *   · Tenure parsing. lib/avm/provider-chain.ts::parseLengthOfResidence is the
 *     ONE parser of `contacts.length_of_residence` in this repo (§6) — the same
 *     survivor lib/predictive-listing/signal-generators.ts derives tenure with,
 *     down to the fall back onto a prior purchase's close_date. No second parser
 *     was written here and none should be.
 *
 * NO MODEL IS CALLED IN THIS FILE. That is not an omission — see MODEL_MAY /
 * MODEL_MAY_NOT in the gate module. A family history the seller dictates must not
 * be quietly replaced by generated prose, for the same reason CLAUDE.md §5
 * forbids model-authored material reaching a licensed appraiser: the output is
 * somebody else's account, and a model imitating it is a forgery the recipient
 * has no way to detect.
 *
 * TENANCY. Both entry points take an already-gated `brokerageId` — resolved from
 * the SESSION by app/actions/video/memory-video.ts, never from a request body
 * (CLAUDE.md §4). Every read below is additionally filtered on it, so a contact
 * id from another tenant matches nothing rather than leaking a row.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { parseLengthOfResidence } from "@/lib/avm/provider-chain"
import {
  assembleSellerDictatedScript,
  assessMemoryVideoTenure,
  isSellerAuthored,
  qualifiesForMemoryVideo,
  MEMORY_VIDEO_MIN_TENURE_YEARS,
  MEMORY_VIDEO_PROMPTS,
  type MemoryVideoTenureVerdict,
  type SellerDictatedSegment,
} from "@/lib/video/memory-video-gate"

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** The rationale tag that makes the offer idempotent per contact. */
export const MEMORY_VIDEO_OFFER_TAG = "MEMORY VIDEO OFFER"

export interface MemoryVideoOfferResult {
  ok: boolean
  status: "offered" | "already_offered" | "not_eligible" | "suppressed" | "failed"
  /** agent_client_messages.id when a proposal was filed. */
  proposalId?: string
  tenureYears?: number | null
  reason: string
}

export interface MemoryVideoCaptureResult {
  ok: boolean
  status: "captured" | "not_eligible" | "refused" | "failed"
  videoProjectId?: string
  /** Chapters still unrecorded — the AGENT's to-do, never the model's to fill. */
  missing?: string[]
  reason: string
}

interface ContactRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  first_name: string | null
  last_name: string | null
  contact_type: string | null
  contact_persona: string | null
  length_of_residence: string | null
  video_opt_out: boolean | null
  address: string | null
}

const CONTACT_COLUMNS =
  "id, brokerage_id, agent_id, first_name, last_name, contact_type, contact_persona, " +
  "length_of_residence, video_opt_out, address"

/**
 * Tenure for THIS contact, through the one survivor parser.
 *
 * `contacts.length_of_residence` first (the enrichment band the seller's own
 * record carries), then years since the most recent CLOSED purchase — the exact
 * fallback lib/predictive-listing/signal-generators.ts::runTenureEquityGenerator
 * uses, restated against one contact instead of a batch. Neither available →
 * null, which assessMemoryVideoTenure refuses.
 */
async function resolveTenureYears(
  svc: ReturnType<typeof createServiceClient>,
  contact: ContactRow,
): Promise<number | null> {
  const parsed = parseLengthOfResidence(contact.length_of_residence)
  if (parsed != null) return parsed

  const { data, error } = await svc
    .from("transactions")
    .select("close_date")
    .eq("contact_id", contact.id)
    .eq("status", "closed")
    .not("close_date", "is", null)
    .order("close_date", { ascending: false })
    .limit(1)
  // supabase-js RESOLVES refusals (CLAUDE.md §3). A refused read is NOT "no
  // prior purchase" — it is "we could not look", and both land on null here, so
  // the refusal is logged rather than laundered into a silent eligibility answer.
  if (error) {
    console.error("[memory-video] prior-purchase read refused:", error.message)
    return null
  }
  const closeDate = (data?.[0] as { close_date?: string | null } | undefined)?.close_date
  if (!closeDate) return null
  const years = (Date.now() - new Date(closeDate).getTime()) / MS_PER_YEAR
  return Number.isFinite(years) && years > 0 ? years : null
}

/**
 * THE OFFER — "a special service that CAN BE OFFERED", so it is proposed to the
 * agent and never auto-sent to the client.
 *
 * The proposal lands on `agent_client_messages` at status 'proposed' through the
 * existing proposeClientMessage rail (the same one lib/kernel/anniversary-equity.ts
 * uses for the gated anniversary note), which means it inherits a real reader: the
 * mobile approval queue, the manager approval cron and approveClientMessage. A
 * human decides; nothing here delivers anything.
 *
 * WHY listing_concierge IS THE agentKind: the recipient is a SELLER on the way to
 * listing, and conciergeForSide routes the seller side there.
 *
 * IDEMPOTENT per contact on the rationale tag — re-running the sweep does not
 * pile a second offer onto the same family.
 */
export async function offerMemoryVideo(input: {
  brokerageId: string
  contactId: string
  /** Optional override; defaults to the contact's own assigned agent. */
  agentRecordId?: string | null
}): Promise<MemoryVideoOfferResult> {
  if (!input.brokerageId || !input.contactId) {
    return { ok: false, status: "failed", reason: "brokerageId + contactId required" }
  }
  const svc = createServiceClient()

  const { data: row, error: contactErr } = await svc
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("id", input.contactId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (contactErr) return { ok: false, status: "failed", reason: `contact read: ${contactErr.message}` }
  const contact = (row as ContactRow | null) ?? null
  if (!contact) return { ok: false, status: "failed", reason: "contact not found in this brokerage" }

  if (contact.video_opt_out) {
    return { ok: true, status: "suppressed", reason: "contact has video_opt_out=true" }
  }

  // TWO QUESTIONS, IN ORDER, EACH WITH ITS OWN PREDICATE (§6).
  // 1. Is this the situation? — the persona the client declared. Never age.
  const situation = qualifiesForMemoryVideo(contact.contact_persona)
  // 2. Does the owner's rule admit them? — tenure, and it fails closed.
  const tenure: MemoryVideoTenureVerdict = assessMemoryVideoTenure(
    await resolveTenureYears(svc, contact),
  )
  if (!tenure.eligible) {
    return { ok: true, status: "not_eligible", tenureYears: tenure.tenureYears, reason: tenure.reason }
  }

  const firstName = contact.first_name ?? "your client"
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  // Idempotency: one standing offer per contact. The tag lives in the rationale
  // because that is the field the anniversary rail already dedupes on.
  const { data: existing, error: existingErr } = await svc
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .eq("recipient_contact_id", input.contactId)
    .like("rationale", `%${MEMORY_VIDEO_OFFER_TAG}%`)
    .limit(1)
  if (existingErr) return { ok: false, status: "failed", reason: `offer lookup: ${existingErr.message}` }
  if (existing && existing.length > 0) {
    return {
      ok: true, status: "already_offered", tenureYears: tenure.tenureYears,
      reason: `a memory-video offer already stands for this contact (${(existing[0] as { id: string }).id})`,
    }
  }

  const years = Math.floor(tenure.tenureYears ?? MEMORY_VIDEO_MIN_TENURE_YEARS)
  const body =
    `${firstName}, before the house goes on the market I'd like to offer you something we only do for ` +
    `families who have been somewhere a long time. We record the story of the house in YOUR words — when ` +
    `you moved in, what you changed, who grew up here, what you want remembered — and you keep the film. ` +
    `It is yours and your family's, not a marketing piece, and nothing goes in it that you did not say. ` +
    `It takes about an hour, and I can bring the questions to you.`

  const rationale =
    `${MEMORY_VIDEO_OFFER_TAG} — ${years} years in the home (threshold ${MEMORY_VIDEO_MIN_TENURE_YEARS}+). ` +
    `${tenure.reason} Persona signal: ${situation ? "downsize/senior — matches" : "no matching persona on file, tenure alone qualifies them"}. ` +
    `SELLER-DICTATED: if they accept, capture their answers to the ${MEMORY_VIDEO_PROMPTS.length} chapter questions ` +
    `and file them through recordMemoryVideoDictation. The platform will not write this script and must not be asked to.`

  const proposed = await proposeClientMessage({
    brokerageId:        input.brokerageId,
    agentKind:          "listing_concierge",
    entityType:         "contact",
    entityId:           input.contactId,
    recipientContactId: input.contactId,
    // audience 'agent' — the SAME shape lib/kernel/anniversary-equity.ts files:
    // the BODY is the ready-to-send note to the seller, and approving it is what
    // delivers it to their portal via the recipient contact. The offer is made to
    // the agent first because the ruling says this service is OFFERED, and an
    // offer that auto-sends is not an offer.
    audience:           "agent",
    subject:            `Memory video — ${years} years in the home`,
    body,
    rationale,
    channel:            "portal",
  }, svc)
  if (!proposed.ok) {
    return { ok: false, status: "failed", reason: `proposal: ${proposed.error ?? "insert failed"}` }
  }

  return {
    ok: true, status: "offered", proposalId: proposed.id, tenureYears: tenure.tenureYears,
    reason: `offer proposed to the agent for approval — ${tenure.reason}`,
  }
}

/**
 * THE CAPTURE — the seller's words become the project row.
 *
 * `script_content` is a concatenation of `sellerWords` produced by the PURE
 * assembler and nothing else, and the row is stamped so a later consumer can
 * verify that without trusting this comment:
 *   video_type       = 'memory_video'   (m565 — its own product, not the anniversary)
 *   is_ai_generated  = false            (the column exists and defaults TRUE)
 *   authored_by      = 'seller'         (video_metadata; isSellerAuthored reads it)
 *   dictation        = the segments, each with its own capture provenance
 *
 * Re-running with more segments UPDATES the same project rather than filing a
 * second one, so a seller who records the last two chapters next week ends up
 * with one film, not two. The row reaches 'script_ready' only when every chapter
 * has been dictated; a partial capture stays at 'draft' with the outstanding
 * chapters named — which is the honest state, and the one thing the platform must
 * never do is finish those chapters itself.
 */
export async function recordMemoryVideoDictation(input: {
  brokerageId: string
  contactId: string
  /** agents.id. NOT users.id — the two id spaces are disjoint (CLAUDE.md §3). */
  agentRecordId: string
  segments: readonly SellerDictatedSegment[]
}): Promise<MemoryVideoCaptureResult> {
  if (!input.brokerageId || !input.contactId || !input.agentRecordId) {
    return { ok: false, status: "failed", reason: "brokerageId + contactId + agentRecordId required" }
  }
  const svc = createServiceClient()

  const { data: row, error: contactErr } = await svc
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("id", input.contactId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (contactErr) return { ok: false, status: "failed", reason: `contact read: ${contactErr.message}` }
  const contact = (row as ContactRow | null) ?? null
  if (!contact) return { ok: false, status: "failed", reason: "contact not found in this brokerage" }

  // THE GATE RUNS AGAIN AT CAPTURE, not only at offer. An offer can sit in the
  // approval queue for weeks and an eligibility that was never established must
  // not become established by the passage of a proposal through a queue.
  const tenure = assessMemoryVideoTenure(await resolveTenureYears(svc, contact))
  if (!tenure.eligible) {
    return { ok: true, status: "not_eligible", reason: tenure.reason }
  }

  const assembled = assembleSellerDictatedScript(input.segments)
  if (!assembled.ok) {
    return { ok: false, status: "refused", missing: assembled.missing, reason: assembled.reason }
  }

  const complete = assembled.missing.length === 0
  const title = `Memory video — ${[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "seller"}`
  const metadata = {
    authored_by:  "seller" as const,
    dictation:    input.segments,
    chapters:     assembled.chapters,
    missing:      assembled.missing,
    tenure_years: tenure.tenureYears,
    property_address: contact.address ?? null,
    captured_by_agent_id: input.agentRecordId,
  }

  const { data: existing, error: existingErr } = await svc
    .from("ai_video_projects")
    .select("id, script_content, video_metadata")
    .eq("brokerage_id", input.brokerageId)
    .eq("contact_id", input.contactId)
    .eq("video_type", "memory_video")
    .limit(1)
  if (existingErr) return { ok: false, status: "failed", reason: `project lookup: ${existingErr.message}` }

  // ADOPT ONLY A ROW THIS RAIL WROTE (wired 2026-09-03). Before m565 the
  // anniversary reactor borrowed the memory_video name, and the manual wizard
  // once offered it as a MODEL-written type; a row like that carries a script
  // with no seller stamp. Overwriting it here would launder an authored script
  // under the seller's name (the update stamps authored_by='seller'). So a row
  // that already holds words but cannot prove they are the seller's is REFUSED
  // rather than adopted — the agent is told which row, and nothing is written.
  {
    const prior = (existing?.[0] ?? null) as { id: string; script_content?: string | null; video_metadata?: unknown } | null
    if (prior && (prior.script_content ?? "").trim().length > 0 && !isSellerAuthored(prior.video_metadata)) {
      return {
        ok: false, status: "refused", missing: assembled.missing,
        reason: `refused: an existing memory_video project (${prior.id}) for this seller holds a script that is not provably seller-authored — it was not written by this capture rail and will not be overwritten under the seller's name. Have an admin retire that row first.`,
      }
    }
  }

  const shared = {
    title,
    script_content:  assembled.script,
    status:          complete ? "script_ready" : "draft",
    approval_status: "draft",
    is_ai_generated: false,
    usage_intent:    "public_marketing",
    audience_type:   "customer_facing",
    video_metadata:  metadata,
  }

  if (existing && existing.length > 0) {
    const id = (existing[0] as { id: string }).id
    // An UPDATE that matches NOTHING resolves with error=null and is
    // byte-identical to one that worked (CLAUDE.md §3), so the rows are COUNTED.
    const { data: updated, error: updErr } = await svc
      .from("ai_video_projects")
      .update(shared)
      .eq("id", id)
      .select("id")
    if (updErr) return { ok: false, status: "failed", reason: `project update: ${updErr.message}` }
    if (!updated || updated.length === 0) {
      return { ok: false, status: "failed", reason: `project ${id} matched no row on update — the capture was not stored` }
    }
    return {
      ok: true, status: "captured", videoProjectId: id, missing: assembled.missing,
      reason: assembled.reason,
    }
  }

  const { data: created, error: insErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id: input.brokerageId,
      agent_id:     input.agentRecordId,
      contact_id:   input.contactId,
      video_type:   "memory_video",
      ...shared,
    })
    .select("id")
    .single()
  if (insErr || !created) {
    return { ok: false, status: "failed", reason: `project insert: ${insErr?.message ?? "no row returned"}` }
  }
  return {
    ok: true, status: "captured", videoProjectId: (created as { id: string }).id,
    missing: assembled.missing, reason: assembled.reason,
  }
}
