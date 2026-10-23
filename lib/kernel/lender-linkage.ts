// lib/kernel/lender-linkage.ts
// ─────────────────────────────────────────────────────────────────────────────
// LENDERS ARE VENDORS. A lender in a transaction is a vendor (vendors.category
// 'Lender') assigned to the deal through the vendor rail (vendor_assignments) —
// NOT a separate user_type/portal identity. This is the single source of truth
// for resolving "which lender vendor is on this transaction" and for linking one.
//
// Why this replaced the old lender_portal_users identity rail: that table was a
// per-(user, transaction) grant that never ran (0 rows live) and duplicated the
// vendor identity/provisioning/assignment path. The vendor system already:
//   • models a lender as a settlement-service category (lib/compliance/vendor-respa
//     treats 'Lender' as RESPA-regulated — so a lender-vendor INHERITS the AfBA /
//     kickback / disclosure gates the standalone lender portal never had),
//   • provisions via vendor-invite (invite → accept → user_role_assignments.vendor_id),
//   • assigns to a transaction via vendor_assignments.
// The lender's financing SPECIFICS (rate, underwriting_status, clear_to_close_date,
// appraisal, rate-lock, conditions) live on transaction_lenders — the alive
// capability layer, keyed by transaction_id and preserved untouched.

import { VENDOR_CATEGORY_LENDER } from "@/lib/kernel/vendor-categories"
import { isBuyerSideContactType } from "@/lib/contact-types"

/** The vendor category that IS a lender. vendors.category carries a live CHECK
 *  (Contractor|Inspector|Lender|Other|Stager|Title Company) — it is NOT free text,
 *  whatever this comment used to say. One spelling, from one module. */
export const LENDER_VENDOR_CATEGORY = VENDOR_CATEGORY_LENDER

export function isLenderVendorCategory(category: string | null | undefined): boolean {
  const c = (category ?? "").trim().toLowerCase()
  // The exact arm compares against THE category constant, not a second spelling
  // of it (§6; lane 80E — LENDER_VENDOR_CATEGORY was exported for the
  // vendor-category proof and read by nothing at runtime).
  return c === LENDER_VENDOR_CATEGORY.toLowerCase() || c.includes("lender") || c.includes("mortgage") || c.includes("loan officer")
}

/**
 * The lender bench, spelled for a POSTGRES filter.
 *
 * `isLenderVendorCategory` is a substring predicate — correct in memory, useless
 * in a query: PostgREST `.in()` is exact and case-sensitive, and a filter that
 * cannot match is a permission (or a picker) that silently never fires
 * (scripts/role-vocabulary-guard.ts). These are the vendors.category CHECK values
 * that ARE a lender, both of which `isLenderVendorCategory` accepts — the two
 * must agree, and the vendor-category guard proves both against the live CHECK.
 *
 * Use this wherever the QUESTION is "which vendors are the brokerage's lenders";
 * use isLenderVendorCategory when you already hold the row.
 */
export const LENDER_BENCH_CATEGORIES = ["lender", "refinance_lender"] as const

/** A safe .in() list — never empty (an empty PostgREST .in() can error), so
 *  callers pass this sentinel for "no rows". */
const NO_MATCH = "00000000-0000-0000-0000-000000000000"
export function lenderFilterIds(ids: string[]): string[] {
  return ids.length > 0 ? ids : [NO_MATCH]
}

export interface LenderVendorRef {
  vendorId: string
  name: string | null
  brokerageId: string
}

/** The Lender vendor assigned to a transaction (via vendor_assignments), if any. */
export async function resolveLenderVendorForTransaction(
  client: any,
  transactionId: string,
): Promise<LenderVendorRef | null> {
  const { data: assigns } = await client
    .from("vendor_assignments")
    .select("vendor_id, brokerage_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("transaction_id", transactionId)
  for (const a of (assigns ?? []) as any[]) {
    const v = a.vendors
    if (v && isLenderVendorCategory(v.category)) {
      return { vendorId: v.id, name: v.name ?? null, brokerageId: v.brokerage_id ?? a.brokerage_id }
    }
  }
  return null
}

/** A vendor SEAT, resolved from the user who holds it. Every vendor category
 *  — not only the lender — rides this shape; `LenderVendorRef` is the same
 *  three fields and stays as the lender-specific name its callers use. */
export interface VendorSeatRef extends LenderVendorRef {
  category: string | null
}

/**
 * THE ONE user → vendors resolver (lane 77C, blind spot (2): "vendor↔contact
 * link by email/phone with no FK").
 *
 * A vendor is a USER TYPE (owner, wave 77: "vendors are not contact type, they
 * are user type"), and the seat is `users.user_type='vendor'`. The `vendors`
 * table carries NO user_id column — its columns (scripts/schema-snapshot.ts,
 * 2026-09-20) are access_expires_at, access_level, ai_verification_score,
 * audience_tags, brokerage_id, category, compliance_credentials, created_at,
 * display_priority, email, estimated_turnaround_days, id, invited_by_team_id,
 * invited_by_user_id, name, notes, phone, platform_vendor_id, preferred,
 * rating, stage_tags, status, team_id, updated_at, verification_flags,
 * verified_at, verified_by, visible_in_portal, website — and
 * `invited_by_user_id` is the INVITER, never the vendor's own seat. The ONE
 * FK-backed link between a user and the vendor company it works for is
 * user_role_assignments.vendor_id (user_id, vendor_id both live on that row:
 * scripts/schema-fk-map.ts), written by app/actions/vendor-invite.ts when the
 * invitation is accepted. So the honest resolution of "which vendor is this
 * signed-in user" is that join — never a contacts row's email/phone digits,
 * which is how a CUSTOMER-surface tool has to guess when a vendor calls the
 * office line as a stranger and lands in `contacts` (the lane-76A tool in
 * lib/ai-isa/capability-catalogue.ts; lane 77A is moving it to the vendor
 * user-type surface, where it can call this instead of matching digits).
 *
 * Returns EVERY vendor seat the user holds, in row order — a user can be
 * linked to more than one vendor row (one per brokerage that invited them).
 * The read's error is READ (§3): a refused read returns [] AND is logged, so
 * a caller that gates on "has a seat" fails closed rather than seeing an
 * empty list it cannot tell from "no seat".
 */
export async function vendorSeatsForUser(client: any, userId: string): Promise<VendorSeatRef[]> {
  if (!userId) return []
  const { data: roleRows, error } = await client
    .from("user_role_assignments")
    .select("vendor_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("user_id", userId)
    .not("vendor_id", "is", null)
  if (error) {
    console.error(`[lender-linkage] vendor seat read refused for user ${userId}: ${error.message}`)
    return []
  }
  const out: VendorSeatRef[] = []
  for (const r of (roleRows ?? []) as any[]) {
    const v = r.vendors
    if (!v?.id) continue
    out.push({ vendorId: v.id, name: v.name ?? null, brokerageId: v.brokerage_id, category: v.category ?? null })
  }
  return out
}

/** The caller's LENDER vendor identity (user_role_assignments.vendor_id → a
 *  Lender-category vendor), if the user is a lender vendor. A FILTER over
 *  vendorSeatsForUser — the same join, never a second query (§6). */
export async function lenderVendorForUser(
  client: any,
  userId: string,
): Promise<LenderVendorRef | null> {
  for (const seat of await vendorSeatsForUser(client, userId)) {
    if (isLenderVendorCategory(seat.category)) {
      return { vendorId: seat.vendorId, name: seat.name, brokerageId: seat.brokerageId }
    }
  }
  return null
}

/**
 * The USER ids attached to a lender vendor — the reverse of lenderVendorForUser.
 *
 * A vendor is a COMPANY; anything addressed to a person (a notification, an
 * inbox row) needs `users.id`, and `notifications.user_id` FKs `users` — handing
 * it a `vendors.id` is a 23503, which loses the whole INSERT (CLAUDE.md §3).
 * user_role_assignments is the one link between the two, so this is where the
 * hop lives instead of being re-derived at each caller.
 *
 * Returns [] both when the vendor has no linked user AND when the read is
 * refused; the caller decides whether "nobody to notify" is acceptable — for a
 * best-effort notification it is, for a gate it never is (use the gates in
 * lib/kernel/portal-auth.ts for that).
 */
export async function lenderVendorUserIds(client: any, vendorId: string): Promise<string[]> {
  if (!vendorId) return []
  const { data, error } = await client
    .from("user_role_assignments")
    .select("user_id")
    .eq("vendor_id", vendorId)
  if (error) return []
  return ((data ?? []) as Array<{ user_id: string | null }>)
    .map((r) => r.user_id)
    .filter((x): x is string => !!x)
}

/** All transaction ids a given lender vendor is assigned to (dashboard/brief scoping). */
export async function lenderVendorTransactionIds(
  client: any,
  vendorId: string,
  brokerageId?: string | null,
): Promise<string[]> {
  let q = client.from("vendor_assignments").select("transaction_id").eq("vendor_id", vendorId)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  return ((data ?? []) as Array<{ transaction_id: string | null }>)
    .map((r) => r.transaction_id).filter((x): x is string => !!x)
}

export interface LinkLenderVendorResult {
  ok: boolean
  error?: string
  assignmentId?: string
}

/**
 * Idempotently assign a Lender vendor to a transaction and ensure a
 * transaction_lenders financing row exists. Constraint-safe (check-then-insert,
 * no ON CONFLICT dependency). This is the vendor-rail replacement for the old
 * assignLenderToTransaction/lender_portal_users write.
 */
export async function linkLenderVendorToTransaction(
  svc: any,
  params: { vendorId: string; transactionId: string; brokerageId: string; lenderName?: string | null },
): Promise<LinkLenderVendorResult> {
  const { vendorId, transactionId, brokerageId } = params
  if (!vendorId || !transactionId || !brokerageId) {
    return { ok: false, error: "vendorId, transactionId and brokerageId are all required" }
  }

  // 1) vendor_assignments (assignment_type 'lender') — one per (vendor, transaction).
  const { data: existing } = await svc
    .from("vendor_assignments")
    .select("id")
    .eq("vendor_id", vendorId)
    .eq("transaction_id", transactionId)
    .maybeSingle()

  let assignmentId: string
  if (existing?.id) {
    assignmentId = existing.id as string
    const { error: confirmErr } = await svc.from("vendor_assignments")
      .update({ assignment_type: "lender", status: "confirmed", brokerage_id: brokerageId })
      .eq("id", assignmentId)
    if (confirmErr) return { ok: false, error: `Could not confirm the lender assignment: ${confirmErr.message}` }
  } else {
    const { data: inserted, error } = await svc
      .from("vendor_assignments")
      .insert({
        vendor_id: vendorId, transaction_id: transactionId, brokerage_id: brokerageId,
        assignment_type: "lender", status: "confirmed",
      })
      .select("id")
      .maybeSingle()
    if (error || !inserted?.id) return { ok: false, error: error?.message ?? "Failed to assign lender vendor" }
    assignmentId = inserted.id as string
  }

  // 2) Ensure a transaction_lenders financing row (the capability layer).
  const { data: tl } = await svc
    .from("transaction_lenders")
    .select("id")
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (!tl?.id) {
    const { error: financingInsErr } = await svc.from("transaction_lenders").insert({
      transaction_id: transactionId, brokerage_id: brokerageId,
      lender_name: params.lenderName ?? null,
    })
    if (financingInsErr) return { ok: false, error: `Lender assigned, but the financing record was not created: ${financingInsErr.message}` }
  } else if (params.lenderName) {
    const { error: financingUpdErr } = await svc.from("transaction_lenders").update({ lender_name: params.lenderName }).eq("id", tl.id)
    if (financingUpdErr) return { ok: false, error: `Lender assigned, but the lender name was not recorded: ${financingUpdErr.message}` }
  }

  return { ok: true, assignmentId }
}

// ─── THE LENDER REFERRAL — one path for the agent's door and the handoff capability ─────────────
export interface LenderReferralInput {
  /** VERIFIED tenant — the session (connectBuyerToLender) or the delegation's anchored row. */
  brokerageId: string
  contactId: string
  /** The human who made / approved the introduction (null for a manager with no human — none today). */
  actorUserId: string | null
  agentName: string
  buyerName: string
  partnerName: string
  /** A referral_partners id (the agent's own rolodex) — one of the two rails must be named. */
  partnerId?: string
  /** A vendors id ON the brokerage's lender bench — verified by the caller. */
  lenderVendorId?: string
  activityNote?: string
}

/**
 * Record a buyer → lender introduction: the credit_partner_referrals row, the
 * buyer_financial_profiles referral columns (each rail writes its own column, m605; real loan facts
 * never clobbered), the lender_for relationship edge, the lender's people notified, and the
 * lender.introduced activity. MOVED here verbatim from app/actions/buyer-financial.ts
 * connectBuyerToLender (wave 108) so the lender_preapproval_handoff capability rides the SAME writes
 * (§1: one survivor — the action now calls this). The caller verifies tenancy and the bench.
 */
export async function recordLenderReferral(supabase: any, p: LenderReferralInput): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!p.partnerId && !p.lenderVendorId) return { ok: false, error: "No lender was selected — pick one from your brokerage's bench or from your own referral partners." }
  const params = p
  const access = { brokerageId: p.brokerageId, userId: p.actorUserId }
  // 1. Insert credit_partner_referral
  const { error: referralError } = await supabase
    .from("credit_partner_referrals")
    .insert({
      contact_id:    params.contactId,
      brokerage_id:  access.brokerageId,
      partner_name:  params.partnerName,
      referral_date: new Date().toISOString().split("T")[0],
      status:        "referred",
      notes:         `Referred by agent ${params.agentName} ${params.activityNote ?? "via buyer dashboard"}`,
    })

  if (referralError) return { ok: false, error: referralError.message }

  // 2. UPSERT buyer_financial_profiles lender referral — WITHOUT clobbering real
  // loan facts. A referral must never overwrite an existing profile's finance_type
  // (e.g. a VA buyer) or cash flag with an invented "conventional" (owner
  // correction: loan terms come from the pre-approval or the lender, never
  // assumed). Existing row → update ONLY the referral fields; new row → insert
  // with the schema-required NOT NULL finance_type placeholder.
  const { data: existingProfile } = await supabase
    .from("buyer_financial_profiles")
    .select("id")
    .eq("contact_id", params.contactId)
    .maybeSingle()
  // EACH RAIL WRITES ITS OWN COLUMN (m605), and a rail the caller did not name
  // is left UNTOUCHED rather than nulled: an agent introducing a buyer to the
  // brokerage's bench lender must not silently erase the mortgage broker their
  // colleague introduced last week. Both are legitimate, and the two columns are
  // independent by design.
  const referralFields: Record<string, unknown> = {
    lender_referral_status: "referred",
    updated_at:             new Date().toISOString(),
  }
  if (params.partnerId)      referralFields.lender_referred_partner_id = params.partnerId
  if (params.lenderVendorId) referralFields.lender_referred_vendor_id  = params.lenderVendorId

  const { error: profileError } = existingProfile
    ? await supabase
        .from("buyer_financial_profiles")
        .update(referralFields)
        .eq("contact_id", params.contactId)
    : await supabase
        .from("buyer_financial_profiles")
        .insert({
          contact_id:                  params.contactId,
          brokerage_id:                access.brokerageId,
          agent_user_id:               access.userId ?? null,
          // finance_type is NOT NULL on the live schema; no honest "unknown" value
          // exists yet (deferred schema shape). This placeholder is only ever written
          // on a brand-new row and is replaced the moment real pre-approval terms land.
          finance_type:                "conventional",
          is_cash_buyer:               false,
          ...referralFields,
        })

  if (profileError) return { ok: false, error: profileError.message }

  // RELATIONSHIP GRAPH (wave 102, lane 102B): the introduction IS a lender_for fact (lender vendor →
  // buyer contact). The bench rail names a vendors.id directly; the partner rail reaches one only
  // through referral_partners.vendor_id — a partner with no vendor identity leaves no edge (the
  // profile row stays the record). Tenant from the SESSION (access.brokerageId); never fails the referral.
  try {
    let lenderVendorId: string | null = params.lenderVendorId ?? null
    let partnerRowId: string | null = null
    if (!lenderVendorId && params.partnerId) {
      const { data: partner, error: partnerErr } = await supabase
        .from("referral_partners").select("id, vendor_id").eq("id", params.partnerId).eq("brokerage_id", access.brokerageId).maybeSingle()
      if (partnerErr) console.error(`[connectBuyerToLender] partner read refused — no lender_for edge: ${partnerErr.message}`)
      lenderVendorId = (partner?.vendor_id as string | null) ?? null
      partnerRowId = (partner?.id as string | null) ?? null
    }
    // Wave 102.1 (102F, ruling R7 / m702): a partner with NO vendor identity is still the lender —
    // the edge points at the referral_partner itself (entity type admitted by m702). The vendor
    // endpoint stays preferred when the partner has one (one lender, one endpoint).
    const lenderRef = lenderVendorId
      ? { type: "vendor" as const, id: lenderVendorId }
      : partnerRowId ? { type: "referral_partner" as const, id: partnerRowId } : null
    if (lenderRef) {
      const { upsertRelationship } = await import("@/lib/kernel/relationship-graph")
      const edge = await upsertRelationship(supabase, {
        brokerageId: access.brokerageId,
        from: lenderRef,
        to: { type: "contact", id: params.contactId },
        type: "lender_for",
        evidence: {
          source: lenderRef.type === "vendor" ? "buyer_financial_profiles.lender_referral" : "buyer_financial_profiles.lender_referral_partner",
          confidence: lenderRef.type === "vendor" ? 0.85 : 0.8,
          observed_at: new Date().toISOString(),
        },
        createdBy: access.userId ?? null,
      })
      if (!edge.ok && !edge.degraded) console.error(`[connectBuyerToLender] lender_for edge not written: ${edge.error}`)
    }
  } catch (e) {
    console.error("[connectBuyerToLender] relationship edge derivation failed (non-blocking)", e)
  }

  // 3. Notify the lender's people, if the vendor has any linked accounts.
  //
  // `notifications.user_id` FKs `users` (scripts/schema-fk-map.ts:532), and a
  // vendor is a COMPANY — inserting a vendors.id here is a 23503 that loses the
  // whole row. The hop from vendor to person is user_role_assignments, resolved
  // once in lib/kernel/lender-linkage.ts rather than re-derived here. A lender
  // vendor with no linked account simply has nobody to notify; the referral row
  // and the activity above are still the record that the introduction happened.
  if (params.lenderVendorId) {
    const recipientIds = await lenderVendorUserIds(supabase, params.lenderVendorId)
    for (const recipientId of recipientIds) {
      await supabase.from("notifications").insert({
        user_id:     recipientId,
        brokerage_id: access.brokerageId,
        type:        "lender_introduction",
        title:       `New buyer introduction: ${params.buyerName}`,
        body:        `Agent ${params.agentName} has introduced a buyer who may need financing assistance.`,
        entity_type: "contact",
        entity_id:   params.contactId,
        priority:    "high",
        channel:     "in_app",
      })
    }
  }

  // 4. Log activity. This row IS the record that the introduction was made —
  // both the agent's timeline and the AI's memory of this contact read it.
  const { error: introActivityError } = await supabase.from("activities").insert({
    brokerage_id:  access.brokerageId,
    // FKs agents(id), not users(id) — a raw user id is FK-rejected (agent-identity rule).
    agent_id:      access.userId ? await (await import("@/lib/kernel/agent-identity")).resolveAgentId(supabase, access.userId) : null,
    contact_id:    params.contactId,
    activity_type: "lender.introduced",
    title:         `Lender introduction sent to ${params.partnerName}`,
    entity_type:   "contact",
    notes:         `Buyer ${params.buyerName} introduced to lender ${params.partnerName}`,
    status:        "completed",
  })
  if (introActivityError) {
    console.error("[buyerFinancial] lender.introduced activity REJECTED — the introduction was sent but has no record:", introActivityError.message)
  }

  return { ok: true }
}


export type LenderHandoffResult =
  | { ok: true; contactId: string; lenderVendorId: string; lenderName: string | null }
  | { ok: false; reason: string; needsChoice?: Array<{ id: string; name: string | null }> }

/**
 * WAVE 108 — the `lender_preapproval_handoff` CAPABILITY (shopping_agent; owner-approved gap of the
 * 107E First-Time Buyer strategy). A lender is a VENDOR category: the bench is vendors pinned to the
 * brokerage with category ∈ LENDER_BENCH_CATEGORIES — never a user type. Only a CONTACT of buyer type
 * (buyer | both) is handed off (a lead converts to a contact first — owner ruling). With no lender named
 * and more than one on the bench, nothing is written: the bench comes back for a human to choose.
 * Every read is pinned to the tenant and every refusal is read (§3).
 */
export async function lenderPreapprovalHandoff(
  supabase: any,
  input: { brokerageId: string; contactId: string; lenderVendorId?: string | null; actorUserId: string | null; actorName?: string | null },
): Promise<LenderHandoffResult> {
  if (!input.brokerageId || !input.contactId) return { ok: false, reason: "brokerageId and contactId are required" }
  const { data: contact, error: cErr } = await supabase.from("contacts")
    .select("id, first_name, last_name, contact_type, deleted_at")
    .eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (cErr) return { ok: false, reason: `contacts read refused: ${cErr.message}` }
  if (!contact || contact.deleted_at) return { ok: false, reason: "contact not found in this brokerage (a lead must convert to a contact first)" }
  if (!isBuyerSideContactType(contact.contact_type)) {
    return { ok: false, reason: `contact_type '${contact.contact_type ?? "none"}' is not a buyer — only a buyer contact (buyer | both) is handed to a lender` }
  }
  const { data: bench, error: bErr } = await supabase.from("vendors")
    .select("id, name, category").eq("brokerage_id", input.brokerageId).in("category", [...LENDER_BENCH_CATEGORIES]).limit(50)
  if (bErr) return { ok: false, reason: `vendors (lender bench) read refused: ${bErr.message}` }
  const lenders = ((bench ?? []) as Array<{ id: string; name: string | null; category: string | null }>).filter((v) => isLenderVendorCategory(v.category))
  if (lenders.length === 0) return { ok: false, reason: "the brokerage has no lender on its vendor bench — add a lender vendor first" }
  const chosen = input.lenderVendorId ? lenders.find((v) => v.id === input.lenderVendorId) : lenders.length === 1 ? lenders[0] : undefined
  if (input.lenderVendorId && !chosen) return { ok: false, reason: "that lender is not on this brokerage's lender bench" }
  if (!chosen) return { ok: false, reason: "more than one bench lender — a human chooses", needsChoice: lenders.map((v) => ({ id: v.id, name: v.name })) }
  const buyerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "a buyer"
  const rec = await recordLenderReferral(supabase, {
    brokerageId: input.brokerageId, contactId: input.contactId, actorUserId: input.actorUserId,
    agentName: input.actorName ?? "the Shopping Agent", buyerName, partnerName: chosen.name ?? "bench lender",
    lenderVendorId: chosen.id, activityNote: "via the buyer → lender pre-approval handoff",
  })
  return rec.ok ? { ok: true, contactId: input.contactId, lenderVendorId: chosen.id, lenderName: chosen.name } : { ok: false, reason: rec.error }
}
