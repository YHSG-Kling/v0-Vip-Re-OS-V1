"use server"

/**
 * Buyer Financial Verification — Server Actions
 *
 * Writes to: client_documents, buyer_financial_profiles,
 *            credit_partner_referrals, notifications, activities
 * Calls: emitLifecycleTransition from lib/buyer-lifecycle/lifecycle-logger.ts
 *
 * Every function except markFinanciallyVerified previously skipped the
 * auth gate and trusted caller-supplied contactId/brokerageId/agentUserId.
 * Any signed-in caller could:
 *   - Upsert/load any contact's financial verification profile (income,
 *     down payment, pre-approval amount, lender name)
 *   - Insert "verified" client_documents rows under any tenant
 *   - Refer any contact to any lender + insert credit_partner_referrals
 *   - Notify any user posing as an agent introducing a buyer
 *   - List every brokerage's lender user roster
 *   - List any agent's referral partner roster
 *
 * All functions now resolve session brokerage + verify the contact
 * (and source agent) belong to it.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { emitLifecycleTransition } from "@/lib/buyer-lifecycle/lifecycle-logger"

async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false, error: "Contact not found" }
  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())
  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }
  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
  // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","broker_owner"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }
  return { ok: false, error: "Forbidden" }
}

// ─── UPSERT FINANCIAL PROFILE ─────────────────────────────────────────────────

export async function upsertFinancialProfile(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from contact
  agentUserId?: string  // ignored — derived from session
  financeType: "conventional" | "fha" | "va" | "cash" | "other"
  isCashBuyer: boolean
  preApprovalAmount?: number
  preApprovalLender?: string
  preApprovalExpiresAt?: string
  preApprovalLetterDocId?: string
  proofOfFundsDocId?: string
  downPaymentPercent?: number
  estimatedMonthlyBudget?: number
}): Promise<{ success: boolean; profileId?: string; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("buyer_financial_profiles")
    .upsert(
      {
        contact_id:                   params.contactId,
        brokerage_id:                 access.brokerageId,
        agent_user_id:                access.userId,
        finance_type:                 params.financeType,
        is_cash_buyer:                params.isCashBuyer,
        pre_approval_amount:          params.preApprovalAmount ?? null,
        pre_approval_lender:          params.preApprovalLender ?? null,
        pre_approval_expires_at:      params.preApprovalExpiresAt ?? null,
        pre_approval_letter_doc_id:   params.preApprovalLetterDocId ?? null,
        proof_of_funds_doc_id:        params.proofOfFundsDocId ?? null,
        down_payment_percent:         params.downPaymentPercent ?? null,
        estimated_monthly_budget:     params.estimatedMonthlyBudget ?? null,
        updated_at:                   new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, profileId: data.id }
}

// ─── RECORD DOCUMENT UPLOAD ───────────────────────────────────────────────────
//
// NO LONGER EXPORTED. In a "use server" file every export is a public HTTP
// endpoint (CLAUDE.md §4), and this one takes a caller-supplied `documentUrl`
// and writes it verbatim onto client_documents — which is precisely how a
// PUBLIC blob URL for a buyer's pre-approval got persisted from two different
// surfaces. Its public survivor is `uploadFinancialVerificationDocument` below
// (this file), which takes the BYTES and mints the URL itself, so no caller can
// hand one in. Kept as an internal helper because the row-writing half is
// correct and is reused verbatim by that survivor.

async function recordDocumentUpload(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from contact
  uploadedBy?: string  // ignored — derived from session
  documentName: string
  documentUrl: string
  docCategory: "pre_approval_letter" | "proof_of_funds"
  verificationAmount?: number
  verificationLender?: string
  expirationDate?: string
}): Promise<{ success: boolean; docId?: string; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("client_documents")
    .insert({
      contact_id:               params.contactId,
      brokerage_id:             access.brokerageId,
      uploaded_by:              access.userId,
      document_name:            params.documentName,
      document_url:             params.documentUrl,
      document_type:            params.docCategory,
      doc_category:             params.docCategory,
      is_financial_verification: true,
      verification_amount:      params.verificationAmount ?? null,
      verification_lender:      params.verificationLender ?? null,
      expiration_date:          params.expirationDate ?? null,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, docId: data.id }
}

// ─── UPLOAD A FINANCIAL VERIFICATION DOCUMENT (bytes in, signed URL out) ──────
//
// THE ONE server-side door for a buyer's pre-approval / proof-of-funds BYTES,
// for every surface — the agent CRM panel and the buyer portal both land here.
//
// Before this existed each surface uploaded on its own and each got it wrong in
// its own way: the CRM panel put the file in the PUBLIC `agent-media` bucket and
// took a getPublicUrl (with a `URL.createObjectURL` blob: fallback that is dead
// the moment the tab closes), and the portal card used @vercel/blob's client
// upload with access:"public". Both then PERSISTED that URL onto the
// client_documents row, so the permanent unauthenticated link outlived the
// upload.
//
// Here the bytes go to the PRIVATE `client-documents` bucket — the bucket
// already created private for exactly this class — and the URL comes from the
// ONE issuer (lib/storage/document-buckets.ts#issueBucketObjectUrl).
// FAIL CLOSED: if the URL cannot be signed the object is removed and the caller
// is refused. There is no public fallback and no object-URL fallback.
//
// Gate first, then the service client: requireContactAccess above resolves the
// tenant from the SESSION and the contact, never from a parameter (CLAUDE.md §4).

export async function uploadFinancialVerificationDocument(params: {
  contactId: string
  fileName: string
  contentType: string
  /** The file, base64-encoded. next.config.ts sets serverActions.bodySizeLimit to 8mb. */
  base64: string
  docCategory: "pre_approval_letter" | "proof_of_funds"
  verificationAmount?: number
  verificationLender?: string
  expirationDate?: string
}): Promise<{ success: boolean; docId?: string; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }

  let buffer: Buffer
  try {
    buffer = Buffer.from(params.base64, "base64")
  } catch {
    return { success: false, error: "Could not read the uploaded file" }
  }
  if (buffer.length === 0) return { success: false, error: "The uploaded file is empty" }

  const { issueBucketObjectUrl } = await import("@/lib/storage/document-buckets")
  const { removeOrRecordOrphan } = await import("@/lib/storage/put-and-sign")
  const { DOCUMENT_BUCKET } = await import("@/lib/kernel/document-autofile")
  const { checkUpload } = await import("@/lib/storage/file-limits")

  // The "8MB" here was copied from next.config.ts's serverActions.bodySizeLimit,
  // which Vercel's 4.5 MB function body cap sits in front of — and this action
  // takes the file as BASE64, a third larger than the bytes it carries, so the
  // decodable payload was never above ~3.4 MB. A buyer's bank statement between
  // 3.4 and 8 MB was accepted by this line and refused at the edge.
  const gate = checkUpload({
    bucket: DOCUMENT_BUCKET,
    transport: "server_action_base64",
    bytes: buffer.length,
    contentType: params.contentType || "application/octet-stream",
  })
  if (!gate.ok) return { success: false, error: gate.reason }

  const svc = createServiceClient()
  const safe = (params.fileName || "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
  const objectPath = `${access.brokerageId}/buyer-financial/${params.contactId}/${Date.now()}-${safe}`

  // supabase-js RESOLVES refusals (CLAUDE.md §3) — read the error.
  const { error: upErr } = await svc.storage
    .from(DOCUMENT_BUCKET)
    .upload(objectPath, buffer, {
      contentType: params.contentType || "application/octet-stream",
      upsert: false,
    })
  if (upErr) return { success: false, error: upErr.message }

  const issued = await issueBucketObjectUrl(svc as never, { bucket: DOCUMENT_BUCKET, objectPath })
  if (!issued.ok) {
    await removeOrRecordOrphan(svc as never, {
      bucket: DOCUMENT_BUCKET,
      objectPath,
      reason: "financial_verification_sign_failed",
      detail: issued.reason,
      brokerageId: access.brokerageId,
    })
    return { success: false, error: issued.reason }
  }

  return recordDocumentUpload({
    contactId:          params.contactId,
    documentName:       params.fileName,
    documentUrl:        issued.url,
    docCategory:        params.docCategory,
    verificationAmount: params.verificationAmount,
    verificationLender: params.verificationLender,
    expirationDate:     params.expirationDate,
  })
}

// ─── MARK AS FINANCIALLY VERIFIED ────────────────────────────────────────────

export async function markFinanciallyVerified(params: {
  contactId: string
  brokerageId: string
  agentUserId: string
}): Promise<{ success: boolean; error?: string }> {
  // Auth: caller must be an authenticated agent/admin in the contact's brokerage.
  // Without this, service-client bypassed RLS and any caller could mark any
  // contact as financially verified.
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { success: false, error: "Not authenticated" }
  if (ctx.brokerageId !== params.brokerageId) {
    return { success: false, error: "Forbidden: brokerage mismatch" }
  }

  const supabase = createServiceClient()

  // Verify the contact is actually in the caller's brokerage before mutating.
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("brokerage_id, agent_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contactRow) return { success: false, error: "Contact not found" }
  if (contactRow.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: contact in another brokerage" }
  }

  // 1. Update buyer_financial_profiles
  const { error: profileError } = await supabase
    .from("buyer_financial_profiles")
    .update({
      verified:    true,
      verified_by: params.agentUserId,
      verified_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq("contact_id", params.contactId)

  if (profileError) return { success: false, error: profileError.message }

  // 2. Emit lifecycle transition → BUYER_FINANCIALLY_VERIFIED
  const transitionResult = await emitLifecycleTransition({
    contactId:     params.contactId,
    brokerageId:   params.brokerageId,
    fromState:     "BUYER_CONTACT_CREATED" as any,
    toState:       "BUYER_FINANCIALLY_VERIFIED" as any,
    triggeredBy:   "agent",
    authorityRole: "agent",
    userId:        params.agentUserId,
    sourceSystem:  "buyer_dashboard",
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error }
  }

  return { success: true }
}

// ─── CONNECT BUYER TO LENDER ─────────────────────────────────────────────────

export async function connectBuyerToLender(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from contact
  agentUserId?: string  // ignored — derived from session
  agentName: string
  buyerName: string
  partnerId: string
  partnerName: string
  lenderUserId?: string
}): Promise<{ success: boolean; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }
  // Contacts can connect themselves to lenders too (portal flow) so we
  // don't restrict to agent-only here.

  const supabase = createServiceClient()

  // Verify the lender user (if specified) is in caller's brokerage —
  // prevents fan-out of fake "agent introductions" to lenders across tenants.
  if (params.lenderUserId) {
    const { data: lenderRow } = await supabase
      .from("users").select("brokerage_id").eq("id", params.lenderUserId).maybeSingle()
    if (!lenderRow || lenderRow.brokerage_id !== access.brokerageId) {
      return { success: false, error: "Forbidden: lender not in your brokerage" }
    }
  }

  // 1. Insert credit_partner_referral
  const { error: referralError } = await supabase
    .from("credit_partner_referrals")
    .insert({
      contact_id:    params.contactId,
      brokerage_id:  access.brokerageId,
      partner_name:  params.partnerName,
      referral_date: new Date().toISOString().split("T")[0],
      status:        "referred",
      notes:         `Referred by agent ${params.agentName} via buyer dashboard`,
    })

  if (referralError) return { success: false, error: referralError.message }

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
  const { error: profileError } = existingProfile
    ? await supabase
        .from("buyer_financial_profiles")
        .update({
          lender_referral_status:     "referred",
          lender_referred_partner_id: params.partnerId,
          updated_at:                 new Date().toISOString(),
        })
        .eq("contact_id", params.contactId)
    : await supabase
        .from("buyer_financial_profiles")
        .insert({
          contact_id:                  params.contactId,
          brokerage_id:                access.brokerageId,
          agent_user_id:               access.userId,
          // finance_type is NOT NULL on the live schema; no honest "unknown" value
          // exists yet (deferred schema shape). This placeholder is only ever written
          // on a brand-new row and is replaced the moment real pre-approval terms land.
          finance_type:                "conventional",
          is_cash_buyer:               false,
          lender_referral_status:      "referred",
          lender_referred_partner_id:  params.partnerId,
          updated_at:                  new Date().toISOString(),
        })

  if (profileError) return { success: false, error: profileError.message }

  // 3. Notify lender if they have an account
  if (params.lenderUserId) {
    await supabase.from("notifications").insert({
      user_id:     params.lenderUserId,
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

  // 4. Log activity. This row IS the record that the introduction was made —
  // both the agent's timeline and the AI's memory of this contact read it.
  const { error: introActivityError } = await supabase.from("activities").insert({
    brokerage_id:  access.brokerageId,
    // FKs agents(id), not users(id) — a raw user id is FK-rejected (agent-identity rule).
    agent_id:      await resolveAgentId(supabase, access.userId),
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

  return { success: true }
}

// ─── LOAD FINANCIAL PROFILE ───────────────────────────────────────────────────

export async function loadFinancialProfile(params: {
  contactId: string
}): Promise<{ success: boolean; profile?: any; documents?: any[]; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }

  const supabase = createServiceClient()

  const [{ data: profile }, { data: documents }] = await Promise.all([
    supabase
      .from("buyer_financial_profiles")
      .select("*")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", access.brokerageId)
      .maybeSingle(),
    supabase
      .from("client_documents")
      .select("id, document_name, document_url, doc_category, is_financial_verification, verification_amount, verification_lender, expiration_date, created_at")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", access.brokerageId)
      .eq("is_financial_verification", true)
      .order("created_at", { ascending: false }),
  ])

  return { success: true, profile: profile ?? null, documents: documents ?? [] }
}

// ─── GET BROKERAGE LENDER USERS ───────────────────────────────────────────────

/**
 * TOMBSTONE — this took `params: { brokerageId?: string }` and, as its own comment
 * said, IGNORED it. Every export of a "use server" file is a public HTTP endpoint
 * (CLAUDE.md §4), so a `brokerageId` in the signature is an open invitation for a
 * caller to believe it selects the tenant; leaving an ignored one in place is how the
 * body-supplied-tenant IDOR shape gets re-introduced by the next person who "wires it
 * up". Deleted rather than read: the tenant lives in the SESSION, resolved two lines
 * below by the act-as seam (resolveActingContext), and that is the survivor.
 */
export async function getBrokerageLenders(): Promise<{ success: boolean; lenders?: { id: string; full_name: string; email: string | null; phone: string | null }[]; error?: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, phone")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("user_type", "lender")
    .is("deleted_at", null)
    .order("last_name", { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, lenders: (data ?? []).map((u: any) => ({ id: u.id, full_name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unnamed Lender", email: u.email ?? null, phone: u.phone ?? null })) }
}

// ─── LOAD MORTGAGE BROKER PARTNERS ───────────────────────────────────────────

/**
 * TOMBSTONE — this took `params: { agentUserId?: string }` and IGNORED it, for the
 * same reason and with the same risk as `getBrokerageLenders` above: a public
 * endpoint that appears to accept an identity and silently does not. The agent is
 * resolved from the SESSION (`ctx.agentId`, below), which is the survivor.
 */
export async function loadMortgageBrokers(): Promise<{ success: boolean; partners?: any[]; error?: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  // Scope by session brokerage; agent_id pulled from session, not caller.
  // pass 12 diagnosed this correctly and then reinstated it: referral_partners
  // .agent_id FKs agents(id), "the old users.id filter always returned zero
  // partners" — and the line below said `?? ctx.userId`. m361 removes the
  // fallback. Same self-cancelling shape as the eight sites in m353.
  // WriteContext.agentId is `string | null` — null for broker/admin/TC roles.
  // `?? ""` turned that into a filter matching nothing, so those sessions saw
  // "no lender recommendations" as though the brokerage had none. Refuse with
  // a reason instead of returning a confident empty list; the sibling guard in
  // smart-queue.ts does exactly this.
  if (!ctx.agentId) {
    return {
      success: false,
      error: "Lender referrals are kept per agent, and this account has no agent profile. Open it from an agent's login, or finish agent setup.",
    }
  }

  const { data, error } = await supabase
    .from("referral_partners")
    .select("id, partner_name, company_name, phone, email")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("agent_id", ctx.agentId)
    .eq("partner_type", "mortgage_broker")
    .eq("active", true)
    .limit(3)

  if (error) return { success: false, error: error.message }
  return { success: true, partners: data ?? [] }
}
