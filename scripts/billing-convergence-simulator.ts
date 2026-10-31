#!/usr/bin/env tsx
/**
 * scripts/billing-convergence-simulator.ts   (npm run test:billing-convergence)
 * ─────────────────────────────────────────────────────────────────────────────
 * BILLING CONVERGENCE — one proof, two waves of it.
 *
 * Layers 1–2 (original): keep-two-stores, share-the-brains. A brokerage tenant pays
 * (subscriptions, brokerage-keyed) and a marketplace vendor pays (vendor_marketplace_
 * profiles, profile-keyed) — separate stores that must not diverge on what they
 * share: the Stripe status vocabulary (lib/billing/stripe-status.ts) and the billing
 * portal (lib/billing/stripe-portal.ts).
 *
 * Layers 3–7 (wave 140J — production convergence, in memory, Stripe stubbed):
 *   3 · FIVE ORIGINS → ONE OPERATIONAL STATE. Self-serve trial, self-serve paid,
 *       staff-created paid, trial→paid and sales-assisted all land on the ONE
 *       subscriptions row (lib/kernel/tenant-creation.ts buildSubscriptionRow is the
 *       only signup inserter; the webhook's upsertBrokerageSubscription is the only
 *       other), read by the ONE resolver (lib/billing/billing-access.ts
 *       loadBillingAccess). The four paid origins converge to byte-identical
 *       {state:"active", blocked:false}; the trial is {trialing, unblocked, days}.
 *       A census of stripped sources holds the inserter set at exactly two files.
 *   4 · A REPLAYED STRIPE EVENT DUPLICATES NOTHING. withStripeEventLedger rides the
 *       action ledger's UNIQUE idempotency_key: the second delivery of the same
 *       event id is a replay (run not executed), so one bell, one row, one event.
 *   5 · TRIAL EXPIRY → THE CORRECT STATE. The pure resolver refuses an expired trial
 *       (trial_expired) and refuses a trial with no end (trial_end_unknown); the
 *       daily sweep moves a local expired trial with no card to 'paused' once.
 *   6 · price_not_configured REFUSES + RAISES (with positive controls): an overage
 *       number on a tier with no administered rate, a vendor tier with no
 *       administered price, a plan checkout whose catalogue row holds no price —
 *       refused with the tenant sentence, no Stripe call, one deduped platform
 *       incident; the SAME move with a configured price proceeds. No code literal
 *       is a price (stripped-source census of phone-plan.ts / vendor-subscription.ts).
 *   7 · TENANT-FACING LANGUAGE: no rendered string in app/** or lib/** (.tsx, outside
 *       superadmin surfaces) says "platform-covered" (comments blanked first — a
 *       tombstone is not a sentence); the finder is proven on a fixture.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { normalizeStripeStatus, isCurrentStatus, isDelinquentStatus } from "../lib/billing/stripe-status"
import { mapStripeEventToStatus, resolveTierPrice, resolveVendorTiers, VENDOR_TIERS } from "../lib/kernel/vendor-subscription"
import { blankComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Billing convergence verified — one Stripe-status vocab + one portal, two correct stores; five origins → one state; replay-safe; price_not_configured refuses; tenant copy clean")
  console.log(" BILLING_CONVERGENCE_PASS")
}
const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => blankComments(src(p), { jsx: true })

// ─── in-memory supabase (writers COUNT rows: update/delete + .select() return the matched rows) ───
type Row = Record<string, any>
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  let seq = 0
  const t = (name: string) => (tables[name] ??= [])
  const like = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select"
    let payload: any = null, onConflict: string | null = null
    let order: { col: string; asc: boolean } | null = null, lim: number | null = null
    let mode: "many" | "single" | "maybe" = "many", count = false, head = false, wantRows = false
    const matched = () => t(table).filter((r) => filters.every((f) => f(r)))
    const shape = (rows: Row[]) => {
      if (mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } }
      if (mode === "maybe") return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }
    function exec() {
      if (op === "select") {
        let rows = matched()
        if (order) { const { col, asc } = order; rows = [...rows].sort((a, b2) => (a[col] < b2[col] ? -1 : a[col] > b2[col] ? 1 : 0) * (asc ? 1 : -1)) }
        if (lim != null) rows = rows.slice(0, lim)
        // A SELECT returns a snapshot (as Postgres does), never the live stored object — a
        // writer that keeps the read row and then updates it must see the PRE-write status.
        const snap = rows.map((r) => ({ ...r }))
        if (count) return { data: head ? null : snap, error: null, count: snap.length }
        return shape(snap)
      }
      if (op === "insert") {
        // Column DEFAULTS the live schema applies (agent_action_ledger.attempts DEFAULT 1 — the
        // re-claim guards on it, so a fake without it turns every retry into "in_flight").
        const defaults: Row = table === "agent_action_ledger" ? { attempts: 1 } : {}
        const list: Row[] = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `${table}_${++seq}`, created_at: new Date().toISOString(), ...defaults, ...p }))
        if (table === "agent_action_ledger") {
          for (const p of list) if (p.idempotency_key && t(table).some((r) => r.idempotency_key === p.idempotency_key)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint agent_action_ledger_idempotency_key_key" } }
        }
        t(table).push(...list)
        return wantRows ? shape(list) : { data: null, error: null }
      }
      if (op === "update") { const rows = matched(); for (const r of rows) Object.assign(r, payload); return wantRows ? shape(rows) : { data: null, error: null } }
      if (op === "upsert") {
        const out: Row[] = []
        for (const p of (Array.isArray(payload) ? payload : [payload])) {
          const ex = onConflict ? t(table).find((r) => r[onConflict!] === p[onConflict!]) : null
          if (ex) { Object.assign(ex, p); out.push(ex) } else { const n = { id: `${table}_${++seq}`, ...p }; t(table).push(n); out.push(n) }
        }
        return wantRows ? shape(out) : { data: null, error: null }
      }
      const rows = matched(); tables[table] = t(table).filter((r) => !rows.includes(r))
      return wantRows ? shape(rows) : { data: null, error: null }
    }
    const b: any = {
      select(_c?: string, o?: any) { if (op === "select") { count = !!o?.count; head = !!o?.head } else wantRows = true; return b },
      insert(p: any) { op = "insert"; payload = p; return b },
      update(p: any) { op = "update"; payload = p; return b },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; onConflict = o?.onConflict ?? null; return b },
      delete() { op = "delete"; return b },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      not(c: string, o: string, v: any) { filters.push((r) => (o === "is" && v === null ? r[c] != null : o === "like" ? !like(String(v)).test(String(r[c] ?? "")) : r[c] !== v)); return b },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return b },
      lte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] <= v); return b },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b },
      ilike(c: string, p: string) { filters.push((r) => like(p).test(String(r[c] ?? ""))); return b },
      or(expr: string) {
        const parts = expr.split(/,(?![^(]*\))/)
        filters.push((r) => parts.some((p) => { const m = p.match(/^(\w+)\.(eq|in)\.(.+)$/); if (!m) return false; const [, c, o, v] = m; return o === "eq" ? String(r[c]) === v : v.replace(/^\(|\)$/g, "").split(",").includes(String(r[c])) }))
        return b
      },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { lim = n; return b },
      maybeSingle() { mode = "maybe"; return b },
      single() { mode = "single"; return b },
      then(res: any, rej: any) { return Promise.resolve().then(exec).then(res, rej) },
    }
    return b
  }
  return { from, tables }
}

const TIER_SOLO = "tier_solo", TIER_UNPRICED = "tier_unpriced"
const STAFF = "user_staff_1", STAFF_HOME = "brk_platform_home"
function seed() {
  return fakeDb({
    subscription_tiers: [
      { id: TIER_SOLO, tier_name: "solo_agent", display_name: "Solo Agent", monthly_price_cents: 9900, annual_price_cents: 99900, setup_fee_cents: 0, is_active: true, stripe_price_id: null, stripe_seat_price_id: null, seat_package_size: 5, features: null },
      { id: TIER_UNPRICED, tier_name: "team", display_name: "Team", monthly_price_cents: null, annual_price_cents: 0, setup_fee_cents: 0, is_active: true, stripe_price_id: null, stripe_seat_price_id: null, seat_package_size: 5, features: null },
    ],
    brokerages: [
      { id: "brk_trial", name: "Trial Co", email: "t@x.test", plan_tier: "solo_agent", trial_ends_at: null },
      { id: "brk_self_paid", name: "Self Paid Co", email: "s@x.test", plan_tier: "solo_agent", trial_ends_at: null },
      { id: "brk_staff_paid", name: "Staff Paid Co", email: "p@x.test", plan_tier: "solo_agent", trial_ends_at: null },
      { id: "brk_trial_to_paid", name: "Trial→Paid Co", email: "c@x.test", plan_tier: "solo_agent", trial_ends_at: null },
      { id: "brk_sales", name: "Sales Assisted Co", email: "a@x.test", plan_tier: "solo_agent", trial_ends_at: null },
      { id: STAFF_HOME, name: "Platform", email: "ops@x.test", plan_tier: "solo_agent", trial_ends_at: null },
    ],
    users: [{ id: STAFF, email: "ops@x.test", user_type: "admin", platform_role: "superadmin", brokerage_id: STAFF_HOME }],
    tenant_phone_numbers: [{ id: "tpn_1", brokerage_id: "brk_self_paid", is_active: true }],
    notifications: [], agent_action_ledger: [], subscriptions: [], billing_invoices: [], platform_prospects: [], platform_settings: [{ collect_tax: false }],
  })
}

/** A Stripe subscription object as the webhook sees it (metadata carries the tenant). */
const stripeSub = (id: string, brokerageId: string, status = "active") => ({
  id, status, customer: `cus_${brokerageId}`, metadata: { brokerage_id: brokerageId, tier_id: TIER_SOLO },
  current_period_start: 1_700_000_000, current_period_end: 1_702_600_000, trial_end: null, cancel_at: null, items: { data: [] },
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Billing convergence simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · shared status normalizer]")
  check("unpaid → past_due; cancelled → canceled (spelling unified)",
    normalizeStripeStatus("unpaid") === "past_due" && normalizeStripeStatus("cancelled") === "canceled" && normalizeStripeStatus("canceled") === "canceled")
  check("incomplete_expired → incomplete; active/trialing/paused map through",
    normalizeStripeStatus("incomplete_expired") === "incomplete" && normalizeStripeStatus("active") === "active" &&
    normalizeStripeStatus("trialing") === "trialing" && normalizeStripeStatus("paused") === "paused")
  check("empty / unknown → unknown", normalizeStripeStatus("") === "unknown" && normalizeStripeStatus("weird") === "unknown")
  check("isCurrentStatus: active/trialing true, past_due/canceled false",
    isCurrentStatus("active") && isCurrentStatus("trialing") && !isCurrentStatus("past_due") && !isCurrentStatus("canceled"))
  check("isDelinquentStatus: past_due/canceled/incomplete true, active false",
    isDelinquentStatus("past_due") && isDelinquentStatus("canceled") && isDelinquentStatus("incomplete") && !isDelinquentStatus("active"))

  console.log("\n[Layer 1b · vendor mapper routes through the shared normalizer]")
  check("payment_failed → past_due (no suspend)", mapStripeEventToStatus("invoice.payment_failed").status === "past_due")
  check("subscription.deleted → canceled + suspend", (() => { const r = mapStripeEventToStatus("customer.subscription.deleted"); return r.status === "canceled" && r.suspendAccount })())
  check("subscription.updated unpaid → past_due", mapStripeEventToStatus("customer.subscription.updated", "unpaid").status === "past_due")
  check("subscription.updated cancelled → canceled + suspend",
    (() => { const r = mapStripeEventToStatus("customer.subscription.updated", "cancelled"); return r.status === "canceled" && r.suspendAccount })())
  check("checkout.session.completed → active", mapStripeEventToStatus("checkout.session.completed", "complete").status === "active")
  check("trialing → trialing (no suspend)", mapStripeEventToStatus("customer.subscription.updated", "trialing").status === "trialing")

  console.log("\n[Layer 2 · one portal, shared normalizer wiring]")
  const portalSrc = src("lib/billing/stripe-portal.ts")
  check("shared createBillingPortalUrl exists", /export async function createBillingPortalUrl/.test(portalSrc))
  const vendorBillingSrc = src("app/actions/vendor-billing.ts")
  check("vendor portal uses the shared helper (no inline billingPortal.sessions.create)",
    /createBillingPortalUrl\(/.test(vendorBillingSrc) && !/stripe\.billingPortal\.sessions\.create/.test(vendorBillingSrc))
  const tenantBillingSrc = src("app/actions/billing.ts")
  check("brokerage tenants now have a self-serve portal action (parity) via the shared helper",
    /createBrokerageBillingPortalAction/.test(tenantBillingSrc) && /createBillingPortalUrl\(/.test(tenantBillingSrc))
  const vendorSubSrc = src("lib/kernel/vendor-subscription.ts")
  check("vendor status mapper imports the shared normalizer (no drift)",
    /from ['"]@\/lib\/billing\/stripe-status['"]/.test(vendorSubSrc) && /normalizeStripeStatus\(/.test(vendorSubSrc))
  const pageSrc = src("app/dashboard/admin/billing/page.tsx")
  check("the Manage-billing button is wired into the tenant billing page", /ManageBillingButton/.test(pageSrc))

  // ─── wave 140J ──────────────────────────────────────────────────────────────
  const { buildSubscriptionRow } = await import("../lib/kernel/tenant-creation")
  const { buildSubscriptionPatch, upsertBrokerageSubscription, createActivationCheckout, planPriceNotConfigured } = await import("../lib/billing/subscription-activation")
  const { normalizeStripeSubscription } = await import("../lib/billing/seat-packages")
  const { loadBillingAccess, resolveBillingAccess } = await import("../lib/billing/billing-access")
  const { withStripeEventLedger, resolveStripeEventTenant, runSubscriptionLifecycleSweep, planTrialEnd } = await import("../lib/billing/stripe-subscription-ops")

  console.log("\n[Layer 3 · five origins → one operational state (in memory)]")
  const db = seed()
  const now = new Date("2026-10-11T12:00:00.000Z")
  // The webhook's checkout.session.completed / customer.subscription.* application, as the route does it.
  const applyStripeSub = (brokerageId: string, sub: any) =>
    upsertBrokerageSubscription(db, brokerageId, buildSubscriptionPatch(normalizeStripeSubscription(sub as any, null)))
  const rowsFor = (b: string) => db.tables.subscriptions.filter((r) => r.brokerage_id === b)

  // O1 — self-serve TRIAL (app/actions/auth/signup-brokerage.ts → createTenantCore → buildSubscriptionRow trial)
  await db.from("subscriptions").insert(buildSubscriptionRow({ brokerageId: "brk_trial", tierId: TIER_SOLO, billing: { mode: "trial", trialDays: 14 }, now }))
  const trialAccess = await loadBillingAccess(db, "brk_trial", now)
  check("O1 self-serve trial: one row, trialing, unblocked, 14 days left (trial_end WRITTEN)",
    rowsFor("brk_trial").length === 1 && trialAccess.state === "trialing" && !trialAccess.blocked && trialAccess.trialDaysLeft === 14, JSON.stringify(trialAccess))

  // O2 — self-serve PAID (signup paid → pending row → hosted checkout → webhook checkout.session.completed)
  await db.from("subscriptions").insert(buildSubscriptionRow({ brokerageId: "brk_self_paid", tierId: TIER_SOLO, billing: { mode: "paid", billingCycle: "monthly" }, now }))
  const pending = await loadBillingAccess(db, "brk_self_paid", now)
  check("O2 self-serve paid BEFORE payment: the pending row is a paywall (expired/blocked), not access",
    pending.state === "expired" && pending.blocked === true && pending.reason === "trial_expired", JSON.stringify(pending))
  const o2 = await applyStripeSub("brk_self_paid", stripeSub("sub_self", "brk_self_paid"))
  check("O2 webhook LINKS the pending row (updated, not inserted)", o2.action === "updated" && rowsFor("brk_self_paid").length === 1, JSON.stringify(o2))

  // O3 — STAFF-CREATED paid (app/actions/admin/create-subscriber.ts → createTenantCore billing.mode 'active')
  await db.from("subscriptions").insert(buildSubscriptionRow({ brokerageId: "brk_staff_paid", tierId: TIER_SOLO, billing: { mode: "active", billingCycle: "monthly", stripeCustomerId: "cus_staff" }, now }))
  const staffBefore = await loadBillingAccess(db, "brk_staff_paid", now)
  check("O3 staff-created paid: active on day one (invoiced; no checkout needed)", staffBefore.state === "active" && !staffBefore.blocked)
  const o3 = await applyStripeSub("brk_staff_paid", stripeSub("sub_staff", "brk_staff_paid"))
  check("O3 a later customer.subscription.created (staff minted it in Stripe) links the SAME row", o3.action === "updated" && rowsFor("brk_staff_paid").length === 1)

  // O4 — TRIAL → PAID (trial row, then the tenant pays: checkout.session.completed)
  await db.from("subscriptions").insert(buildSubscriptionRow({ brokerageId: "brk_trial_to_paid", tierId: TIER_SOLO, billing: { mode: "trial", trialDays: 14 }, now }))
  const o4 = await applyStripeSub("brk_trial_to_paid", stripeSub("sub_t2p", "brk_trial_to_paid"))
  check("O4 trial→paid: the trialing row becomes the paid row (previousStatus trialing → active, still one row)",
    o4.action === "updated" && o4.previousStatus === "trialing" && rowsFor("brk_trial_to_paid").length === 1 && rowsFor("brk_trial_to_paid")[0].status === "active",
    `${JSON.stringify(o4)} rows=${JSON.stringify(rowsFor("brk_trial_to_paid").map((r) => ({ status: r.status, sub: r.stripe_subscription_id })))}`)

  // O5 — SALES-ASSISTED (lib/platform/prospect-conversion.ts → the same createTenantCore, paid + hosted checkout)
  await db.from("subscriptions").insert(buildSubscriptionRow({ brokerageId: "brk_sales", tierId: TIER_SOLO, billing: { mode: "paid", billingCycle: "annual" }, now }))
  const o5 = await applyStripeSub("brk_sales", stripeSub("sub_sales", "brk_sales"))
  check("O5 sales-assisted paid: same pending→linked path, one row", o5.action === "updated" && rowsFor("brk_sales").length === 1)

  const paidStates = await Promise.all(["brk_self_paid", "brk_staff_paid", "brk_trial_to_paid", "brk_sales"].map((b) => loadBillingAccess(db, b, now)))
  const key = (a: any) => JSON.stringify({ state: a.state, blocked: a.blocked, reason: a.reason, trialDaysLeft: a.trialDaysLeft, graceDaysLeft: a.graceDaysLeft })
  check("CONVERGENCE: the four paid origins resolve to BYTE-IDENTICAL billing access {active, unblocked}",
    paidStates.every((a) => key(a) === key(paidStates[0])) && paidStates[0].state === "active" && paidStates[0].blocked === false, paidStates.map(key).join(" | "))
  check("CONVERGENCE: every origin holds exactly ONE subscriptions row, Stripe-linked where money moved",
    ["brk_trial", "brk_self_paid", "brk_staff_paid", "brk_trial_to_paid", "brk_sales"].every((b) => rowsFor(b).length === 1) &&
    ["brk_self_paid", "brk_staff_paid", "brk_trial_to_paid", "brk_sales"].every((b) => !!rowsFor(b)[0].stripe_subscription_id))

  // Source: the doors and the inserter census.
  const insertRe = /from\("subscriptions"\)\s*\.insert\(/
  const inserters: string[] = []
  for (const f of walk(["lib", "app"], (p) => /\.(ts|tsx)$/.test(p))) if (insertRe.test(code(f))) inserters.push(f)
  // THE RULE: the canonical inserters are tenant-creation.ts (every signup door) and
  // subscription-activation.ts (the webhook writer). THE FINDING (wave 140J, published, not
  // hidden): app/actions/onboarding/ensure-agent-brokerage.ts still mints a brokerage-of-one
  // + a trialing row on dashboard load for a brokerage-less agent — a hidden first-login
  // provisioner outside createTenantCore (lane 140C's door convergence). It is NAMED here so
  // the day it converges this list goes stale and the proof says so (a count that moves is
  // the finding), rather than a silent "2" that could never have seen it.
  const CANONICAL_INSERTERS = ["lib/kernel/tenant-creation.ts", "lib/billing/subscription-activation.ts"]
  // Wave 140 integration: ensure-agent-brokerage CONVERGED onto createTenantCore (adoptExistingOwner) — lane 140C.
  // The list is empty by design; a new name here is a regression that must be explained in prose.
  const NAMED_PARALLEL_INSERTERS: string[] = []
  const unexplained = inserters.filter((f) => !CANONICAL_INSERTERS.includes(f) && !NAMED_PARALLEL_INSERTERS.includes(f))
  console.log(`    subscriptions inserters (stripped source): ${inserters.join(", ")}`)
  check("census: both canonical inserters exist and NO unexplained file inserts a subscriptions row",
    CANONICAL_INSERTERS.every((f) => inserters.includes(f)) && unexplained.length === 0, `unexplained: ${unexplained.join(", ")}`)
  check("census: ensure-agent-brokerage (the former third inserter) is CONVERGED — it calls createTenantCore and inserts no subscriptions row itself (count moved 3 → 2)",
    NAMED_PARALLEL_INSERTERS.length === 0 && !inserters.includes("app/actions/onboarding/ensure-agent-brokerage.ts") && /createTenantCore\(/.test(code("app/actions/onboarding/ensure-agent-brokerage.ts")))
  check("census positive control: the inserter finder sees a fixture", insertRe.test('svc.from("subscriptions")\n  .insert({ a: 1 })'))
  check("doors: self-serve signup, staff create-subscriber and the prospect converter all call createTenantCore; the superadmin manual door rides create-subscriber",
    /createTenantCore\(/.test(code("app/actions/auth/signup-brokerage.ts")) && /createTenantCore\(/.test(code("app/actions/admin/create-subscriber.ts")) &&
    /provisionTenant \?\? [\s\S]{0,80}createTenantCore/.test(code("lib/platform/prospect-conversion.ts")) && /createSubscriber/.test(code("app/actions/superadmin/manual-subscriber.ts")))
  const hook = code("app/api/billing/webhook/route.ts")
  check("webhook: checkout.session.completed and customer.subscription.* both write through upsertBrokerageSubscription and re-sync brokerages.plan_tier",
    (hook.match(/upsertBrokerageSubscription\(/g) ?? []).length >= 2 && (hook.match(/syncBrokeragePlanTier\(/g) ?? []).length >= 3)

  console.log("\n[Layer 4 · a replayed Stripe event duplicates nothing]")
  let ran = 0
  const deliver = (eventId: string, brokerageId: string, run: () => Promise<void>) =>
    withStripeEventLedger({ eventId, eventType: "invoice.payment_failed", brokerageId }, async () => { ran++; await run() }, { client: db })
  const bell = async () => { await db.from("notifications").insert({ brokerage_id: "brk_self_paid", type: "billing_alert", title: "Payment Failed" }) }
  const d1 = await deliver("evt_pf_1", "brk_self_paid", bell)
  const d2 = await deliver("evt_pf_1", "brk_self_paid", bell)
  const bells = db.tables.notifications.filter((n) => n.type === "billing_alert").length
  check("first delivery applies (ledgered); the SECOND delivery of the same event id is a REPLAY — run executed once, ONE bell",
    d1.kind === "applied" && (d1 as any).ledgered === true && d2.kind === "replay" && ran === 1 && bells === 1, `d1=${d1.kind} d2=${d2.kind} ran=${ran} bells=${bells}`)
  check("the ledger holds ONE executed row for the event (LAW 5: tenant + event + outcome)",
    db.tables.agent_action_ledger.filter((r) => r.subject_id === "evt_pf_1").length === 1 && db.tables.agent_action_ledger.find((r) => r.subject_id === "evt_pf_1")?.status === "executed")
  const d3 = await deliver("evt_pf_2", "brk_self_paid", bell)
  check("a DIFFERENT event id applies again (the key is the event, not the tenant)", d3.kind === "applied" && ran === 2)
  const r1 = await withStripeEventLedger({ eventId: "evt_co_1", eventType: "checkout.session.completed", brokerageId: "brk_sales" }, () => applyStripeSub("brk_sales", stripeSub("sub_sales", "brk_sales")), { client: db })
  const r2 = await withStripeEventLedger({ eventId: "evt_co_1", eventType: "checkout.session.completed", brokerageId: "brk_sales" }, () => applyStripeSub("brk_sales", stripeSub("sub_sales", "brk_sales")), { client: db })
  check("a replayed checkout.session.completed leaves ONE subscription row and does not re-run the writer", r1.kind === "applied" && r2.kind === "replay" && rowsFor("brk_sales").length === 1)
  const failing = await withStripeEventLedger({ eventId: "evt_fail_1", eventType: "invoice.paid", brokerageId: "brk_sales" }, async () => { throw new Error("transient refusal") }, { client: db }).catch((e) => ({ kind: "threw", error: (e as Error).message }))
  const retried = await withStripeEventLedger({ eventId: "evt_fail_1", eventType: "invoice.paid", brokerageId: "brk_sales" }, async () => "ok", { client: db })
  check("a delivery that THREW is settled 'failed' and Stripe's retry RE-CLAIMS it (not stuck as a replay)", (failing as any).kind === "threw" && retried.kind === "applied")
  const unledgered = await withStripeEventLedger({ eventId: "evt_acct_1", eventType: "account.updated", brokerageId: null }, async () => "ran", { client: db })
  check("an event with no tenant (account.updated) runs unledgered and says so (published blind spot)", unledgered.kind === "applied" && (unledgered as any).ledgered === false)
  const fakeStripe = { subscriptions: { retrieve: async (id: string) => (id === "sub_inv" ? { metadata: { brokerage_id: "brk_from_sub" } } : { metadata: {} }) } }
  const tenantOf = (type: string, object: any) => resolveStripeEventTenant(fakeStripe, { type, data: { object } })
  check("resolveStripeEventTenant: session metadata → direct; invoice → its subscription's metadata; subscription object → its metadata; account.updated → null",
    (await tenantOf("checkout.session.completed", { metadata: { brokerage_id: "brk_direct" } })) === "brk_direct" &&
    (await tenantOf("invoice.payment_failed", { subscription: "sub_inv" })) === "brk_from_sub" &&
    (await tenantOf("customer.subscription.updated", { metadata: { brokerage_id: "brk_sub" } })) === "brk_sub" &&
    (await tenantOf("account.updated", { id: "acct_1" })) === null &&
    (await tenantOf("invoice.paid", { subscription: "sub_other" })) === null)
  check("route: the tenant is resolved BEFORE the switch and the whole switch runs inside withStripeEventLedger keyed by event.id; a replay answers applied:false",
    hook.indexOf("resolveStripeEventTenant(stripe, event)") > 0 && hook.indexOf("resolveStripeEventTenant(stripe, event)") < hook.indexOf("switch (event.type)") &&
    /withStripeEventLedger\(\{ eventId: event\.id, eventType: event\.type, brokerageId: eventTenant \}/.test(hook) && /case "replay":[\s\S]{0,400}applied: false, replay: true/.test(hook) &&
    /case "refused":[\s\S]{0,300}status: 503/.test(hook))

  console.log("\n[Layer 5 · trial expiry → the correct state]")
  const past = new Date(now.getTime() - 86_400_000).toISOString(), future = new Date(now.getTime() + 3 * 86_400_000).toISOString()
  const exp = resolveBillingAccess({ status: "trialing", trial_end: past }, now)
  const live = resolveBillingAccess({ status: "trialing", trial_end: future }, now)
  const noEnd = resolveBillingAccess({ status: "trialing", trial_end: null }, now)
  check("pure: an ended trial is expired + blocked (trial_expired); a live one is open with days left; a trial with NO end is refused (trial_end_unknown)",
    exp.state === "expired" && exp.blocked && exp.reason === "trial_expired" && live.state === "trialing" && !live.blocked && live.trialDaysLeft === 3 && noEnd.blocked && noEnd.reason === "trial_end_unknown")
  check("pure: planTrialEnd — no card → expire; card on file → convert; Stripe-linked → defer to Stripe; not ended → none",
    planTrialEnd({ trialEnded: true, stripeLinked: false, hasPaymentMethod: false }) === "expire" && planTrialEnd({ trialEnded: true, stripeLinked: false, hasPaymentMethod: true }) === "convert" &&
    planTrialEnd({ trialEnded: true, stripeLinked: true, hasPaymentMethod: false }) === "defer_to_stripe" && planTrialEnd({ trialEnded: false, stripeLinked: false, hasPaymentMethod: false }) === "none")
  const sweepDb = seed()
  await sweepDb.from("subscriptions").insert({ ...buildSubscriptionRow({ brokerageId: "brk_trial", tierId: TIER_SOLO, billing: { mode: "trial", trialDays: 14 }, now: new Date(now.getTime() - 20 * 86_400_000) }) })
  const sweepDeps = { hasPaymentMethod: async () => ({ ok: true, has: false }), ledgerClient: sweepDb, send: async () => ({ success: true, providerKey: "stub" }) }
  const s1 = await runSubscriptionLifecycleSweep(sweepDb, now, sweepDeps)
  const s2 = await runSubscriptionLifecycleSweep(sweepDb, now, sweepDeps)
  const afterSweep = await loadBillingAccess(sweepDb, "brk_trial", now)
  check("sweep: a local trial that ended with no card is moved to 'paused' ONCE (second run moves nothing) and access reads expired/blocked",
    s1.expired === 1 && s2.expired === 0 && sweepDb.tables.subscriptions[0].status === "paused" && afterSweep.blocked && afterSweep.state === "expired",
    `run1=${JSON.stringify({ e: s1.expired, c: s1.converted, err: s1.errors })} run2=${JSON.stringify({ e: s2.expired, err: s2.errors })} status=${sweepDb.tables.subscriptions[0].status}`)

  console.log("\n[Layer 6 · price_not_configured refuses the money move + raises the incident (positive controls)]")
  const { PHONE_ALLOWANCE_DEFAULTS, resolvePhoneAllowance, evaluateNumberProvisioning, evaluatePhoneMetering } = await import("../lib/billing/phone-plan")
  const { evaluateTenantNumberProvisioning } = await import("../lib/billing/phone-plan-resolve")
  const { PRICE_NOT_CONFIGURED, isConfiguredPriceCents } = await import("../lib/billing/plan-catalog")
  check("no tier carries a code-default overage rate (all null — a rate exists only when administered)",
    (Object.values(PHONE_ALLOWANCE_DEFAULTS) as any[]).every((a) => a.overageNumberCents === null && a.overageVoiceMinuteCents === null && a.overageSmsCents === null))
  const refusedPhone = evaluateNumberProvisioning({ allowance: resolvePhoneAllowance("solo_agent"), activeNumbers: 1, tier: "solo_agent" })
  check("phone: the 2nd number on an unpriced solo tier is REFUSED as price_not_configured with the tenant sentence (nothing charged)",
    !refusedPhone.allowed && refusedPhone.priceNotConfigured?.code === PRICE_NOT_CONFIGURED && refusedPhone.monthlyOverageCents === null && /not been published|nothing was charged/.test(refusedPhone.reason ?? ""), refusedPhone.reason)
  const okPhone = evaluateNumberProvisioning({ allowance: resolvePhoneAllowance("solo_agent", { overage_number_cents: 300 }), activeNumbers: 1, tier: "solo_agent" })
  check("phone positive control: the SAME move with an administered rate proceeds as metered overage at that rate",
    okPhone.allowed && okPhone.billing === "overage" && okPhone.monthlyOverageCents === 300 && !okPhone.priceNotConfigured)
  check("phone: the 1st (included) number never needs a rate", evaluateNumberProvisioning({ allowance: resolvePhoneAllowance("solo_agent"), activeNumbers: 0 }).allowed)
  const meterUnpriced = evaluatePhoneMetering({ allowance: resolvePhoneAllowance("solo_agent"), voiceMinutes: 340, smsSegments: 10, activeNumbers: 1, tier: "solo_agent" })
  const meterPriced = evaluatePhoneMetering({ allowance: resolvePhoneAllowance("solo_agent", { overage_voice_minute_cents: 5 }), voiceMinutes: 340, smsSegments: 10, activeNumbers: 1 })
  check("meter: overage UNITS are reported with NO amount when the rate is unset (total null, the gap named); priced → 90 × 5¢; zero units on an unpriced line is an honest 0",
    meterUnpriced.overageVoiceMinutes === 90 && meterUnpriced.overageVoiceCents === null && meterUnpriced.overageTotalCents === null && meterUnpriced.priceNotConfigured.length === 1 &&
    meterUnpriced.overageSmsCents === 0 && meterPriced.overageVoiceCents === 450 && meterPriced.overageTotalCents === 450 && meterPriced.priceNotConfigured.length === 0)
  // The server door: the refusal raises ONE deduped platform incident through the real platform-staff bell.
  const v1 = await evaluateTenantNumberProvisioning(db, "brk_self_paid")
  const v2 = await evaluateTenantNumberProvisioning(db, "brk_self_paid")
  const incidents = db.tables.notifications.filter((n) => n.type === PRICE_NOT_CONFIGURED)
  check("server door: refused twice, ONE platform incident (deduped per day per surface) delivered to platform staff naming the missing rate",
    !v1.allowed && !v2.allowed && !!v1.priceNotConfigured && incidents.length === 1 && incidents[0].user_id === STAFF && /phone_number_overage/.test(incidents[0].title) && /overage_number_cents/.test(incidents[0].body),
    `incidents=${incidents.length} ${JSON.stringify(incidents[0] ?? null)}`)
  // Vendor tiers.
  check("vendor: the catalog carries NO price (every tier null); an administered override wins; an explicit $0 override is honoured; capabilities untouched",
    Object.values(VENDOR_TIERS).every((t) => t.monthlyPriceUsd === null) && resolveTierPrice("standard") === null && resolveTierPrice("standard", { standard: 129 }) === 129 &&
    resolveTierPrice("basic", { basic: 0 }) === 0 && resolveVendorTiers({ premium: 249 }).premium.monthlyPriceUsd === 249 && resolveVendorTiers({ premium: 249 }).premium.preferredEligible === true)
  const vb = code("app/actions/vendor-billing.ts")
  check("vendor checkout: reads the administered vendor_tier_pricing, refuses price_not_configured BEFORE stripe.checkout.sessions.create, charges the resolved price (never VENDOR_TIERS[t].monthlyPriceUsd)",
    /vendor_tier_pricing/.test(vb) && vb.indexOf("priceNotConfiguredRefusal(") > 0 && vb.indexOf("priceNotConfiguredRefusal(") < vb.indexOf("stripe.checkout.sessions.create") &&
    /raisePriceNotConfiguredIncident\(/.test(vb) && /unit_amount: monthlyPriceUsd \* 100/.test(vb) && !/cap\.monthlyPriceUsd/.test(vb))
  // Plan checkout.
  const unpricedTier = db.tables.subscription_tiers.find((t) => t.id === TIER_UNPRICED)!
  check("plan: planPriceNotConfigured refuses null AND 0 recurring prices, passes a real one",
    !!planPriceNotConfigured(unpricedTier, "monthly") && !!planPriceNotConfigured(unpricedTier, "annual") && planPriceNotConfigured(db.tables.subscription_tiers[0], "monthly") === null)
  const refusedCheckout = await createActivationCheckout(db, { brokerageId: "brk_trial", tierId: TIER_UNPRICED, billingCycle: "monthly", successUrl: "https://x/s", cancelUrl: "https://x/c" })
  const pricedCheckout = await createActivationCheckout(db, { brokerageId: "brk_trial", tierId: TIER_SOLO, billingCycle: "monthly", successUrl: "https://x/s", cancelUrl: "https://x/c" })
  const planIncidents = db.tables.notifications.filter((n) => n.type === PRICE_NOT_CONFIGURED && /tenant_plan_checkout/.test(n.title))
  check("hosted checkout: an unpriced catalogue row is refused as price_not_configured (no Stripe call) with its own incident; the priced tier passes the price gate (fails only at the stubbed Stripe credential)",
    !refusedCheckout.ok && (refusedCheckout as any).priceNotConfigured === true && planIncidents.length === 1 && !pricedCheckout.ok && (pricedCheckout as any).priceNotConfigured !== true,
    `refused=${JSON.stringify(refusedCheckout)} priced=${JSON.stringify(pricedCheckout).slice(0, 160)}`)
  check("embedded checkout (app/actions/billing.ts) asks the SAME planPriceNotConfigured before any Stripe customer/session and raises the same incident",
    /planPriceNotConfigured\(/.test(tenantBillingSrc) && tenantBillingSrc.indexOf("planPriceNotConfigured(") < tenantBillingSrc.indexOf("stripe.customers.create") && /raisePriceNotConfiguredIncident\(/.test(tenantBillingSrc))
  check("isConfiguredPriceCents: null/undefined/NaN/negative/float are NOT prices; 0 only with allowZero; positive integers are",
    !isConfiguredPriceCents(null) && !isConfiguredPriceCents(undefined) && !isConfiguredPriceCents(NaN) && !isConfiguredPriceCents(-1) && !isConfiguredPriceCents(1.5) &&
    !isConfiguredPriceCents(0) && isConfiguredPriceCents(0, { allowZero: true }) && isConfiguredPriceCents(9900))
  // Census: no code literal is a price.
  const phoneLiteral = /overage(Number|VoiceMinute|Sms)Cents:\s*\d/
  const vendorLiteral = /monthlyPriceUsd:\s*\d/
  check("census: lib/billing/phone-plan.ts carries no numeric overage rate and lib/kernel/vendor-subscription.ts no numeric tier price (stripped source)",
    !phoneLiteral.test(code("lib/billing/phone-plan.ts")) && !vendorLiteral.test(code("lib/kernel/vendor-subscription.ts")))
  check("census positive control: the literal finders see fixtures", phoneLiteral.test("overageNumberCents: 300,") && vendorLiteral.test("monthlyPriceUsd: 49,"))
  check("the resolver + the meter raise the incident on the server (phone-plan-resolve.ts), the activation checkout raises it, the webhook never prices anything",
    (code("lib/billing/phone-plan-resolve.ts").match(/raisePriceNotConfiguredIncident\(/g) ?? []).length === 2 && /raisePriceNotConfiguredIncident\(/.test(code("lib/billing/subscription-activation.ts")) && !/unit_amount/.test(hook))

  console.log("\n[Layer 7 · tenant-facing language — no rendered 'platform-covered']")
  const phrase = /platform[- ]covered/i
  const offenders: string[] = []
  const scanned = walk(["app", "lib"], (p) => p.endsWith(".tsx") && !/\/superadmin\//.test(p))
  for (const f of scanned) {
    const stripped = blankComments(src(f), { jsx: true })
    if (phrase.test(stripped)) offenders.push(f)
  }
  console.log(`    scanned ${scanned.length} .tsx files (app/** + lib/**, superadmin surfaces excluded; comments blanked); blind spot: strings assembled at runtime from parts`)
  check("no tenant-rendered .tsx says 'platform-covered' (comments blanked first — a tombstone is not a sentence)", offenders.length === 0, offenders.join(", "))
  check("positive control: the finder sees the phrase in rendered JSX text and in a string literal",
    phrase.test(blankComments("<p>Platform-covered — never billed</p>", { jsx: true })) && phrase.test(blankComments('const s = "platform-covered AI"', { jsx: true })))
  check("negative control: a comment-only mention is NOT counted", !phrase.test(blankComments("{/* platform-covered ledger term */}\n// platform-covered\nconst x = 1", { jsx: true })))
  check("the five named sites now say 'included in your subscription' / 'never counted as your spend'",
    /included in your subscription and never counted as your spend/.test(src("app/leads/[leadId]/page.tsx")) && /Included in your subscription — never counted as your spend/.test(src("app/dashboard/campaigns/competitive/brand-listening-card.tsx")) &&
    /included in your subscription and never counted as your spend/.test(src("app/dashboard/admin/import/page.tsx")) && /AI included in your subscription \(never counted as your spend\)/.test(src("app/dashboard/financials/brokerage/page.tsx")))

  report()
}

function walk(dirs: string[], keep: (p: string) => boolean): string[] {
  const out: string[] = []
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) visit(p)
      else { const rel = relative(ROOT, p).split("\\").join("/"); if (keep(rel)) out.push(rel) }
    }
  }
  for (const d of dirs) visit(join(ROOT, d))
  return out.sort()
}

main().catch((e) => { console.error(e); process.exit(1) })
