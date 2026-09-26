"use server"

// app/actions/a2p-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// A2P 10DLC — the tenant-facing half of carrier registration on the PHONE
// settings page: read the status line and what is still missing, kick/resume
// the step machine. Broker/admin gated; the platform's master + subaccount
// creds do the actual filing (lib/voice/a2p-registration).
//
// The business profile is NOT typed here any more (wave 84D) — it is a
// BRANDING SETTING (owner: "add the registration info needed for registration
// in as a branding setting so that info is pulled for registration."), edited
// on /settings/branding's Business registration card and pulled by
// resolveA2pProfile through lib/branding/business-registration.ts.

import { createServiceClient } from "@/lib/supabase/service"
// ★ ACT-AS SEAM — TWO ENTRY POINTS, ONE GATE ★ resolveActingContext for the
// status read, resolveWriteContext for the carrier filing.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { loadA2pState, runA2pRegistration, describeA2pState, nextA2pStep, resolveA2pProfile, type A2pState, type A2pFieldSource } from "@/lib/voice/a2p-registration"
import { redactDraftForClient, BUSINESS_REGISTRATION_SETTINGS_PATH } from "@/lib/branding/business-registration"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"

// TOMBSTONE: local isBrokerRole (["admin","broker","broker_owner","broker_admin"])
// was the BROKERAGE_FINANCE_ADMIN_USER_TYPES roster restated — carrier
// registration obligates the brokerage the same way finance does, and
// resolve-user-role.ts:539 isBrokerageFinanceAdmin (imported above) is that
// roster's one predicate (§1/§6 SAME BODY census round 3, 2026-09-09).

// TOMBSTONE (wave 84D, §1.1 — merged onto the survivor, then deleted):
// saveA2pBusinessProfileAction wrote the tenant-typed profile (EIN, privacy /
// terms URLs, and a retyped copy of the legal name / address / contact) to
// brokerage_settings.settings.a2p_business_profile. Its survivor is
// app/actions/settings/business-registration.ts:saveBusinessRegistrationAction
// (the Branding page's Business registration card), which writes the
// registration-only facts to settings.business_registration and the identity
// facts through the brokerages row's one writer (updateBrokerageIdentity) —
// no second copy of a name or an address. Live brokerage_settings held 0 rows
// on 2026-09-26, so no a2p_business_profile data was stranded.

/**
 * ONE gate, TWO channels (§6).
 *
 * WHY `mode` EXISTS. The act-as merge routed all three exports through the WRITE
 * entry point, which refuses a 'read_only' impersonation grant. Correct for
 * runA2pRegistrationAction (which files with carriers and writes
 * phone_number_events); wrong for getA2pStatusAction, which only reads the
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
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return { ok: false, error: "Only broker / admin can manage carrier registration" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export interface A2pStatusView {
  statusLine: string
  nextStep: string
  profileSaved: boolean
  profileMissing: string[]
  state: A2pState
  /** Every field already known (registration branding setting first, then the
   *  brokerage record / owner seat) — EIN MASKED (redactDraftForClient). */
  prefill: Record<string, string>
  /** Which prefilled fields came from somewhere other than the registration record. */
  derivedKeys: string[]
  /** Where each field came from (registration | brokerage | owner_seat | default | storefront). */
  sources: Record<string, A2pFieldSource>
  /** Where the tenant completes what is missing (the Branding card). */
  settingsPath: string
}

export async function getA2pStatusAction(): Promise<{ ok: true; status: A2pStatusView } | { ok: false; error: string }> {
  // READ — the status line only. A read_only act-as grant may see it (§5).
  const auth = await requireBrokerCtx("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // READ: resolveA2pProfile never writes (84D retired the derived-copy persist).
  const [{ state }, v] = await Promise.all([
    loadA2pState(svc, auth.brokerageId),
    resolveA2pProfile(svc, auth.brokerageId),
  ])
  return {
    ok: true,
    status: {
      statusLine: describeA2pState(state),
      nextStep: nextA2pStep(state),
      profileSaved: v.ok,
      profileMissing: v.ok ? [] : v.missing,
      state,
      prefill: redactDraftForClient(v.draft),
      derivedKeys: v.derivedKeys ?? [],
      sources: v.sources ?? {},
      settingsPath: BUSINESS_REGISTRATION_SETTINGS_PATH,
    },
  }
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
