#!/usr/bin/env tsx
/**
 * scripts/subscriber-door-simulator.ts   (npm run test:subscriber-door)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 79D — THE ONE SUBSCRIBER DOOR, TWO ENTRANCES (owner verbatim: "an easy
 * way to convert a prospect to a subscriber or a new subscriber that isn't a
 * prospect … agenticos using autonomous ai methodology with humans when
 * warranted"; "not everyone enrolls in trial; there is a setup fee").
 *
 * No DB, no network. Production functions run against injected clients;
 * every code-token scan reads STRIPPED source (scripts/strip-comments.ts,
 * CLAUDE.md §2) with positive controls.
 *
 *   Layer 1 — PURE: the routing rule (band DERIVED from lane 79A's table,
 *             never a literal; commercial reasons → sales-assisted; service
 *             reasons → provision + task; trial vs paid billing; honeypot),
 *             the checkout email copy, the stall rule + its idempotence.
 *   Layer 2 — BEHAVIOUR: the checkout email through the egress seam (fail
 *             closed without a rep; never a contactId/leadId), the sales-
 *             assisted intake against an in-memory client running the REAL
 *             prospect writer (idempotent by email; an existing subscriber is
 *             told to sign in — zero writes, control), the conversion's
 *             idempotency (twice → same tenant, core called zero times), the
 *             stall sweep (nudge once, escalate once, re-run = counted zero,
 *             demo tenants skipped, no-rep = reported not swallowed).
 *   Layer 3 — SOURCE: both entrances reach createTenantCore; the core reaches
 *             createActivationCheckout on the paid branch only; the success
 *             URL and the email share SUBSCRIBER_ACTIVATED_PATH; the setup fee
 *             rides line_items (Checkout rejects add_invoice_items); the
 *             honeypot + sales-assisted split run BEFORE any write; the growth
 *             board and the form are mounted; the sweep rides the cron.
 *   Layer 4 — registration.
 *
 * Run: npx tsx scripts/subscriber-door-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string): string => readFileSync(join(root, p), "utf8")
const code = (p: string): string => stripComments(raw(p))

const DOOR = "lib/platform/subscriber-door.ts"
const STALL = "lib/onboarding/subscriber-stall.ts"
const CORE = "lib/kernel/tenant-creation.ts"
const ACTIVATION = "lib/billing/subscription-activation.ts"
const BILLING = "app/actions/billing.ts"
const SIGNUP = "app/actions/auth/signup-brokerage.ts"
const GROWTH = "app/actions/superadmin/platform-growth.ts"
const TOOLS = "lib/platform/prospect-agent-tools.ts"
const BOARD = "app/dashboard/superadmin/growth/platform-growth-board.tsx"
const FORM = "app/get-started/trial-funnel-form.tsx"
const CRON = "app/api/cron/onboarding-reminders/route.ts"
const WEBHOOK = "app/api/billing/webhook/route.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · PURE — routing rule, email copy, stall rule]")
const {
  planSubscriberEntrance, normalizeProducerSeats, isHoneypotTripped, composeActivationCheckoutEmail,
  SUBSCRIBER_ACTIVATED_PATH, SALES_ASSISTED_BOOKING_PATH, COMMERCIAL_HUMAN_REASONS,
  sendActivationCheckoutEmail, salesAssistedIntake,
} = await import("../lib/platform/subscriber-door")
const { TIER_SEAT_BANDS, CANONICAL_TIERS, tierForSeatCount } = await import("../lib/billing/plan-catalog")
const { conversionHumanReasons, convertProspectToSubscriber } = await import("../lib/platform/prospect-conversion")
const {
  subscriberStallState, isActivationPending, composeStallNudge, runSubscriberStallSweep, NUDGE_AFTER_DAYS,
} = await import("../lib/onboarding/subscriber-stall")
const { STALL_AFTER_DAYS } = await import("../lib/onboarding/onboarding-roster")
const { buildCheckoutConfig } = await import("../lib/billing/subscription-activation")

{
  // THE RULE, not the numbers: for every capped band, a seat count AT the band
  // fits that tier and ONE MORE moves up — whatever lane 79A sets the bands to.
  const capped = CANONICAL_TIERS.filter((t) => TIER_SEAT_BANDS[t] !== null)
  const atBand = capped.every((t) => planSubscriberEntrance({ producerSeats: TIER_SEAT_BANDS[t]! }).tier === t)
  const overBand = capped.every((t) => { const p = planSubscriberEntrance({ producerSeats: TIER_SEAT_BANDS[t]! + 1 }); return p.tier !== t && p.tier === tierForSeatCount(TIER_SEAT_BANDS[t]! + 1) })
  check(`the seat band is DERIVED (tierForSeatCount over TIER_SEAT_BANDS: ${capped.map((t) => `${t}≤${TIER_SEAT_BANDS[t]}`).join(", ")}) — at the band fits, one over moves up`, capped.length > 0 && atBand && overBand)
  check("a seat count inside the brokerage band never reaches multi_location; past the band (wave 79: brokerage 30) it does, as custom pricing (sales-assisted); a declared canonical tier wins over the count",
    [1, 3, 9, 29, 30].every((n) => planSubscriberEntrance({ producerSeats: n }).tier !== "multi_location")
    && [31, 500, 5000].every((n) => planSubscriberEntrance({ producerSeats: n }).tier === "multi_location")
    && planSubscriberEntrance({ declaredTier: "brokerage", producerSeats: 1 }).tier === "brokerage"
    && planSubscriberEntrance({ declaredTier: "fit", producerSeats: 1 }).tier === tierForSeatCount(1))
  check("the door's seatBand echoes lane 79A's table for the chosen tier (null = custom/unlimited)", CANONICAL_TIERS.every((t) => planSubscriberEntrance({ declaredTier: t }).seatBand === TIER_SEAT_BANDS[t]))
  check("POSITIVE CONTROL: a restated band table would be caught — the door's source names TIER_SEAT_BANDS and carries no `solo_agent: <n>` literal",
    /TIER_SEAT_BANDS/.test(code(DOOR)) && !/solo_agent:\s*\d/.test(code(DOOR)) && /solo_agent:\s*\d/.test('const T = { solo_agent: 2 }'))

  const multi = planSubscriberEntrance({ declaredTier: "multi_location", activation: "paid", billingCycle: "annual" })
  check("multi_location → SALES-ASSISTED (custom seat pricing is a commercial decision): route sales_assisted, enterprise_size in commercialReasons, the paid+annual choice preserved for the person who prices it",
    multi.route === "sales_assisted" && multi.commercialReasons.includes("enterprise_size") && multi.billing.mode === "paid" && (multi.billing as { billingCycle?: string }).billingCycle === "annual")
  const custom = planSubscriberEntrance({ declaredTier: "team", producerSeats: 4, customPricingRequested: true })
  check("a custom-pricing ask on any tier → sales_assisted (custom_pricing) — pricing is never a model's or a form's decision", custom.route === "sales_assisted" && custom.commercialReasons.join() === "custom_pricing" && custom.tier === "team")
  const crm = planSubscriberEntrance({ declaredTier: "team", producerSeats: 4, currentTools: "kvCORE" })
  check("a CRM migration is SERVICE, not commerce → self_serve WITH crm_migration in humanReasons (tenant minted, white-glove task rides along)", crm.route === "self_serve" && crm.humanReasons.join() === "crm_migration" && crm.commercialReasons.length === 0 && crm.humanReasonLabels.length === 1)
  check("'spreadsheets' is not a CRM → fully autonomous (no reasons)", planSubscriberEntrance({ declaredTier: "solo_agent", currentTools: "spreadsheets" }).humanReasons.length === 0)
  check("the warranted rule is the SAME function the prospect conversion uses (conversionHumanReasons) — one spelling", crm.humanReasons.join() === conversionHumanReasons({ tier: "team", sizeSeats: 4, currentTools: "kvCORE" }).join() && COMMERCIAL_HUMAN_REASONS.every((r) => ["enterprise_size", "custom_pricing"].includes(r)))
  check("trial is the default; paid carries the cycle (monthly unless annual); a self-serve plan can never carry a setup-fee waiver (no field exists)",
    planSubscriberEntrance({}).billing.mode === "trial" && planSubscriberEntrance({ activation: "paid" }).billing.mode === "paid"
    && (planSubscriberEntrance({ activation: "paid" }).billing as { billingCycle?: string }).billingCycle === "monthly" && !("setupFeeWaiver" in planSubscriberEntrance({ activation: "paid" }).billing))
  check("seat input normalizes: '4' → 4, 0/NaN/negative/'' → null (the person asking is one seat)", normalizeProducerSeats("4") === 4 && normalizeProducerSeats(0) === null && normalizeProducerSeats("abc") === null && normalizeProducerSeats(-2) === null && normalizeProducerSeats("") === null)
  check("honeypot: any non-empty value is a bot; empty/undefined is a human", isHoneypotTripped("http://spam") && planSubscriberEntrance({ honeypot: "x" }).bot && !planSubscriberEntrance({ honeypot: "" }).bot && !planSubscriberEntrance({}).bot)

  const email = composeActivationCheckoutEmail({ firstName: "Dana", brandName: "VIP", tier: "team", billingCycle: "monthly", checkoutUrl: "https://checkout.stripe.com/c/x", setupFeeCents: 49900 })
  check("checkout email: the exact fee the checkout carries, the URL, the cycle, and the sign-in landing after it clears", email.html.includes("$499") && email.text.includes("https://checkout.stripe.com/c/x") && /billed monthly/.test(email.html) && /sign-in/.test(email.html))
  check("…a WAIVED fee says so and a plan with no fee says so — never an invented number",
    /setup fee is waived/.test(composeActivationCheckoutEmail({ firstName: "D", brandName: "V", tier: "team", billingCycle: "annual", checkoutUrl: "u", setupFeeCents: 49900, setupFeeWaived: true }).html)
    && /lists no setup fee/.test(composeActivationCheckoutEmail({ firstName: "D", brandName: "V", tier: "team", billingCycle: "annual", checkoutUrl: "u", setupFeeCents: 0 }).html))
  check("SUBSCRIBER_ACTIVATED_PATH is the real sign-in page (/login, never the demo /auth/login) and the booking path is the demo survivor", SUBSCRIBER_ACTIVATED_PATH === "/login?activated=1" && SALES_ASSISTED_BOOKING_PATH === "/demo")

  // The stall rule — read from rows the core writes, no migration.
  const now = new Date("2026-09-23T12:00:00.000Z")
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
  const paidPending = (created: string) => ({ status: "trialing", stripe_subscription_id: null, trial_end: created })
  const realTrial = (created: string) => ({ status: "trialing", stripe_subscription_id: null, trial_end: new Date(new Date(created).getTime() + 14 * 86_400_000).toISOString() })
  const base = { id: "b", name: "Acme", email: "o@acme.com", plan_tier: "team", billing_metadata: null }
  check("activation_pending = 'trialing' + no stripe_subscription_id + trial_end at creation (the core's paid shape); a real 14-day trial is NOT one; a linked Stripe sub is NOT one",
    isActivationPending(paidPending(daysAgo(4)), daysAgo(4)) && !isActivationPending(realTrial(daysAgo(4)), daysAgo(4)) && !isActivationPending({ status: "trialing", stripe_subscription_id: "sub_1", trial_end: daysAgo(4) }, daysAgo(4)) && !isActivationPending({ status: "active", stripe_subscription_id: null, trial_end: daysAgo(4) }, daysAgo(4)))
  check(`stages: day ${NUDGE_AFTER_DAYS - 1} none · day ${NUDGE_AFTER_DAYS} nudge · day ${STALL_AFTER_DAYS} escalate (STALL_AFTER_DAYS is the roster's own constant)`,
    subscriberStallState({ ...base, created_at: daysAgo(NUDGE_AFTER_DAYS - 1), onboarding_status: "pending", subscription: realTrial(daysAgo(NUDGE_AFTER_DAYS - 1)) }, now).due === null
    && subscriberStallState({ ...base, created_at: daysAgo(NUDGE_AFTER_DAYS), onboarding_status: "pending", subscription: realTrial(daysAgo(NUDGE_AFTER_DAYS)) }, now).due === "nudge"
    && subscriberStallState({ ...base, created_at: daysAgo(STALL_AFTER_DAYS), onboarding_status: "pending", subscription: realTrial(daysAgo(STALL_AFTER_DAYS)) }, now).due === "escalate" && NUDGE_AFTER_DAYS < STALL_AFTER_DAYS)
  check("kinds: paid-pending wins over onboarding-pending; in_progress/completed with a real trial is nobody's stall here (the agent-level loops own it)",
    subscriberStallState({ ...base, created_at: daysAgo(5), onboarding_status: "pending", subscription: paidPending(daysAgo(5)) }, now).kind === "activation_pending"
    && subscriberStallState({ ...base, created_at: daysAgo(5), onboarding_status: "pending", subscription: realTrial(daysAgo(5)) }, now).kind === "onboarding_pending"
    && subscriberStallState({ ...base, created_at: daysAgo(9), onboarding_status: "in_progress", subscription: realTrial(daysAgo(9)) }, now).kind === null)
  check("IDEMPOTENCE is in the rule: a nudged_at stamp silences the nudge; an escalate stage with nudged_at but no escalated_at owes only the escalation; both stamps owe nothing",
    subscriberStallState({ ...base, created_at: daysAgo(4), onboarding_status: "pending", subscription: null, billing_metadata: { subscriber_stall: { nudged_at: daysAgo(1) } } }, now).due === null
    && subscriberStallState({ ...base, created_at: daysAgo(8), onboarding_status: "pending", subscription: null, billing_metadata: { subscriber_stall: { nudged_at: daysAgo(5) } } }, now).due === "escalate"
    && subscriberStallState({ ...base, created_at: daysAgo(8), onboarding_status: "pending", subscription: null, billing_metadata: { subscriber_stall: { nudged_at: daysAgo(5), escalated_at: daysAgo(1) } } }, now).due === null)
  const nudge = composeStallNudge({ kind: "activation_pending", brandName: "VIP", brokerageName: "Acme", firstName: "Dana", planTier: "team", appUrl: "https://app.test" })
  check("stall nudge copy: names the stall, the sign-in link, and a person one reply away", /checkout never finished/.test(nudge.html) && nudge.text.includes("https://app.test/login") && /reply/.test(nudge.html) && /waiting/.test(composeStallNudge({ kind: "onboarding_pending", brandName: "V", brokerageName: "A", firstName: "D", planTier: null, appUrl: "" }).subject))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · BEHAVIOUR — injected clients and seams]")

type Row = Record<string, unknown> & { id: string }
/** In-memory PostgREST-shaped client: enough operators for the door, the prospect writer and the stall sweep. */
function fakeSvc(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { ...seed }
  const log: Array<{ table: string; kind: string; payload?: Record<string, unknown> }> = []
  function from(name: string) {
    const store = tables[name] ?? (tables[name] = [])
    let filters: Array<(r: Row) => boolean> = []
    let op: { kind: "select" | "insert" | "update"; payload?: Record<string, unknown> } = { kind: "select" }
    let single = false, lim: number | null = null
    const api: any = {
      select() { return api },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return api },
      is(col: string, val: unknown) { filters.push((r) => r[col] === val); return api },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return api },
      gte(col: string, val: string) { filters.push((r) => String(r[col]) >= val); return api },
      not() { return api }, order() { return api }, limit(n: number) { lim = n; return api },
      maybeSingle() { single = true; return api }, single() { single = true; return api },
      insert(payload: Record<string, unknown>) { op = { kind: "insert", payload }; return api },
      update(payload: Record<string, unknown>) { op = { kind: "update", payload }; return api },
      then(resolve: (v: unknown) => unknown) {
        let match = store.filter((r) => filters.every((f) => f(r)))
        if (lim !== null) match = match.slice(0, lim)
        let out: unknown
        if (op.kind === "insert") { const r = { id: `${name}-${store.length + 1}`, ...op.payload } as Row; store.push(r); log.push({ table: name, kind: "insert", payload: op.payload }); out = { data: r, error: null } }
        else if (op.kind === "update") { for (const r of match) Object.assign(r, op.payload); log.push({ table: name, kind: "update", payload: op.payload }); out = { data: match.map((r) => ({ id: r.id, email: r.email ?? null, phone: r.phone ?? null })), error: null } }
        else out = { data: single ? (match[0] ?? null) : match, error: null }
        filters = []; op = { kind: "select" }; single = false; lim = null
        return Promise.resolve(resolve(out))
      },
    }
    return api
  }
  return { from, tables, log }
}

{
  // (a) the ONE checkout email — through the egress seam, from the rep, never a contactId/leadId
  const sends: Array<Record<string, unknown>> = []
  const rep = async () => ({ userId: "usr-rep", brokerageId: "brk-platform" })
  const ok = await sendActivationCheckoutEmail({}, { to: "dana@acme.com", firstName: "Dana", brandName: "VIP", tier: "team", billingCycle: "monthly", checkoutUrl: "https://checkout/x", setupFeeCents: 49900 }, { resolveRep: rep, dispatch: async (p) => { sends.push(p); return { success: true } } })
  check("sent from the platform rep's tenant key (brokerageId/userId), transactional, to the signer, with NO contactId/leadId (the recipient is not a CRM record)",
    ok.sent && sends.length === 1 && sends[0]!.brokerageId === "brk-platform" && sends[0]!.userId === "usr-rep" && sends[0]!.to === "dana@acme.com" && sends[0]!.channelPurpose === "transactional" && !("contactId" in sends[0]!) && !("leadId" in sends[0]!))
  const noRep = await sendActivationCheckoutEmail({}, { to: "d@a.com", firstName: "D", brandName: "V", tier: "team", billingCycle: "monthly", checkoutUrl: "u", setupFeeCents: 0 }, { resolveRep: async () => null, dispatch: async (p) => { sends.push(p); return { success: true } } })
  check("FAIL CLOSED: no platform rep → not sent, reason named, dispatch never called (control: still one send above)", !noRep.sent && /no staff account/.test((noRep as { error: string }).error) && sends.length === 1)
  const refused = await sendActivationCheckoutEmail({}, { to: "d@a.com", firstName: "D", brandName: "V", tier: "team", billingCycle: "monthly", checkoutUrl: "u", setupFeeCents: 0 }, { resolveRep: rep, dispatch: async () => ({ success: false, error: "provider down" }) })
  check("a refused send is reported by name, never swallowed", !refused.sent && (refused as { error: string }).error === "provider down")
  check("an empty checkout URL is refused before any lookup", !(await sendActivationCheckoutEmail({}, { to: "d@a.com", firstName: "D", brandName: "V", tier: "team", billingCycle: "monthly", checkoutUrl: "", setupFeeCents: 0 }, { resolveRep: async () => { throw new Error("must not run") } })).sent)
}

{
  // (b) the sales-assisted intake — REAL prospect writer + REAL handoff stamp on the in-memory client; only the bell is a seam
  const svc = fakeSvc({ users: [], platform_prospects: [] })
  const bells: Array<Record<string, unknown>> = []
  const deps = { notifyStaff: async (_s: unknown, n: Record<string, unknown>) => { bells.push(n); return 3 } }
  const input = { email: "Owner@Acme.com", name: "Dana Lee", company: "Acme Realty", tier: "multi_location" as const, producerSeats: 40, currentTools: "kvCORE", activation: "paid" as const, humanReasons: ["enterprise_size" as const, "crm_migration" as const], source: "get_started:sales_assisted" }
  const r1 = await salesAssistedIntake(svc, input, deps)
  const row = svc.tables.platform_prospects[0] as Row & { details: Record<string, any> }
  check("captured on the ONE prospect rail: email lowercased (the idempotency key), role_interest = the tier, qualification carries seats/company/tools, details.sales_assisted records the ask",
    r1.ok && !r1.alreadySubscriber && r1.created && svc.tables.platform_prospects.length === 1 && row.email === "owner@acme.com" && row.role_interest === "multi_location"
    && row.details.qualification.size_seats === 40 && row.details.qualification.current_tools === "kvCORE" && row.details.sales_assisted.activation === "paid")
  check("the handoff is OPEN (silences the cold ladder) and status advanced to contacted; ONE platform-staff bell on the prospect (entity platform_prospect), priority high; booking path = /demo",
    row.details.human_handoff?.status === "open" && row.status === "contacted" && bells.length === 1 && bells[0]!.entityType === "platform_prospect" && bells[0]!.entityId === row.id && bells[0]!.priority === "high" && r1.ok && !r1.alreadySubscriber && r1.staffNotified === 3 && r1.bookingPath === "/demo")
  const r2 = await salesAssistedIntake(svc, { ...input, producerSeats: 45 }, deps)
  check("IDEMPOTENT: a second submit with the same email merges onto the SAME row (one prospect, seats updated, no second row)", r2.ok && !r2.alreadySubscriber && r2.prospectId === r1.prospectId && !r2.created && svc.tables.platform_prospects.length === 1 && row.details.qualification.size_seats === 45)
  const svc2 = fakeSvc({ users: [{ id: "u1", email: "owner@acme.com", brokerage_id: "brk-live" }], platform_prospects: [] })
  const bells2: unknown[] = []
  const r3 = await salesAssistedIntake(svc2, input, { notifyStaff: async (_s: unknown, n: unknown) => { bells2.push(n); return 1 } })
  check("DEDUPE: an email that already OWNS a tenant is told to sign in — no prospect row, no bell (control: zero writes)", r3.ok && r3.alreadySubscriber && svc2.tables.platform_prospects.length === 0 && bells2.length === 0)
  check("FAIL CLOSED on a bad email or a missing name before any write", !(await salesAssistedIntake(fakeSvc({ users: [] }), { ...input, email: "nope" }, deps)).ok && !(await salesAssistedIntake(fakeSvc({ users: [] }), { ...input, name: " " }, deps)).ok)
}

{
  // (c) the sales-assisted entrance's other half: the conversion is idempotent (twice → same tenant, core never re-called)
  const svc = fakeSvc({ platform_prospects: [{ id: "p-1", name: "Dana Lee", email: "owner@acme.com", phone: null, company: "Acme", role_interest: "team", status: "trial", converted_brokerage_id: "brk-old", details: {} }], calendar_events: [], brokerages: [], superadmin_audit_log: [] })
  const calls: unknown[] = []
  const deps = { provisionTenant: async (_s: unknown, i: unknown) => { calls.push(i); return { ok: true, brokerageId: "brk-new", userId: "u", extrasSkipped: [] } }, notifyStaff: async () => 0 }
  const a = await convertProspectToSubscriber(svc, { prospectId: "p-1", actor: { kind: "platform_staff", userId: "s", email: "s@p.com" }, billing: { mode: "paid", billingCycle: "monthly" } }, deps)
  const b = await convertProspectToSubscriber(svc, { prospectId: "p-1", actor: { kind: "platform_staff", userId: "s", email: "s@p.com" }, billing: { mode: "trial" } }, deps)
  check("a prospect converting TWICE returns the same tenant both times and the core is called ZERO times (already linked)", a.ok && a.alreadyConverted && a.brokerageId === "brk-old" && b.ok && b.alreadyConverted && calls.length === 0)
  check("the duplicate-EMAIL guard lives in the core (one spelling): users.email lookup → 'already exists. Sign in instead' BEFORE the brokerage insert",
    (() => { const c = code(CORE); const guard = c.indexOf('.eq("email", adminEmail)'); return guard > 0 && c.includes("An account with this email already exists. Sign in instead.") && guard < c.indexOf('from("brokerages")') })())
}

{
  // (d) the stall sweep — nudge once, escalate once, re-run = zero
  const now = new Date("2026-09-23T12:00:00.000Z")
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
  const svc = fakeSvc({
    brokerages: [
      { id: "b-nudge", name: "Nudge Co", email: "n@co.com", created_at: daysAgo(4), onboarding_status: "pending", plan_tier: "team", billing_metadata: { coupon: { code: "X" } }, is_demo: false },
      { id: "b-paid", name: "Paid Co", email: "p@co.com", created_at: daysAgo(8), onboarding_status: "pending", plan_tier: "brokerage", billing_metadata: null, is_demo: false },
      { id: "b-live", name: "Live Co", email: "l@co.com", created_at: daysAgo(9), onboarding_status: "in_progress", plan_tier: "team", billing_metadata: null, is_demo: false },
      { id: "b-new", name: "New Co", email: "w@co.com", created_at: daysAgo(1), onboarding_status: "pending", plan_tier: "solo_agent", billing_metadata: null, is_demo: false },
      { id: "b-demo", name: "Demo Co", email: "d@co.com", created_at: daysAgo(30), onboarding_status: "pending", plan_tier: "team", billing_metadata: null, is_demo: true },
    ],
    subscriptions: [
      { id: "s1", brokerage_id: "b-nudge", status: "trialing", stripe_subscription_id: null, trial_end: daysAgo(4 - 14) },
      { id: "s2", brokerage_id: "b-paid", status: "trialing", stripe_subscription_id: null, trial_end: daysAgo(8) },
      { id: "s3", brokerage_id: "b-live", status: "active", stripe_subscription_id: "sub_1", trial_end: null },
    ],
    users: [
      { id: "u-n", brokerage_id: "b-nudge", user_type: "admin", email: "owner-n@co.com", first_name: "Nia", created_at: daysAgo(4) },
      { id: "u-p", brokerage_id: "b-paid", user_type: "broker", email: "owner-p@co.com", first_name: "Pat", created_at: daysAgo(8) },
    ],
    notifications: [],
  })
  const sends: Array<Record<string, unknown>> = []
  const bells: Array<Record<string, unknown>> = []
  const deps = { resolveRep: async () => ({ userId: "usr-rep", brokerageId: "brk-platform" }), dispatch: async (p: Record<string, unknown>) => { sends.push(p); return { success: true } }, notifyStaff: async (_s: unknown, n: Record<string, unknown>) => { bells.push(n); return 2 }, brandName: "VIP", appUrl: "https://app.test" }
  const r1 = await runSubscriberStallSweep(svc, now, deps)
  check("run 1: 4 scanned (the demo tenant is never scanned), 3 pending (live is not), 2 nudged (day 4 + day 8), 1 escalated (day 8 only), day-1 skipped as not yet due, zero errors",
    r1.scanned === 4 && r1.pending === 3 && r1.nudged === 2 && r1.escalated === 1 && r1.skipped === 1 && r1.errors.length === 0, JSON.stringify(r1))
  const paidSend = sends.find((s) => s.to === "owner-p@co.com")
  check("the owner gets the EMAIL (the only channel that reaches someone who never signed in) from the platform rep + an in-app bell for when they do; the paid-pending copy names the unfinished checkout",
    sends.length === 2 && paidSend?.brokerageId === "brk-platform" && /checkout never finished/.test(String(paidSend?.html)) && svc.tables.notifications.length === 2 && svc.tables.notifications.every((n) => n.type === "onboarding_reminder"))
  check("the day-8 paid-pending tenant escalates ONCE to platform staff (type platform_subscriber_stalled, entity brokerage, high) — the day-4 one does not",
    bells.length === 1 && bells[0]!.type === "platform_subscriber_stalled" && bells[0]!.entityId === "b-paid" && bells[0]!.entityType === "brokerage" && /never finished checkout/.test(String(bells[0]!.title)))
  const nudgeRow = svc.tables.brokerages.find((b) => b.id === "b-nudge") as Row & { billing_metadata: Record<string, any> }
  check("stamps land in billing_metadata.subscriber_stall WITHOUT clobbering the carry-bag (the coupon survives)", nudgeRow.billing_metadata.subscriber_stall?.nudged_at === now.toISOString() && nudgeRow.billing_metadata.coupon?.code === "X")
  const r2 = await runSubscriberStallSweep(svc, now, deps)
  check("run 2 (same day): a COUNTED ZERO — nothing nudged, nothing escalated, no new email or bell (idempotent)", r2.nudged === 0 && r2.escalated === 0 && r2.pending === 3 && sends.length === 2 && bells.length === 1, JSON.stringify(r2))
  const later = new Date(now.getTime() + 4 * 86_400_000)
  const r3 = await runSubscriberStallSweep(svc, later, deps)
  check("run 3 (four days later): the day-4 tenant crossed STALL_AFTER_DAYS → ONE escalation and no second nudge; the day-1 tenant crossed NUDGE_AFTER_DAYS → its ONE nudge (to the brokerage email — it has no owner row); the day-8 tenant owes nothing more",
    r3.escalated === 1 && r3.nudged === 1 && bells.length === 2 && bells[1]!.entityId === "b-nudge" && sends.length === 3 && sends[2]!.to === "w@co.com" && (svc.tables.brokerages.find((b) => b.id === "b-paid") as any).billing_metadata.subscriber_stall.escalated_at === now.toISOString(), JSON.stringify(r3))
  const svcNoRep = fakeSvc({ brokerages: [{ id: "b-x", name: "X", email: "x@co.com", created_at: daysAgo(4), onboarding_status: "pending", plan_tier: "team", billing_metadata: null, is_demo: false }], subscriptions: [], users: [{ id: "u-x", brokerage_id: "b-x", user_type: "admin", email: "ox@co.com", first_name: "O", created_at: daysAgo(4) }], notifications: [] })
  const r4 = await runSubscriberStallSweep(svcNoRep, now, { ...deps, resolveRep: async () => null })
  check("no platform rep → the missing email is REPORTED by name (never swallowed), the bell still lands, and the stage is stamped so it is not retried blind every day", r4.errors.some((e) => /no platform sales rep/.test(e)) && svcNoRep.tables.notifications.length === 1 && r4.nudged === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · SOURCE — both entrances on the survivors (stripped, with controls)]")
{
  const signup = code(SIGNUP), growth = code(GROWTH), tools = code(TOOLS), core = code(CORE), door = code(DOOR), stall = code(STALL)
  check("self-serve entrance: plans through planSubscriberEntrance, refuses a bot and splits to salesAssistedIntake BEFORE the service client is created, then reaches createTenantCore ONCE with the plan's tier",
    (() => { const plan = signup.indexOf("planSubscriberEntrance("); const bot = signup.indexOf("if (plan.bot) return"); const split = signup.indexOf("salesAssistedIntake(service"); const svc = signup.indexOf("createServiceClient()"); const core = signup.indexOf("createTenantCore(service")
      return plan > 0 && bot > plan && svc > bot && split > svc && core > split && (signup.match(/createTenantCore\(/g) ?? []).length === 1 && /tier: plan\.tier,/.test(signup) })())
  check("self-serve entrance: a paid activation ALSO emails the checkout through the ONE sender, and a service-only reason (CRM migration) raises the white-glove bell on the NEW tenant",
    /sendActivationCheckoutEmail\(service, \{/.test(signup) && /if \(plan\.humanReasons\.length > 0\)[\s\S]{0,600}notifyPlatformStaff\(service as never, \{[\s\S]{0,900}entityType: "brokerage", entityId: brokerage\.id/.test(signup))
  check("sales-assisted entrance (staff): convertProspectToSubscriberAction → convertProspectToSubscriber (the core behind it) + the SAME checkout sender; prospectId is the only id in the request",
    /convertProspectToSubscriber\(svc, \{/.test(growth) && /sendActivationCheckoutEmail\(svc, \{/.test(growth) && /prospectId: input\.prospectId/.test(growth) && !/input\.brokerageId/.test(growth))
  check("sales-assisted entrance (AI rep): start_subscription delegates the checkout email to the survivor — the inline dispatchEmail + copy is GONE (tombstone kept in prose)",
    /sendActivationCheckoutEmail\(svc, \{/.test(tools) && !/platform_prospect_activation_checkout/.test(tools) && /platform_prospect_activation_checkout/.test(raw(TOOLS) + door) && /sendActivationCheckoutEmail/.test(raw(TOOLS)) && /TOMBSTONE \(lane 79D\)/.test(raw(TOOLS)))
  check("the conversion still delegates to the ONE core (dynamic import — the @proofSeam is the only alternative)", /deps\.provisionTenant \?\? \(await import\("@\/lib\/kernel\/tenant-creation"\)\)\.createTenantCore/.test(code("lib/platform/prospect-conversion.ts")))
  check("the core reaches createActivationCheckout exactly once, on the paid branch only, and never on a trial",
    /if \(input\.billing\.mode === "paid"\) \{[\s\S]{0,3000}createActivationCheckout\(service, \{/.test(core) && (core.match(/createActivationCheckout\(/g) ?? []).length === 1 && !/mode === "trial"[\s\S]{0,400}createActivationCheckout/.test(core))
  check("ONE landing: the core's success URL reads SUBSCRIBER_ACTIVATED_PATH from the door (no second '/auth/login?activated=1' literal in the core)",
    /successUrl: `\$\{appUrl\}\$\{SUBSCRIBER_ACTIVATED_PATH\}`/.test(core) && !/activated=1/.test(code(CORE)) && /SUBSCRIBER_ACTIVATED_PATH = "\/login\?activated=1"/.test(door))
  check("POSITIVE CONTROL: the landing finder sees a restated literal on a fixture", /activated=1/.test('successUrl: `${appUrl}/auth/login?activated=1`'))
  check("THE MONEY FIX: both Stripe callers put the setup fee in line_items (one-time price → initial invoice) and NEITHER passes subscription_data.add_invoice_items (a Subscriptions-API parameter Checkout rejects)",
    /line_items: \[\.\.\.lineItems, \.\.\.addInvoiceItems\]/.test(code(ACTIVATION)) && /line_items: \[\.\.\.lineItems, \.\.\.addInvoiceItems\]/.test(code(BILLING)) && !/add_invoice_items:/.test(code(ACTIVATION)) && !/add_invoice_items:/.test(code(BILLING)))
  check("POSITIVE CONTROL: the rejected shape is still recognised on a fixture, and the builder still emits the one-time item without `recurring`",
    /add_invoice_items:/.test('subscription_data: { add_invoice_items: x }') && (() => { const c = buildCheckoutConfig({ tier_name: "team", display_name: "Team", monthly_price_cents: 100, annual_price_cents: 1000, setup_fee_cents: 50 }, "monthly"); return c.addInvoiceItems.length === 1 && !("recurring" in (c.addInvoiceItems[0] as any).price_data) })())
  check("the webhook activates on checkout.session.completed through the ONE brokerage-keyed writer and advances the prospect trial → converted", /case "checkout\.session\.completed"/.test(code(WEBHOOK)) && /upsertBrokerageSubscription\(supabase, brokerageId, patch\)/.test(code(WEBHOOK)) && /\.eq\("status", "trial"\)/.test(code(WEBHOOK)))
  check("UI: the growth board mounts Convert to subscriber on convertProspectToSubscriberAction and reports whether the checkout was emailed",
    code(BOARD).includes("convertProspectToSubscriberAction(") && code(BOARD).includes("Convert to subscriber") && /checkoutEmailed/.test(code(BOARD)))
  const form = code(FORM)
  check("UI: the public form posts producerSeats / customPricingRequested / currentTools / the honeypot, previews the band from lane 79A's plan-catalog (client-safe — never the door's server graph), and renders the sales_assisted + existing_subscriber routes",
    /producerSeats:/.test(form) && /customPricingRequested: customPricing/.test(form) && /website,/.test(form) && /from "@\/lib\/billing\/plan-catalog"/.test(form) && !/subscriber-door/.test(form)
    && /route === "sales_assisted"/.test(form) && /route === "existing_subscriber"/.test(form) && /tierForSeatCount\(/.test(form) && !/Up to \d/.test(form))
  check("the door's public surface is throttled (checkPublicRateLimit) and the honeypot refusal writes nothing", /checkPublicRateLimit\("signup"/.test(signup) && /if \(plan\.bot\) return \{ ok: false/.test(signup))
  check("AUTONOMOUS LOOP: the stall sweep rides the EXISTING daily onboarding-reminders cron (registered in cron-dispatch) — no new cron", /runSubscriberStallSweep\(createServiceClient\(\)\)/.test(code(CRON)) && /\/api\/cron\/onboarding-reminders/.test(code("lib/kernel/cron-dispatch.ts")))
  check("the loop escalates to a HUMAN only at the stall threshold (notifyPlatformStaff guarded by due === 'escalate') and nudges through the ONE egress survivor", /if \(state\.due === "escalate"\) \{[\s\S]{0,400}notifyPlatformStaff/.test(stall) && /@\/lib\/providers\/dispatch/.test(stall) && !/@\/lib\/providers\/messaging/.test(stall + door))
  const ID_LEAK = /(contactId|leadId|contact_id|lead_id)\s*:\s*(prospect(Id)?(\.id)?|saved\.id|row\.id|input\.prospectId)\b/
  check("no prospect id ever sits in a contactId/leadId slot (door + stall + signup + growth)", ![door, stall, signup, growth].some((s) => ID_LEAK.test(s)) && ID_LEAK.test("dispatchEmail({ contactId: saved.id })"))
  check("Stripe only through the existing survivors: the door, the stall loop and the signup action import no Stripe client", ![door, stall, signup].some((s) => /@\/lib\/stripe|checkout\.sessions|\bstripe\./.test(s)))
  check("every read/write in the door and the stall loop destructures `error` where it reads a table (§3) — no bare `const { data } = await svc.from(`", !/const \{ data \} = await svc\.from\(/.test(door) && !/const \{ data \} = await svc\.from\(/.test(stall))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · registration]")
{
  const pkg = raw("package.json")
  const guardLine = pkg.split("\n").find((l) => l.includes('"guard":')) ?? ""
  check('"test:subscriber-door" is registered', /"test:subscriber-door":\s*"tsx scripts\/subscriber-door-simulator\.ts"/.test(pkg))
  check("the guard chain runs it after test:scrapers (ordering only, CLAUDE.md §2: never pin a neighbour)", guardLine.indexOf("npm run test:subscriber-door") > guardLine.indexOf("npm run test:scrapers") && guardLine.indexOf("npm run test:scrapers") > 0)
  check("MAINTENANCE_DOMAINS carries subscriber_door with proof test:subscriber-door and names its cross-cooperating managers", /subscriber_door:\s*\{\s*manager:\s*"[a-z_]+",\s*proof:\s*"test:subscriber-door"/.test(code("lib/kernel/manager-registry.ts")) && /subscriber_door:[^\n]*finance_manager[^\n]*recruiting_manager/.test(raw("lib/kernel/manager-registry.ts")))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ One subscriber door, two entrances, humans when warranted, the loop after")
console.log(" SUBSCRIBER_DOOR_PASS")
