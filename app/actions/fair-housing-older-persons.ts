"use server"

// app/actions/fair-housing-older-persons.ts
//
// The tenant-admin DOOR for the housing-for-older-persons exemption record (wave 143, lane 143F) — the ONE writer
// of public.older_persons_housing_verifications (m846). The rules are lib/compliance/fair-housing-older-persons.ts;
// persistence is lib/compliance/fair-housing-older-persons-store.ts. Every export here is a public endpoint: each one
// resolves the tenant from the SESSION (never an argument), admits only the tenant admin roster MINUS team_lead (a
// 55+ / 62+ attestation is a legal statement the brokerage stands behind — an operational team lead does not make
// it), and reads every { error }.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import {
  evaluateOlderPersonsRecord, OLDER_PERSONS_AUTHORITY,
  type OlderPersonsCondition, type OlderPersonsVerification,
} from "@/lib/compliance/fair-housing-older-persons"
import { loadOlderPersonsVerifications, saveOlderPersonsVerification, removeOlderPersonsVerification } from "@/lib/compliance/fair-housing-older-persons-store"

interface RecordSummary {
  id: string | null
  community_name: string
  basis: OlderPersonsVerification["basis"]
  status: "verified" | "conditions_unmet"
  expiresOn: string | null
  unmet: Array<Pick<OlderPersonsCondition, "id" | "authority" | "detail">>
  verified_at: string | null
}

async function requireAttester(): Promise<{ ok: true; brokerageId: string; userId: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Not authenticated" }
  const supabase = await createClient()
  const admin = await resolveTenantAdmin(supabase, ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin || ctx.userType === "team_lead") {
    return { ok: false, error: "Only a broker, an admin or a compliance officer can attest a housing-for-older-persons exemption." }
  }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId }
}

function summarise(r: OlderPersonsVerification): RecordSummary {
  const ev = evaluateOlderPersonsRecord(r)
  return {
    id: r.id ?? null, community_name: r.community_name, basis: r.basis, status: ev.status, expiresOn: ev.expiresOn,
    unmet: ev.unmet.map((c) => ({ id: c.id, authority: c.authority, detail: c.detail })), verified_at: r.verified_at ?? null,
  }
}

/** The tenant's recorded verifications, EVALUATED today (a record past its two-year clock reads conditions_unmet). */
export async function listOlderPersonsVerificationsAction(): Promise<
  { success: true; records: RecordSummary[]; canAttest: boolean; authority: string } | { success: false; error: string }
> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }
    const records = await loadOlderPersonsVerifications(createServiceClient(), ctx.brokerageId)
    if (records === "unreadable") return { success: false, error: "The exemption records could not be read (is migration m846 applied?). Age-qualified claims stay held until they can." }
    const gate = await requireAttester()
    return { success: true, records: records.map(summarise), canAttest: gate.ok, authority: `${OLDER_PERSONS_AUTHORITY.statute}; ${OLDER_PERSONS_AUTHORITY.regulation}` }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to list the exemption records" }
  }
}

/** Record (or replace) one community's attestation. The STATUS is computed from the facts — it cannot be asserted. */
export async function recordOlderPersonsVerificationAction(input: Partial<OlderPersonsVerification>): Promise<
  { success: true; id: string; status: "verified" | "conditions_unmet"; expiresOn: string | null; unmet: Array<Pick<OlderPersonsCondition, "id" | "authority" | "detail">> } | { success: false; error: string }
> {
  try {
    const gate = await requireAttester()
    if (!gate.ok) return { success: false, error: gate.error }
    // Only the fields the form supplies — id / verified_by / verified_at / status are the server's, never the client's.
    const clean: Partial<OlderPersonsVerification> = {
      community_name: input.community_name, basis: input.basis, governing_rules: input.governing_rules,
      occupied_units: input.occupied_units, qualifying_units: input.qualifying_units, survey_completed_on: input.survey_completed_on,
      policies_published: input.policies_published, policies_reference: input.policies_reference,
      age_verification_procedures: input.age_verification_procedures, program_name: input.program_name,
      program_determination_ref: input.program_determination_ref, sworn_certification_on_file: input.sworn_certification_on_file,
      certifying_representative: input.certifying_representative, certification_date: input.certification_date,
      state: input.state, state_law_reviewed: input.state_law_reviewed,
    }
    const r = await saveOlderPersonsVerification(createServiceClient(), { brokerageId: gate.brokerageId, actorUserId: gate.userId, input: clean })
    if (!r.ok) return { success: false, error: r.error }
    return {
      success: true, id: r.id, status: r.evaluation.status, expiresOn: r.evaluation.expiresOn,
      unmet: r.evaluation.unmet.map((c) => ({ id: c.id, authority: c.authority, detail: c.detail })),
    }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to record the exemption verification" }
  }
}

/** Withdraw a recorded verification (a counted, tenant-pinned delete). Claims naming the community are held again. */
export async function removeOlderPersonsVerificationAction(id: string): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const gate = await requireAttester()
    if (!gate.ok) return { success: false, error: gate.error }
    const r = await removeOlderPersonsVerification(createServiceClient(), { brokerageId: gate.brokerageId, id })
    return r.ok ? { success: true } : { success: false, error: r.error }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to remove the exemption verification" }
  }
}
