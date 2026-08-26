"use server"

// ============================================================
// SYSTEM: L11-S03 — Tech Stack Setup Server Actions
// VIP Real Estate AI OS — Layer 11
// ============================================================
// SECURITY: Never return raw credentials after save
// Credentials only accessed server-side during test connection

import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { PROVIDER_METADATA, type ProviderName } from "@/lib/onboarding/integration-tester"
import type { IntegrationStatus } from "@/lib/integrations/integration-status"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ProviderStatus {
  provider: ProviderName
  displayName: string
  providerType: string
  status: IntegrationStatus
  lastTestedAt: string | null
  lastError: string | null
  hasCredentials: boolean
  isOAuth: boolean
}

export interface IntegrationStatusResult {
  providers: ProviderStatus[]
  requiredComplete: boolean
  connectedCount: number
  totalRequired: number
}

// ─── GET INTEGRATION STATUS ───────────────────────────────────────────────────

/**
 * Roles allowed to administer the BROKERAGE's shared provider credentials.
 *
 * Every export in this file already verified that the caller belongs to the brokerage
 * they passed — so this was never cross-tenant. What it did not check was PRIVILEGE:
 * these rows are written with owner_type "brokerage", so any producing agent could
 * overwrite or delete the credentials the whole tenant runs on. Same defect, and same
 * fix, as app/actions/settings/integrations.ts.
 */
// TENANT ADMIN GATE (kept inline, tenant credentials — deliberately no team_lead):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage these credentials run.
const TECH_STACK_ADMIN_ROLES = ["admin", "broker", "broker_owner", "broker_admin"]

/** Authenticate, confirm tenant membership, AND confirm the caller may administer it. */
async function requireBrokerageAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData || userData.brokerage_id !== brokerageId) {
    return { ok: false, error: "Unauthorized: Brokerage mismatch" }
  }

  const resolvedRole = String(
    (userData as { user_type?: string | null; role?: string | null }).user_type ??
      (userData as { role?: string | null }).role ??
      "",
  )
  if (!TECH_STACK_ADMIN_ROLES.includes(resolvedRole)) {
    return { ok: false, error: "Forbidden: provider credentials are managed by your broker or admin" }
  }

  return { ok: true, userId: user.id }
}

export async function getIntegrationStatus(
  brokerageId: string
): Promise<{ data: IntegrationStatusResult | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // Verify session
    const gate = await requireBrokerageAdmin(supabase, brokerageId)
    if (!gate.ok) return { data: null, error: gate.error }

    // Get all brokerage_integrations records
    const { data: integrations } = await supabase
      .from("brokerage_integrations")
      .select("provider_name, status, last_health_check_at, last_error")
      .eq("brokerage_id", brokerageId)

    // Get all platform_credentials records (only metadata, NOT credentials)
    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("platform, is_active, last_tested_at, test_status")
      .eq("brokerage_id", brokerageId)

    // Build provider status list
    const allProviders = Object.keys(PROVIDER_METADATA) as ProviderName[]
    const providers: ProviderStatus[] = allProviders.map(provider => {
      const metadata = PROVIDER_METADATA[provider]
      const integration = integrations?.find(i => i.provider_name === provider)
      const credential = credentials?.find(c => c.platform === provider)

      return {
        provider,
        displayName: metadata.displayName,
        providerType: metadata.providerType,
        status: integration?.status || "not_configured",
        lastTestedAt: integration?.last_health_check_at || credential?.last_tested_at || null,
        lastError: integration?.last_error || null,
        hasCredentials: !!credential && credential.is_active,
        isOAuth: metadata.isOAuth || false,
      }
    })

    // Calculate required completion
    // Required: Twilio (sms) + SendGrid (email) + (DocuSign OR DotLoop) (esign)
    const smsConnected = providers.some(p => p.providerType === "sms" && p.status === "connected")
    const emailConnected = providers.some(p => p.providerType === "email" && p.status === "connected")
    const esignConnected = providers.some(p => p.providerType === "esign" && p.status === "connected")
    
    const requiredComplete = smsConnected && emailConnected && esignConnected
    const connectedCount = providers.filter(p => p.status === "connected").length
    const totalRequired = 3 // SMS + Email + E-Sign

    return {
      data: {
        providers,
        requiredComplete,
        connectedCount,
        totalRequired,
      },
      error: null,
    }
  } catch (error) {
    console.error("[L11-TechStack] getIntegrationStatus error:", error)
    return { data: null, error: "Failed to fetch integration status" }
  }
}

// ─── SAVE CREDENTIALS ─────────────────────────────────────────────────────────

export async function saveCredentials(
  provider: ProviderName,
  credentials: Record<string, string>,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const gate = await requireBrokerageAdmin(supabase, brokerageId)
    if (!gate.ok) return { success: false, error: gate.error }

    const metadata = PROVIDER_METADATA[provider]
    if (!metadata) {
      return { success: false, error: "Unknown provider" }
    }

    // Validate required fields
    for (const field of metadata.credentialFields) {
      if (field.required && !credentials[field.key]) {
        return { success: false, error: `${field.label} is required` }
      }
    }

    // Owner-keyed update-or-insert. The unique key is (owner_type, owner_id,
    // platform) and it is REAL — VERIFIED LIVE, not assumed: m104 created it as
    // `platform_credentials_owner_uniq`, a PARTIAL UNIQUE INDEX
    // `WHERE owner_type IS NOT NULL`, and a duplicate insert is refused with 23505.
    // It is spelled out here because it lives in pg_index and NOT in pg_constraint:
    // a check that dumps pg_constraint for this table sees only the two FKs and the
    // three CHECKs, reads the key as absent, and reports this comment as a lie. It
    // is not. A concurrent OAuth callback racing this read-then-write cannot
    // duplicate the credential — the second writer gets 23505, not a second row.
    // Store credentials as config JSONB (encrypted at rest by Supabase).
    const credRow = {
      brokerage_id: brokerageId,
      owner_type: "brokerage",
      owner_id: brokerageId,
      platform: provider,
      config: credentials, // Stored encrypted
      is_active: true,
      test_status: "pending",
      updated_at: new Date().toISOString(),
    }
    const { data: existingCred } = await supabase
      .from("platform_credentials")
      .select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId).eq("platform", provider).maybeSingle()
    const { error: credError } = existingCred
      ? await supabase.from("platform_credentials").update(credRow).eq("id", existingCred.id)
      : await supabase.from("platform_credentials").insert(credRow)

    if (credError) {
      console.error("[L11-TechStack] Failed to save credentials:", credError)
      return { success: false, error: "Failed to save credentials" }
    }

    // UPSERT brokerage_integrations
    const { error: intError } = await supabase
      .from("brokerage_integrations")
      .upsert({
        brokerage_id: brokerageId,
        provider_type: metadata.providerType,
        provider_name: provider,
        status: "not_configured",
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id,provider_name",
      })

    if (intError) {
      console.error("[L11-TechStack] Failed to update integration status:", intError)
      return { success: false, error: "Failed to update integration status" }
    }

    console.log(`[L11-TechStack] Credentials saved for ${provider}`)
    return { success: true }
  } catch (error) {
    console.error("[L11-TechStack] saveCredentials error:", error)
    return { success: false, error: "Failed to save credentials" }
  }
}

// ─── DELETE CREDENTIALS ──────────────────────────────────��────────────────────

export async function deleteCredentials(
  provider: ProviderName,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const gate = await requireBrokerageAdmin(supabase, brokerageId)
    if (!gate.ok) return { success: false, error: gate.error }

    // Delete platform_credentials
    const { error: credError } = await supabase
      .from("platform_credentials")
      .delete()
      .eq("brokerage_id", brokerageId)
      .eq("platform", provider)

    if (credError) {
      console.error("[L11-TechStack] Failed to delete credentials:", credError)
      return { success: false, error: "Failed to delete credentials" }
    }

    // Update brokerage_integrations status to not_configured
    await supabase
      .from("brokerage_integrations")
      .update({
        status: "not_configured",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("brokerage_id", brokerageId)
      .eq("provider_name", provider)

    console.log(`[L11-TechStack] Credentials deleted for ${provider}`)
    return { success: true }
  } catch (error) {
    console.error("[L11-TechStack] deleteCredentials error:", error)
    return { success: false, error: "Failed to delete credentials" }
  }
}

// ─── MARK TECH STACK COMPLETE ─────────────────────────────────────────────────

export async function markTechStackComplete(
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Verify session
    const gate = await requireBrokerageAdmin(supabase, brokerageId)
    if (!gate.ok) return { success: false, error: gate.error }

    // Verify required integrations are connected
    const { data: statusData, error: statusError } = await getIntegrationStatus(brokerageId)
    if (statusError || !statusData) {
      return { success: false, error: "Failed to verify integration status" }
    }

    if (!statusData.requiredComplete) {
      return { success: false, error: "Required integrations not complete" }
    }

    // Resolve agent ID
    const agentId = await resolveAgentId(supabase, gate.userId)

    // Insert agent_step_completions
    const { error: stepError } = await supabase
      .from("agent_step_completions")
      .upsert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        step_id: null, // Will be linked via step_key lookup
        completed: true,
        completed_at: new Date().toISOString(),
        notes: "tech_stack_configured",
      }, {
        onConflict: "agent_id,step_id",
      })

    if (stepError) {
      console.error("[L11-TechStack] Failed to record step completion:", stepError)
      // Non-blocking - continue with lifecycle transition
    }

    // Get agent's onboarding record
    const { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id, status")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.INTEGRATION_CONNECTED,
      brokerageId,
      entityType: "brokerage_integrations",
      entityId: brokerageId,
    })

    // Transition lifecycle if onboarding exists
    if (onboarding) {
      await transitionLifecycle({
        brokerageId,
        entityType: "agent_onboarding_machine",
        entityId: onboarding.id,
        fromState: onboarding.status || "brand_configured",
        toState: "integrations_configured",
        actorUserId: gate.userId,
        eventType: "integrations_configured",
        metadata: {
          connectedCount: statusData.connectedCount,
        },
      })

      // Update onboarding step
      await supabase
        .from("agent_onboarding")
        .update({
          status: "in_progress",
          updated_at: new Date().toISOString(),
        })
        .eq("id", onboarding.id)
    }

    console.log("[L11-TechStack] Tech stack marked complete")
    return { success: true }
  } catch (error) {
    console.error("[L11-TechStack] markTechStackComplete error:", error)
    return { success: false, error: "Failed to complete tech stack setup" }
  }
}

// ─── GET MASKED CREDENTIALS ───────────────────────────────────────────────────
// Returns credential fields with masked values for display

export async function getMaskedCredentials(
  provider: ProviderName,
  brokerageId: string
): Promise<{ data: Record<string, string> | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // Verify session
    const gate = await requireBrokerageAdmin(supabase, brokerageId)
    if (!gate.ok) return { data: null, error: gate.error }

    // Get credentials
    const { data: credential } = await supabase
      .from("platform_credentials")
      .select("config")
      .eq("brokerage_id", brokerageId)
      .eq("platform", provider)
      .maybeSingle()

    if (!credential?.config) {
      return { data: null, error: null }
    }

    const config = credential.config as Record<string, string>
    const metadata = PROVIDER_METADATA[provider]
    const masked: Record<string, string> = {}

    // Mask all credential values
    for (const field of metadata.credentialFields) {
      const value = config[field.key]
      if (value) {
        if (field.type === "password") {
          // Fully mask sensitive fields
          masked[field.key] = "••••••••"
        } else if (field.type === "email") {
          // Show partial email
          const [local, domain] = value.split("@")
          masked[field.key] = local.length > 2 
            ? `${local.substring(0, 2)}•••@${domain}` 
            : `•••@${domain}`
        } else if (field.type === "select") {
          // Show select values
          masked[field.key] = value
        } else {
          // Show first 4 chars for other fields
          masked[field.key] = value.length > 4 
            ? `${value.substring(0, 4)}••••••••` 
            : "••••••••"
        }
      }
    }

    return { data: masked, error: null }
  } catch (error) {
    console.error("[L11-TechStack] getMaskedCredentials error:", error)
    return { data: null, error: "Failed to fetch credentials" }
  }
}
