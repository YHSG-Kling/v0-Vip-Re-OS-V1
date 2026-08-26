"use server"

// app/actions/a2p-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// A2P 10DLC — the tenant-facing half of carrier registration: save the real
// business profile (validated, honest missing-field list), kick/resume the
// step machine, read the status line. Broker/admin gated; the platform's
// master + subaccount creds do the actual filing (lib/voice/a2p-registration).

import { createServiceClient } from "@/lib/supabase/service"
// ★ ACT-AS SEAM — TWO ENTRY POINTS, ONE GATE ★ resolveActingContext for the
// status read, resolveWriteContext for the profile save and the carrier filing.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { validateA2pProfile, loadA2pState, runA2pRegistration, describeA2pState, nextA2pStep, type A2pState } from "@/lib/voice/a2p-registration"

function isBrokerRole(t?: string | null) {
  // TENANT ADMIN GATE (kept inline, telecom infra): 'superadmin' removed — dead
  // as users.user_type (0 live rows); broker_owner added — storable seat that
  // owns the brokerage and was wrongly refused its own carrier registration.
  return ["admin", "broker", "broker_owner", "broker_admin"].includes(t ?? "")
}

/**
 * ONE gate, TWO channels (§6).
 *
 * WHY `mode` EXISTS. The act-as merge routed all three exports through the WRITE
 * entry point, which refuses a 'read_only' impersonation grant. Correct for the
 * profile save and for runA2pRegistrationAction (which files with carriers and
 * writes phone_number_events); wrong for getA2pStatusAction, which only reads the
 * registration state line. §5 — a grant walks the account and never exceeds it,
 * and "what is our carrier registration doing?" is the first question a support
 * seat asks. Nothing is widened: resolveActingContext hands back the same service
 * client under an active grant, and isBrokerRole is evaluated on the same
 * impersonated identity.
 */
async function requireBrokerCtx(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isBrokerRole(ctx.userType)) return { ok: false, error: "Only broker / admin can manage carrier registration" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export interface A2pStatusView {
  statusLine: string
  nextStep: string
  profileSaved: boolean
  profileMissing: string[]
  state: A2pState
}

export async function getA2pStatusAction(): Promise<{ ok: true; status: A2pStatusView } | { ok: false; error: string }> {
  // READ — the status line only. A read_only act-as grant may see it (§5).
  const auth = await requireBrokerCtx("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const [{ state }, { data: bs }] = await Promise.all([
    loadA2pState(svc, auth.brokerageId),
    svc.from("brokerage_settings").select("settings").eq("brokerage_id", auth.brokerageId).maybeSingle(),
  ])
  const v = validateA2pProfile((bs as any)?.settings?.a2p_business_profile)
  return {
    ok: true,
    status: {
      statusLine: describeA2pState(state),
      nextStep: nextA2pStep(state),
      profileSaved: v.ok,
      profileMissing: v.ok ? [] : v.missing,
      state,
    },
  }
}

export async function saveA2pBusinessProfileAction(input: Record<string, string>): Promise<{ ok: boolean; error?: string; missing?: string[] }> {
  // WRITE — brokerage_settings.a2p_business_profile.
  const auth = await requireBrokerCtx("write")
  if (!auth.ok) return auth
  const v = validateA2pProfile(input)
  if (!v.ok) return { ok: false, error: "Profile incomplete", missing: v.missing }
  const svc = createServiceClient()
  const { data: bs } = await svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", auth.brokerageId).maybeSingle()
  const settings = { ...((bs as any)?.settings ?? {}), a2p_business_profile: v.value }
  const write = bs
    ? await svc.from("brokerage_settings").update({ settings, updated_at: new Date().toISOString() }).eq("id", (bs as any).id)
    : await svc.from("brokerage_settings").insert({ brokerage_id: auth.brokerageId, settings })
  if (write.error) return { ok: false, error: write.error.message }
  return { ok: true }
}

/** Kick/resume registration — every call advances as far as carriers allow
 *  right now and polls the async reviews. Safe to press repeatedly. */
export async function runA2pRegistrationAction(): Promise<{ ok: boolean; statusLine: string; error?: string }> {
  // WRITE — files with the carriers and stamps phone_number_events.
  const auth = await requireBrokerCtx("write")
  if (!auth.ok) return { ok: false, statusLine: "", error: auth.error }
  const svc = createServiceClient()
  const r = await runA2pRegistration(svc, auth.brokerageId)
  await svc.from("phone_number_events").insert({
    brokerage_id: auth.brokerageId, phone_number: "a2p",
    event_type: "webhooks_bound", source: "a2p_registration",
    notes: `A2P step machine ran → ${r.advancedTo}${r.error ? ` (error: ${r.error.slice(0, 160)})` : ""}`,
  }).then(undefined, () => {})
  return { ok: r.ok, statusLine: describeA2pState(r.state), error: r.error }
}
