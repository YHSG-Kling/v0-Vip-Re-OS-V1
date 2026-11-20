// lib/ads/audience-reengagement.ts
//
// CONTRACT C2 — 1:1 AD RE-ENGAGEMENT WITH AN AUDIENCE (wave 146, lane 146E; owner ruling 2, 2026-10-29: "Arbiter …
// should do 1:1 ad follow up with audiences" — "It may recommend audience sync / retargeting / personalized creative
// for an identity-matched, consented audience. Never spam, never impersonate.").
//
// requestAudienceReengagement({ brokerageId, partyIds, basis, creativeHint? }) is the arbiter's (lane 146B) and a
// person's way to ask for it. It RECOMMENDS — it never uploads and never spends:
//
//   parties → identity match (each is THIS tenant's contact, or a lead already converted to one, with a hashable
//   email / phone) → consent (the ONE PII-share gate lib/ads/audience-eligibility.ts isAudienceUploadEligible, plus the
//   population floor syncAudience applies: e-mail on file + tcpa_consent) → fair housing (the basis is a closed WHY
//   vocabulary; the rule passes the ONE protected-class refusal assertAudienceSegmentationAllowed) → entitlement
//   (mayUseAndAfford app.access — fail closed) → credentials (the platform's connected account; no request without
//   one — "no launch without permitted credentials") → authority (lib/kernel/approval-authority.ts approverFor,
//   contract C5 — the owner, or the brokerage where policy requires) → a DRAFT audience (status pending_review, rule
//   reengagement_parties) + ONE approval_items request (pending) + the approver told → evidence (withActionLedger).
//
// The upload happens ONLY through lib/kernel/ads.ts syncAudience — whose own gates (consent basis, fair housing,
// persona, source rule) all run again — and only after a permitted person approved (reengagementApprovalGate below,
// read at the upload door). Budget: an audience upload spends nothing on Meta / Google / StackAdapt; spend starts only
// at a human-approved campaign launch through the Ads Manager's existing clamp (MAX_AD_DAILY_BUDGET_USD).
// One request per (basis, party set) is open at a time — a repeat returns the open one (idempotent, never a second
// audience of the same people).

import { createHash } from "node:crypto"
import { AUDIENCE_CONSENT_COLUMNS, isAudienceUploadEligible } from "@/lib/ads/audience-eligibility"
import { hashMatchKey } from "@/lib/ads/connectors/pii"
import { REENGAGEMENT_MAX_PARTIES } from "@/lib/ads/audience-source-rules"
import { assertAudienceSegmentationAllowed } from "@/lib/lead-governance/protected-class-signals"
import { approverFor, requirePublishApprover, type ApproverScope } from "@/lib/kernel/approval-authority"

type Db = { from: (table: string) => any }

/** WHY a re-engagement is asked for — a first-party action or relationship moment, NEVER a characteristic of the
 *  person (one vocabulary, §6; anything else is refused). */
export const REENGAGEMENT_BASES = [
  "inbound_ad_response",        // they answered an ad (lead form, reply) and went quiet
  "inbound_social_response",    // they commented / messaged on social and went quiet
  "lead_magnet_engagement",     // they asked for a guide / report / video
  "portal_activity",            // their own portal activity (saved search, viewed homes)
  "conversation_reengagement",  // a conversation they started stalled
  "listing_interest",           // they asked about a listing
  "past_client_reconnect",      // a past client of this brokerage
] as const
export type ReengagementBasis = (typeof REENGAGEMENT_BASES)[number]

/** approval_items.item_type of a re-engagement request (the ONE approval queue reads it as a legacy row). */
export const AUDIENCE_REENGAGEMENT_ITEM_TYPE = "ad_audience_reengagement"

/** The platforms whose connector really uploads a hashed CRM audience (lib/ads/connectors/*: pushCustomAudience). */
const REENGAGEMENT_PLATFORMS = ["facebook", "instagram", "google", "stackadapt"] as const
type ReengagementPlatform = (typeof REENGAGEMENT_PLATFORMS)[number]

export type ReengagementParty = string | { kind: "contact" | "lead" | "platform_prospect"; id: string }

export interface AudienceReengagementInput {
  /** The VERIFIED tenant — the session's, or the record's own (the arbiter acts on a tenant-owned record). */
  brokerageId: string
  /** contacts.id strings, or { kind, id } — a lead resolves to its contact; a platform prospect is never a tenant audience. */
  partyIds: ReadonlyArray<ReengagementParty>
  basis: ReengagementBasis
  /** Direction for the human who approves (the creative itself goes through the ONE creative approval queue). */
  creativeHint?: string | null
  /** Default facebook (Meta). Must be a platform whose connector uploads a hashed CRM audience. */
  platform?: ReengagementPlatform
  /** Who asks: the arbiter (manager) or a person. Default the arbiter (ai_isa). */
  requestedBy?: { type: "manager"; managerKey: string } | { type: "user"; userId: string }
  /** The owning agent / team when the caller knows it (else derived from the contacts' one agent, else the brokerage). */
  scope?: ApproverScope
  client?: Db
  now?: Date
  /** Test seams — default to the real survivors. */
  deps?: {
    entitled?: (brokerageId: string) => Promise<{ allowed: boolean; reason?: string }>
    connected?: (brokerageId: string, platform: string) => Promise<boolean>
    ledger?: false
  }
}

export interface ReengagementRefusal { partyId: string; reason: string }

export type AudienceReengagementResult =
  | { ok: true; status: "pending_approval"; reused: boolean; audienceId: string; approvalItemId: string; admitted: number; refused: ReengagementRefusal[]; approverUserIds: string[]; brokerageApprovalRequired: boolean; platform: ReengagementPlatform }
  | { ok: false; reason: string; refused: ReengagementRefusal[] }

async function db(client?: Db): Promise<Db> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Db
}

function partyOf(p: ReengagementParty): { kind: "contact" | "lead" | "platform_prospect"; id: string } {
  return typeof p === "string" ? { kind: "contact", id: p } : p
}

/**
 * THE C2 DOOR. Recommends a 1:1 re-engagement audience for identity-matched, consented parties and files it for the
 * person who may approve it. Never uploads, never spends, never launches.
 */
export async function requestAudienceReengagement(input: AudienceReengagementInput): Promise<AudienceReengagementResult> {
  const refused: ReengagementRefusal[] = []
  if (!input.brokerageId) return { ok: false, reason: "no tenant — a re-engagement audience belongs to one brokerage", refused }
  if (!(REENGAGEMENT_BASES as readonly string[]).includes(input.basis)) {
    return { ok: false, reason: `basis '${String(input.basis)}' is not a re-engagement WHY (${REENGAGEMENT_BASES.join(", ")}) — an audience is never chosen by a characteristic`, refused }
  }
  const platform: ReengagementPlatform = input.platform ?? "facebook"
  if (!(REENGAGEMENT_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, reason: `'${String(platform)}' does not upload a hashed CRM audience`, refused }
  const parties = (input.partyIds ?? []).map(partyOf)
  if (parties.length === 0) return { ok: false, reason: "no parties named — re-engagement is 1:1, never 'everyone'", refused }
  if (parties.length > REENGAGEMENT_MAX_PARTIES) return { ok: false, reason: `${parties.length} parties named — a re-engagement request names at most ${REENGAGEMENT_MAX_PARTIES}`, refused }

  try {
    const svc = await db(input.client)

    // ── entitlement (fail closed) ──
    const entitled = input.deps?.entitled
      ? await input.deps.entitled(input.brokerageId)
      : await (async () => { const { mayUseAndAfford } = await import("@/lib/billing/billing-access"); return mayUseAndAfford({ brokerageId: input.brokerageId, capability: "app.access", client: svc }) })()
    if (!entitled.allowed) return { ok: false, reason: `the brokerage may not use ads right now (${entitled.reason ?? "refused"})`, refused }

    // ── credentials: no request for a platform the tenant has not connected ──
    const connected = input.deps?.connected
      ? await input.deps.connected(input.brokerageId, platform)
      : await (async () => { const { loadConnectorCredential } = await import("@/lib/ads/connectors/registry"); return !!(await loadConnectorCredential(input.brokerageId, platform, svc as never)) })()
    if (!connected) return { ok: false, reason: `${platform} is not connected for this brokerage — no re-engagement audience is requested without a permitted ad account`, refused }

    // ── identity: leads resolve to their contact; prospects are never a tenant audience ──
    const leadIds = parties.filter((p) => p.kind === "lead").map((p) => p.id)
    for (const p of parties) if (p.kind === "platform_prospect") refused.push({ partyId: p.id, reason: "a platform prospect is not this tenant's contact — never in a tenant audience" })
    const contactIdOfLead = new Map<string, string>()
    if (leadIds.length) {
      const { data: leads, error: lErr } = await svc.from("leads").select("id, contact_id").eq("brokerage_id", input.brokerageId).in("id", leadIds)
      if (lErr) return { ok: false, reason: `the leads could not be read (${lErr.message ?? "refused"})`, refused }
      for (const l of (leads ?? []) as Array<{ id: string; contact_id: string | null }>) if (l.contact_id) contactIdOfLead.set(l.id, l.contact_id)
      for (const id of leadIds) if (!contactIdOfLead.has(id)) refused.push({ partyId: id, reason: "a lead with no contact record — the lead domain is never uploaded to an ad platform (contact-only rule)" })
    }
    const wanted = new Map<string, string>() // contactId → the partyId that named it
    for (const p of parties) {
      if (p.kind === "contact") wanted.set(p.id, p.id)
      else if (p.kind === "lead" && contactIdOfLead.has(p.id)) wanted.set(contactIdOfLead.get(p.id)!, p.id)
    }
    if (wanted.size === 0) return { ok: false, reason: "no party resolved to a contact of this brokerage", refused }

    const { data: rows, error: cErr } = await svc.from("contacts")
      .select(`id, agent_id, email, phone, ${AUDIENCE_CONSENT_COLUMNS}`)
      .eq("brokerage_id", input.brokerageId).in("id", [...wanted.keys()])
    if (cErr) return { ok: false, reason: `the contacts could not be read (${cErr.message ?? "refused"})`, refused }
    const found = new Map(((rows ?? []) as Array<Record<string, unknown> & { id: string }>).map((r) => [r.id, r]))
    const admitted: string[] = []
    const agents = new Set<string>()
    for (const [contactId, partyId] of wanted) {
      const c = found.get(contactId)
      if (!c) { refused.push({ partyId, reason: "not a contact of this brokerage" }); continue }
      if (!hashMatchKey({ email: c.email as string | null, phone: c.phone as string | null })) { refused.push({ partyId, reason: "no e-mail or phone to match on — identity cannot be matched" }); continue }
      if (!c.email || c.tcpa_consent !== true) { refused.push({ partyId, reason: "the audience consent floor is not met (an e-mail on file and recorded consent)" }); continue }
      if (!isAudienceUploadEligible(c as never)) { refused.push({ partyId, reason: "consent withdrawn or opted out of every marketing channel — their identifiers are never shared with an ad platform" }); continue }
      admitted.push(contactId)
      if (typeof c.agent_id === "string") agents.add(c.agent_id)
    }
    if (admitted.length === 0) return { ok: false, reason: "no named party is identity-matched and consented", refused }
    admitted.sort()

    // ── fair housing: the rule names people by id and WHY; the ONE refusal still judges it ──
    const requestKey = createHash("sha256").update(`${input.brokerageId}|${platform}|${input.basis}|${admitted.join(",")}`).digest("hex").slice(0, 32)
    const sourceRule = { type: "reengagement_parties", request_key: requestKey, filters: { contact_ids: admitted, reengagement_basis: input.basis, ...(input.creativeHint ? { creative_hint: String(input.creativeHint).slice(0, 500) } : {}) } }
    try { assertAudienceSegmentationAllowed(sourceRule, `re-engagement (${input.basis})`) } catch (e) { return { ok: false, reason: (e as Error).message, refused } }

    // ── idempotent: one open request per (platform, basis, party set) ──
    const { data: open, error: oErr } = await svc.from("facebook_custom_audiences").select("id, status")
      .eq("brokerage_id", input.brokerageId).contains("source_rule", { request_key: requestKey }).in("status", ["pending_review", "approved", "synced"]).limit(1)
    if (oErr) return { ok: false, reason: `open requests could not be read (${oErr.message ?? "refused"})`, refused }
    const scope: ApproverScope = input.scope ?? (agents.size === 1 ? { agentId: [...agents][0] } : {})
    const approver = await approverFor({ brokerageId: input.brokerageId, assetKind: "ad_audience", scope, client: svc })
    if (!approver.ok) return { ok: false, reason: `nobody can approve this audience: ${approver.reason}`, refused }
    const existing = ((open ?? []) as Array<{ id: string }>)[0]
    if (existing) {
      const { data: item, error: iErr } = await svc.from("approval_items").select("id").eq("brokerage_id", input.brokerageId).eq("item_type", AUDIENCE_REENGAGEMENT_ITEM_TYPE).eq("item_id", existing.id).order("submitted_at", { ascending: false }).limit(1)
      if (iErr) return { ok: false, reason: `the open request could not be read (${iErr.message ?? "refused"})`, refused }
      return { ok: true, status: "pending_approval", reused: true, audienceId: existing.id, approvalItemId: ((item ?? []) as Array<{ id: string }>)[0]?.id ?? "", admitted: admitted.length, refused, approverUserIds: approver.primaryUserIds, brokerageApprovalRequired: approver.brokerageApprovalRequired, platform }
    }

    const run = async (): Promise<AudienceReengagementResult> => {
      const now = (input.now ?? new Date()).toISOString()
      const ownerUserId = approver.tier === "owner_agent" ? approver.primaryUserIds[0] ?? null : null
      const { data: aud, error: aErr } = await svc.from("facebook_custom_audiences").insert({
        brokerage_id: input.brokerageId,
        audience_name: `Re-engage · ${input.basis.replace(/_/g, " ")} · ${admitted.length} contact${admitted.length === 1 ? "" : "s"} · ${now.slice(0, 10)}`,
        audience_type: "custom",
        source_rule: sourceRule,
        consent_basis: `reengagement:${input.basis} — each contact identity-matched with recorded consent (isAudienceUploadEligible + tcpa_consent), re-checked at upload`,
        status: "pending_review",
        target_platform: platform,
        scope_type: approver.tier === "owner_agent" ? "agent" : scope.teamId ? "team" : "brokerage",
        agent_user_id: ownerUserId,
        created_at: now, updated_at: now,
      }).select("id").maybeSingle()
      if (aErr || !aud) return { ok: false, reason: `the draft audience was not written (${aErr?.message ?? "no row returned"})`, refused }
      const audienceId = (aud as { id: string }).id

      const { data: item, error: itemErr } = await svc.from("approval_items").insert({
        brokerage_id: input.brokerageId, item_type: AUDIENCE_REENGAGEMENT_ITEM_TYPE, item_id: audienceId, status: "pending",
        agent_id: (scope.agentId ?? null), submitted_at: now,
        review_notes: JSON.stringify({ summary: `1:1 ad re-engagement for ${admitted.length} consented contact(s) — ${input.basis}`, basis: input.basis, platform, approver_basis: approver.basis, ...(input.creativeHint ? { creative_hint: String(input.creativeHint).slice(0, 500) } : {}) }),
      }).select("id").maybeSingle()
      if (itemErr || !item) {
        // A draft audience with no request is unreachable by any approver — take it back (counted) rather than strand it.
        const { data: gone, error: goneErr } = await svc.from("facebook_custom_audiences").delete().eq("id", audienceId).eq("brokerage_id", input.brokerageId).select("id")
        return { ok: false, reason: `the approval request was not filed (${itemErr?.message ?? "no row returned"})${!goneErr && (gone ?? []).length === 1 ? "; the draft audience was withdrawn" : `; the draft audience could NOT be withdrawn${goneErr ? ` (${goneErr.message})` : ""}`}`, refused }
      }
      const approvalItemId = (item as { id: string }).id

      // Tell the person who decides (best-effort per recipient; a refused bell is said, never silent).
      for (const userId of approver.primaryUserIds.slice(0, 10)) {
        const { error: nErr } = await svc.from("notifications").insert({
          user_id: userId, brokerage_id: input.brokerageId, type: "approval_requested",
          title: "Ad re-engagement awaiting your approval",
          body: `${admitted.length} consented contact(s) — ${input.basis.replace(/_/g, " ")}. Approve the audience before anything is uploaded.`,
          entity_type: "facebook_custom_audience", entity_id: audienceId, created_at: now,
        })
        if (nErr) console.error("[audience-reengagement] approver notification refused:", nErr.message)
      }
      return { ok: true, status: "pending_approval", reused: false, audienceId, approvalItemId, admitted: admitted.length, refused, approverUserIds: approver.primaryUserIds, brokerageApprovalRequired: approver.brokerageApprovalRequired, platform }
    }

    if (input.deps?.ledger === false) return await run()
    const by = input.requestedBy ?? { type: "manager", managerKey: "ai_isa" }
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return await withActionLedger<AudienceReengagementResult>(
      {
        brokerageId: input.brokerageId, action: "ads.audience.reengagement_request",
        actor: by.type === "user" ? { type: "user", userId: by.userId } : { type: "manager", managerKey: by.managerKey },
        subject: { type: "audience_request", ref: requestKey },
        reasonCode: by.type === "user" ? "HUMAN_REQUESTED" : (input.basis === "inbound_ad_response" || input.basis === "inbound_social_response" || input.basis === "conversation_reengagement" ? "CONVERSATION_RESPONSE" : "NURTURE_TOUCH"),
        reasonDetail: `1:1 ad re-engagement (${input.basis}) for ${admitted.length} consented contact(s); approver ${approver.tier} (${approver.basis})`,
        riskClass: "LOW_RISK_WRITE", systemSource: "audience_reengagement", idempotencyKey: `reengage:${requestKey}`,
        detail: { platform, basis: input.basis, admitted: admitted.length, refused: refused.length, approver_basis: approver.basis, brokerage_required: approver.brokerageApprovalRequired, policy_ref: approver.policyRef },
      },
      run,
      {
        settle: (r) => (r.ok ? { status: "executed", outcome: "reengagement_requested", providerRef: r.audienceId } : { status: "failed", outcome: "reengagement_refused", error: r.reason }),
        replay: () => ({ ok: false, reason: "this exact re-engagement was already requested (ledger replay) — the open request stands", refused }),
      },
      { client: svc as never },
    )
  } catch (e) {
    return { ok: false, reason: `re-engagement request failed: ${(e as Error)?.message ?? String(e)}`, refused }
  }
}

/** The latest decision on an audience's re-engagement request (approved / rejected wins over pending; by reviewed_at). */
async function latestDecision(svc: Db, brokerageId: string, audienceId: string): Promise<{ ok: true; row: { id: string; status: string; reviewed_by: string | null } | null; pendingId: string | null } | { ok: false; reason: string }> {
  const { data, error } = await svc.from("approval_items").select("id, status, reviewed_by, reviewed_at, submitted_at")
    .eq("brokerage_id", brokerageId).eq("item_type", AUDIENCE_REENGAGEMENT_ITEM_TYPE).eq("item_id", audienceId)
  if (error) return { ok: false, reason: `the request's decision could not be read (${error.message ?? "refused"})` }
  const rows = (data ?? []) as Array<{ id: string; status: string; reviewed_by: string | null; reviewed_at: string | null; submitted_at: string | null }>
  const decided = rows.filter((r) => r.status === "approved" || r.status === "rejected").sort((a, b) => String(b.reviewed_at ?? b.submitted_at ?? "").localeCompare(String(a.reviewed_at ?? a.submitted_at ?? "")))
  const pending = rows.find((r) => r.status === "pending") ?? null
  return { ok: true, row: decided[0] ?? null, pendingId: pending?.id ?? null }
}

/**
 * THE UPLOAD DOOR'S CHECK (lib/kernel/ads.ts syncAudience calls it for a reengagement_parties audience): the latest
 * decision is 'approved' and the reviewer is a permitted approver of the audience (contract C5). Fail closed.
 */
export async function reengagementApprovalGate(svc: Db, input: { brokerageId: string; audienceId: string }): Promise<{ ok: true; approvedBy: string } | { ok: false; reason: string }> {
  const d = await latestDecision(svc, input.brokerageId, input.audienceId)
  if (!d.ok) return { ok: false, reason: d.reason }
  if (!d.row) return { ok: false, reason: d.pendingId ? "the re-engagement request is still awaiting a person's approval" : "no approval request exists for this re-engagement audience" }
  if (d.row.status !== "approved") return { ok: false, reason: "the re-engagement request was rejected" }
  if (!d.row.reviewed_by) return { ok: false, reason: "the approval names no reviewer — an approval is a person's act" }
  const who = await requirePublishApprover({ brokerageId: input.brokerageId, assetKind: "ad_audience", assetTable: "facebook_custom_audiences", assetId: input.audienceId, approverUserId: d.row.reviewed_by, client: svc })
  if (!who.ok) return { ok: false, reason: `the approval was given by someone who may not approve this audience — ${who.reason}` }
  return { ok: true, approvedBy: d.row.reviewed_by }
}

/**
 * Settle the request when a person decided the audience on its OWN door (the Ads dashboard's approveAudience, or the
 * unified queue): the pending approval_items row records the decision (counted). Not a re-engagement audience = ok.
 */
export async function recordReengagementDecision(svc: Db, input: { brokerageId: string; audienceId: string; outcome: "approved" | "rejected"; reviewerUserId: string; now?: Date }): Promise<{ ok: true; settled: boolean } | { ok: false; error: string }> {
  const d = await latestDecision(svc, input.brokerageId, input.audienceId)
  if (!d.ok) return { ok: false, error: d.reason }
  if (!d.pendingId) return { ok: true, settled: false }
  const { data, error } = await svc.from("approval_items").update({ status: input.outcome, reviewed_by: input.reviewerUserId, reviewed_at: (input.now ?? new Date()).toISOString() })
    .eq("id", d.pendingId).eq("brokerage_id", input.brokerageId).eq("status", "pending").select("id")
  if (error) return { ok: false, error: error.message ?? "refused" }
  return (data ?? []).length === 1 ? { ok: true, settled: true } : { ok: false, error: "the pending request matched no row (already decided?)" }
}

/**
 * The unified queue's bare approval_items door (lib/kernel/approval-queue-aggregator.ts) for a re-engagement request:
 * BEFORE its write, the reviewer must be a permitted approver (C5); AFTER an approval, the draft audience moves to
 * 'approved' (the state the audience sync reads) — counted, tenant-pinned. A rejection withdraws the draft ('deleted').
 */
export async function settleReengagementFromQueue(svc: Db, input: { brokerageId: string; approvalItemId: string; outcome: "approved" | "rejected"; reviewerUserId: string; phase: "before" | "after" }): Promise<{ ok: true; applies: boolean } | { ok: false; error: string }> {
  const { data, error } = await svc.from("approval_items").select("id, item_type, item_id").eq("id", input.approvalItemId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `the request could not be read (${error.message ?? "refused"})` }
  const row = data as { item_type: string | null; item_id: string | null } | null
  if (!row || row.item_type !== AUDIENCE_REENGAGEMENT_ITEM_TYPE || !row.item_id) return { ok: true, applies: false }
  if (input.phase === "before") {
    if (input.outcome !== "approved") return { ok: true, applies: true }
    const who = await requirePublishApprover({ brokerageId: input.brokerageId, assetKind: "ad_audience", assetTable: "facebook_custom_audiences", assetId: row.item_id, approverUserId: input.reviewerUserId, client: svc })
    return who.ok ? { ok: true, applies: true } : { ok: false, error: who.reason }
  }
  const next = input.outcome === "approved" ? "approved" : "deleted"
  const { data: moved, error: mErr } = await svc.from("facebook_custom_audiences").update({ status: next, updated_at: new Date().toISOString() })
    .eq("id", row.item_id).eq("brokerage_id", input.brokerageId).eq("status", "pending_review").select("id")
  if (mErr) return { ok: false, error: `the audience did not move to ${next}: ${mErr.message ?? "refused"}` }
  return (moved ?? []).length === 1 ? { ok: true, applies: true } : { ok: false, error: `the audience did not move to ${next} (no pending_review row matched)` }
}
