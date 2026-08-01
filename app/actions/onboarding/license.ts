"use server"

// ============================================================
// SYSTEM: L11-S01 — Agent License Intake Server Actions
// VIP Real Estate AI OS — Layer 11
// ============================================================
// All server actions verify session, enforce RLS, and return typed { data, error }.

import { createClient } from "@/lib/supabase/server"
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
  contractRecord: {
    id: string
    status: string
    sent_at: string | null
    signed_at: string | null
    provider: string
    signing_url: string | null
  } | null
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
    const isAdmin = ["admin", "broker", "broker_owner", "superadmin", "super_admin"]
      .includes(caller.user_type ?? "")

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

    // Resolve the proper agent ID
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

    // Update the most recent license record with E&O info using the dedicated
    // E&O columns on agent_licenses (eo_insurance_carrier/policy/coverage/expiration).
    const { data: licenseRecord } = await supabase
      .from("agent_licenses")
      .select("id")
      .eq("agent_id", user.id)
      .eq("brokerage_id", agent.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (licenseRecord) {
      await supabase
        .from("agent_licenses")
        .update({
          eo_insurance_carrier: data.insurerName,
          eo_policy_number: data.policyNumber,
          eo_coverage_amount: data.coverageAmount,
          eo_expiration_date: data.expiryDate,
          updated_at: new Date().toISOString(),
        })
        .eq("id", licenseRecord.id)
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
    const isAdmin = ["admin", "broker", "broker_owner", "superadmin", "super_admin"]
      .includes(caller.user_type ?? "")
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

    // Verify user is admin
    const { data: userData } = await supabase
      .from("users")
      .select("platform_role, brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData || !["admin", "broker", "superadmin"].includes(userData.platform_role || "")) {
      return { success: false, error: "Only admins can manually mark contracts as signed" }
    }

    // Get contract and verify brokerage
    const { data: contract } = await supabase
      .from("contract_signatures")
      .select("id, agent_id, brokerage_id")
      .eq("id", contractSignatureId)
      .single()

    if (!contract) {
      return { success: false, error: "Contract not found" }
    }

    if (contract.brokerage_id !== userData.brokerage_id) {
      return { success: false, error: "Unauthorized: Contract belongs to different brokerage" }
    }

    const now = new Date().toISOString()

    // Update contract status
    await supabase
      .from("contract_signatures")
      .update({
        esign_status: "fully_signed",
        fully_signed_at: now,
      })
      .eq("id", contractSignatureId)

    // Get agent's onboarding record
    const { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id")
      .eq("agent_id", contract.agent_id)
      .eq("brokerage_id", contract.brokerage_id)
      .single()

    // Mark step as complete
    const { data: stepRecord } = await supabase
      .from("onboarding_steps")
      .select("id")
      .eq("step_key", "contract_signed")
      .or(`brokerage_id.eq.${contract.brokerage_id},brokerage_id.is.null`)
      .order("brokerage_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .single()

    if (stepRecord) {
      await supabase.from("agent_step_completions").upsert({
        agent_id: contract.agent_id,
        brokerage_id: contract.brokerage_id,
        step_id: stepRecord.id,
        completed: true,
        completed_at: new Date().toISOString(),
      }, {
        onConflict: "agent_id,step_id",
      })
    }

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.CONTRACT_SIGNED,
      brokerageId: contract.brokerage_id,
      entityType: "contract_signature",
      entityId: contractSignatureId,
    })

    if (onboarding) {
      // Transition lifecycle
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
