"use server"

/**
 * BUYER HAZARD / HOMEOWNER'S INSURANCE — the two halves of the owner's ruling:
 * TRACK the policy, and RECOMMEND insurance vendors from the brokerage's own
 * marketplace, linking the buyer to the spots those vendors already have.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not create a hazard-insurance table, a hazard-insurance recommender,
 * or a hazard-insurance milestone system. All three already exist under other
 * names and this file composes them:
 *
 *   · THE RECORD lives on `transaction_vendor_services` where
 *     service_type='insurance_quote' — the row app/actions/transaction-inspections.ts
 *     already creates for the quote. m385 added `policy` (jsonb) and `vendor_id`
 *     to it. Binding is the completion of that same engagement, not a new one.
 *   · THE RECOMMENDATION is lib/vendor-marketplace/resolve-contact-vendors.ts —
 *     the ONE contact-facing vendor path, already persona/stage/team filtered,
 *     already honouring vendors.preferred + display_priority (paid placement),
 *     already brokerage-scoped, and already fronted by the RESPA/AfBA
 *     acknowledgment gate on /portal/[contactId]/vendors. No ranking is invented
 *     here and no gate is bypassed: this filters that resolver's OUTPUT to the
 *     insurance category, preserving its order exactly.
 *   · THE MILESTONE is `hazard_insurance_bound` in the single milestone catalog,
 *     completed through lib/transactions/milestone-service.completeMilestone so
 *     the buyer portal, transparency updates and sequences all fan out normally.
 *   · THE DOCUMENT is a `transaction_documents` row plus the `insurance_binder`
 *     classification (m385), so a brokerage can put the binder on its existing
 *     required-documents checklist.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { resolveMilestoneIdentity } from "@/lib/transactions/milestone-identity"
import {
  readHazardInsurance,
  type HazardServiceRow,
  type HazardPolicyRecord,
  type HazardInsuranceView,
  type InsuranceVendorRecommendation,
} from "@/lib/transactions/hazard-insurance"

/** The vendors.category that IS hazard / homeowner's insurance. Admitted by the
 *  live vendors_category_check since m304 — no widening was needed for m385.
 *  'home_warranty' is deliberately NOT included: a warranty is not hazard
 *  coverage and a lender will not accept one in its place. */
const INSURANCE_CATEGORY = "insurance"

// ─── AUTH ────────────────────────────────────────────────────────────────────
// Same shape as app/actions/transaction-inspections.ts — the brokerage comes
// from the SESSION, never from the caller's parameters.

async function requireCallerForBrokerage(claimedBrokerageId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: "Not authenticated" }
  const { data: profile, error: profileError } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) {
    console.error("[hazard-insurance] caller profile read failed:", profileError.message)
    return { ok: false as const, error: "Could not verify your account" }
  }
  if (!profile?.brokerage_id) {
    return { ok: false as const, error: "Your account is not linked to a brokerage yet — ask an admin to assign you one." }
  }
  if (claimedBrokerageId && profile.brokerage_id !== claimedBrokerageId) {
    return { ok: false as const, error: "Cannot act on transactions outside your brokerage" }
  }
  return { ok: true as const, userId: user.id, brokerageId: profile.brokerage_id as string }
}

interface TransactionScope {
  id: string
  brokerageId: string
  closeDate: string | null
  dealType: string | null
  /** contacts.id of the BUYER. Never an agents.id / users.id / leads.id. */
  buyerContactId: string | null
  teamId: string | null
}

/**
 * Load the transaction and confirm it is in the caller's brokerage, resolving
 * the buyer contact and its team.
 *
 * ID SPACES: buyer_contact_id and contact_id are BOTH contacts.id — the same
 * space — so preferring one over the other is a SEMANTIC resolution, not an
 * id-space substitution. contact_id is only accepted when the deal is buyer-side
 * (deal_type buyer|dual), because on a seller-side deal contact_id is the
 * SELLER and recommending the seller a homeowner's policy for the house they are
 * leaving would be wrong. Anything else resolves to null and the UI says the
 * buyer contact is not linked.
 */
async function loadTransactionScope(
  transactionId: string,
  brokerageId: string,
): Promise<{ ok: true; scope: TransactionScope } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data: tx, error } = await svc
    .from("transactions")
    .select("id, brokerage_id, close_date, deal_type, buyer_contact_id, contact_id")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) {
    console.error("[hazard-insurance] transaction read failed:", error.message)
    return { ok: false, error: "Could not load the transaction" }
  }
  if (!tx) return { ok: false, error: "Transaction not found in your brokerage" }

  const dealType = (tx.deal_type as string | null) ?? null
  const buyerSide = dealType === "buyer" || dealType === "dual" || dealType == null
  const buyerContactId =
    (tx.buyer_contact_id as string | null) ??
    (buyerSide ? ((tx.contact_id as string | null) ?? null) : null)

  let teamId: string | null = null
  if (buyerContactId) {
    const { data: contact, error: contactError } = await svc
      .from("contacts")
      .select("team_id")
      .eq("id", buyerContactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (contactError) {
      console.error("[hazard-insurance] buyer contact read failed:", contactError.message)
    } else {
      teamId = (contact?.team_id as string | null) ?? null
    }
  }

  return {
    ok: true,
    scope: {
      id: tx.id as string,
      brokerageId,
      closeDate: (tx.close_date as string | null) ?? null,
      dealType,
      buyerContactId,
      teamId,
    },
  }
}

/** Read the deal's insurance engagement row, tenant-scoped. */
async function loadInsuranceService(
  transactionId: string,
  brokerageId: string,
): Promise<{ ok: true; row: HazardServiceRow | null } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("transaction_vendor_services")
    .select("id, service_type, status, vendor_name, vendor_id, quote_amount, cost, policy")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("service_type", "insurance_quote")
    .order("created_at", { ascending: false })
    .limit(1)
  // A refused read RESOLVES to data:null, which is indistinguishable from "no
  // policy on file" — and those are opposite facts on this screen. Report the
  // failure rather than rendering "not yet provided" over a policy that exists.
  if (error) {
    console.error("[hazard-insurance] insurance service read failed:", error.message)
    return { ok: false, error: "Could not read this deal's insurance record" }
  }
  return { ok: true, row: ((data ?? [])[0] as unknown as HazardServiceRow) ?? null }
}

// ─── READ ────────────────────────────────────────────────────────────────────

/**
 * The whole Hazard Insurance panel in one read: the tracked posture plus the
 * marketplace recommendations. Called from the transaction detail page (a server
 * component) and re-read after a write.
 */
export async function getTransactionHazardInsuranceAction(
  transactionId: string,
  brokerageId?: string,
): Promise<HazardInsuranceView> {
  const empty: HazardInsuranceView = {
    ok: false, status: null, recommendations: [], recommendationNote: null,
    buyerContactId: null, closeDate: null,
  }

  const auth = await requireCallerForBrokerage(brokerageId)
  if (!auth.ok) return { ...empty, error: auth.error }

  const scoped = await loadTransactionScope(transactionId, auth.brokerageId)
  if (!scoped.ok) return { ...empty, error: scoped.error }
  const scope = scoped.scope

  const service = await loadInsuranceService(transactionId, auth.brokerageId)
  if (!service.ok) {
    return { ...empty, error: service.error, closeDate: scope.closeDate, buyerContactId: scope.buyerContactId }
  }

  const status = readHazardInsurance({
    service: service.row,
    closeDate: scope.closeDate,
    now: new Date(),
  })

  const { recommendations, note } = await resolveInsuranceRecommendations(scope)

  return {
    ok: true,
    status,
    recommendations,
    recommendationNote: note,
    buyerContactId: scope.buyerContactId,
    closeDate: scope.closeDate,
  }
}

/**
 * Insurance vendors for THIS buyer, straight off the existing contact-facing
 * resolver.
 *
 * The resolver decides everything that matters — tenant scope, status=active,
 * visible_in_portal, persona + lifecycle audience matching, team curation, and
 * the preferred → display_priority ordering that IS the paid-placement rule. All
 * this function adds is a category filter over its output, so the order it
 * returns is preserved exactly and no second ranking exists.
 *
 * GLOBAL / PLATFORM VENDORS (brokerage_id IS NULL) DO NOT APPEAR, and that is
 * inherited, not decided here: resolveContactVendors is brokerage-scoped, the
 * m355 `vendors_global_not_curated` CHECK forces every global vendor to
 * preferred=false / display_priority=0 / empty audience+stage tags (so it is
 * structurally incapable of carrying the curation this surface ranks on), and
 * the RESPA/AfBA config a client-facing referral must be classified against is
 * loaded per brokerage — a global vendor has none. The owner's ruling says "the
 * brokerage's own vendor marketplace", so the existing boundary is the right
 * one and is left alone. Global vendors remain reachable to AGENTS through
 * searchVendors / getSuggestedVendorsByStage, which already include them.
 */
async function resolveInsuranceRecommendations(
  scope: TransactionScope,
): Promise<{ recommendations: InsuranceVendorRecommendation[]; note: string | null }> {
  if (!scope.buyerContactId) {
    return {
      recommendations: [],
      note: "No buyer contact is linked to this transaction, so the marketplace cannot be filtered to this client. Link the buyer contact to see recommended carriers.",
    }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  const { data: contact, error: contactError } = await svc
    .from("contacts")
    .select("id, contact_type, contact_persona, buyer_stage")
    .eq("id", scope.buyerContactId)
    .eq("brokerage_id", scope.brokerageId)
    .maybeSingle()
  if (contactError) {
    console.error("[hazard-insurance] recommendation contact read failed:", contactError.message)
    return { recommendations: [], note: "Could not load the buyer's profile, so no carriers are shown." }
  }

  const { data: tx, error: txError } = await svc
    .from("transactions")
    .select("status")
    .eq("id", scope.id)
    .eq("brokerage_id", scope.brokerageId)
    .maybeSingle()
  if (txError) {
    console.error("[hazard-insurance] recommendation transaction status read failed:", txError.message)
  }

  const { resolveContactVendors, buildVendorAudienceTags } =
    await import("@/lib/vendor-marketplace/resolve-contact-vendors")

  const { audienceTags, stage } = buildVendorAudienceTags({
    contactType: (contact?.contact_type as string | null) ?? null,
    contactPersona: (contact?.contact_persona as string | null) ?? null,
    buyerStage: (contact?.buyer_stage as string | null) ?? null,
    portalView: "buyer",
    transactionStatus: (tx?.status as string | null) ?? null,
    closeDate: scope.closeDate,
  })

  const curated = await resolveContactVendors(supabase, {
    contactId: scope.buyerContactId,
    brokerageId: scope.brokerageId,
    teamId: scope.teamId,
    stage,
    audienceTags,
  })

  const insurance = curated.filter((v) => v.category === INSURANCE_CATEGORY)
  if (insurance.length === 0) {
    return {
      recommendations: [],
      note: curated.length === 0
        ? "This brokerage has no vendors published to the client marketplace yet."
        : "No insurance vendors are published to the client marketplace for this buyer yet. Add one under Vendors with the 'insurance' category and make it visible in the portal.",
    }
  }

  return {
    recommendations: insurance.map((v) => ({
      vendorId: v.id,
      name: v.name,
      phone: v.phone,
      email: v.email,
      website: v.website,
      rating: v.rating,
      preferred: !!v.preferred,
      // The vendor's marketplace SPOT. There is no per-vendor route: the spot is
      // the card on the buyer's portal marketplace, grouped by category, behind
      // the RESPA acknowledgment gate. Deep-link to that anchor rather than
      // reproducing contact details here and stepping around the gate.
      marketplaceUrl: `/portal/${scope.buyerContactId}/vendors#vendor-category-${INSURANCE_CATEGORY}`,
    })),
    note: null,
  }
}

// ─── WRITE ───────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface RecordHazardPolicyInput {
  transactionId: string
  brokerageId?: string
  carrier: string
  policyNumber?: string
  /** Dwelling coverage, whole USD. */
  coverageAmount?: number
  /** Annual premium, USD. Omit when not known yet — never guessed. */
  annualPremium?: number
  /** ISO yyyy-mm-dd. */
  effectiveDate?: string
  /** ISO yyyy-mm-dd. */
  expiry?: string
  /** vendors.id when the carrier came off the brokerage marketplace. */
  vendorId?: string | null
  /** Storage URL of the binder / declarations page, when one was uploaded. */
  binderUrl?: string
  binderFileName?: string
  notes?: string
}

/**
 * Record the deal's BOUND hazard policy.
 *
 * Writes, in order: the binder document (when supplied), the policy onto the
 * insurance engagement row, and the milestone completion. Every step is
 * error-checked — a refused write RESOLVES in supabase-js, so an unchecked one
 * would report a bound policy that is not there.
 *
 * Nothing is invented: a field the agent did not supply is stored as absent, and
 * the panel renders it as unknown rather than as a figure.
 */
export async function recordHazardPolicyAction(
  input: RecordHazardPolicyInput,
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCallerForBrokerage(input.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const carrier = input.carrier?.trim()
  if (!carrier) return { success: false, error: "Carrier is required — a policy with no carrier is not a record of anything." }

  for (const [label, value] of [["Effective date", input.effectiveDate], ["Expiry", input.expiry]] as const) {
    if (value && !ISO_DAY.test(value)) {
      return { success: false, error: `${label} must be a yyyy-mm-dd date.` }
    }
  }
  if (input.coverageAmount != null && (!Number.isFinite(input.coverageAmount) || input.coverageAmount < 0)) {
    return { success: false, error: "Coverage amount must be zero or more." }
  }
  if (input.annualPremium != null && (!Number.isFinite(input.annualPremium) || input.annualPremium < 0)) {
    return { success: false, error: "Annual premium must be zero or more." }
  }
  if (input.effectiveDate && input.expiry && input.expiry <= input.effectiveDate) {
    return { success: false, error: "Expiry must be after the effective date." }
  }

  const scoped = await loadTransactionScope(input.transactionId, auth.brokerageId)
  if (!scoped.ok) return { success: false, error: scoped.error }
  const scope = scoped.scope

  const svc = createServiceClient()

  // ── The marketplace vendor, RESOLVED not asserted ─────────────────────────
  // Same gate assignVendorToTransaction enforces: the vendor must be in the
  // caller's brokerage. A vendor id from another tenant is refused rather than
  // quietly dropped, so the deal never records a carrier it did not come from.
  let vendorId: string | null = null
  if (input.vendorId) {
    const { data: vendor, error: vendorError } = await svc
      .from("vendors")
      .select("id, brokerage_id")
      .eq("id", input.vendorId)
      .maybeSingle()
    if (vendorError) {
      console.error("[hazard-insurance] vendor read failed:", vendorError.message)
      return { success: false, error: "Could not verify the selected vendor" }
    }
    if (!vendor || vendor.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "That vendor is not in your brokerage's marketplace" }
    }
    vendorId = vendor.id as string
  }

  // ── The binder document ───────────────────────────────────────────────────
  // Filed into the transaction's own document list with the m385 doc type. The
  // id written into the policy record is the id THIS insert returns — the action
  // never accepts a document id from the caller, which is how the
  // transaction_documents.id space stays pinned without an FK inside jsonb.
  let documentId: string | null = null
  if (input.binderUrl) {
    const { data: doc, error: docError } = await svc
      .from("transaction_documents")
      .insert({
        transaction_id: input.transactionId,
        brokerage_id:   auth.brokerageId,
        doc_type:       "insurance_binder",
        doc_label:      input.binderFileName?.trim() || `${carrier} — insurance binder`,
        storage_url:    input.binderUrl,
        status:         "uploaded",
        uploaded_by:    auth.userId,
        uploaded_at:    new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()
    if (docError || !doc) {
      console.error("[hazard-insurance] binder document insert failed:", docError?.message)
      return { success: false, error: "Could not file the binder document — the policy was not recorded." }
    }
    documentId = doc.id as string
  }

  // ── The policy record ─────────────────────────────────────────────────────
  // Keys are omitted, never null-filled, when unknown: hazard_policy_record_ok
  // accepts an absent key as "not on file", and the evaluator renders that
  // honestly instead of showing a blank figure as if it were data.
  const policy: HazardPolicyRecord = { carrier }
  if (input.policyNumber?.trim()) policy.policy_number = input.policyNumber.trim()
  if (input.coverageAmount != null) policy.coverage_amount = input.coverageAmount
  if (input.annualPremium != null) policy.annual_premium = input.annualPremium
  if (input.effectiveDate) policy.effective_date = input.effectiveDate
  if (input.expiry) policy.expiry = input.expiry
  if (documentId) policy.document_id = documentId
  policy.bound_at = new Date().toISOString()
  policy.bound_by = auth.userId

  const existing = await loadInsuranceService(input.transactionId, auth.brokerageId)
  if (!existing.ok) return { success: false, error: existing.error }

  if (existing.row) {
    // The engagement already exists (a quote was requested). Binding COMPLETES
    // it — it does not open a second insurance row beside it. A binder filed on
    // a previous attempt is superseded by the new document id, so the policy
    // record always points at the document that matches its own numbers.
    const { error: updateError } = await svc
      .from("transaction_vendor_services")
      .update({
        policy,
        status:      "bound",
        vendor_id:   vendorId ?? existing.row.vendor_id ?? null,
        vendor_name: carrier,
        notes:       input.notes?.trim() || null,
        updated_at:  new Date().toISOString(),
      })
      .eq("id", existing.row.id)
      .eq("brokerage_id", auth.brokerageId)
    if (updateError) {
      console.error("[hazard-insurance] policy update failed:", updateError.message)
      return { success: false, error: `Could not record the policy: ${updateError.message}` }
    }
  } else {
    const { error: insertError } = await svc
      .from("transaction_vendor_services")
      .insert({
        transaction_id: input.transactionId,
        brokerage_id:   auth.brokerageId,
        service_type:   "insurance_quote",
        vendor_name:    carrier,
        vendor_id:      vendorId,
        status:         "bound",
        notes:          input.notes?.trim() || null,
        policy,
        created_at:     new Date().toISOString(),
      })
    if (insertError) {
      console.error("[hazard-insurance] policy insert failed:", insertError.message)
      return { success: false, error: `Could not record the policy: ${insertError.message}` }
    }
  }

  // ── The milestone ─────────────────────────────────────────────────────────
  // Resolved by canonical IDENTITY, then completed by the row's OWN
  // milestone_name — because seedJourneyMilestones stores the human label
  // ("Homeowner's Insurance Bound") while ensureRequiredMilestones stores
  // snake_case, and completeMilestone matches on milestone_name. Matching on a
  // hardcoded name would silently no-op on half the transactions, which is
  // exactly the bug that left insurance_quote_approved dead.
  await completeHazardMilestone(scope.id, auth.brokerageId, auth.userId)

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true }
}

/** Complete `hazard_insurance_bound` by identity. Best-effort: the policy is
 *  recorded either way, and a missing milestone (a pre-m385 transaction) is not
 *  a reason to fail the write. */
async function completeHazardMilestone(
  transactionId: string,
  brokerageId: string,
  userId: string,
): Promise<void> {
  try {
    const svc = createServiceClient()
    const { data: rows, error } = await svc
      .from("transaction_milestones")
      .select("milestone_name, milestone_type, status")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
    if (error) {
      console.error("[hazard-insurance] milestone read failed:", error.message)
      return
    }
    const match = (rows ?? []).find(
      (m: { milestone_name: string; milestone_type: string | null }) =>
        resolveMilestoneIdentity(m) === "hazard_insurance_bound",
    )
    if (!match || match.status === "completed") return

    const { completeMilestone } = await import("@/lib/transactions/milestone-service")
    await completeMilestone({
      transactionId,
      brokerageId,
      milestoneName: match.milestone_name,
      completedBy: userId,
    })
  } catch (err) {
    console.error("[hazard-insurance] milestone completion failed (non-blocking):", err)
  }
}
