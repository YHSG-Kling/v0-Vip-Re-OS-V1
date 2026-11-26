"use server"

/**
 * app/actions/ai-agent-capabilities.ts
 *
 * Lane 75B — the tenant-admin surface for brokerage_settings.settings.
 * ai_agent_capabilities (lib/ai-isa/capability-catalogue.ts): per-capability
 * enable/disable toggles + brand-authored custom tool definitions that
 * COMPOSE existing catalogue capabilities. Gate first, then the service
 * client (CLAUDE.md §4) — tenant from the SESSION, never a request body.
 */

import { getAgentContext } from "@/lib/identity"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import {
  CAPABILITY_CATALOGUE,
  parseCapabilitiesSettings,
  validateCustomToolDefinition,
  type CapabilityId,
  type CustomToolDefinition,
} from "@/lib/ai-isa/capability-catalogue"

type SessionGate =
  | { ok: true; brokerageId: string; userId: string | null; canManage: boolean }
  | { ok: false; error: string }

/** Identity and tenant come from the SESSION. Neither is ever an argument. */
async function resolveSession(): Promise<SessionGate> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not signed in." }
  if (!ctx.brokerageId) {
    return { ok: false, error: "This account is not attached to a brokerage yet." }
  }
  return {
    ok: true,
    brokerageId: ctx.brokerageId,
    userId: ctx.userId ?? null,
    canManage: TENANT_ADMIN_USER_TYPES.has(ctx.userType ?? ""),
  }
}

export interface CapabilitiesSettingsView {
  ok: boolean
  error?: string
  canManage: boolean
  catalogue: typeof CAPABILITY_CATALOGUE
  disabled: CapabilityId[]
  custom: CustomToolDefinition[]
}

export async function getCapabilitiesSettings(): Promise<CapabilitiesSettingsView> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error, canManage: false, catalogue: CAPABILITY_CATALOGUE, disabled: [], custom: [] }

  const svc = createServiceClient()
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (error) {
    return { ok: false, error: error.message, canManage: gate.canManage, catalogue: CAPABILITY_CATALOGUE, disabled: [], custom: [] }
  }
  const parsed = parseCapabilitiesSettings((data as { settings?: Record<string, unknown> } | null)?.settings ?? null)
  return { ok: true, canManage: gate.canManage, catalogue: CAPABILITY_CATALOGUE, disabled: parsed.disabled, custom: parsed.custom }
}

/** Toggle ONE capability on/off. Fails closed on a write error (the toggle
 *  reports failure rather than silently keeping the prior state as "saved"). */
export async function setCapabilityEnabled(id: CapabilityId, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) return { ok: false, error: "Only a broker, admin or owner can change AI agent capabilities." }

  // 86C: merged BY KEY onto the settings the database holds at write time (version-checked) —
  // the old read (whose refusal was never read) → whole-object upsert could wipe other keys.
  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const current = parseCapabilitiesSettings(settings)
    const disabled = enabled
      ? current.disabled.filter((d) => d !== id)
      : current.disabled.includes(id) ? current.disabled : [...current.disabled, id]
    return { ai_agent_capabilities: { disabled, custom: current.custom } }
  }, { policy: { type: "user", userId: gate.userId, reason: `capability ${id} ${enabled ? "enabled" : "disabled"}` } })
  if (!write.ok) return { ok: false, error: write.error }
  return { ok: true }
}

/** Save a brand's custom tool composition. Refused (never silently stored)
 *  when it names a capability id this catalogue does not have. */
export async function saveCustomTool(def: CustomToolDefinition): Promise<{ ok: boolean; error?: string; unknownCapabilities?: string[] }> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) return { ok: false, error: "Only a broker, admin or owner can create AI agent tools." }

  const validation = validateCustomToolDefinition(def)
  if (!validation.ok) {
    return {
      ok: false,
      error: `This tool names a capability that doesn't exist: ${validation.unknownCapabilities.join(", ")}`,
      unknownCapabilities: validation.unknownCapabilities,
    }
  }

  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const current = parseCapabilitiesSettings(settings)
    return { ai_agent_capabilities: { disabled: current.disabled, custom: [...current.custom.filter((c) => c.id !== def.id), def] } }
  }, { policy: { type: "user", userId: gate.userId, reason: `custom tool ${def.id} saved` } })
  if (!write.ok) return { ok: false, error: write.error }
  return { ok: true }
}

export async function deleteCustomTool(id: string): Promise<{ ok: boolean; error?: string }> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) return { ok: false, error: "Only a broker, admin or owner can remove AI agent tools." }

  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const current = parseCapabilitiesSettings(settings)
    return { ai_agent_capabilities: { disabled: current.disabled, custom: current.custom.filter((c) => c.id !== id) } }
  }, { policy: { type: "user", userId: gate.userId, reason: `custom tool ${id} removed` } })
  if (!write.ok) return { ok: false, error: write.error }
  return { ok: true }
}
