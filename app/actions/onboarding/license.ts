"use server"

// ============================================================
// SYSTEM: L11-S01 — Agent License Intake Server Actions
// VIP Real Estate AI OS — Layer 11
// ============================================================
// All server actions verify session, enforce RLS, and return typed { data, error }.

import { createClient } from "@/lib/supabase/server"
// TRUE ADMIN GATES (operational: license/onboarding) — the two user_type role
// arrays below are repointed to the ONE tenant roster. 'superadmin'/'super_admin'
// were dead there: 0 live rows store either users.user_type spelling.
import { isAdminOrBroker, resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { resolveProvider } from "@/lib/kernel/providers"
import { KernelEvent } from "@/lib/kernel/events"
import { runLicenseVerification } from "@/lib/onboarding/license-verifier"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface LicenseFormData {
  licenseState: string
  licenseNumber: string
  licenseType: "salesperson" | "broker" | "broker_associate"
  expiryDate: string
  documentUrl?: string
  documentBackUrl?: string
}

export interface EOFormData {
  insurerName: string
  policyNumber: string
  coverageAmount: number
  expiryDate: string
  certificateUrl?: string
}

export interface ContractRecordView {
  id: string
  status: string
  sent_at: string | null
  signed_at: string | null
  provider: string
  signing_url: string | null
}

export interface AgentLicenseStatus {
  currentStep: number
  licenseRecord: {
    id: string
    license_number: string
    license_state: string
    license_type: string
    expiry_date: string
    verification_status: string
    document_url: string | null
  } | null
  /** The brokerage-join contract (contract_type 'independent_contractor'). */
  contractRecord: ContractRecordView | null
  /**
   * m481 — the TEAM-join contract (contract_type 'team_agreement'). Present
   * only when the agent is on a team: an agent joining a team signs BOTH the
   * brokerage's independent-contractor agreement AND the team's agreement
   * (owner ruling: "the agent has to sign contracts to join the brokerage and
   * teams"). null = no team, or no team contract issued yet.
   */
  teamContractRecord: ContractRecordView | null
  /** The team the agent resolved to (public.agent_team_id), or null. */
  teamId: string | null
  completedSteps: string[]
  onboardingId: string | null
}

// ─── GET AGENT LICENSE STATUS ─────────────────────────────────────────────────

export async function getAgentLicenseStatus(
  agentId: string
): Promise<{ data: AgentLicenseStatus | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { data: null, error: "Unauthorized" }
    }

    // Get caller's brokerage + role
    const { data: caller } = await supabase
      .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
    if (!caller?.brokerage_id) return { data: null, error: "Unauthorized" }
    const isAdmin = isAdminOrBroker({ user_type: caller.user_type })

    // Caller-supplied agentId — allow only self OR admin in same brokerage.
    // Previously any caller could view any agent's license/E&O/contract
    // status across tenants (PII + compliance status leak).
    if (agentId !== user.id && !isAdmin) {
      return { data: null, error: "Forbidden" }
    }

    // Get agent's brokerage and verify it matches caller's
    const { data: agent, error: agentError } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", agentId)
      .single()

    if (agentError || !agent) {
      console.error("[L11-License] Agent not found:", agentError)
      return { data: null, error: "Agent not found" }
    }
    if (agent.brokerage_id !== caller.brokerage_id) {
      return { data: null, error: "Forbidden" }
    }

    // IDENTITY CLASS (m340). This action is keyed by a USERS id — agentId is
    // compared against user.id above and looked up in `users` — but
    // agent_onboarding, agent_licenses and agent_step_completions ALL FK AGENTS.
    // Someone already hit this on the contract_signatures query below and left a
    // comment about it ("caught by the pilot simulation"), then fixed only that
    // one query. The other three kept the bug: the onboarding INSERT was a
    // foreign-key violation, so a licence page could neither find nor create an
    // onboarding record, and the licence + step reads returned empty as though
    // the agent had simply not started.
    const agentRecordId = await resolveUserIdToAgentRecord(agentId, agent.brokerage_id)
    if (!agentRecordId) {
      return { data: null, error: "No agent record for this user in this brokerage" }
    }

    // Get or create onboarding record
    let { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id, status")
      .eq("agent_id", agentRecordId)
      .eq("brokerage_id", agent.brokerage_id)
      .single()

    if (!onboarding) {
      // Create new onboarding record
      const { data: newOnboarding, error: createError } = await supabase
        .from("agent_onboarding")
        .insert({
          agent_id: agentRecordId,
          brokerage_id: agent.brokerage_id,
          status: "in_progress",
          start_date: new Date().toISOString().split("T")[0],
          current_day: 1,
          completion_percentage: 0,
        })
        .select("id, status")
        .single()

      if (createError) {
        console.error("[L11-License] Failed to create onboarding:", createError)
        return { data: null, error: "Failed to create onboarding record" }
      }
      onboarding = newOnboarding
    }

    // Get license record
    const { data: licenseRecord } = await supabase
      .from("agent_licenses")
      .select("id, license_number, license_state, license_type, expiry_date:expiration_date, verification_status, document_url")
      .eq("agent_id", agentRecordId)
      .eq("brokerage_id", agent.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    // Get contract record. LIVE-SCHEMA CONTRACT (caught by the pilot
    // simulation): contract_signatures.agent_id FKs to AGENTS, while this
    // action is keyed by the users id — resolve the user's agents row(s)
    // first or the query can never match a valid row.
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", agentId)
      .eq("brokerage_id", agent.brokerage_id)
    const agentRowIds = ((agentRows ?? []) as Array<{ id: string }>).map((r) => r.id)
    const { data: contractRecord } = agentRowIds.length > 0
      ? await supabase
          .from("contract_signatures")
          .select("id, status:esign_status, sent_at, signed_at:fully_signed_at, provider:provider_name, signing_url")
          .in("agent_id", agentRowIds)
          .eq("brokerage_id", agent.brokerage_id)
          .eq("contract_type", "independent_contractor")
          .order("created_at", { ascending: false })
          .limit(1)
          .single()
      : { data: null }

    // m481 — TEAM-JOIN AWARENESS. If the agent resolves to a team (the same
    // FK-anchored resolution RLS uses: public.agent_team_id — never a
    // user_type), surface the team_agreement contract beside the
    // independent-contractor one, so joining a team is also in writing.
    // DESTRUCTURED errors: a refused read must not report as "no team" /
    // "no contract".
    let teamId: string | null = null
    let teamContractRecord: ContractRecordView | null = null
    const { data: resolvedTeam, error: teamErr } = await supabase.rpc("agent_team_id", {
      p_agent_id: agentRecordId,
    })
    if (teamErr) {
      console.error("[L11-License] Could not resolve the agent's team:", teamErr)
    } else if (resolvedTeam) {
      teamId = resolvedTeam as string
      const { data: teamContract, error: teamContractErr } = agentRowIds.length > 0
        ? await supabase
            .from("contract_signatures")
            .select("id, status:esign_status, sent_at, signed_at:fully_signed_at, provider:provider_name, signing_url")
            .in("agent_id", agentRowIds)
            .eq("brokerage_id", agent.brokerage_id)
            .eq("contract_type", "team_agreement")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null, error: null }
      if (teamContractErr) {
        console.error("[L11-License] Team contract read failed:", teamContractErr)
      } else {
        teamContractRecord = (teamContract as ContractRecordView | null) ?? null
      }
    }

    // Get completed steps
    const { data: completedStepsData } = await supabase
      .from("agent_step_completions")
      .select("step_id, completed")
      .eq("agent_id", agentRecordId)
      .eq("brokerage_id", agent.brokerage_id)
      .eq("completed", true)

    // Get step keys from onboarding_steps
    const stepIds = completedStepsData?.map(s => s.step_id) || []
    let completedSteps: string[] = []

    if (stepIds.length > 0) {
      const { data: steps } = await supabase
        .from("onboarding_steps")
        .select("step_key")
        .in("id", stepIds)

      completedSteps = steps?.map(s => s.step_key) || []
    }

    // Determine current step
    let currentStep = 1
    if (completedSteps.includes("license_upload")) {
      currentStep = 2
    }
    if (completedSteps.includes("eo_insurance")) {
      currentStep = 3
    }
    if (completedSteps.includes("contract_signed")) {
      currentStep = 4
    }
    if (
      completedSteps.includes("fair_housing_ack") &&
      completedSteps.includes("tcpa_ack") &&
      completedSteps.includes("mls_rules_ack") &&
      completedSteps.includes("brand_standards_ack")
    ) {
      currentStep = 5 // Complete
    }

    return {
      data: {
        currentStep,
        licenseRecord,
        contractRecord,
        teamContractRecord,
        teamId,
        completedSteps,
        onboardingId: onboarding?.id || null,
      },
      error: null,
    }
  } catch (error) {
    console.error("[L11-License] getAgentLicenseStatus error:", error)
    return { data: null, error: "Failed to fetch license status" }
  }
}

// ─── SUBMIT LICENSE DETAILS ───────────────────────────────────────────────────

export async function submitLicenseDetails(
  data: LicenseFormData
): Promise<{ success: boolean; licenseId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Resolve the proper agent ID.
    //
    // REPORTED, NOT CHANGED HERE: resolveAgentId is the UNSCOPED resolver — it
    // returns the user's oldest agents row across every brokerage, so a user who
    // belongs to two tenants could file a licence against the wrong one. The
    // scoped resolveUserIdToAgentRecord(userId, brokerageId) is what the reader
    // above and the E&O writer below use. Changing it here needs the caller's
    // tenant established first (this action derives the tenant FROM the agents
    // row, so it would be circular), and m459 now makes the database refuse a
    // mismatch outright rather than write into the wrong tenant. No live user
    // has rows in two brokerages, so this is latent, not active.
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return { success: false, error: "Agent profile not found" }
    }

    // Get agent's brokerage
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", agentId)
      .single()

    if (agentError || !agent?.brokerage_id) {
      console.error("[L11-License] Agent brokerage not found:", agentError)
      return { success: false, error: "Agent brokerage not found" }
    }

    // Get onboarding record
    const { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id, status")
      .eq("agent_id", agentId)
      .eq("brokerage_id", agent.brokerage_id)
      .single()

    if (!onboarding) {
      return { success: false, error: "Onboarding record not found" }
    }

    // Insert agent_licenses record
    const { data: licenseRecord, error: licenseError } = await supabase
      .from("agent_licenses")
      .insert({
        brokerage_id: agent.brokerage_id,
        agent_id: agentId,
        license_number: data.licenseNumber,
        license_state: data.licenseState,
        license_type: data.licenseType,
        expiration_date: data.expiryDate,
        document_url: data.documentUrl || null,
        verification_status: "pending",
      })
      .select("id")
      .single()

    if (licenseError) {
      console.error("[L11-License] Failed to insert license:", licenseError)
      return { success: false, error: "Failed to save license details" }
    }

    // Update agents table
    await supabase
      .from("agents")
      .update({
        license_number: data.licenseNumber,
        license_state: data.licenseState,
        license_expiry: data.expiryDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", agentId)

    // Get or create step completion record
    const { data: stepRecord } = await supabase
      .from("onboarding_steps")
      .select("id")
      .eq("step_key", "license_upload")
      .or(`brokerage_id.eq.${agent.brokerage_id},brokerage_id.is.null`)
      .order("brokerage_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .single()

    if (stepRecord) {
      await supabase.from("agent_step_completions").upsert({
        agent_id: await resolveAgentId(supabase as any, user.id),
        brokerage_id: agent.brokerage_id,
        step_id: stepRecord.id,
        completed: true,
        completed_at: new Date().toISOString(),
      }, {
        onConflict: "agent_id,step_id",
      })
    }

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.AGENT_LICENSE_SUBMITTED,
      brokerageId: agent.brokerage_id,
      entityType: "agent_onboarding_machine",
      entityId: onboarding.id,
    })

    // Transition lifecycle
    await transitionLifecycle({
      brokerageId: agent.brokerage_id,
      entityType: "agent_onboarding_machine",
      entityId: onboarding.id,
      fromState: onboarding.status || "started",
      toState: "license_submitted",
      actorUserId: user.id,
      eventType: "license_submitted",
      metadata: { license_id: licenseRecord.id },
    })

    // Trigger async verification (non-blocking)
    runLicenseVerification({
      agentLicenseId: licenseRecord.id,
      agentId,
      brokerageId: agent.brokerage_id,
      onboardingId: onboarding.id,
      licenseNumber: data.licenseNumber,
      licenseState: data.licenseState,
      documentUrl: data.documentUrl,
    }).catch(err => {
      console.error("[L11-License] Background verification error:", err)
    })

    return { success: true, licenseId: licenseRecord.id }
  } catch (error) {
    console.error("[L11-License] submitLicenseDetails error:", error)
    return { success: false, error: "Failed to submit license details" }
  }
}

// ─── SUBMIT E&O INSURANCE ─────────────────────────────────────────────────────

export async function submitEOInsurance(
  data: EOFormData
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get agent's brokerage
    const { data: agent, error: agentError } = await supabase
      .from("users")
      .select("id, brokerage_id")
      .eq("id", user.id)
      .single()

    if (agentError || !agent?.brokerage_id) {
      console.error("[L11-License] Agent brokerage not found:", agentError)
      return { success: false, error: "Agent brokerage not found" }
    }

    // Validate expiry date is in the future
    const expiryDate = new Date(data.expiryDate)
    if (expiryDate <= new Date()) {
      return { success: false, error: "E&O insurance expiry date must be in the future" }
    }

    // IDENTITY CLASS, AGAIN. `agent_licenses.agent_id` FKs AGENTS (verified
    // against pg_constraint: agent_licenses_agent_id_fkey -> agents.id), and this
    // read compared it to `user.id`, a USERS id. Two id spaces that never
    // overlap, so the lookup matched nothing, `if (licenseRecord)` fell through,
    // and E&O insurance was NEVER PERSISTED — while the action returned
    // success:true and marked the step complete.
    //
    // The identical bug was found and fixed in getLicenseStatus (line 112) and
    // submitLicenseDetails, both of which resolve the agents row first. This
    // copy was missed, exactly as the comment at line 105 describes happening
    // once already. Same resolver, same argument order.
    const agentRecordId = await resolveUserIdToAgentRecord(user.id, agent.brokerage_id)
    if (!agentRecordId) {
      return { success: false, error: "No agent record for this user in this brokerage" }
    }

    // Update the most recent license record with E&O info using the dedicated
    // E&O columns on agent_licenses (eo_insurance_carrier/policy/coverage/
    // expiration) plus eo_certificate_url, added by m459 — the certificate the
    // intake form uploads to storage had nowhere to land and was being dropped.
    // It is NOT document_url: that column holds the licence itself.
    //
    // The error is destructured now. supabase-js RESOLVES a failed query, so the
    // old bare `{ data }` reported a PGRST116 (no rows) and a permission denial
    // identically, as "nothing there".
    const { data: licenseRecord, error: licenseLookupError } = await supabase
      .from("agent_licenses")
      .select("id")
      .eq("agent_id", agentRecordId)
      .eq("brokerage_id", agent.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (licenseLookupError) {
      console.error("[L11-License] E&O licence lookup failed:", licenseLookupError)
      return { success: false, error: "Could not read your licence record" }
    }

    // E&O attaches TO a licence. With no licence on file there is nothing to
    // attach it to, and silently succeeding is what hid this bug: say so.
    if (!licenseRecord) {
      return { success: false, error: "Add your licence details before submitting E&O insurance" }
    }

    // `.select("id")` on the UPDATE is not decoration. A zero-row RLS refusal on
    // an UPDATE comes back as `error: null` with no rows — indistinguishable from
    // a successful write unless the affected rows are counted. m459 narrowed this
    // table to "your own row, or a brokerage admin", so a refusal is now possible
    // and must not read as a save.
    const { data: eoUpdated, error: eoError } = await supabase
      .from("agent_licenses")
      .update({
        eo_insurance_carrier: data.insurerName,
        eo_policy_number: data.policyNumber,
        eo_coverage_amount: data.coverageAmount,
        eo_expiration_date: data.expiryDate,
        eo_certificate_url: data.certificateUrl ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", licenseRecord.id)
      .select("id")

    if (eoError) {
      console.error("[L11-License] Failed to save E&O insurance:", eoError)
      return { success: false, error: "Failed to save E&O insurance" }
    }
    if (!eoUpdated || eoUpdated.length === 0) {
      return { success: false, error: "E&O insurance was not saved — you may not have permission to edit this licence record" }
    }

    // Get or create step completion record
    const { data: stepRecord } = await supabase
      .from("onboarding_steps")
      .select("id")
      .eq("step_key", "eo_insurance")
      .or(`brokerage_id.eq.${agent.brokerage_id},brokerage_id.is.null`)
      .order("brokerage_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .single()

    if (stepRecord) {
      // agentRecordId, not resolveAgentId(user.id): the unscoped resolver returns
      // the user's FIRST agents row across every brokerage, which is the wrong
      // one for anyone who belongs to more than one. This is the same row the E&O
      // write above landed on, so the completion cannot drift from the record.
      //
      // Reached only AFTER the E&O update is proven to have written — marking the
      // step complete beside a write that did not happen is precisely how this
      // defect stayed invisible: the checklist said done, the record was empty.
      const { error: stepError } = await supabase.from("agent_step_completions").upsert({
        agent_id: agentRecordId,
        brokerage_id: agent.brokerage_id,
        step_id: stepRecord.id,
        completed: true,
        completed_at: new Date().toISOString(),
      }, {
        onConflict: "agent_id,step_id",
      })
      if (stepError) {
        // The E&O record IS saved at this point; only the checklist tick failed.
        // Report it rather than swallow it, but do not claim the save failed.
        console.error("[L11-License] E&O saved but step completion failed:", stepError)
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-License] submitEOInsurance error:", error)
    return { success: false, error: "Failed to submit E&O insurance" }
  }
}

// ─── SEND CONTRACT FOR SIGNATURE ──────────────────────────────────────────────

export async function sendContractForSignature(
  agentId: string,
  _brokerageId?: string  // ignored — verified against caller's session
): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get caller's brokerage + role (the previous role check used
    // platform_role which doesn't exist as a column; the right field
    // is user_type)
    const { data: caller } = await supabase
      .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
    if (!caller?.brokerage_id) {
      return { success: false, error: "Unauthorized" }
    }
    const isAdmin = isAdminOrBroker({ user_type: caller.user_type })
    if (user.id !== agentId && !isAdmin) {
      return { success: false, error: "Unauthorized to send contract for this agent" }
    }

    // Verify target agent is in caller's brokerage; ignore caller-supplied brokerageId
    const { data: targetAgent } = await supabase
      .from("users").select("brokerage_id").eq("id", agentId).maybeSingle()
    if (!targetAgent || targetAgent.brokerage_id !== caller.brokerage_id) {
      return { success: false, error: "Forbidden: agent not in your brokerage" }
    }
    const brokerageId = caller.brokerage_id

    // Resolve e-sign provider
    const provider = await resolveProvider({
      providerType: "esign",
      actorContext: {
        userId: agentId,
        brokerageId,
      },
    })

    if (!provider.providerKey) {
      return { success: false, error: "No e-sign provider configured. Contact your broker admin." }
    }

    // HONEST REFUSAL (production audit): this path used to fabricate a
    // provider envelope id and mark the contract "sent" without sending
    // anything — the agent saw "sent for signature" and the status could
    // never advance (silent false success, the exact failure mode the
    // podcast-distribution fix killed). The onboarding envelope API for
    // contract_signatures is not integrated yet, so we refuse to simulate
    // it and point at the REAL path that works today: sign offline and
    // record it with markContractSignedManually (same screen).
    return {
      success: false,
      error: `Automatic ${provider.providerKey} sending for onboarding contracts isn't connected yet — send the Independent Contractor Agreement through ${provider.providerKey} directly, then use "Mark as signed" here to record it.`,
    }
  } catch (error) {
    console.error("[L11-License] sendContractForSignature error:", error)
    return { success: false, error: "Failed to send contract for signature" }
  }
}

// ─── GET CONTRACT STATUS ──────────────────────────────────────────────────────

export async function getContractStatus(
  contractSignatureId: string
): Promise<{ status: string; signedAt: string | null; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { status: "error", signedAt: null, error: "Unauthorized" }
    }

    const { data: contract, error: contractError } = await supabase
      .from("contract_signatures")
      .select("status:esign_status, signed_at:fully_signed_at, provider:provider_name, provider_envelope_id")
      .eq("id", contractSignatureId)
      .single()

    if (contractError || !contract) {
      return { status: "error", signedAt: null, error: "Contract not found" }
    }

    // TODO: Poll actual e-sign provider API for status
    // For now, return the stored status

    return {
      status: contract.status,
      signedAt: contract.signed_at,
    }
  } catch (error) {
    console.error("[L11-License] getContractStatus error:", error)
    return { status: "error", signedAt: null, error: "Failed to get contract status" }
  }
}

// ─── MARK CONTRACT AS SIGNED (MANUAL) ─────────────────────────────────────────

export async function markContractSignedManually(
  contractSignatureId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // TENANT gate (the body pins the contract to the caller's brokerage) — the old
    // gate tested a tenant roster against platform_role and so admitted only platform staff.
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("user_type, brokerage_id")
      .eq("id", user.id)
      .single()

    if (userError || !userData) {
      return { success: false, error: "Only admins can manually mark contracts as signed" }
    }

    // Guards a WRITE → resolveTenantAdmin, so a tenant role GRANT passes too (m466 parity).
    const adminResult = await resolveTenantAdmin(supabase, user.id, userData)
    if (!adminResult.ok) {
      return { success: false, error: adminResult.error }
    }
    if (!adminResult.isTenantAdmin) {
      return { success: false, error: "Only admins can manually mark contracts as signed" }
    }

    // Get contract and verify brokerage. contract_type matters below: the
    // "contract_signed" onboarding step means the BROKERAGE-JOIN contract
    // (independent_contractor); a team_agreement (m481) is recorded here too,
    // but must not tick the brokerage-contract checklist step.
    const { data: contract } = await supabase
      .from("contract_signatures")
      .select("id, agent_id, brokerage_id, contract_type")
      .eq("id", contractSignatureId)
      .single()

    if (!contract) {
      return { success: false, error: "Contract not found" }
    }

    if (contract.brokerage_id !== userData.brokerage_id) {
      return { success: false, error: "Unauthorized: Contract belongs to different brokerage" }
    }

    const now = new Date().toISOString()

    // Update contract status. `.select("id")` + destructured error: a zero-row
    // RLS refusal on an UPDATE resolves with error:null and no rows — counting
    // the rows is the only way "recorded" cannot be reported over a refusal.
    const { data: signedRows, error: signErr } = await supabase
      .from("contract_signatures")
      .update({
        esign_status: "fully_signed",
        fully_signed_at: now,
      })
      .eq("id", contractSignatureId)
      .select("id")
    if (signErr) {
      console.error("[L11-License] Failed to mark contract signed:", signErr)
      return { success: false, error: "Failed to mark contract as signed" }
    }
    if (!signedRows || signedRows.length === 0) {
      return { success: false, error: "Contract was not updated — you may not have permission to sign it off" }
    }

    const isBrokerageJoinContract = contract.contract_type === "independent_contractor"

    // Get agent's onboarding record
    const { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id")
      .eq("agent_id", contract.agent_id)
      .eq("brokerage_id", contract.brokerage_id)
      .single()

    // Mark the checklist step — ONLY for the brokerage-join contract; a signed
    // team agreement is its own record, not the "contract_signed" step.
    if (isBrokerageJoinContract) {
      const { data: stepRecord } = await supabase
        .from("onboarding_steps")
        .select("id")
        .eq("step_key", "contract_signed")
        .or(`brokerage_id.eq.${contract.brokerage_id},brokerage_id.is.null`)
        .order("brokerage_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .single()

      if (stepRecord) {
        const { error: stepErr } = await supabase.from("agent_step_completions").upsert({
          agent_id: contract.agent_id,
          brokerage_id: contract.brokerage_id,
          step_id: stepRecord.id,
          completed: true,
          completed_at: new Date().toISOString(),
        }, {
          onConflict: "agent_id,step_id",
        })
        if (stepErr) {
          // The contract IS recorded signed; only the checklist tick failed.
          console.error("[L11-License] Contract signed but step completion failed:", stepErr)
        }
      }
    }

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.CONTRACT_SIGNED,
      brokerageId: contract.brokerage_id,
      entityType: "contract_signature",
      entityId: contractSignatureId,
    })

    if (onboarding && isBrokerageJoinContract) {
      // Transition lifecycle — the onboarding machine's contract_signed state
      // is about the brokerage-join contract, so the team agreement does not
      // drive it.
      await transitionLifecycle({
        brokerageId: contract.brokerage_id,
        entityType: "agent_onboarding_machine",
        entityId: onboarding.id,
        fromState: "license_verified",
        toState: "contract_signed",
        actorUserId: user.id,
        eventType: "contract_signed",
        metadata: { contract_id: contractSignatureId, manual: true },
      })
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-License] markContractSignedManually error:", error)
    return { success: false, error: "Failed to mark contract as signed" }
  }
}

// ─── MARK COMPLIANCE COMPLETE ─────────────────────────────────────────────────

export async function markComplianceComplete(
  agentId: string,
  stepKeys: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Verify the requesting user matches the agent
    if (user.id !== agentId) {
      return { success: false, error: "Unauthorized" }
    }

    // Get agent's brokerage
    const { data: agent } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", agentId)
      .single()

    if (!agent?.brokerage_id) {
      return { success: false, error: "Agent brokerage not found" }
    }

    const now = new Date().toISOString()

    // Get step records for the provided step keys
    for (const stepKey of stepKeys) {
      const { data: stepRecord } = await supabase
        .from("onboarding_steps")
        .select("id")
        .eq("step_key", stepKey)
        .or(`brokerage_id.eq.${agent.brokerage_id},brokerage_id.is.null`)
        .order("brokerage_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .single()

    if (stepRecord) {
      await supabase.from("agent_step_completions").upsert({
        agent_id: agentId,
        brokerage_id: agent.brokerage_id,
        step_id: stepRecord.id,
        completed: true,
        completed_at: new Date().toISOString(),
      }, {
        onConflict: "agent_id,step_id",
      })
    }
    }

    // Check if all compliance steps are complete
    const requiredSteps = ["fair_housing_ack", "tcpa_ack", "mls_rules_ack", "brand_standards_ack"]
    const allComplete = requiredSteps.every(step => stepKeys.includes(step))

    if (allComplete) {
      // Get onboarding record
      const { data: onboarding } = await supabase
        .from("agent_onboarding")
        .select("id, status")
        .eq("agent_id", agentId)
        .eq("brokerage_id", agent.brokerage_id)
        .single()

      if (onboarding) {
        // Update onboarding to move to brand setup
        await supabase
          .from("agent_onboarding")
          .update({
            status: "in_progress",
            updated_at: now,
          })
          .eq("id", onboarding.id)

        // Transition lifecycle
        await transitionLifecycle({
          brokerageId: agent.brokerage_id,
          entityType: "agent_onboarding_machine",
          entityId: onboarding.id,
          fromState: onboarding.status || "license_verified",
          toState: "brand_configured",
          actorUserId: agentId,
          eventType: "brand_configured",
          metadata: { compliance_steps_completed: stepKeys },
        })
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-License] markComplianceComplete error:", error)
    return { success: false, error: "Failed to mark compliance complete" }
  }
}
