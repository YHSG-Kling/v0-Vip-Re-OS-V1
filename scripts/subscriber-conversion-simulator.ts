#!/usr/bin/env tsx
/**
 * scripts/subscriber-conversion-simulator.ts   (npm run test:subscriber-conversion)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 77B — owner verbatim: "when a real estate subscriber wants to purchase
 * the platform subscription there needs to be an easy way to convert a
 * prospect to a subscriber or a new subscriber that isn't a prospect … act
 * like a well versed real estate business saas creator who has experience
 * creating subscribers keeping in mind this saas is agenticos using
 * autonomous ai methodology with humans when warranted."
 *
 * Proves, with the production functions run against an injected client (the
 * only edge stubbed) and STRIPPED source for every code-token scan
 * (scripts/strip-comments.ts — CLAUDE.md §2), positive controls throughout:
 *
 *   Layer 1 — PURE: the seat-band tier fit, the name split, the tenant facts
 *             derived from a prospect row (fail closed without an email or a
 *             name), the humans-when-warranted rule (enterprise size, custom
 *             pricing, CRM migration — and NOT a spreadsheet), the
 *             subscription row for each billing mode, the membership flags.
 *   Layer 2 — BEHAVIOUR: convertProspectToSubscriber with the tenant-creation
 *             core and the staff bell injected — autonomous self-conversion,
 *             the warranted refusal (no provisioning call — control), the
 *             active-billing refusal for a prospect, the staff conversion with
 *             the white-glove task + the pending demo hold released + the
 *             open handoff closed, idempotency on an already-linked row, and
 *             the id-keyed stamp.
 *   Layer 3 — ONE CORE: exactly one brokerages insert outside the documented
 *             brokerage-of-one self-heal, in lib/kernel/tenant-creation.ts;
 *             the self-serve signup, the staff door and the conversion all
 *             delegate to createTenantCore (positive control: a fixture with
 *             a second insert is counted); the core carries every day-one
 *             piece once; the direct (never-a-prospect) path links back by
 *             the admin email through the same stamp.
 *   Layer 4 — AFTERWARDS: the ladder reads only new|contacted (a converted
 *             row is never nudged); SUBSCRIPTION_CREATED + the onboarding
 *             library are emitted by the core; the human task is guarded by
 *             the warranted reasons; no prospect id in a contactId/leadId
 *             slot; Stripe only through the existing survivors.
 *   Layer 5 — SURFACES: the growth-board action (marketing-gated, audited,
 *             prospectId is the only id in the request) and the
 *             start_subscription tool (prospect_self, trial or paid, hands off
 *             on needsHuman); the exit menu names it.
 *   Layer 6 — registration.
 *
 * No DB, no network. Run:
 *   npx tsx --conditions=react-server scripts/subscriber-conversion-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string): string => readFileSync(join(root, p), "utf8")
const stripped = (p: string): string => stripComments(raw(p))

const CORE = "lib/kernel/tenant-creation.ts"
const CONVERSION = "lib/platform/prospect-conversion.ts"
const CAPTURE = "lib/platform/prospect-capture.ts"
const SIGNUP = "app/actions/auth/signup-brokerage.ts"
const STAFF_DOOR = "app/actions/admin/create-subscriber.ts"
const TOOLS = "lib/platform/prospect-agent-tools.ts"
const GROWTH_ACTIONS = "app/actions/superadmin/platform-growth.ts"
const BOARD = "app/dashboard/superadmin/growth/platform-growth-board.tsx"
const FOLLOWUP = "lib/platform/prospect-followup.ts"
const SELF_HEAL = "app/actions/onboarding/ensure-agent-brokerage.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · PURE — facts, tier fit, humans when warranted, the subscription row]")
const {
  tierForProspect, splitPersonName, deriveProspectTenantFacts, conversionHumanReasons,
  ENTERPRISE_SEAT_FLOOR, stampProspectConversion, convertProspectToSubscriber,
} = await import("../lib/platform/prospect-conversion")
// Wave 78A — the bands live in the plan catalogue (ONE derivation); this file
// used to import a private 1/15/75 table from prospect-conversion.
const { TIER_SEAT_BANDS, CANONICAL_TIERS: BAND_TIERS } = await import("../lib/billing/plan-catalog")
const { buildSubscriptionRow, platformMembershipFlags, buildTenantSlug, isCanonicalTier, CANONICAL_TIERS } = await import("../lib/kernel/tenant-creation")

check("tier fit: a declared canonical role_interest wins; else the seat band (2 → solo, 4 → team, 40 → brokerage, 200 → brokerage; multi_location only by declaration)",
  tierForProspect("brokerage", 2) === "brokerage" && tierForProspect("unknown", 2) === "solo_agent" && tierForProspect(null, 4) === "team" && tierForProspect("unknown", 40) === "brokerage" && tierForProspect(null, 200) === "brokerage" && tierForProspect("multi_location", 3) === "multi_location" && tierForProspect(null, null) === "solo_agent")
check("the seat bands (plan-catalog) are 2 / 5 / unlimited / unlimited — capped tiers ascend, then unlimited takes everything above", TIER_SEAT_BANDS.solo_agent === 2 && TIER_SEAT_BANDS.team === 5 && TIER_SEAT_BANDS.brokerage === null && TIER_SEAT_BANDS.multi_location === null && BAND_TIERS.length === 4)
check("name split: 'Dana Lee Smith' → first Dana, last 'Lee Smith'; a single token has an empty last name", splitPersonName(" Dana Lee Smith ").first === "Dana" && splitPersonName("Dana Lee Smith").last === "Lee Smith" && splitPersonName("Dana").last === "")

const row = {
  id: "p-1", name: "Dana Lee", email: "Dana@Acme.com", phone: "+15125550100", company: null, role_interest: "unknown", status: "contacted", converted_brokerage_id: null,
  details: { qualification: { brokerage_name: "Acme Realty", size_seats: 4, territory: "Austin metro", current_tools: "Follow Up Boss" } },
}
const facts = deriveProspectTenantFacts(row)
check("facts derive from the row: company ← qualification.brokerage_name, email lowercased, tier ← seat band, territory + current tools carried",
  facts.ok && facts.facts.brokerageName === "Acme Realty" && facts.facts.adminEmail === "dana@acme.com" && facts.facts.adminFirstName === "Dana" && facts.facts.adminLastName === "Lee" && facts.facts.tier === "team" && facts.facts.territory === "Austin metro" && facts.facts.currentTools === "Follow Up Boss" && facts.facts.brokeragePhone === "+15125550100")
check("overrides win (the plan they chose, a corrected email, a company said out loud)", (() => { const f = deriveProspectTenantFacts(row, { tier: "brokerage", email: "owner@acme.com", company: "Acme Group" }); return f.ok && f.facts.tier === "brokerage" && f.facts.adminEmail === "owner@acme.com" && f.facts.brokerageName === "Acme Group" })())
check("FAIL CLOSED: no usable email → refused; no name → refused (the sign-in link needs a mailbox, the owner row a first name)",
  !deriveProspectTenantFacts({ ...row, email: null }).ok && !deriveProspectTenantFacts({ ...row, name: null }).ok && !deriveProspectTenantFacts({ ...row, email: "not-an-email" }).ok)
check("a prospect with no company anywhere still gets a brokerage name (never a blank tenant)", (() => { const f = deriveProspectTenantFacts({ ...row, company: null, details: {} }); return f.ok && f.facts.brokerageName === "Dana Lee Real Estate" })())

check("humans when warranted: enterprise size (multi_location OR ≥ ENTERPRISE_SEAT_FLOOR seats)",
  conversionHumanReasons({ tier: "multi_location", sizeSeats: 3, currentTools: null }).includes("enterprise_size") && conversionHumanReasons({ tier: "team", sizeSeats: ENTERPRISE_SEAT_FLOOR, currentTools: null }).includes("enterprise_size") && !conversionHumanReasons({ tier: "brokerage", sizeSeats: ENTERPRISE_SEAT_FLOOR - 1, currentTools: null }).includes("enterprise_size"))
check("humans when warranted: custom pricing (explicit flag OR a handoff reason that talks price/contract)",
  conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: null, customPricingRequested: true }).includes("custom_pricing") && conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: null, handoffReason: "wants a discount for 3 years" }).includes("custom_pricing") && !conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: null, handoffReason: "asked how the ISA works" }).includes("custom_pricing"))
check("humans when warranted: a CRM migration — a real CRM yes, 'spreadsheets' / 'none' NO",
  conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: "Follow Up Boss" }).includes("crm_migration") && !conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: "spreadsheets and my phone" }).includes("crm_migration") && !conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: "none yet" }).includes("crm_migration"))
check("a plain solo/team prospect with no CRM and no pricing ask is FULLY autonomous (no reasons)", conversionHumanReasons({ tier: "team", sizeSeats: 5, currentTools: null }).length === 0)

const now = new Date("2026-09-21T12:00:00.000Z")
const trialRow = buildSubscriptionRow({ brokerageId: "b", tierId: "t", billing: { mode: "trial", trialDays: 14 }, now })
const activeRow = buildSubscriptionRow({ brokerageId: "b", tierId: "t", billing: { mode: "active", billingCycle: "annual" }, now })
check("the trial row writes trial_end == current_period_end (the paywall reads trial_end) and status 'trialing'", trialRow.status === "trialing" && trialRow.trial_end === trialRow.current_period_end && trialRow.current_period_end === "2026-10-05T12:00:00.000Z")
check("the active row has no trial_end, status 'active', and the cycle's period end (annual → +365d)", activeRow.status === "active" && !("trial_end" in activeRow) && activeRow.current_period_end === "2027-09-21T12:00:00.000Z")
check("membership flags: solo → the checkboxes (default false); any org tier → true", platformMembershipFlags({ tier: "solo_agent" }).brokerage_on_platform === false && platformMembershipFlags({ tier: "solo_agent", brokerageOnPlatform: true }).brokerage_on_platform === true && platformMembershipFlags({ tier: "brokerage" }).team_on_platform === true)
check("the slug is kebab + a suffix, and the tier vocabulary is the canonical four", buildTenantSlug("Acme Realty & Co", "ab12") === "acme-realty-co-ab12" && isCanonicalTier("team") && !isCanonicalTier("enterprise") && CANONICAL_TIERS.length === 4)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · BEHAVIOUR — convertProspectToSubscriber against an injected client + seams]")

type Row = Record<string, unknown> & { id: string }
function fakeSvc(seed: { prospects: Row[]; events?: Row[]; brokerages?: Row[] }) {
  const tables: Record<string, Row[]> = {
    platform_prospects: seed.prospects, calendar_events: seed.events ?? [], brokerages: seed.brokerages ?? [], superadmin_audit_log: [],
  }
  function from(name: string) {
    const store = tables[name] ?? (tables[name] = [])
    let filters: Array<(r: Row) => boolean> = []
    let op: { kind: "select" | "insert" | "update"; payload?: Record<string, unknown> } = { kind: "select" }
    let single = false
    const api: any = {
      select() { return api },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return api },
      is(col: string, val: unknown) { filters.push((r) => r[col] === val); return api },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return api },
      maybeSingle() { single = true; return api },
      single() { single = true; return api },
      insert(payload: Record<string, unknown>) { op = { kind: "insert", payload }; return api },
      update(payload: Record<string, unknown>) { op = { kind: "update", payload }; return api },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          const match = store.filter((r) => filters.every((f) => f(r)))
          let out: unknown
          if (op.kind === "insert") { const r = { id: `${name}-${store.length + 1}`, ...op.payload } as Row; store.push(r); out = { data: r, error: null } }
          else if (op.kind === "update") { for (const r of match) Object.assign(r, op.payload); out = { data: match.map((r) => ({ id: r.id })), error: null } }
          else out = { data: single ? (match[0] ?? null) : match, error: null }
          filters = []; op = { kind: "select" }; single = false
          return Promise.resolve(resolve(out))
        } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e) }
      },
    }
    return api
  }
  return { from, tables }
}

function seamDeps() {
  const provisionCalls: any[] = []
  const bells: any[] = []
  return {
    provisionCalls, bells,
    deps: {
      provisionTenant: async (_svc: any, input: any) => {
        provisionCalls.push(input)
        return { ok: true, brokerageId: "brk-new", userId: "usr-new", subscriptionId: "sub-1", slug: "acme-x", trialEndsAt: "2026-10-05T12:00:00.000Z", inviteSent: true, prospectStamp: { matched: 1, linked: 1, statusAdvanced: 1, errors: [] }, extrasSkipped: [] }
      },
      notifyStaff: async (_svc: any, n: any) => { bells.push(n); return 2 },
    },
  }
}

{
  // (a) the prospect says YES on the chat — fully autonomous
  const svc = fakeSvc({ prospects: [{ ...row, id: "p-a", details: { qualification: { brokerage_name: "Acme Realty", size_seats: 4 } } }] })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-a", actor: { kind: "prospect_self", channel: "web:live_agent" }, billing: { mode: "trial" } }, s.deps)
  const call = s.provisionCalls[0]
  check("self-conversion: the ONE core is called once with the derived facts, signupSource self_serve, a trial, and the prospect id for the link-back",
    r.ok && !r.alreadyConverted && s.provisionCalls.length === 1 && call.signupSource === "self_serve" && call.billing.mode === "trial" && call.brokerageName === "Acme Realty" && call.adminEmail === "dana@acme.com" && call.tier === "team" && call.callerUserId === null && call.prospect.prospectIds[0] === "p-a")
  check("self-conversion: no human task (nothing warranted) — the staff bell is never rung", r.ok && !r.alreadyConverted && r.humanReasons.length === 0 && r.staffNotified === 0 && s.bells.length === 0)
  const stamped = svc.tables.platform_prospects[0]!.details as any
  check("the conversion record lands on the prospect row (details.conversion: actor self:<channel>, tier, billing) and the moment is audited", stamped.conversion?.actor === "self:web:live_agent" && stamped.conversion?.tier === "team" && stamped.conversion?.billing_mode === "trial" && svc.tables.superadmin_audit_log.length === 1 && svc.tables.superadmin_audit_log[0]!.action === "platform_prospect.converted_to_subscriber")
}
{
  // (b) warranted → the prospect is NOT self-converted; the surface hands off
  const svc = fakeSvc({ prospects: [{ ...row, id: "p-b" }] }) // current_tools: Follow Up Boss → crm_migration
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-b", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "trial" } }, s.deps)
  check("self-conversion with a CRM migration → refused with needsHuman ['crm_migration'] and the core is NEVER called (control: zero provisioning calls)", !r.ok && r.needsHuman?.join(",") === "crm_migration" && s.provisionCalls.length === 0 && svc.tables.superadmin_audit_log.length === 0)
}
{
  // (c) a prospect can never self-provision an ACTIVE subscription
  const svc = fakeSvc({ prospects: [{ ...row, id: "p-c", details: {} }] })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-c", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "active", billingCycle: "monthly" } }, s.deps)
  check("self-conversion with billing 'active' → refused (an invoiced row is staff vouching; the in-app checkout survivor collects a card), core never called", !r.ok && s.provisionCalls.length === 0)
}
{
  // (c2) wave 78A — a prospect CAN activate paid: the hosted checkout is minted by the core
  const svc = fakeSvc({ prospects: [{ ...row, id: "p-c2", details: {} }] })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-c2", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "paid", billingCycle: "monthly" } }, s.deps)
  check("self-conversion with billing 'paid' → the core is called with mode paid and NO waiver (the prospect's stated choice drives trial vs paid)", r.ok && s.provisionCalls.length === 1 && s.provisionCalls[0].billing.mode === "paid" && !s.provisionCalls[0].billing.setupFeeWaiver)
  const s2 = seamDeps()
  const r2 = await convertProspectToSubscriber(fakeSvc({ prospects: [{ ...row, id: "p-c3", details: {} }] }), { prospectId: "p-c3", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "paid", billingCycle: "monthly", setupFeeWaiver: { reason: "asked nicely" } } }, s2.deps)
  check("…but a prospect asking to waive their own setup fee is refused, core never called (control)", !r2.ok && s2.provisionCalls.length === 0)
}
{
  // (d) staff conversion of an enterprise prospect with a pending demo hold and an open handoff
  const svc = fakeSvc({
    prospects: [{ ...row, id: "p-d", role_interest: "multi_location", details: { qualification: { size_seats: 120, brokerage_name: "Big Group" }, demo_appointment: { calendar_event_id: "ce-1", status: "pending_rep_confirmation" }, human_handoff: { status: "open", reason: "wants enterprise pricing" } } }],
    events: [{ id: "ce-1", event_type: "demo_appointment", status: "pending_agent_confirmation" }],
  })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-d", actor: { kind: "platform_staff", userId: "staff-1", email: "rep@platform.test" }, billing: { mode: "active", billingCycle: "annual" } }, s.deps)
  check("staff conversion: the core is called with signupSource superadmin, the staff actor, an ACTIVE annual subscription, tier multi_location",
    r.ok && !r.alreadyConverted && s.provisionCalls[0]?.signupSource === "superadmin" && s.provisionCalls[0]?.callerUserId === "staff-1" && s.provisionCalls[0]?.billing.billingCycle === "annual" && r.tier === "multi_location")
  check("…the white-glove task is raised ONLY because it is warranted (enterprise_size + custom_pricing from the handoff reason): one platform-staff bell on the NEW BROKERAGE",
    r.ok && !r.alreadyConverted && r.humanReasons.includes("enterprise_size") && r.humanReasons.includes("custom_pricing") && s.bells.length === 1 && s.bells[0].type === "platform_subscriber_white_glove" && s.bells[0].entityType === "brokerage" && s.bells[0].entityId === "brk-new" && r.staffNotified === 2)
  const ev = svc.tables.calendar_events[0]!
  const d = svc.tables.platform_prospects[0]!.details as any
  check("…the PENDING demo hold is released (calendar_events → cancelled, COUNTED) and stamped; the open handoff is closed", r.ok && !r.alreadyConverted && r.demoDisposition === "hold_released" && ev.status === "cancelled" && d.demo_appointment.status === "cancelled" && d.human_handoff.status === "done")
}
{
  // (d2) a CONFIRMED demo is kept — it becomes the onboarding session
  const svc = fakeSvc({
    prospects: [{ ...row, id: "p-e", details: { demo_appointment: { calendar_event_id: "ce-2", status: "confirmed" } } }],
    events: [{ id: "ce-2", event_type: "demo_appointment", status: "scheduled" }],
  })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-e", actor: { kind: "platform_staff", userId: "staff-1", email: "rep@platform.test" }, billing: { mode: "trial" } }, s.deps)
  check("a CONFIRMED demo is kept on the calendar (disposition kept_as_onboarding, row untouched)", r.ok && !r.alreadyConverted && r.demoDisposition === "kept_as_onboarding" && svc.tables.calendar_events[0]!.status === "scheduled")
}
{
  // (e) idempotent — an already-linked row never provisions twice
  const svc = fakeSvc({ prospects: [{ ...row, id: "p-f", converted_brokerage_id: "brk-old" }] })
  const s = seamDeps()
  const r = await convertProspectToSubscriber(svc, { prospectId: "p-f", actor: { kind: "platform_staff", userId: "staff-1", email: "rep@platform.test" }, billing: { mode: "trial" } }, s.deps)
  check("an already-converted prospect returns its brokerage and the core is NOT called again (idempotent)", r.ok && r.alreadyConverted && r.brokerageId === "brk-old" && s.provisionCalls.length === 0)
  const missing = await convertProspectToSubscriber(svc, { prospectId: "nope", actor: { kind: "platform_staff", userId: "staff-1", email: "rep@platform.test" }, billing: { mode: "trial" } }, s.deps)
  check("an unknown prospect id is refused (never provisions a tenant for nobody)", !missing.ok && s.provisionCalls.length === 0)
}
{
  // (f) the stamp links by ID — a phone-only prospect with no email still gets converted_brokerage_id
  const svc = fakeSvc({ prospects: [{ id: "p-g", status: "new", email: null, phone: "+15125550199", converted_brokerage_id: null }] })
  const r = await stampProspectConversion(svc, { brokerageId: "brk-9", emails: [], prospectIds: ["p-g"], outcome: "trial" })
  check("stampProspectConversion by prospect id: matched 1, linked 1, status → trial, audited", r.matched === 1 && r.linked === 1 && svc.tables.platform_prospects[0]!.converted_brokerage_id === "brk-9" && svc.tables.platform_prospects[0]!.status === "trial" && svc.tables.superadmin_audit_log.length === 1)
  const r2 = await stampProspectConversion(svc, { brokerageId: "brk-9", emails: [], prospectIds: ["p-g"], outcome: "trial" })
  check("…and a re-run is a counted zero (never-clobber, idempotent)", r2.matched === 0 && r2.linked === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · ONE CORE — every door delegates; the direct path links back]")
// Comments stripped, strings KEPT — the token scanned for is inside a string
// literal (`from("brokerages")`), so blankStrings would blind the finder.
const insertRe = /from\("brokerages"\)\s*\.\s*insert/
const runtimeFiles = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
const creationPaths = runtimeFiles
  .filter((f) => insertRe.test(stripComments(readFileSync(f, "utf8"))))
  .map((f) => f.replace(root + "/", ""))
const outsideSelfHeal = creationPaths.filter((p) => p !== SELF_HEAL)
console.log(`    denominator: ${runtimeFiles.length} .ts/.tsx files under lib/ + app/; creation paths: ${creationPaths.join(" · ")}`)
check(`exactly ONE brokerages insert outside the documented brokerage-of-one self-heal (${SELF_HEAL}), and it is the core (found: ${outsideSelfHeal.join(", ")})`, outsideSelfHeal.length === 1 && outsideSelfHeal[0] === CORE)
check("POSITIVE CONTROL: a fixture with a second `from(\"brokerages\").insert(` is counted, and a commented one is not (the finder is not blind)", insertRe.test(stripComments('const { data } = await svc\n  .from("brokerages")\n  .insert({ name: "n" })')) && !insertRe.test(stripComments('// legacy: svc.from("brokerages").insert({...})\nconst a = 1')))
const coreSrc = stripped(CORE)
const signupSrc = stripped(SIGNUP)
const staffSrc = stripped(STAFF_DOOR)
const convSrc = stripped(CONVERSION)
check("self-serve signup delegates to createTenantCore (signupSource self_serve, the signer's trial-or-paid choice with the 14-day trial as default) and no longer provisions the owner or inserts the subscription itself",
  /createTenantCore\(service, \{[\s\S]{0,600}signupSource: "self_serve"[\s\S]{0,200}billing,/.test(signupSrc) && /\{ mode: "trial" as const, trialDays: TRIAL_DAYS \}/.test(signupSrc) && !signupSrc.includes("provisionTenantOwner(") && !/from\("subscriptions"\)\s*\.insert/.test(signupSrc))
check("the staff door delegates to createTenantCore (signupSource superadmin, an ACTIVE subscription for the cycle, the staff-picked snapshot) and keeps only its gate, Stripe customer and audit",
  /createTenantCore\(service, \{[\s\S]{0,800}signupSource: "superadmin"[\s\S]{0,200}billing: \{ mode: "active", billingCycle: params\.billingCycle/.test(staffSrc) && staffSrc.includes("snapshotId: params.snapshotId") && !staffSrc.includes("provisionTenantOwner(") && staffSrc.includes("gateStaffAction(\"tenants\")") && staffSrc.includes("stripe.customers.create("))
check("the conversion delegates to the SAME core (dynamic import — the @proofSeam is the only alternative)", /deps\.provisionTenant \?\? \(await import\("@\/lib\/kernel\/tenant-creation"\)\)\.createTenantCore/.test(convSrc))
check("POSITIVE CONTROL: the delegation finder rejects a door that spells its own insert", !/createTenantCore\(/.test('const { data } = await svc.from("brokerages").insert({ name })'))
check("the core: tier row → duplicate-owner guard → brokerage → provisionTenantOwner + counted rollback → subscription (error READ) → snapshot → stamp → ISA actor → assistant → SUBSCRIPTION_CREATED → onboarding library, in that order",
  (() => {
    const order = ['from("subscription_tiers")', 'from("users")', 'from("brokerages")', "provisionTenantOwner({", "rollbackTenantCreation(", 'from("subscriptions").insert(', "snapshotForTier(input.tier", "applySnapshotPayload(", "stampProspectConversion(", "provisionIsaActorForBrokerage(", "seedStarterAssistant(", "KernelEvent.SUBSCRIPTION_CREATED", 'from("learning_assignments")']
    const idx = order.map((t) => coreSrc.indexOf(t))
    return idx.every((i) => i >= 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]!)
  })())
check("the core writes trial_end on the trial row and READS the subscription insert error (§3)", coreSrc.includes("trial_end: end") && /const \{ data: subscription, error: subErr \}/.test(coreSrc) && /if \(subErr \|\| !subscription\)/.test(coreSrc))
check("the core derives the stamp outcome from the billing mode (active → 'converted'; trial AND paid-pending → 'trial' until the webhook sees money) — one rule, not two spellings", coreSrc.includes('outcome: input.billing.mode === "active" ? "converted" : "trial"'))
check("DIRECT PATH LINK-BACK: the core's stamp always includes the admin email (the same key upsertPlatformProspect uses), so a signer who was never a prospect is a clean zero and a prospect is linked", /emails: \[adminEmail, input\.brokerageEmail, \.\.\.\(input\.prospect\?\.emails \?\? \[\]\)\]/.test(coreSrc) && /prospectIds: input\.prospect\?\.prospectIds \?\? \[\]/.test(coreSrc))
check("the core mints the brokerage id and returns it — no door passes a brokerage id in (CLAUDE.md §4)",
  (() => { const body = coreSrc.slice(coreSrc.indexOf("export async function createTenantCore(")); return !/input\.brokerageId/.test(body) && /brokerageId = \(brokerage as \{ id: string \}\)\.id/.test(body) && !/brokerageId\??:/.test(coreSrc.slice(coreSrc.indexOf("export interface TenantCreationInput"), coreSrc.indexOf("export interface TenantCreationResult"))) })())
check("the demo showcase tenant still provisions through the self-serve door (no forked provisioning)", stripped("lib/platform/demo-tenant.ts").includes("signupBrokerageAction({"))
check("tenant-scope guard: the core's global owner-email lookup is a documented exemption (the tenant does not exist yet)", /"lib\/kernel\/tenant-creation\.ts":/.test(raw("scripts/tenant-scope-guard.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · AFTERWARDS — ladder stops, journey emitted, humans only when warranted, identity, Stripe]")
const followupSrc = stripped(FOLLOWUP)
const ladderStatuses = [...followupSrc.matchAll(/\.eq\("status",\s*"([^"]+)"\)/g)].map((m) => m[1]!)
check("the cold ladder reads ONLY status new|contacted — a 'trial' / 'converted' row is never nudged again", ladderStatuses.length === 2 && ladderStatuses.every((s) => s === "new" || s === "contacted"))
check("the onboarding journey is kicked off by the core: SUBSCRIPTION_CREATED (the curriculum hook) + the onboarding library + the welcome bell; the 90-day agent_onboarding row comes from provisionTenantOwner for a solo/team owner",
  coreSrc.includes("KernelEvent.SUBSCRIPTION_CREATED") && coreSrc.includes('signal_source: "subscriber_onboarding"') && coreSrc.includes('type: "agent_onboarding"') && (await import("../lib/kernel/tenant-provisioning-spec")).requiresOnboardingRow("admin", "team"))
check("the human task is GUARDED by the warranted reasons (if (humanReasons.length > 0)) — never an unconditional bell", /if \(humanReasons\.length > 0\) \{[\s\S]{0,400}notifyPlatformStaff/.test(convSrc) && (convSrc.match(/notifyPlatformStaff\(/g) ?? []).length === 1)
check("the staff bell targets platform_role staff (lib/notifications/platform-staff.ts) and the tenant, entity_type 'brokerage'", convSrc.includes("@/lib/notifications/platform-staff") && convSrc.includes('entityType: "brokerage", entityId: brokerageId'))
const ID_LEAK = /(contactId|leadId|contact_id|lead_id)\s*:\s*(prospect(Id)?(\.id)?|params\.prospectId|ctx\.prospectId|saved\.id|p\.id|row\.id|r\.entity_id|input\.prospectId)\b/
for (const [name, s] of [[CONVERSION, convSrc], [CORE, coreSrc], [TOOLS, stripped(TOOLS)], [GROWTH_ACTIONS, stripped(GROWTH_ACTIONS)]] as const) {
  check(`${name}: no prospect id in a contactId/leadId/contact_id/lead_id slot`, !ID_LEAK.test(s))
}
check("POSITIVE CONTROL: the id-leak scanner recognises `contactId: row.id` on a fixture", ID_LEAK.test("dispatchEmail({ contactId: row.id })"))
for (const [name, s] of [[CONVERSION, convSrc], [CORE, coreSrc], [TOOLS, stripped(TOOLS)], [GROWTH_ACTIONS, stripped(GROWTH_ACTIONS)]] as const) {
  check(`${name}: Stripe only through the existing survivors — no lib/stripe import, no checkout.sessions, no stripe. call`, !/@\/lib\/stripe|checkout\.sessions|\bstripe\./.test(s))
}
check("POSITIVE CONTROL: the Stripe scanner sees the staff door's customer create (the survivor) and billing.ts's checkout", /\bstripe\./.test(staffSrc) && /checkout\.sessions\.create/.test(stripped("app/actions/billing.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · SURFACES — the growth board action and the start_subscription tool]")
const growthSrc = stripped(GROWTH_ACTIONS)
check("convertProspectToSubscriberAction is marketing/sales platform_role-gated, audited by name, and hands the conversion a platform_staff actor",
  // Lane 79D: the checkout-email block (sendActivationCheckoutEmail) now sits
  // between the actor and the audit — the window grew, the order did not.
  /convertProspectToSubscriberAction[\s\S]{0,1200}requireMarketingStaff\(\)[\s\S]{0,1200}actor: \{ kind: "platform_staff", userId: auth\.userId, email: auth\.email \}[\s\S]{0,2500}audit\(auth\.userId, auth\.email, "platform_prospect\.convert_to_subscriber_clicked"/.test(growthSrc))
check("the action's request carries the prospect id only — never a brokerage id (the tenant comes back from the core)", /prospectId: input\.prospectId/.test(growthSrc) && !/input\.brokerageId/.test(growthSrc))
check("the board mounts the Convert to subscriber dialog on convertProspectToSubscriberAction", stripped(BOARD).includes("convertProspectToSubscriberAction(") && stripped(BOARD).includes("Convert to subscriber"))
const toolsSrc = stripped(TOOLS)
check("start_subscription: prospect_self actor, the prospect's choice (trial | paid — wave 78A), resolves the prospect through the ONE writer first, hands off on needsHuman",
  /start_subscription:\s*tool\(\{[\s\S]{0,3000}resolveProspect\(\{ email: a\.email[\s\S]{0,2000}actor: \{ kind: "prospect_self", channel: ctx\.source \}[\s\S]{0,200}tier: a\.plan, billing,[\s\S]{0,600}needsHuman: true/.test(toolsSrc)
  && /a\.activation === "paid"\s*\?\s*\{ mode: "paid" as const/.test(toolsSrc) && /: \{ mode: "trial" as const \}/.test(toolsSrc))
const { PLATFORM_EXIT_MENU } = await import("../lib/ai-isa/qualification-playbook")
const { PLATFORM_PROSPECT_TOOL_NAMES, platformExitMenuMatchesTools } = await import("../lib/platform/prospect-agent-tools")
check("the playbook's exit menu names start_subscription and every exit is a registered tool", PLATFORM_EXIT_MENU.some((o) => o.tool === "start_subscription") && platformExitMenuMatchesTools() && (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes("start_subscription"))
check("the conversion stamp writer is the ONE prospect-capture module (markProspectConverted) and it closes an open handoff", stripped(CAPTURE).includes("export async function markProspectConverted") && /if \(handoff && handoff\.status === "open"\) details\.human_handoff = \{ \.\.\.handoff, status: "done" \}/.test(stripped(CAPTURE)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · registration]")
const pkg = raw("package.json")
check(`"test:subscriber-conversion" script is registered`, /"test:subscriber-conversion":\s*"tsx --conditions=react-server scripts\/subscriber-conversion-simulator\.ts"/.test(pkg))
const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
check("the guard chain runs it AFTER test:scrapers (wave 77 ruling)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:subscriber-conversion") > guardLine.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS carries subscriber_conversion with proof test:subscriber-conversion", /subscriber_conversion:\s*\{\s*manager:\s*"[a-z_]+",\s*proof:\s*"test:subscriber-conversion"/.test(stripped("lib/kernel/manager-registry.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ SUBSCRIBER_CONVERSION — see failures above")
  process.exit(1)
}
console.log("\n✅ SUBSCRIBER_CONVERSION — one tenant-creation core, prospect stamped, ladder stops, journey emitted, humans only when warranted")
