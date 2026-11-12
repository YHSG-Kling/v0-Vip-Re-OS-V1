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
  haltVerdict, profileFingerprint,
  type A2pState, type CarrierRunDeps, type A2pFailureClass,
} from "@/lib/voice/a2p-registration"
import { pollPortIns, portInNeedsPolling, type PortInDeps, type PortInRecord } from "@/lib/voice/number-port-in"
import { BUSINESS_REGISTRATION_SETTINGS_LABEL, BUSINESS_REGISTRATION_SETTINGS_PATH } from "@/lib/branding/business-registration"

// ── The phase (PURE) ─────────────────────────────────────────────────────────

/** THE ONE carrier-posture vocabulary (wave 83D; `halted` added by wave 140G —
 *  a credential / compliance refusal the loop must not retry on its own). The
 *  tenant's four UI states DERIVE from it (tenantA2pUiState) — never a second
 *  stored status. It lives in platform_credentials 'twilio_a2p' config jsonb
 *  (loop_phase), so no CHECK constrains it and no migration was needed. */
export type CarrierPhase = "no_numbers" | "needs_input" | "filing" | "carrier_review" | "approved" | "rejected" | "halted"

// ── Wave 140G: the TENANT's four states, derived from the phase (PURE) ───────
// Owner (wave 140): "tenant UI shows AVAILABLE / PENDING REGISTRATION / ACTION
// REQUIRED / RESTRICTED". One vocabulary, one derivation:
//   AVAILABLE            — approved: every lane the numbers need is carrier-
//                          registered; texting and the phone test are live
//   PENDING_REGISTRATION — filed (or being filed) and waiting on Twilio / TCR /
//                          the carriers; nothing for the tenant to do
//   ACTION_REQUIRED      — someone must act before filing can continue: the
//                          registration is missing fields (needs_input), a
//                          carrier said no (rejected), or the provider refused
//                          our request for a reason a retry cannot change
//                          (halted — the provider's reason is shown verbatim)
//   RESTRICTED           — texting is restricted and nothing is in flight:
//                          no number yet, or a number whose registration has
//                          not been filed (carriers filter unregistered
//                          business traffic; filing starts automatically)

export type TenantA2pUiState = "AVAILABLE" | "PENDING_REGISTRATION" | "ACTION_REQUIRED" | "RESTRICTED"

const TENANT_A2P_UI_LABELS: Readonly<Record<TenantA2pUiState, string>> = {
  AVAILABLE: "Available",
  PENDING_REGISTRATION: "Pending registration",
  ACTION_REQUIRED: "Action required",
  RESTRICTED: "Restricted",
}

/** PURE: the phase → the tenant's state. Exhaustive over CarrierPhase. */
function tenantA2pUiState(phase: CarrierPhase, state: A2pState): TenantA2pUiState {
  switch (phase) {
    case "approved": return "AVAILABLE"
    case "carrier_review": return "PENDING_REGISTRATION"
    case "filing": return state.customer_profile_sid || state.tollfree_verification_sid ? "PENDING_REGISTRATION" : "RESTRICTED"
    case "needs_input":
    case "rejected":
    case "halted": return "ACTION_REQUIRED"
    case "no_numbers": return "RESTRICTED"
  }
}

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
  // Wave 140G: a halted filing is a named needs-action (the provider's reason),
  // never a silent hourly retry. haltVerdict with no fingerprint = "as stored".
  const halt = haltVerdict(state, null)
  if (halt.halted) return { phase: "halted", testUnlocked: false, needs: [halt.reason], statusLines }
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

/** PURE: should the tick run the 10DLC / toll-free runner for this tenant?
 *  Wave 140G: a HALTED tenant (credential / compliance refusal) is not run —
 *  zero provider calls — unless the profile fingerprint shows the tenant
 *  corrected the registration (compliance only; haltVerdict is the rule). */
export function carrierTickPlan(state: A2pState, numbers: ReadonlyArray<{ phone_number: string; twilio_number_sid?: string | null }>, profileOk: boolean, fingerprint: string | null = null): { run10dlc: boolean; runTollfree: boolean } {
  if (!profileOk || !numbers.length) return { run10dlc: false, runTollfree: false }
  if (haltVerdict(state, fingerprint).halted) return { run10dlc: false, runTollfree: false }
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
  /** Wave 140G (readiness): may this tenant's PLAN hold a phone number at all?
   *  Default: lib/billing/phone-plan-resolve.ts evaluateTenantNumberProvisioning
   *  (lazy — it is server-only). null = unknown (a refused read never reads as
   *  "not applicable"). */
  numbersAllowed?: (svc: any, brokerageId: string) => Promise<boolean | null>
  /** Wave 140N (readiness): the business-profile resolver (default resolveA2pProfile —
   *  it reads the registration sources + NEXT_PUBLIC_APP_URL; the readiness proof
   *  injects it so the REAL syncA2pStatus runs against an in-memory tenant). */
  profile?: typeof resolveA2pProfile
}

export interface CarrierTickTenantResult {
  brokerageId: string
  before: CarrierPhase | null
  after: CarrierPhase
  /** Wave 140G: the tenant's state, derived from `after` (one vocabulary). */
  uiState: TenantA2pUiState
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

export async function advanceTenantCarrier(svc: any, brokerageId: string, deps: CarrierTickDeps = {}, opts: { resume?: boolean } = {}): Promise<CarrierTickTenantResult> {
  // 1. Ports first — a number that lands now is registered in this same pass.
  const port = await pollPortIns(svc, brokerageId, deps.port)

  const { data: nums, error: numErr } = await svc.from("tenant_phone_numbers")
    .select("phone_number, twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
  const { state: before } = await loadA2pState(svc, brokerageId)
  if (numErr) {
    const stale = (before.loop_phase as CarrierPhase) ?? null
    return { brokerageId, before: stale, after: stale ?? "no_numbers", uiState: tenantA2pUiState(stale ?? "no_numbers", before), ported: port.landed, ran: [], needs: [], testUnlocked: false, error: `numbers read refused: ${numErr.message}` }
  }
  const numbers = (nums ?? []) as Array<{ phone_number: string; twilio_number_sid: string | null }>

  // 2. The profile, derived from the brokerage's own record.
  const profile = numbers.length ? await (deps.profile ?? resolveA2pProfile)(svc, brokerageId) : { ok: false as const, missing: [] }
  // Wave 140G: the fingerprint the halt rule compares (a corrected registration
  // lifts a compliance halt); an explicit resume lifts any halt once.
  const fingerprint = profile.ok ? profileFingerprint(profile.draft) : null
  const plan = carrierTickPlan(opts.resume ? { ...before, halted_at: null } : before, numbers, profile.ok, fingerprint)

  // 3. Advance each lane the numbers need (resumable; idle = one poll).
  const ran: Array<"10dlc" | "tollfree"> = []
  if (plan.run10dlc) { await runA2pRegistration(svc, brokerageId, { deps: deps.carrier, resume: opts.resume }); ran.push("10dlc") }
  if (plan.runTollfree) { await runTollfreeVerification(svc, brokerageId, { deps: deps.carrier, resume: opts.resume }); ran.push("tollfree") }

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
    // Wave 140G: a halt is rung ONCE with the provider's reason — it is never
    // retried silently (a credential halt waits for platform support; the
    // platform sentinel's A2P stall detector reads the same last_error).
    else if (view.phase === "halted") await ringAdmins(svc, brokerageId, "Business texting registration needs attention", `${view.needs.join(" · ")} (Phone settings → Carrier registration).`)
  }
  return { brokerageId, before: prev, after: view.phase, uiState: tenantA2pUiState(view.phase, after), ported: port.landed, ran, needs: view.needs, testUnlocked: view.testUnlocked }
}

// ── Wave 140G: THE ONE STATUS SYNC the readiness repair calls ────────────────
// Owner (wave 140): "Self-healing may retry safe status-sync/reconciliation
// (expose ONE syncA2pStatus(svc, brokerageId) the readiness repair can call);
// credential/compliance failures never auto-heal — ACTION REQUIRED with the
// provider's reason." There is no second reconciler: a sync IS one pass of
// advanceTenantCarrier (resumable, idempotent — approved + pooled costs zero
// provider calls; a review in flight costs one poll; nothing is ever filed
// twice because every step keys on its persisted sid), REFUSED while the
// tenant is halted (zero provider calls, the stored reason returned) unless
// the caller is a human pressing resume. `probeOnly` evaluates without running
// (the readiness contract's evaluate step; repair runs it for real).
//
// READINESS HOOK (integrator): lib/kernel/tenant-readiness.ts (lane 140B/K)
// takes the PHONE HALF of its `communications` ReadinessCheck from `readiness`
// below (status + required + reason + evidence — wave 140N: no second mapping
// of the phase anywhere) — evaluate with { probeOnly: true }, repair with no
// option, and never widen the halt.
//
// THE RULE FOR A TENANT WITH NO NUMBER YET: the communications check is
// WAITING_EXTERNAL with required:false (the tenant has not picked or ported a
// number — their choice, outside the platform; the contract's READY rule only
// counts REQUIRED checks, so this never blocks READY) or NOT_APPLICABLE (the
// plan admits no number at all) — NEVER BLOCKED, NEVER REQUIRED. Readiness
// does not fail a tenant for not having chosen a phone number. A filing the
// carrier is reviewing stays required:true WAITING_EXTERNAL — not READY until
// the carrier answers.

export interface A2pSyncResult {
  /** false when the sync did not run (halted — the stored reason is returned) or a read refused. */
  ok: boolean
  brokerageId: string
  phase: CarrierPhase
  uiState: TenantA2pUiState
  uiLabel: string
  /** One honest sentence — the provider's reason when halted / rejected. */
  reason: string
  needs: string[]
  testUnlocked: boolean
  ran: Array<"10dlc" | "tollfree">
  halted: { class: A2pFailureClass; reason: string; since: string } | null
  readiness: {
    status: "PASS" | "REPAIRABLE" | "WAITING_EXTERNAL" | "BLOCKED" | "NOT_APPLICABLE"
    required: boolean
    reason: string
    owner: "compliance_officer" | "platform"
    /** How the repair runs when REPAIRABLE (this function, no option). */
    repair: string | null
  }
  evidence: Record<string, unknown>
}

/** PURE: the readiness verdict for the communications check (see the rule above). */
function a2pReadinessVerdict(phase: CarrierPhase, state: A2pState, numbersAllowed: boolean | null): A2pSyncResult["readiness"] {
  const owner = state.last_error_class === "credential" ? "platform" : "compliance_officer"
  switch (phase) {
    case "approved": return { status: "PASS", required: true, reason: "every lane the tenant's numbers need is carrier-registered", owner: "compliance_officer", repair: null }
    case "no_numbers":
      if (numbersAllowed === false) return { status: "NOT_APPLICABLE", required: false, reason: "the plan admits no phone number — nothing to register", owner: "compliance_officer", repair: null }
      // required:false — "never a blocker" IS the rule (readinessVerdict counts only REQUIRED checks).
      return { status: "WAITING_EXTERNAL", required: false, reason: "no phone number yet — the tenant picks a local number or ports theirs; never a blocker", owner: "compliance_officer", repair: null }
    case "carrier_review": return { status: "WAITING_EXTERNAL", required: true, reason: "filed — waiting on Twilio / TCR / carrier review", owner: "compliance_officer", repair: null }
    case "filing": return { status: "REPAIRABLE", required: true, reason: "steps still to submit — the hourly loop or a sync files them", owner: "compliance_officer", repair: "lib/voice/carrier-registration-loop.ts syncA2pStatus(svc, brokerageId)" }
    case "needs_input": return { status: "BLOCKED", required: true, reason: `the Business registration is missing fields (${BUSINESS_REGISTRATION_SETTINGS_PATH})`, owner: "compliance_officer", repair: null }
    case "rejected": return { status: "BLOCKED", required: true, reason: `a carrier rejected the filing${state.last_error ? `: ${state.last_error}` : ""}`, owner: "compliance_officer", repair: null }
    case "halted": {
      const h = haltVerdict(state, null)
      return { status: "BLOCKED", required: true, reason: h.halted ? h.reason : "filing halted", owner, repair: null }
    }
  }
}

async function defaultNumbersAllowed(svc: any, brokerageId: string): Promise<boolean | null> {
  try {
    const { evaluateTenantNumberProvisioning } = await import("@/lib/billing/phone-plan-resolve")
    const v = await evaluateTenantNumberProvisioning(svc, brokerageId)
    return v.allowed
  } catch { return null }
}

export async function syncA2pStatus(svc: any, brokerageId: string, opts: { deps?: CarrierTickDeps; resume?: boolean; probeOnly?: boolean } = {}): Promise<A2pSyncResult> {
  const deps = opts.deps ?? {}
  const { state: stored } = await loadA2pState(svc, brokerageId)
  // haltVerdict with resume=true is never halted — a human's resume runs once.
  const halt = haltVerdict(stored, null, opts.resume)
  let ran: Array<"10dlc" | "tollfree"> = []
  let runError: string | null = null
  if (!opts.probeOnly && !halt.halted) {
    const r = await advanceTenantCarrier(svc, brokerageId, deps, { resume: opts.resume })
    ran = r.ran
    runError = r.error ?? null
  }
  // The view, from STORED state (what the tenant and the contract read).
  const { state } = await loadA2pState(svc, brokerageId)
  const { data: nums, error: numErr } = await svc.from("tenant_phone_numbers")
    .select("phone_number, twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
  if (numErr) throw new Error(`tenant phone numbers could not be read (${numErr.message}) — the carrier status is unknown, not clear`)
  const numbers = (nums ?? []) as Array<{ phone_number: string; twilio_number_sid: string | null }>
  const profile = numbers.length ? await (deps.profile ?? resolveA2pProfile)(svc, brokerageId) : { ok: false as const, missing: [] as string[] }
  const view = carrierRegistrationPhase(state, numbers, profile.ok ? [] : profile.missing)
  const numbersAllowed = numbers.length ? true : await (deps.numbersAllowed ?? defaultNumbersAllowed)(svc, brokerageId)
  const nowHalt = haltVerdict(state, null)
  const uiState = tenantA2pUiState(view.phase, state)
  return {
    // ok = nothing needs a human right now (halted / rejected / missing input are not ok).
    ok: !nowHalt.halted && !runError && view.phase !== "rejected" && view.phase !== "needs_input",
    brokerageId,
    phase: view.phase,
    uiState,
    uiLabel: TENANT_A2P_UI_LABELS[uiState],
    reason: nowHalt.halted ? nowHalt.reason : (runError ?? view.needs[0] ?? view.statusLines.join(" ")),
    needs: view.needs,
    testUnlocked: view.testUnlocked,
    ran,
    halted: nowHalt.halted ? { class: nowHalt.class, reason: nowHalt.reason, since: state.halted_at ?? "" } : null,
    readiness: a2pReadinessVerdict(view.phase, state, numbersAllowed),
    evidence: {
      numbers: numbers.length, brand_status: state.brand_status ?? null, campaign_status: state.campaign_status ?? null,
      tollfree_status: state.tollfree_status ?? null, last_error: state.last_error ?? null, last_error_class: state.last_error_class ?? null,
      halted_at: state.halted_at ?? null, updated_at: state.updated_at ?? null, probeOnly: !!opts.probeOnly,
    },
  }
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
