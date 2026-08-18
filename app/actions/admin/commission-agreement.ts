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
 *
 * m481 — THE AGENCY CONTRACT FAMILY. Owner ruling: "the agent has to sign
 * contracts to join the brokerage and teams so tenants need to write the agency
 * contracts for the agents to sign." SAME rails, SAME actions, ONE vocabulary:
 * the family now carries THREE contract types —
 *   • commission_agreement    (the original — the agent's terms)
 *   • independent_contractor  (join the BROKERAGE; finance-admin only)
 *   • team_agreement          (join a TEAM; the m473 lead lane applies — a lead
 *                              may send THEIR team's agreement to their joiners,
 *                              and the row is pinned to the team via team_id)
 * Templates stay in brokerage_forms (form_category = the contract type); the
 * signed record stays the agent-keyed contract_signatures ledger, whose live
 * CHECK already admits all three types (measured in m481).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { uploadBufferToBucket } from "@/lib/storage/buckets"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { leadsAgentsTeam, resolveLedTeamId } from "@/lib/teams/team-scope"

const COMMISSION_CATEGORY = "commission_agreement"

/** The tenant-authored contracts an agent signs (m481). */
export type AgencyContractType = "commission_agreement" | "independent_contractor" | "team_agreement"
const AGENCY_CONTRACT_TYPES: readonly AgencyContractType[] = [
  "commission_agreement",
  "independent_contractor",
  "team_agreement",
] as const

/** Refuse unknown types loudly — the ledger's CHECK would refuse them anyway. */
function normalizeContractType(input: string | undefined): AgencyContractType | null {
  const t = input ?? COMMISSION_CATEGORY
  return (AGENCY_CONTRACT_TYPES as readonly string[]).includes(t) ? (t as AgencyContractType) : null
}

/**
 * Finance admin, OR — when a target is named — the LEAD of that agent's team
 * (m473). Sending or reading a commission agreement IS setting the agent's
 * terms, which the owner assigns to the lead for THEIR agents; the TEAM
 * agreement is the lead's own team's joining paperwork, so the same FK-anchored
 * lane (leadsAgentsTeam — the teams.team_lead_id FACT, never a user_type)
 * applies to it. The INDEPENDENT-CONTRACTOR agreement binds the agent to the
 * BROKERAGE, not to a team — the lead lane deliberately does NOT apply there.
 * The template library (upload/list, no target) stays finance-only: forms are
 * brokerage-level assets. Service-client writes; this gate is the only gate.
 */
async function requireAdmin(
  targetUserId?: string,
  contractType: AgencyContractType = COMMISSION_CATEGORY,
): Promise<
  | { ok: true; brokerageId: string; userId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Unauthorized" }
  if (isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
    return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
  }
  if (targetUserId && contractType !== "independent_contractor") {
    const svc = createServiceClient()
    const { data: agent, error } = await svc
      .from("agents").select("id, brokerage_id").eq("user_id", targetUserId).maybeSingle()
    if (error) return { ok: false, error: `Could not resolve the target agent: ${error.message}` }
    if (agent && agent.brokerage_id === ctx.brokerageId) {
      const lead = await leadsAgentsTeam(svc, ctx.userId, agent.id)
      if (!lead.ok) return { ok: false, error: lead.error }
      if (lead.leads) return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
    }
  }
  return { ok: false, error: "Forbidden" }
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
  /** m481: which agency contract this template is (default commission_agreement). */
  contractType?: AgencyContractType
}): Promise<{ ok: true; formId: string } | { ok: false; error: string }> {
  const contractType = normalizeContractType(input.contractType)
  if (!contractType) return { ok: false, error: "Unknown contract type" }
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
      // The family key: commission_agreement | independent_contractor | team_agreement.
      form_category: contractType,
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

export async function listCommissionAgreementFormsAction(
  /** m481: which agency contract templates to list (default commission_agreement). */
  contractTypeInput?: AgencyContractType,
): Promise<
  { ok: true; forms: CommissionForm[] } | { ok: false; error: string }
> {
  const contractType = normalizeContractType(contractTypeInput)
  if (!contractType) return { ok: false, error: "Unknown contract type" }
  // READ-ONLY template picker. Finance admins, plus any FK team lead — the lead
  // cannot exercise their m473 send authority without seeing the form list.
  // Uploading/managing templates stays finance-only above.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
    const led = await resolveLedTeamId(svc, ctx.userId)
    if (!led.ok) return { ok: false, error: led.error }
    if (!led.teamId) return { ok: false, error: "Forbidden" }
  }
  const auth = { ok: true as const, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
  const { data, error } = await svc
    .from("brokerage_forms")
    .select("id, form_name, document_url, field_schema")
    .eq("brokerage_id", auth.brokerageId)
    .eq("form_category", contractType)
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
  /** m481: which agency contract's status (default commission_agreement). */
  contractTypeInput?: AgencyContractType,
): Promise<{ ok: true; status: CommissionAgreementStatus } | { ok: false; error: string }> {
  const contractType = normalizeContractType(contractTypeInput)
  if (!contractType) return { ok: false, error: "Unknown contract type" }
  const auth = await requireAdmin(targetUserId, contractType)
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
    .eq("contract_type", contractType)
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
  /** m481: which agency contract is being sent (default commission_agreement). */
  contractType?: AgencyContractType
}): Promise<
  | {
      ok: true
      dispatched: boolean
      provider: string | null
      esignStatus: string
      /** Present when the send completed but something needs a human — e.g. the
       *  envelope went out yet its id could not be stamped, so finalize-packet
       *  can never auto-complete this agreement. */
      warning?: string
    }
  | { ok: false; error: string }
> {
  const contractType = normalizeContractType(input.contractType)
  if (!contractType) return { ok: false, error: "Unknown contract type" }
  const auth = await requireAdmin(input.targetUserId, contractType)
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

  // m481: a TEAM agreement records WHICH team is being joined. The pin is the
  // FK-anchored resolution RLS uses (public.agent_team_id — lead's own team →
  // users.team_id → active team_members row → agents.team_id), never a
  // user_type. An agent on no team has no team to join in writing — refuse
  // honestly rather than write an unpinned team contract.
  let teamId: string | null = null
  if (contractType === "team_agreement") {
    const { data: resolvedTeam, error: teamErr } = await svc.rpc("agent_team_id", { p_agent_id: agentId })
    if (teamErr) return { ok: false, error: `Could not resolve the agent's team: ${teamErr.message}` }
    if (!resolvedTeam) return { ok: false, error: "This agent is not on a team — a team agreement needs a team to join" }
    teamId = resolvedTeam as string
  }

  const { data: signer } = await svc
    .from("users")
    .select("email, first_name, last_name")
    .eq("id", input.targetUserId)
    .maybeSingle()
  const signerEmail = (signer as { email?: string | null } | null)?.email ?? null

  // Load the chosen template (must be this brokerage's form OF THIS TYPE — a
  // commission form cannot be sent as a team agreement or vice versa).
  const { data: form } = await svc
    .from("brokerage_forms")
    .select("id, form_name, document_url, form_category")
    .eq("id", input.formId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!form || (form as any).form_category !== contractType) {
    return { ok: false, error: "Agreement form not found for this contract type" }
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

  // Create the agent-keyed contract_signatures record. The default family
  // member (commission) is unchanged; m481 widened the same insert to the
  // brokerage-join and team-join contracts (the latter team-pinned).
  const { data: inserted, error: insErr } = await svc
    .from("contract_signatures")
    .insert({
      brokerage_id: auth.brokerageId,
      agent_id: agentId,
      contract_type: contractType,
      // m481: the team pin — null for every non-team contract.
      team_id: teamId,
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
  let warning: string | undefined
  const signerName =
    [(signer as any)?.first_name, (signer as any)?.last_name].filter(Boolean).join(" ").trim() || signerEmail || "the agent"
  const CONTRACT_LABEL: Record<AgencyContractType, string> = {
    commission_agreement: "Commission Agreement",
    independent_contractor: "Independent Contractor Agreement",
    team_agreement: "Team Agreement",
  }
  const contractLabel = CONTRACT_LABEL[contractType]

  if (canEsign) {
    // Notify the agent their agreement is ready to sign via the configured provider.
    // Best-effort but sentinel-ledgered (never a raw silencer — the ratchet forbids
    // swallowing a lost write; a lost notification shows up in the repair digest).
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    await sentinelWrite(svc, svc.from("notifications").insert({
      user_id: input.targetUserId,
      brokerage_id: auth.brokerageId,
      type: "commission_agreement_ready",
      title: `Sign your ${contractLabel.toLowerCase()} via ${providerName}`,
      body: `Your brokerage ${contractLabel.toLowerCase()} is ready for your signature in ${providerName}.`,
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
          propertyAddress: `${contractLabel} — ${signerName}`,
          transactionType: "purchase",
          transactionId: rowId,
        })
        if (tx.success && tx.externalTransactionId) {
          await dotloop.attachForms({
            externalTransactionId: tx.externalTransactionId,
            forms: [{ formName: `${contractLabel} — ${signerName}`, formUrl: documentUrl ?? undefined }],
          })
          await dotloop.sendForSignature({
            externalTransactionId: tx.externalTransactionId,
            documentId: tx.externalTransactionId,
            signers: [{ email: signerEmail!, name: signerName, role: "agent" }],
            message: `Please sign your brokerage ${contractLabel.toLowerCase()}.`,
          })
          // provider_envelope_id is the ONLY join key finalize-packet uses to
          // match the signed envelope back to this row. This sat inside a catch
          // that CANNOT fire for it — supabase-js resolves a rejected update
          // rather than throwing — so a lost stamp was invisible and the row
          // would sit at 'sent' forever while the agent had already signed.
          // Read the error, ledger it, and tell the admin.
          const { error: stampErr } = await svc
            .from("contract_signatures")
            .update({ provider_envelope_id: tx.externalTransactionId })
            .eq("id", rowId)

          // The envelope IS out at the provider — that fact is true regardless of
          // whether we managed to record its id, so `dispatched` stays honest.
          dispatched = true

          if (stampErr) {
            const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
            await sentinelWrite(svc, Promise.resolve({ error: stampErr }), {
              flow: "commission_agreement_envelope_stamp",
              table: "contract_signatures",
              brokerageId: auth.brokerageId,
            })
            warning =
              `Sent via ${providerName}, but the envelope reference (${tx.externalTransactionId}) could not be saved ` +
              `(${stampErr.message}). This agreement will NOT auto-complete when the agent signs — it needs manual reconciliation.`
          }
        }
      } catch (err) {
        // Reachable for real: the Dotloop HTTP calls above can throw. Previously
        // the admin saw dispatched=false with no reason at all.
        warning =
          `Could not reach ${providerName} to send the agreement (` +
          `${err instanceof Error ? err.message : String(err)}). The record was saved and the agent was notified; retry the send.`
      }
    } else {
      // Provider configured but no inline integration — the staged notification is
      // the honest hand-off; the envelope is created in the provider by the broker.
      dispatched = true
    }
  }

  return { ok: true, dispatched, provider: providerName, esignStatus, warning }
}
