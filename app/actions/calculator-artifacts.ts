"use server"

// app/actions/calculator-artifacts.ts — THE DOORS OF THE CALCULATOR ARTIFACT FAMILY (wave 156, lane 156H).
//
// Every export here is a public HTTP endpoint (CLAUDE.md §4). Two kinds of door:
//   · AUTHORING (createCalculatorArtifactAction, listCalculatorArtifactsAction, getCalculatorFunnelAction; the internal net
//     sheet's one door is calculateSellerNet in app/actions/calculators.ts) — the tenant, the agent and the user come from the SESSION (getAgentContext), never
//     from the body; gate first, then the service client. Publishing (and the optional QR) is the EXISTING door
//     app/actions/lead-magnets-actions.ts publishLeadMagnetAction(magnetId, ["landing_page", "qr_code"]).
//   · PUBLIC (recordCalculatorOpenAction, computeCalculatorArtifactAction, optInCalculatorArtifactAction) — anonymous by
//     design (a lead magnet that demanded a login would not be one). The tenant is the FORM's, read by id; nothing the
//     caller sends names a tenant. Bounded per IP with the existing limiter (lib/security/public-rate-limit.ts).
//     A view or a computation writes one event and NEVER a contact; only the opt-in reaches the one capture path.
//
// All logic lives in lib/calculators/artifact.ts (driven by scripts/wave156-h-calculators-guard.ts); these are thin doors.

import type { LeadMagnetAttribution } from "@/lib/lead-magnets/attribution"

const LIMITS = {
  open: { limit: 60, windowMs: 60_000 },
  compute: { limit: 60, windowMs: 60_000 },
  optIn: { limit: 5, windowMs: 60_000 },
} as const

/** File-local (not exported). Over the window → refused; a limiter that cannot run → open for the read-only doors (the
 *  calculators' owner ruling, app/actions/calculators.ts header) and CLOSED for the opt-in, which writes a contact. */
async function allowed(surface: keyof typeof LIMITS): Promise<boolean> {
  try {
    const { checkPublicRateLimit, publicCallerIp } = await import("@/lib/security/public-rate-limit")
    return checkPublicRateLimit(`calculator-artifacts:${surface}`, await publicCallerIp(), LIMITS[surface]).allowed
  } catch (e) {
    console.error(`[calculator-artifacts] rate limiter unavailable for ${surface}:`, (e as Error)?.message ?? String(e))
    return surface !== "optIn"
  }
}

async function svc() {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient()
}
async function clean(a: LeadMagnetAttribution | null | undefined) {
  const { sanitizeLeadMagnetAttribution } = await import("@/lib/lead-magnets/attribution")
  return sanitizeLeadMagnetAttribution(a ?? null)
}

// ── authoring ─────────────────────────────────────────────────────────────────
export async function createCalculatorArtifactAction(input: { title: string; config: unknown }) {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.agentId || !ctx.userId) return { success: false as const, error: "Sign in with an agent seat to build a calculator." }
  const { createCalculatorArtifact } = await import("@/lib/calculators/artifact")
  return createCalculatorArtifact({ brokerageId: ctx.brokerageId, agentId: ctx.agentId, createdBy: ctx.userId, title: input?.title ?? "", config: input?.config }, { client: await svc() })
}

/** The tenant's calculators (the seat's own; the whole brokerage for the operational admin roster). */
export async function listCalculatorArtifactsAction() {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false as const, error: "Not authenticated", calculators: [] }
  const { isAdminOrBroker } = await import("@/lib/auth/resolve-user-role")
  const wide = isAdminOrBroker({ user_type: ctx.role })
  if (!wide && !ctx.agentId) return { success: false as const, error: "No agent profile for this user.", calculators: [] }
  const client = await svc()
  let q = client.from("lead_capture_forms").select("id, name, slug, is_active, settings, created_at, qr_code_id").eq("brokerage_id", ctx.brokerageId).eq("magnet_type", "calculator")
  if (!wide) q = q.eq("agent_id", ctx.agentId as string)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(100)
  if (error) return { success: false as const, error: error.message, calculators: [] }
  const { calculatorArtifactOf } = await import("@/lib/calculators/artifact")
  return {
    success: true as const,
    calculators: ((data ?? []) as Array<{ id: string; name: string; slug: string; is_active: boolean | null; settings: unknown; created_at: string; qr_code_id: string | null }>).map((r) => ({
      id: r.id, name: r.name, slug: r.slug, isActive: r.is_active === true, createdAt: r.created_at, hasQr: !!r.qr_code_id, config: calculatorArtifactOf(r.settings),
    })),
  }
}

export async function getCalculatorFunnelAction(formId: string) {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
  const { getCalculatorFunnel } = await import("@/lib/calculators/artifact")
  return getCalculatorFunnel(await svc(), { brokerageId: ctx.brokerageId, formId: String(formId ?? "") })
}

// TOMBSTONE (wave 156, lane 156H, round 3) — `computeInternalSellerNetAction` stood here: a second door onto the brokerage's
// agreed-commission net sheet that nothing in the product called, beside the dashboard's own door. What it had and the survivor
// lacked (estimate marks, buyer-broker compensation in dollars, other liens, concessions, prorated tax) was merged onto the
// SURVIVOR first: calculateSellerNet at app/actions/calculators.ts:136 (session gate → claimed-tenant decision → ledger receipt →
// lib/calculators/artifact.ts computeInternalSellerNet with the canonical commission reader).

// ── public ────────────────────────────────────────────────────────────────────
export async function recordCalculatorOpenAction(formId: string, attribution?: LeadMagnetAttribution | null) {
  if (!(await allowed("open"))) return { success: false as const, error: "rate limited" }
  const { recordCalculatorOpen } = await import("@/lib/calculators/artifact")
  return recordCalculatorOpen({ formId: String(formId ?? ""), attribution: await clean(attribution) }, { client: await svc() })
}

export async function computeCalculatorArtifactAction(input: { formId: string; inputs: Record<string, unknown>; estimateKeys?: string[]; attribution?: LeadMagnetAttribution | null }) {
  if (!(await allowed("compute"))) return { success: false as const, error: "Too many calculations from this connection — try again in a minute." }
  const { computeCalculatorArtifact } = await import("@/lib/calculators/artifact")
  return computeCalculatorArtifact({ formId: String(input?.formId ?? ""), inputs: input?.inputs ?? {}, estimateKeys: Array.isArray(input?.estimateKeys) ? input.estimateKeys.map(String).slice(0, 40) : [], attribution: await clean(input?.attribution) }, { client: await svc() })
}

export async function optInCalculatorArtifactAction(input: {
  formId: string
  inputs: Record<string, unknown>
  estimateKeys?: string[]
  intent: "save_results" | "talk_to_agent"
  contact: { first_name?: string; last_name?: string; email?: string; phone?: string }
  consent?: unknown
  attribution?: LeadMagnetAttribution | null
}) {
  if (!(await allowed("optIn"))) return { success: false as const, error: "Too many requests from this connection — try again in a minute." }
  let ipAddress: string | undefined, userAgent: string | undefined
  try {
    const { headers } = await import("next/headers")
    const h = await headers()
    ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined
    userAgent = h.get("user-agent") ?? undefined
  } catch { /* outside a request scope: no provenance rather than a fabricated one */ }
  const { optInCalculatorResult } = await import("@/lib/calculators/artifact")
  return optInCalculatorResult({
    formId: String(input?.formId ?? ""), inputs: input?.inputs ?? {}, estimateKeys: Array.isArray(input?.estimateKeys) ? input.estimateKeys.map(String).slice(0, 40) : [],
    intent: input?.intent === "talk_to_agent" ? "talk_to_agent" : "save_results", contact: input?.contact ?? {}, consent: input?.consent,
    attribution: await clean(input?.attribution), ipAddress, userAgent,
  }, { client: await svc() })
}
