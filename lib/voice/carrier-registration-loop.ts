// lib/voice/carrier-registration-loop.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AUTOMATIC BUSINESS-REGISTRATION LOOP (wave 83, lane 83D — owner verbatim:
// "the person picks a number or ports and auto business listing approval.").
//
// ALREADY EXISTED — REUSED: lib/voice/a2p-registration.ts is THE step machine
// (TrustHub secondary customer profile → A2P trust product → brand → messaging
// service → number attach → campaign; toll-free verification for 8xx) and
// kickCarrierRegistration fired it ONCE, at purchase / port time. What did NOT
// exist: anything that ran it AGAIN. Twilio's reviews are asynchronous — the
// customer profile up to 72 h, a brand in manual vetting 7+ business days, a
// campaign 10–15 days (twilio.com/docs/messaging/compliance/a2p-10dlc,
// 2026-09-26) — and the campaign cannot even be FILED until the brand clears.
// So every tenant stopped at "brand under review" until a human pressed
// "Run / resume registration"; the platform sentinel could only REPORT the
// stall ("nothing advances on its own", lib/platform/platform-sentinel.ts).
//
// This file is the missing half: an hourly tick (app/api/cron/
// carrier-registration-tick, registered in lib/kernel/cron-dispatch.ts) that,
// per tenant with a number or an open port,
//   1. polls open port-ins and LANDS completed numbers (lib/voice/number-port-in)
//      — landing kicks registration through the same core;
//   2. resolves the business profile from the brokerage's own record
//      (resolveA2pProfile) — the tenant is asked ONLY for what no record holds;
//      since wave 84D that is PULLED from the Branding page's Business
//      registration setting (lib/branding/business-registration.ts, the one
//      reader) — the ring names the missing fields and links there;
//   3. runs the 10DLC machine for local numbers and toll-free verification for
//      8xx, each resumable and idempotent (a pass is one poll when idle);
//   4. derives ONE phase (carrierRegistrationPhase) and, when it CHANGES,
//      audits phone_number_events and rings the brokerage's finance admins —
//      "needs your input" names the fields, "approved" says the phone test is
//      unlocked.
// The phone/test feature needs no switch: it reads assessPhoneTestReadiness
// over the same state, so it unlocks the moment a poll records the approval —
// and ONLY then.

import {
  loadA2pState, runA2pRegistration, runTollfreeVerification, resolveA2pProfile, recordLoopPhase,
  assessPhoneTestReadiness, a2pCampaignApproved, isTollFreeNumber, describeA2pState, describeTollfreeState,
  type A2pState, type CarrierRunDeps,
} from "@/lib/voice/a2p-registration"
import { pollPortIns, portInNeedsPolling, type PortInDeps, type PortInRecord } from "@/lib/voice/number-port-in"
import { BUSINESS_REGISTRATION_SETTINGS_LABEL, BUSINESS_REGISTRATION_SETTINGS_PATH } from "@/lib/branding/business-registration"

// ── The phase (PURE) ─────────────────────────────────────────────────────────

export type CarrierPhase = "no_numbers" | "needs_input" | "filing" | "carrier_review" | "approved" | "rejected"

export interface CarrierPhaseView {
  phase: CarrierPhase
  /** true iff assessPhoneTestReadiness says ready — the ONE unlock rule. */
  testUnlocked: boolean
  /** What the tenant must do, in plain words (empty when nothing). */
  needs: string[]
  statusLines: string[]
}

const CAMPAIGN_REJECTED = ["FAILED"]
const BRAND_REJECTED = ["FAILED", "SUSPENDED"]

/**
 * PURE: one phase for the tenant's whole carrier posture.
 *   no_numbers     — nothing to register yet
 *   needs_input    — the profile is missing fields (named) — nothing can file
 *   rejected       — a carrier said no (brand / campaign / toll-free) — fix + re-run
 *   filing         — steps still to submit (the tick submits them)
 *   carrier_review — everything submitted, waiting on Twilio / TCR / carriers
 *   approved       — every lane the numbers need is registered → test unlocked
 */
export function carrierRegistrationPhase(
  state: A2pState,
  numbers: ReadonlyArray<{ phone_number: string }>,
  profileMissing: string[],
): CarrierPhaseView {
  const readiness = assessPhoneTestReadiness(state, numbers)
  const needLocal = numbers.some((n) => !isTollFreeNumber(n.phone_number))
  const needTollfree = numbers.some((n) => isTollFreeNumber(n.phone_number))
  const statusLines = [...(needLocal ? [describeA2pState(state)] : []), ...(needTollfree ? [describeTollfreeState(state)] : [])]
  if (!numbers.length) return { phase: "no_numbers", testUnlocked: false, needs: [], statusLines: ["No phone number yet — pick a local number or port yours."] }
  if (readiness.ready) return { phase: "approved", testUnlocked: true, needs: [], statusLines }
  if (profileMissing.length) return { phase: "needs_input", testUnlocked: false, needs: profileMissing.map((m) => `Business profile: ${m}`), statusLines }
  const brand = (state.brand_status ?? "").toUpperCase()
  const campaign = (state.campaign_status ?? "").toUpperCase()
  const tf = (state.tollfree_status ?? "").toUpperCase()
  const rejectedNeeds: string[] = []
  if (needLocal && state.brand_sid && BRAND_REJECTED.includes(brand)) rejectedNeeds.push(`Brand ${brand}${state.last_error ? `: ${state.last_error}` : ""} — correct the legal name / EIN / address to match the IRS record`)
  if (needLocal && state.campaign_sid && CAMPAIGN_REJECTED.includes(campaign)) rejectedNeeds.push(`Campaign FAILED${state.last_error ? `: ${state.last_error}` : ""}`)
  if (needTollfree && tf === "TWILIO_REJECTED") rejectedNeeds.push(`Toll-free verification REJECTED${state.tollfree_error ? `: ${state.tollfree_error}` : ""}`)
  if (rejectedNeeds.length) return { phase: "rejected", testUnlocked: false, needs: rejectedNeeds, statusLines }
  // Waiting on a carrier = the campaign is filed, OR the brand is filed and
  // still under TCR review (the campaign cannot be filed before it clears).
  const brandInReview = !!state.brand_sid && !["APPROVED", ...BRAND_REJECTED].includes(brand) && !!state.number_attached
  const localSubmitted = !needLocal || !!state.campaign_sid || brandInReview
  const tfSubmitted = !needTollfree || !!state.tollfree_verification_sid
  const errorNeeds = [
    ...(needLocal && state.last_error ? [`Last filing error: ${state.last_error}`] : []),
    ...(needTollfree && state.tollfree_error ? [`Last toll-free error: ${state.tollfree_error}`] : []),
  ]
  return { phase: localSubmitted && tfSubmitted ? "carrier_review" : "filing", testUnlocked: false, needs: errorNeeds, statusLines }
}

/** PURE: should the tick run the 10DLC / toll-free runner for this tenant? */
export function carrierTickPlan(state: A2pState, numbers: ReadonlyArray<{ phone_number: string; twilio_number_sid?: string | null }>, profileOk: boolean): { run10dlc: boolean; runTollfree: boolean } {
  if (!profileOk || !numbers.length) return { run10dlc: false, runTollfree: false }
  const local = numbers.filter((n) => !isTollFreeNumber(n.phone_number))
  const unattached = local.some((n) => n.twilio_number_sid && !(state.attached_number_sids ?? []).includes(n.twilio_number_sid))
  const tfDone = ["TWILIO_APPROVED", "TWILIO_REJECTED"].includes((state.tollfree_status ?? "").toUpperCase())
  return {
    // Approved AND every local number pooled → nothing to do (no API call).
    run10dlc: local.length > 0 && (!a2pCampaignApproved(state) || unattached),
    runTollfree: numbers.some((n) => isTollFreeNumber(n.phone_number)) && !tfDone,
  }
}

// ── The tick (IMPURE) ────────────────────────────────────────────────────────

export interface CarrierTickDeps {
  carrier?: CarrierRunDeps
  port?: PortInDeps
  /** Tenants per tick (default 50) — bounded so one tick never runs away. */
  limit?: number
}

export interface CarrierTickTenantResult {
  brokerageId: string
  before: CarrierPhase | null
  after: CarrierPhase
  ported: string[]
  ran: Array<"10dlc" | "tollfree">
  needs: string[]
  testUnlocked: boolean
  error?: string
}

/** The finance-admin roster rings for carrier news (same tier that files it). */
async function ringAdmins(svc: any, brokerageId: string, title: string, body: string): Promise<void> {
  const { BROKERAGE_FINANCE_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  const { data: admins, error } = await svc.from("users").select("id").eq("brokerage_id", brokerageId)
    .in("user_type", [...BROKERAGE_FINANCE_ADMIN_USER_TYPES]).is("deleted_at", null).limit(5)
  if (error) { console.warn(`[carrier-loop] admin roster read refused for ${brokerageId}:`, error.message); return }
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  for (const a of (admins ?? []) as Array<{ id: string }>) {
    await sentinelWrite(svc, svc.from("notifications").insert({
      user_id: a.id, brokerage_id: brokerageId, type: "carrier_registration", title, body: body.slice(0, 900), priority: "high", is_read: false,
    }), { table: "notifications", flow: "carrier_registration_loop", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the registration it reports" })
  }
}

export async function advanceTenantCarrier(svc: any, brokerageId: string, deps: CarrierTickDeps = {}): Promise<CarrierTickTenantResult> {
  // 1. Ports first — a number that lands now is registered in this same pass.
  const port = await pollPortIns(svc, brokerageId, deps.port)

  const { data: nums, error: numErr } = await svc.from("tenant_phone_numbers")
    .select("phone_number, twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
  const { state: before } = await loadA2pState(svc, brokerageId)
  if (numErr) return { brokerageId, before: (before.loop_phase as CarrierPhase) ?? null, after: (before.loop_phase as CarrierPhase) ?? "no_numbers", ported: port.landed, ran: [], needs: [], testUnlocked: false, error: `numbers read refused: ${numErr.message}` }
  const numbers = (nums ?? []) as Array<{ phone_number: string; twilio_number_sid: string | null }>

  // 2. The profile, derived from the brokerage's own record.
  const profile = numbers.length ? await resolveA2pProfile(svc, brokerageId) : { ok: false as const, missing: [] }
  const plan = carrierTickPlan(before, numbers, profile.ok)

  // 3. Advance each lane the numbers need (resumable; idle = one poll).
  const ran: Array<"10dlc" | "tollfree"> = []
  if (plan.run10dlc) { await runA2pRegistration(svc, brokerageId, { deps: deps.carrier }); ran.push("10dlc") }
  if (plan.runTollfree) { await runTollfreeVerification(svc, brokerageId, { deps: deps.carrier }); ran.push("tollfree") }

  // 4. One phase; a CHANGE is audited and rung.
  const { state: after } = await loadA2pState(svc, brokerageId)
  const view = carrierRegistrationPhase(after, numbers, profile.ok ? [] : profile.missing)
  const prev = (after.loop_phase ?? before.loop_phase ?? null) as CarrierPhase | null
  if (view.phase !== prev) {
    await recordLoopPhase(svc, brokerageId, view.phase)
    const { logPhoneNumberEvent } = await import("@/lib/voice/number-provisioning")
    await logPhoneNumberEvent(svc, {
      brokerageId, phoneNumber: numbers[0]?.phone_number ?? "carrier",
      // CHECK'd vocabulary: the registration lane has always audited as
      // webhooks_bound with a distinct source (lib/voice/a2p-registration.ts).
      eventType: "webhooks_bound", source: "carrier_registration_tick",
      notes: `carrier registration ${prev ?? "new"} → ${view.phase}${view.needs.length ? ` · needs: ${view.needs.join("; ")}` : ""}`.slice(0, 500),
    })
    if (view.phase === "approved") await ringAdmins(svc, brokerageId, "Business texting approved — phone test unlocked", `Carriers approved your business registration. ${view.statusLines.join(" ")} You can now run the phone test from Phone settings.`)
    else if (view.phase === "needs_input" || view.phase === "rejected") await ringAdmins(svc, brokerageId, "Business registration needs your input", `${view.needs.join(" · ")} — add it in ${BUSINESS_REGISTRATION_SETTINGS_LABEL} (${BUSINESS_REGISTRATION_SETTINGS_PATH}); filing resumes on its own within the hour.`)
  }
  return { brokerageId, before: prev, after: view.phase, ported: port.landed, ran, needs: view.needs, testUnlocked: view.testUnlocked }
}

/**
 * The hourly tick: every tenant with an active number or an open port.
 * Tenants whose phase is already `approved` with nothing new cost one read.
 */
export async function runCarrierRegistrationTick(svc: any, deps: CarrierTickDeps = {}): Promise<{ tenants: number; results: CarrierTickTenantResult[]; errors: string[] }> {
  const limit = Math.min(Math.max(deps.limit ?? 50, 1), 200)
  const errors: string[] = []
  const ids = new Set<string>()
  const { data: numRows, error: numErr } = await svc.from("tenant_phone_numbers").select("brokerage_id").eq("is_active", true).not("brokerage_id", "is", null).limit(2000)
  if (numErr) errors.push(`tenant_phone_numbers read refused: ${numErr.message}`)
  for (const r of (numRows ?? []) as Array<{ brokerage_id: string }>) if (r.brokerage_id) ids.add(r.brokerage_id)
  const { data: portRows, error: portErr } = await svc.from("brokerage_settings").select("brokerage_id, settings").not("settings->phone_port_ins", "is", null).limit(500)
  if (portErr) errors.push(`port-in scan refused: ${portErr.message}`)
  for (const r of (portRows ?? []) as Array<{ brokerage_id: string; settings: any }>) {
    const open = (Array.isArray(r.settings?.phone_port_ins) ? r.settings.phone_port_ins : []) as PortInRecord[]
    if (open.some(portInNeedsPolling)) ids.add(r.brokerage_id)
  }
  const results: CarrierTickTenantResult[] = []
  for (const id of [...ids].slice(0, limit)) {
    try { results.push(await advanceTenantCarrier(svc, id, deps)) }
    catch (err) { errors.push(`${id}: ${(err as Error)?.message ?? "unknown"}`) }
  }
  return { tenants: ids.size, results, errors }
}
