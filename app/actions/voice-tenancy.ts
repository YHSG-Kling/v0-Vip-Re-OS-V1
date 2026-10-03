"use server"

// app/actions/voice-tenancy.ts — the phone-system commercial model's tenant
// surface: voice usage visibility (metered resale needs a visible meter) and
// the BYO Twilio escape hatch (multi_location tier only — everyone else rides
// the platform's subaccounts and never touches a Twilio signup).

import { createServiceClient } from "@/lib/supabase/service"
// ★ ACT-AS SEAM — TWO ENTRY POINTS, ONE GATE ★
// resolveActingContext for the READS, resolveWriteContext for the WRITE. Same
// admin predicate, evaluated on the same impersonated identity either way; the
// only difference is that a 'read_only' grant is refused on the write path and
// admitted on the read path. See the §5 note on requireBrokerageAdmin below.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { loadVoiceUsage, type VoiceUsage } from "@/lib/voice/twilio-tenancy"

// TENANT ADMIN GATE (kept inline, telecom tenancy — deliberately no team_lead):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

/**
 * ONE gate, TWO channels (§6) — the same shape lib/kernel/global-settings.ts and
 * app/actions/settings/revenue-share-setting.ts already use.
 *
 * WHY `mode` EXISTS. The act-as merge routed this whole file through the WRITE
 * entry point, which refuses a 'read_only' impersonation grant outright. That is
 * correct for setTwilioByoCredsAction and WRONG for the two readers: §5 says a
 * grant "walks the account and never exceeds it", and a support seat that cannot
 * READ the voice meter or see whether BYO Twilio is configured is not walking the
 * account — it is locked out of it. The refusal was visible rather than silent,
 * so nothing was ever mis-reported; it simply blanked two settings cards.
 *
 * NOTHING IS WIDENED. resolveActingContext hands back the SAME service client
 * under an active grant that resolveWriteContext does, and the ADMIN_TYPES
 * predicate below is evaluated on the SAME impersonated identity. The read path
 * gains exactly one caller class — a read_only grant — and gains no table, no
 * column and no tenant that a full grant did not already reach.
 */
async function requireBrokerageAdmin(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return { ok: false, error: "Forbidden — brokerage admin only" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

/** This month's voice line: calls, minutes, cost — the meter behind the bill.
 *
 *  Also reports `planTier`, so the phone-settings page can decide whether to
 *  render the BYO-Twilio card at all. The tier rule is still ENFORCED inside
 *  setTwilioByoCredsAction — this is only what the page renders, never the gate.
 *  (Reading `plan_tier`, the column with writers; `subscription_tier` drifts.) */
export async function getVoiceUsageAction(month?: string): Promise<
  { ok: true; usage: VoiceUsage; credTier: string; planTier: string | null } | { ok: false; error: string }
> {
  // READ — a read_only act-as grant may see the meter (§5).
  const auth = await requireBrokerageAdmin("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const m = month ?? new Date().toISOString().slice(0, 7)
  const usage = await loadVoiceUsage(svc, auth.brokerageId, m)
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, auth.brokerageId)
  const { data: brk } = await svc
    .from("brokerages").select("plan_tier").eq("id", auth.brokerageId).maybeSingle()
  return {
    ok: true,
    usage,
    credTier: creds?.tier ?? "unconfigured",
    planTier: ((brk as any)?.plan_tier as string | null) ?? null,
  }
}

/** Whether BYO Twilio is currently configured for this brokerage — the read the
 *  settings card needs so it can say "connected" without ever handing the auth
 *  token back to the browser. Only the SID (a public identifier) is returned. */
export async function getTwilioByoStatusAction(): Promise<
  { ok: true; configured: boolean; accountSid: string | null } | { ok: false; error: string }
> {
  // READ — status only; the auth token is never echoed on any grant.
  const auth = await requireBrokerageAdmin("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // Destructure error — a refused read must not render as "not connected",
  // which would invite an admin to re-enter credentials that are already there.
  const { data, error } = await svc
    .from("platform_credentials")
    .select("account_id, is_active")
    .eq("brokerage_id", auth.brokerageId)
    .eq("platform", "twilio_byo")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    configured: Boolean(data?.is_active && data?.account_id),
    // NEVER access_token. The SID is the only half safe to echo back.
    accountSid: (data?.account_id as string | null) ?? null,
  }
}

/** BYO Twilio creds — the top-tier escape hatch for tenants with their own
 *  carrier contract. Everyone else stays on platform subaccounts. */
export async function setTwilioByoCredsAction(input: { accountSid: string; authToken: string }): Promise<{ ok: boolean; error?: string }> {
  // WRITE — carrier credentials. read_only is refused inside the gate.
  const auth = await requireBrokerageAdmin("write")
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", auth.brokerageId).maybeSingle()
  if ((brk as any)?.plan_tier !== "multi_location") {
    return { ok: false, error: "Bring-your-own Twilio is a Multi-Location tier feature — other tiers run on platform-managed numbers (nothing to set up)." }
  }

  const sid = input.accountSid?.trim()
  const token = input.authToken?.trim()
  if (!/^AC[a-f0-9]{32}$/i.test(sid ?? "")) return { ok: false, error: "That doesn't look like a Twilio Account SID (AC…)" }
  if (!token || token.length < 24) return { ok: false, error: "That doesn't look like a Twilio auth token" }

  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", auth.brokerageId).eq("platform", "twilio_byo").maybeSingle()
  const row = { brokerage_id: auth.brokerageId, platform: "twilio_byo", account_id: sid, access_token: token, owner_type: "brokerage", owner_id: auth.brokerageId, is_active: true }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  return error ? { ok: false, error: error.message } : { ok: true }
}
