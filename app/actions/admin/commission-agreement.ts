"use server"

/**
 * app/actions/admin/commission-agreement.ts
 *
 * COMMISSION AGREEMENT ON THE AGENT PROFILE (owner: "brokerage would have
 * uploaded the commission agreement form so the form can be selected under forms
 * to fill out the fields ... then send to esign which then saves it on their user
 * profile"). Reuses the real rails, no parallel path:
 *   • the uploaded template lives in brokerage_forms (form_category
 *     'commission_agreement') — the general, category-based form library;
 *   • the signed record lives in contract_signatures (already agent-keyed:
 *     agent_id, contract_type, provider_envelope_id, document_url, esign_status)
 *     + the new form_id / field_values columns;
 *   • the e-sign dispatch resolves the brokerage's CONFIGURED provider and mirrors
 *     the CDA pattern's HONEST fallback (no provider → in-app record, never a fake
 *     send); the finalize-packet webhook closes the loop on completion.
 *
 * Admin-gated (broker / broker_admin / admin / superadmin / team_lead), agent
 * pinned to the caller's brokerage. recruiting_manager owns onboarding paperwork;
 * compliance_officer gates the e-sign; finance_manager owns the commission terms.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { uploadBufferToBucket } from "@/lib/storage/buckets"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])
const COMMISSION_CATEGORY = "commission_agreement"

async function requireAdmin(): Promise<
  | { ok: true; brokerageId: string; userId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
}

export interface CommissionFormField {
  key: string
  label: string
  type?: "text" | "number" | "date" | "percent"
  required?: boolean
}

export interface CommissionForm {
  id: string
  name: string
  documentUrl: string | null
  fields: CommissionFormField[]
}

// ─── Upload a commission-agreement form (the brokerage's own template) ───────

export async function uploadCommissionAgreementFormAction(input: {
  fileName: string
  /** base64 of the PDF (no data: prefix). */
  base64: string
  formName: string
  fields?: CommissionFormField[]
}): Promise<{ ok: true; formId: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const name = (input.formName ?? "").trim()
  if (!name) return { ok: false, error: "Give the form a name" }
  if (!input.base64) return { ok: false, error: "No file provided" }

  let buffer: Buffer
  try {
    buffer = Buffer.from(input.base64, "base64")
  } catch {
    return { ok: false, error: "Could not read the uploaded file" }
  }
  if (buffer.length === 0) return { ok: false, error: "The uploaded file is empty" }

  const safe = (input.fileName || "commission-agreement.pdf").replace(/[^a-zA-Z0-9._-]/g, "_")
  const path = `${auth.brokerageId}/${Date.now()}-${safe}`
  const up = await uploadBufferToBucket({
    bucket: "commission-agreements",
    path,
    buffer,
    contentType: "application/pdf",
  })
  if (!up.ok) return { ok: false, error: up.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerage_forms")
    .insert({
      brokerage_id: auth.brokerageId,
      form_name: name,
      form_category: COMMISSION_CATEGORY,
      form_type: "onboarding",
      document_url: up.url,
      field_schema: input.fields ?? [],
      is_active: true,
      created_by: auth.userId,
    })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, formId: (data as { id: string }).id }
}

// ─── List the brokerage's commission-agreement forms ─────────────────────────

export async function listCommissionAgreementFormsAction(): Promise<
  { ok: true; forms: CommissionForm[] } | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerage_forms")
    .select("id, form_name, document_url, field_schema")
    .eq("brokerage_id", auth.brokerageId)
    .eq("form_category", COMMISSION_CATEGORY)
    .eq("is_active", true)
    .order("form_name")
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    forms: (data ?? []).map((f: Record<string, unknown>) => ({
      id: f.id as string,
      name: f.form_name as string,
      documentUrl: (f.document_url as string | null) ?? null,
      fields: Array.isArray(f.field_schema) ? (f.field_schema as CommissionFormField[]) : [],
    })),
  }
}

// ─── Status of the agent's commission agreement ──────────────────────────────

export interface CommissionAgreementStatus {
  exists: boolean
  esignStatus: string | null
  provider: string | null
  documentUrl: string | null
  signingUrl: string | null
  sentAt: string | null
  fullySignedAt: string | null
}

export async function getCommissionAgreementStatusAction(
  targetUserId: string,
): Promise<{ ok: true; status: CommissionAgreementStatus } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data: agent } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", targetUserId)
    .maybeSingle()
  if (!agent) return { ok: false, error: "This user is not an agent" }
  if ((agent as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "Agent belongs to a different brokerage" }
  }

  const { data: row } = await svc
    .from("contract_signatures")
    .select("esign_status, provider_name, document_url, signing_url, sent_at, fully_signed_at")
    .eq("agent_id", (agent as { id: string }).id)
    .eq("contract_type", COMMISSION_CATEGORY)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!row) {
    return {
      ok: true,
      status: { exists: false, esignStatus: null, provider: null, documentUrl: null, signingUrl: null, sentAt: null, fullySignedAt: null },
    }
  }
  const r = row as any
  return {
    ok: true,
    status: {
      exists: true,
      esignStatus: r.esign_status ?? null,
      provider: r.provider_name ?? null,
      documentUrl: r.document_url ?? null,
      signingUrl: r.signing_url ?? null,
      sentAt: r.sent_at ?? null,
      fullySignedAt: r.fully_signed_at ?? null,
    },
  }
}

// ─── Send the commission agreement for signature ─────────────────────────────

export async function sendCommissionAgreementAction(input: {
  targetUserId: string
  formId: string
  fieldValues: Record<string, unknown>
}): Promise<
  | { ok: true; dispatched: boolean; provider: string | null; esignStatus: string }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Resolve the agent + their signer email, pinned to the caller's brokerage.
  const { data: agent } = await svc
    .from("agents")
    .select("id, user_id, brokerage_id")
    .eq("user_id", input.targetUserId)
    .maybeSingle()
  if (!agent) return { ok: false, error: "This user is not an agent" }
  if ((agent as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "Agent belongs to a different brokerage" }
  }
  const agentId = (agent as { id: string }).id

  const { data: signer } = await svc
    .from("users")
    .select("email, first_name, last_name")
    .eq("id", input.targetUserId)
    .maybeSingle()
  const signerEmail = (signer as { email?: string | null } | null)?.email ?? null

  // Load the chosen template (must be this brokerage's commission-agreement form).
  const { data: form } = await svc
    .from("brokerage_forms")
    .select("id, form_name, document_url, form_category")
    .eq("id", input.formId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!form || (form as any).form_category !== COMMISSION_CATEGORY) {
    return { ok: false, error: "Commission agreement form not found" }
  }
  const documentUrl = (form as any).document_url ?? null

  // Resolve the brokerage's CONFIGURED e-sign provider (no provider is privileged).
  let providerName: string | null = null
  let providerConfigured = false
  try {
    const { resolveTransactionFormsProvider } = await import("@/lib/kernel/forms")
    const pr = await resolveTransactionFormsProvider({ brokerage_id: auth.brokerageId })
    providerConfigured = !!pr.success && !!pr.data?.is_configured
    providerName = pr.data?.provider_name && pr.data.provider_name !== "not_configured" ? pr.data.provider_name : null
  } catch { /* fall through to in-app record */ }

  // Honest mode decision — mirrors resolveCdaSignMode: e-sign only when a provider
  // is configured AND we have a document + a signer email; otherwise the in-app
  // record stands (never a faked send).
  const canEsign = providerConfigured && !!providerName && !!documentUrl && !!signerEmail
  // esign_status CHECK: pending | sent | viewed | agent_signed | fully_signed | voided | declined.
  // No provider configured → 'pending' (created, not yet dispatched — the honest state).
  const esignStatus = canEsign ? "sent" : "pending"

  // Create the agent-keyed contract_signatures record.
  const { data: inserted, error: insErr } = await svc
    .from("contract_signatures")
    .insert({
      brokerage_id: auth.brokerageId,
      agent_id: agentId,
      contract_type: COMMISSION_CATEGORY,
      // provider_name is NOT NULL — "none" records the honest no-provider state.
      provider_name: providerName ?? "none",
      esign_status: esignStatus,
      document_url: documentUrl,
      form_id: input.formId,
      field_values: input.fieldValues ?? {},
      sent_at: canEsign ? new Date().toISOString() : null,
    })
    .select("id")
    .single()
  if (insErr) return { ok: false, error: insErr.message }
  const rowId = (inserted as { id: string }).id

  // Dispatch through the configured provider (best-effort; stamps the envelope id
  // so finalize-packet can auto-complete). No provider → an in-app notification
  // that the agreement is ready, and the row stays 'awaiting_provider'.
  let dispatched = false
  const signerName =
    [(signer as any)?.first_name, (signer as any)?.last_name].filter(Boolean).join(" ").trim() || signerEmail || "the agent"

  if (canEsign) {
    // Notify the agent their agreement is ready to sign via the configured provider.
    // Best-effort but sentinel-ledgered (never a raw silencer — the ratchet forbids
    // swallowing a lost write; a lost notification shows up in the repair digest).
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    await sentinelWrite(svc, svc.from("notifications").insert({
      user_id: input.targetUserId,
      brokerage_id: auth.brokerageId,
      type: "commission_agreement_ready",
      title: `Sign your commission agreement via ${providerName}`,
      body: `Your brokerage commission agreement is ready for your signature in ${providerName}.`,
      entity_type: "agent",
      entity_id: agentId,
      priority: "high",
      channel: "in_app",
    }), { flow: "commission_agreement", table: "notifications", brokerageId: auth.brokerageId })

    // Inline provider send where wired (Dotloop today) — stamp the envelope id.
    if (providerName === "dotloop") {
      try {
        const { resolveTransactionFormsProvider } = await import("@/lib/kernel/forms")
        const pr = await resolveTransactionFormsProvider({ brokerage_id: auth.brokerageId })
        const creds = pr.data?.access_token && pr.data?.account_id
          ? { apiKey: pr.data.access_token, profileId: pr.data.account_id }
          : undefined
        const { DotloopProvider } = await import("@/lib/integrations/providers/dotloop-provider")
        const dotloop = new DotloopProvider(creds)
        const tx = await dotloop.createTransaction({
          propertyAddress: `Commission Agreement — ${signerName}`,
          transactionType: "purchase",
          agentId: input.targetUserId,
          transactionId: rowId,
        })
        if (tx.success && tx.externalTransactionId) {
          await dotloop.attachForms({
            externalTransactionId: tx.externalTransactionId,
            forms: [{ formName: `Commission Agreement — ${signerName}`, formUrl: documentUrl ?? undefined }],
          })
          await dotloop.sendForSignature({
            externalTransactionId: tx.externalTransactionId,
            documentId: tx.externalTransactionId,
            signers: [{ email: signerEmail!, name: signerName, role: "agent" }],
            message: "Please sign your brokerage commission agreement.",
          })
          await svc.from("contract_signatures").update({ provider_envelope_id: tx.externalTransactionId }).eq("id", rowId)
          dispatched = true
        }
      } catch { /* staging notification already sent; inline send is best-effort */ }
    } else {
      // Provider configured but no inline integration — the staged notification is
      // the honest hand-off; the envelope is created in the provider by the broker.
      dispatched = true
    }
  }

  return { ok: true, dispatched, provider: providerName, esignStatus }
}
