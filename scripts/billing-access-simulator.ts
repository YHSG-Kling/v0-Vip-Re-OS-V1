#!/usr/bin/env tsx
/**
 * scripts/billing-access-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANDS-OFF PAYWALL. A lapsed-trial / past-due / cancelled tenant is routed to
 * billing at login, so the money loop closes itself with no human in the loop —
 * while NEVER locking out a legacy / no-subscription account (fail-open). Also
 * proves pricing is NOT hardcoded in signup (subscription_tiers is the source of
 * truth, so a production price bump is a DB update, not a code change).
 *
 * Layer 1 (pure): resolveBillingAccess across every state (active / trialing-with-
 *   time-left / trial-expired / past_due / cancelled / no-sub / unknown).
 * Layer 2 (source): the login resolver has the paywall gate (blocked → billing,
 *   staff exempt, fail-open on error); the signup page loads subscription_tiers and
 *   the form renders priceByTier (no hardcoded "$99/$299/..." price strings).
 * Layer 3 (live, gated): seed a brokerage + a trialing subscription whose trial_end
 *   is in the PAST → loadBillingAccess is blocked/expired; flip to active → not
 *   blocked. Cleanup==0.
 *
 * Run: npx tsx scripts/billing-access-simulator.ts   (npm run test:billing-access)
 */
import { resolveBillingAccess, loadBillingAccess, mayUseAndAfford, isPaywalledPath, type BillingAccess } from "../lib/billing/billing-access"
import { PAST_DUE_GRACE_DAYS, DUNNING_LADDER } from "../lib/billing/dunning"
import { planLifecycleReminder, planTrialEnd, reminderCycle, sendSubscriptionReminder } from "../lib/billing/stripe-subscription-ops"
import { activeSubscriberBrokerageIds } from "../lib/lead-pipeline/subscription-gate"
import { stripComments, blankStrings } from "./strip-comments"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
  console.log(" ✅ Paywall verified — one fail-closed may-use-and-afford answer, grace + staff bypass kept, lifecycle once per cycle, prices DB-driven")
  console.log(" BILLING_ACCESS_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Billing access (hands-off paywall) simulator")
  console.log("══════════════════════════════════════════════════")

  const now = new Date("2026-07-06T00:00:00.000Z")
  const future = new Date("2026-07-20T00:00:00.000Z").toISOString()
  const past = new Date("2026-07-01T00:00:00.000Z").toISOString()

  console.log("\n[Layer 1 · pure access classifier]")
  check("active → NOT blocked", (() => { const a = resolveBillingAccess({ status: "active", trial_end: null }, now); return !a.blocked && a.state === "active" })())
  check("trialing with time left → NOT blocked, trialDaysLeft > 0",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: future }, now); return !a.blocked && (a.trialDaysLeft ?? 0) > 0 })())
  check("trialing but trial_end in the PAST → BLOCKED (expired) — the core enforcement",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: past }, now); return a.blocked && a.state === "expired" && a.trialDaysLeft === 0 })())
  // RE-ANCHORED (wave 99A, owner LAW: fail closed + past-due grace). The rule is
  // derived from PAST_DUE_GRACE_DAYS (dunning.ts — the day the ladder says
  // "access is restricted"), never a pinned number.
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
  check(`past_due INSIDE grace (${PAST_DUE_GRACE_DAYS - 1}d < ${PAST_DUE_GRACE_DAYS}d) → ALLOWED, grace days reported`,
    (() => { const a = resolveBillingAccess({ status: "past_due", trial_end: null, past_due_since: daysAgo(PAST_DUE_GRACE_DAYS - 1) }, now); return !a.blocked && a.state === "past_due" && a.reason === "past_due_in_grace" && a.graceDaysLeft === 1 })())
  check(`past_due AT/AFTER grace (${PAST_DUE_GRACE_DAYS}d) → BLOCKED`,
    (() => { const a = resolveBillingAccess({ status: "past_due", trial_end: null, past_due_since: daysAgo(PAST_DUE_GRACE_DAYS) }, now); return a.blocked && a.reason === "past_due_grace_elapsed" })())
  check("past_due with NO episode anchor → BLOCKED (its age is unknown — fail closed)",
    (() => { const a = resolveBillingAccess({ status: "past_due", trial_end: null }, now); return a.blocked && a.reason === "past_due_episode_unanchored" })())
  check("the dunning ladder's 'access is restricted' step fires AT the grace constant (one number, two readers)",
    DUNNING_LADDER.some((s) => s.afterDays === PAST_DUE_GRACE_DAYS && /restricted/i.test(s.subject)))
  check("cancelled / canceled → BLOCKED (expired)",
    resolveBillingAccess({ status: "cancelled", trial_end: null }, now).blocked && resolveBillingAccess({ status: "canceled", trial_end: null }, now).blocked)
  check("NO subscription row → REFUSED with its reason (fail closed — m692 backfills legacy tenants)",
    (() => { const a = resolveBillingAccess(null, now); return a.blocked && a.reason === "no_subscription" })())
  check("unknown status → REFUSED, the value named in the reason", (() => { const a = resolveBillingAccess({ status: "weird", trial_end: null }, now); return a.blocked && a.reason === "status_unknown_weird" })())

  // ── THE ROW THIS SUITE NEVER BUILT ─────────────────────────────────────────
  //
  // Every assertion above hands the classifier a `trial_end`. Layer 3 below
  // SEEDS one too. So the suite proved the classifier and never the WRITER —
  // and the writer was the defect: app/actions/auth/signup-brokerage.ts
  // inserted status='trialing' with `trial_end` LEFT NULL (it wrote
  // current_period_end and brokerages.trial_ends_at instead). trial_end's only
  // writers were the Stripe webhook — which needs a Stripe subscription signup
  // deliberately does not create — and the superadmin comp. So on a self-serve
  // signup the column was NULL, the expiry branch never ran, and a 14-day trial
  // never expired. 11 green checks reported a paywall that could not fire.
  //
  // This is the shape the classifier now has to answer for. It stays green two
  // ways and BOTH are asserted: signup writes trial_end at birth, and
  // loadBillingAccess reconciles a NULL against brokerages.trial_ends_at.
  console.log("\n[Layer 1b · the row SIGNUP writes, not the row this test writes]")
  check("trialing with NO trial_end is REFUSED (trial_end_unknown — an indefinite trial nobody granted)",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: null }, now); return a.blocked && a.reason === "trial_end_unknown" })(),
    "wave 99A: the pure layer fails closed; the RECONCILIATION below supplies the deadline")
  check("…so the reconciled value is what decides: a past tenant trial_ends_at BLOCKS",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: past }, now); return a.blocked && a.state === "expired" })())

  // RE-ANCHORED (lane 77B): the trial row is written by the ONE tenant-creation
  // core (lib/kernel/tenant-creation.ts — buildSubscriptionRow + the counted
  // insert), which the self-serve signup delegates to. The RULE is unchanged:
  // the trial row carries trial_end, and the insert error is READ.
  const coreSrc = readFileSync(join(process.cwd(), "lib/kernel/tenant-creation.ts"), "utf8")
  const signupSrc = readFileSync(join(process.cwd(), "app/actions/auth/signup-brokerage.ts"), "utf8")
  check("the tenant-creation core WRITES subscriptions.trial_end on the trial row (the missing writer)",
    /trial_end:\s*end,/.test(coreSrc) && /from\("subscriptions"\)\.insert\(subscriptionRow\)/.test(coreSrc),
    "the core inserted status='trialing' with trial_end NULL — the paywall reads that column")
  check("the core READS the subscription insert error (§3 — supabase-js resolves refusals)",
    /const \{ data: subscription, error: subErr \}[\s\S]{0,400}?if \(subErr \|\| !subscription\)/.test(coreSrc))
  check("self-serve signup reaches that writer through the core (createTenantCore with billing mode 'trial')",
    /createTenantCore\(service, \{[\s\S]{0,800}?billing,/.test(signupSrc)
    && /\{ mode: "trial" as const, trialDays: TRIAL_DAYS \}/.test(signupSrc))

  const accessSrc = readFileSync(join(process.cwd(), "lib/billing/billing-access.ts"), "utf8")
  check("loadBillingAccess reconciles trial_end against brokerages.trial_ends_at (same rule as subscription-oversight.ts:155)",
    /trial_ends_at/.test(accessSrc) && /sub\.trial_end \?\? tenantTrialEnd/.test(accessSrc))
  check("…and a REFUSED brokerages read does not invent a trial end",
    /brkRes\?\.error[\s\S]{0,120}?\? null/.test(accessSrc))
  // POSITIVE CONTROL — the three source greps above must be able to go RED.
  check("↺ control: the source scan can tell a written trial_end from an absent one",
    !/trial_end:\s*end,/.test(
      `return { brokerage_id: b, status: "trialing", current_period_end: end, created_at: nowIso }`),
    "the regex matched a row that has NO trial_end — it proves nothing")

  // ── Layer 1c · THE ONE RESOLVER: mayUseAndAfford (wave 99A, LAW 2) ─────────
  console.log("\n[Layer 1c · mayUseAndAfford — fail closed, staff bypass, grace by capability]")
  // A fake supabase-js client: every chain method returns the builder; awaiting it
  // (or maybeSingle/single) resolves the table's canned { data, error }.
  function fakeSvc(tables: Record<string, { data: unknown; error: { message: string } | null }>) {
    return {
      from(table: string) {
        const res = tables[table] ?? { data: null, error: null }
        const api: any = {}
        for (const m of ["select", "eq", "in", "not", "order", "limit", "gte", "update", "insert"]) api[m] = () => api
        api.maybeSingle = async () => res
        api.single = async () => res
        api.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, ko)
        return api
      },
    }
  }
  const viaAccess = (a: BillingAccess) => ({ loadAccess: async () => a })
  {
    const refused = await loadBillingAccess(fakeSvc({ subscriptions: { data: null, error: { message: "permission denied" } } }), "b1", now)
    check("a subscriptions READ ERROR is REFUSED with the error named (never read as 'no row → let in')",
      refused.blocked && /^subscription_read_refused: permission denied/.test(refused.reason), JSON.stringify(refused))
    const v = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", client: fakeSvc({ subscriptions: { data: null, error: { message: "timeout" } } }), now })
    check("…and the resolver carries that refusal: allowed=false", !v.allowed && /subscription_read_refused/.test(v.reason))
    const none = await loadBillingAccess(fakeSvc({ subscriptions: { data: null, error: null } }), "b1", now)
    check("NO subscription row (a clean read that found nothing) → REFUSED 'no_subscription'", none.blocked && none.reason === "no_subscription")
    const anchored = await loadBillingAccess(fakeSvc({
      subscriptions: { data: { status: "past_due", trial_end: null, updated_at: daysAgo(30) }, error: null },
      brokerages: { data: { trial_ends_at: null, plan_tier: "team" }, error: null },
      billing_invoices: { data: [{ invoice_date: daysAgo(2), due_date: daysAgo(2) }], error: null },
    }), "b1", now)
    check("loadBillingAccess ages past_due from dunning's episodeAnchor (oldest open invoice), not the row's updated_at",
      !anchored.blocked && anchored.reason === "past_due_in_grace" && anchored.planTier === "team", JSON.stringify(anchored))
    const invRefused = await loadBillingAccess(fakeSvc({
      subscriptions: { data: { status: "past_due", trial_end: null, updated_at: daysAgo(1) }, error: null },
      billing_invoices: { data: null, error: { message: "denied" } },
    }), "b1", now)
    check("…a REFUSED invoice read leaves the episode unanchored → REFUSED", invRefused.blocked && invRefused.reason === "past_due_episode_unanchored")

    const staff = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", actor: { platformRole: "support" }, now,
      deps: { loadAccess: async () => { throw new Error("must not be asked") } } })
    check("platform staff (users.platform_role) are ALLOWED without a subscription read", staff.allowed && staff.reason === "platform_staff")
    const notStaff = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", actor: { platformRole: null, userType: "agent" }, now,
      deps: { loadAccess: async () => { throw new Error("read blew up") } } })
    check("↺ control: the same call for a tenant user DOES read, and a thrown read REFUSES",
      !notStaff.allowed && /^access_check_threw/.test(notStaff.reason))
    const unknownCap = await mayUseAndAfford({ brokerageId: "b1", capability: "teleport", now, deps: viaAccess(resolveBillingAccess({ status: "active", trial_end: null }, now)) })
    check("an UNKNOWN capability is REFUSED by name", !unknownCap.allowed && unknownCap.reason === "unknown_capability:teleport")
    const noTenant = await mayUseAndAfford({ brokerageId: null, capability: "app.access", now })
    check("no tenant (and not staff) is REFUSED — the tenant comes from the session, never assumed", !noTenant.allowed && noTenant.reason === "no_tenant")

    const trial = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", now, deps: viaAccess(resolveBillingAccess({ status: "trialing", trial_end: future }, now)) })
    check("a trial IN WINDOW is ALLOWED, days left reported in the plan", trial.allowed && (trial.plan?.trialDaysLeft ?? 0) > 0)
    const expired = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", now, deps: viaAccess(resolveBillingAccess({ status: "trialing", trial_end: past }, now)) })
    check("an EXPIRED trial is REFUSED", !expired.allowed && expired.reason === "trial_expired")
    const graceAccess = resolveBillingAccess({ status: "past_due", trial_end: null, past_due_since: daysAgo(2) }, now)
    const graceApp = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", now, deps: viaAccess(graceAccess) })
    const graceScrape = await mayUseAndAfford({ brokerageId: "b1", capability: "lead.scrape", now, deps: viaAccess(graceAccess) })
    check("past_due WITHIN grace: app.access ALLOWED, lead.scrape REFUSED (platform spend never served unpaid — pre-99A rule kept)",
      graceApp.allowed && graceApp.reason === "past_due_in_grace" && !graceScrape.allowed && graceScrape.reason === "past_due_not_served:lead.scrape")
    const afterGrace = await mayUseAndAfford({ brokerageId: "b1", capability: "app.access", now, deps: viaAccess(resolveBillingAccess({ status: "past_due", trial_end: null, past_due_since: daysAgo(PAST_DUE_GRACE_DAYS + 3) }, now)) })
    check("past_due AFTER grace is REFUSED", !afterGrace.allowed && afterGrace.reason === "past_due_grace_elapsed")
    const notice = await mayUseAndAfford({ brokerageId: "b1", capability: "billing.notice", now, deps: { loadAccess: async () => { throw new Error("must not be asked") } } })
    check("billing.notice reaches a lapsed tenant (access-exempt — the reminder that says how to pay)", notice.allowed && notice.reason === "access_exempt")
    const active = resolveBillingAccess({ status: "active", trial_end: null }, now)
    const aiOut = await mayUseAndAfford({ brokerageId: "b1", capability: "ai.generate", estTokens: 500, now,
      deps: { ...viaAccess(active), aiBudget: async () => ({ allowed: false, tokensUsed: 1000, tokensLimit: 1000, message: "cap" }) } })
    const aiIn = await mayUseAndAfford({ brokerageId: "b1", capability: "ai.generate", estTokens: 500, now,
      deps: { ...viaAccess(active), aiBudget: async () => ({ allowed: true, tokensUsed: 200, tokensLimit: 1000 }) } })
    check("ai.generate: the AFFORD half refuses at the cap and reports remainingBudget otherwise",
      !aiOut.allowed && aiOut.reason === "ai_budget_exhausted" && aiOut.remainingBudget === 0 && aiIn.allowed && aiIn.remainingBudget === 800)
    const spendLapsed = await mayUseAndAfford({ brokerageId: "b1", capability: "comms.send", estCostUsd: 0.01, now,
      deps: { ...viaAccess(resolveBillingAccess({ status: "cancelled", trial_end: null }, now)), vendorBudget: async () => { throw new Error("budget must not be asked when access is refused") } } })
    check("comms.send on a cancelled tenant is refused on ACCESS before any budget read", !spendLapsed.allowed && spendLapsed.reason === "status_cancelled")
    const degraded = await mayUseAndAfford({ brokerageId: "b1", capability: "comms.send", estCostUsd: 0.01, now,
      deps: { ...viaAccess(active), vendorBudget: async () => ({ allowed: true, spent: 0, budget: 50, softWarning: false, degraded: true }) } })
    check("the vendor-budget half keeps its DOCUMENTED fail-open contract, surfaced as budgetDegraded", degraded.allowed && degraded.budgetDegraded === true)

    // ── wave 100 (lane 100C — 99A open item 3): the PLAN-FEATURE half, composed as capability "feature.use".
    const seen: Array<{ u: string; k: string; c: unknown }> = []
    const sessionClient = { tag: "session-client" }
    const featOk = await mayUseAndAfford({ brokerageId: "b1", capability: "feature.use", now, feature: { userId: "u1", featureKey: "direct_mail", client: sessionClient },
      deps: { ...viaAccess(active), featureAccess: async (u, k, _t, c) => { seen.push({ u, k, c }); return { allowed: true, limit: 10, used: 2 } } } })
    check("feature.use: subscription current + canAccessFeature allows → allowed, the verdict rides back, and the gate read through the CALLER'S client (the session seam)",
      featOk.allowed && featOk.reason === "subscription_current" && (featOk.feature as any)?.used === 2 && seen.length === 1 && seen[0].c === sessionClient && seen[0].k === "direct_mail")
    const featNo = await mayUseAndAfford({ brokerageId: "b1", capability: "feature.use", now, feature: { userId: "u1", featureKey: "direct_mail" },
      deps: { ...viaAccess(active), featureAccess: async () => ({ allowed: false, reason: "Not on your plan" }) } })
    check("feature.use: a feature refusal refuses, names the feature, and carries the gate's own message",
      !featNo.allowed && featNo.reason === "feature_refused:direct_mail" && featNo.message === "Not on your plan")
    const featLapsed = await mayUseAndAfford({ brokerageId: "b1", capability: "feature.use", now, feature: { userId: "u1", featureKey: "direct_mail" },
      deps: { ...viaAccess(resolveBillingAccess({ status: "cancelled", trial_end: null }, now)), featureAccess: async () => { throw new Error("feature gate must not be asked when access is refused") } } })
    check("feature.use: a LAPSED tenant is refused on access BEFORE the feature gate runs (the gap the bare canAccessFeature call left open)",
      !featLapsed.allowed && featLapsed.reason === "status_cancelled")
    const featThrew = await mayUseAndAfford({ brokerageId: "b1", capability: "feature.use", now, feature: { userId: "u1", featureKey: "x" },
      deps: { ...viaAccess(active), featureAccess: async () => { throw new Error("flag read refused") } } })
    const featNone = await mayUseAndAfford({ brokerageId: "b1", capability: "feature.use", now, deps: { ...viaAccess(active), featureAccess: async () => ({ allowed: true }) } })
    check("feature.use FAILS CLOSED: a gate that threw refuses (feature_check_threw), and no feature named refuses (feature_unspecified) even when the gate would allow (positive control)",
      !featThrew.allowed && /^feature_check_threw/.test(featThrew.reason) && !featNone.allowed && featNone.reason === "feature_unspecified")
    const mk = stripComments(readFileSync(join(process.cwd(), "lib/kernel/marketing.ts"), "utf8"))
    check("WIRED: the direct-mail creator asks mayUseAndAfford(feature.use) with its client seam — the bare canAccessFeature(…\"direct_mail\"…) call is gone (tombstoned)",
      /capability: "feature\.use",\s*feature: \{ userId: actorUserId, featureKey: "direct_mail", client: featureClient \}/.test(mk) && !/await canAccessFeature\(actorUserId, "direct_mail"/.test(mk))
    check("POSITIVE CONTROL: the bare-call finder flags the pre-100C spelling",
      /await canAccessFeature\(actorUserId, "direct_mail"/.test(`const access = await canAccessFeature(actorUserId, "direct_mail", undefined, featureClient)`))

    // ── wave 101C: EVERY plan-feature gate rides feature.use — mayUseFeature is its call-site form.
    {
      const fakeSvc = (users: Record<string, { brokerage_id: string | null; user_type: string | null; platform_role: string | null }>, refuse = false) => ({
        from: (_t: string) => {
          let id = ""
          const q: any = { select: () => q, eq: (_c: string, v: string) => { id = v; return q },
            maybeSingle: async () => refuse ? { data: null, error: { message: "users read refused" } } : { data: users[id] ?? null, error: null } }
          return q
        },
      })
      const users = { u1: { brokerage_id: "b1", user_type: "agent", platform_role: null }, staff: { brokerage_id: null, user_type: "agent", platform_role: "superadmin" } }
      const asked: Array<{ b: string; u: string; c: unknown }> = []
      const gate = async (u: string, _k: string, _t: string | undefined, c: unknown) => { asked.push({ b: "", u, c }); return { allowed: true, usage: { current: 2, limit: 10, remaining: 8 } } }
      const sessionClient = { tag: "session" }
      const loadSeen: string[] = []
      const viaAccessFor = (a: BillingAccess) => ({ loadAccess: async (_s: unknown, b: string) => { loadSeen.push(b); return a } })
      const { mayUseFeature } = await import("../lib/billing/billing-access")
      const ok = await mayUseFeature("u1", "direct_mail", { client: sessionClient, now, deps: { service: fakeSvc(users), ...viaAccessFor(active), featureAccess: gate } })
      check("mayUseFeature: the TENANT is read off the verified user's own row, the subscription half runs on it, and the plan-feature half reads through the SESSION client — the verdict's usage rides back",
        ok.allowed && loadSeen[0] === "b1" && asked[0]?.c === sessionClient && ok.usage?.remaining === 8 && ok.decision.reason === "subscription_current")
      loadSeen.length = 0; asked.length = 0
      const lapsed = await mayUseFeature("u1", "direct_mail", { now, deps: { service: fakeSvc(users), ...viaAccessFor(resolveBillingAccess({ status: "cancelled", trial_end: null }, now)), featureAccess: gate } })
      check("mayUseFeature: a LAPSED tenant is refused before the feature gate is asked, with human copy (not a machine reason) for the surface",
        !lapsed.allowed && asked.length === 0 && lapsed.decision.reason === "status_cancelled" && /subscription is not active/i.test(lapsed.reason ?? ""))
      loadSeen.length = 0
      const tenantRail = await mayUseFeature("b9", "competitor_monitor", { now, deps: { service: fakeSvc(users), ...viaAccessFor(active), featureAccess: gate } })
      check("mayUseFeature: a tenant-gated rail (a brokerages.id with no users row) is judged as THAT tenant — canAccessFeature's own tenant-id fallback, mirrored",
        tenantRail.allowed && loadSeen[0] === "b9")
      const refused = await mayUseFeature("u1", "direct_mail", { now, deps: { service: fakeSvc(users, true), ...viaAccessFor(active), featureAccess: gate } })
      check("mayUseFeature FAILS CLOSED: a refused users read refuses (never 'no row, let them in')", !refused.allowed && /^user_read_refused/.test(refused.decision.reason))
      const featRefused = await mayUseFeature("u1", "x", { now, deps: { service: fakeSvc(users), ...viaAccessFor(active), featureAccess: async () => ({ allowed: false, reason: "Upgrade to Team" }) } })
      check("mayUseFeature: a plan-feature refusal keeps the gate's own message", !featRefused.allowed && featRefused.reason === "Upgrade to Team")
      loadSeen.length = 0
      const staff = await mayUseFeature("staff", "x", { now, deps: { service: fakeSvc(users), ...viaAccessFor(active), featureAccess: gate } })
      check("mayUseFeature: platform staff with no tenant keep the resolver's access bypass (the subscription half is never read)", staff.allowed && loadSeen.length === 0)

      // THE CENSUS: no plan-feature gate asks canAccessFeature directly — only the resolver does.
      const { readdirSync, statSync } = await import("node:fs")
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of readdirSync(join(process.cwd(), dir))) {
          const rel = `${dir}/${e}`
          if (e === "node_modules" || e.startsWith(".")) continue
          if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
          else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
        }
        return out
      }
      const OWNERS = new Set(["lib/billing/billing-access.ts", "lib/kernel/0.1-feature-access.ts"])
      const bareCall = /(?<![\w.])canAccessFeature\s*\(|\)\.canAccessFeature\s*\(/
      const files = [...walk("app"), ...walk("lib")]
      const direct = files.filter((rel) => !OWNERS.has(rel) && bareCall.test(blankStrings(stripComments(readFileSync(join(process.cwd(), rel), "utf8")))))
      const routed = files.filter((rel) => /\bmayUseFeature\s*\(/.test(blankStrings(stripComments(readFileSync(join(process.cwd(), rel), "utf8"))))).length
      console.log(`  · census: ${direct.length} module(s) call canAccessFeature directly outside the resolver; ${routed} module(s) gate through mayUseFeature (wave 101C base e0b0a3c8c: 27 modules / 68 call sites direct). Denominator: ${files.length} .ts/.tsx under app/ + lib/`)
      check("EVERY plan-feature gate rides mayUseAndAfford(feature.use) — no direct canAccessFeature call outside the resolver", direct.length === 0, direct.join(", "))
      check("POSITIVE CONTROL: the census flags the pre-101C call shape, and not a type-only use", bareCall.test(`const access = await canAccessFeature(userId, "ad_creator")`) && !bareCall.test(`type C = Parameters<typeof canAccessFeature>[3]`))
      check("the census ran over a non-trivial tree, and gates were found routed", files.length > 1000 && routed >= 20, `${files.length} files / ${routed} routed`)
      const progress = stripComments(readFileSync(join(process.cwd(), "app/dashboard/onboarding/progress/page.tsx"), "utf8"))
      check("onboarding/progress: the swapped-argument gate whose OBJECT was tested for truthiness is gone — the session user, the feature key, and `.allowed`",
        /mayUseFeature\(user\.id, "training_progress"/.test(progress) && /if \(!access\.allowed\)/.test(progress) && !/canAccessFeature\("training_progress"/.test(progress))

      // ── wave 102C (owner answer 1): EVERY feature key the code gates has a ROW IT CAN BE CHECKED AGAINST.
      // A key with no feature_flags row is refused for everyone ("Feature does not exist", resolve.ts) —
      // ai_listing_generation / ai_social_content were exactly that until m699. The row names are DERIVED
      // from the seed writers (every `INSERT INTO feature_flags` under supabase/migrations + scripts) plus
      // the dated live snapshot in scripts/marketing-system-claim-simulator.ts; the gated keys are the
      // `mayUseFeature(…, "<key>")` literals on stripped source (strings kept — the key IS the literal).
      const sqlUnder = (dir: string) => readdirSync(join(process.cwd(), dir)).filter((f) => f.endsWith(".sql")).map((f) => `${dir}/${f}`)
      const seedFiles = [...sqlUnder("supabase/migrations"), ...sqlUnder("scripts")]
        .filter((rel) => /INSERT INTO feature_flags/i.test(readFileSync(join(process.cwd(), rel), "utf8")))
      const seededKeys = new Set<string>()
      for (const rel of seedFiles) {
        const sql = readFileSync(join(process.cwd(), rel), "utf8").replace(/--[^\n]*/g, "")
        for (const m of sql.matchAll(/\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'[^']*'\s*,\s*'[^']*'/g)) seededKeys.add(m[1])
      }
      const snapshotSrc = readFileSync(join(process.cwd(), "scripts/marketing-system-claim-simulator.ts"), "utf8")
      const snapshotBlock = /LIVE_FEATURE_KEYS_\d+\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(snapshotSrc)?.[1] ?? ""
      for (const m of snapshotBlock.matchAll(/"([a-z][a-z0-9_]*)"/g)) seededKeys.add(m[1])
      const gated = new Map<string, string[]>()
      for (const rel of files) {
        const s = stripComments(readFileSync(join(process.cwd(), rel), "utf8"))
        for (const m of s.matchAll(/\bmayUseFeature\s*\([^,()]+,\s*"([a-z][a-z0-9_]*)"/g)) gated.set(m[1], [...(gated.get(m[1]) ?? []), rel])
      }
      const rowless = [...gated.keys()].filter((k) => !seededKeys.has(k)).sort()
      console.log(`  · census: ${gated.size} distinct feature keys gated by literal across ${[...gated.values()].flat().length} call sites; ${seededKeys.size} row names from ${seedFiles.length} seed file(s) + the dated snapshot. Blind spot: a key passed as a VARIABLE is not a literal and is not counted; the snapshot is dated, the seeds are files (the seed rows exist live only once their migration is applied — m699 was applied 2026-10-05).`)
      check("EVERY gated feature key (mayUseFeature literal) has a seed / row name it can be checked against", rowless.length === 0, `rowless: ${rowless.join(", ")}`)
      check("POSITIVE CONTROL: the census would flag a gate on a key no seed names", !seededKeys.has("no_such_feature_key_102c") && /\bmayUseFeature\s*\([^,()]+,\s*"([a-z][a-z0-9_]*)"/.exec(`await mayUseFeature(user.id, "no_such_feature_key_102c")`)?.[1] === "no_such_feature_key_102c")
      check("m699 seeds ai_listing_generation + ai_social_content and both are gated in the content action (the finder saw them, the seed names them)",
        ["ai_listing_generation", "ai_social_content"].every((k) => gated.get(k)?.includes("app/actions/ai-content-generation.tsx") && seedFiles.some((rel) => /m699/.test(rel) && readFileSync(join(process.cwd(), rel), "utf8").includes(`'${k}'`))))
      const m699 = seedFiles.find((rel) => /m699/.test(rel))
      const m699Sql = m699 ? readFileSync(join(process.cwd(), m699), "utf8") : ""
      // CLAUDE.md §2: the status line is a RULE (exactly one provenance stamp — the lane's "WRITTEN,
      // NOT APPLIED" or the integrator's "APPLIED LIVE <date>"), never a pin on the pre-apply waypoint.
      check("m699 mirrors the live ai_content_generation row (SELECT … FROM feature_flags t WHERE t.feature_key = 'ai_content_generation'), is idempotent (NOT EXISTS + ON CONFLICT DO NOTHING) and line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)",
        /FROM feature_flags t[\s\S]*t\.feature_key = 'ai_content_generation'/.test(m699Sql) && /WHERE NOT EXISTS/.test(m699Sql) && /ON CONFLICT \(feature_key\) DO NOTHING/.test(m699Sql) && /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(m699Sql))
    }

    // ── wave 100 (lane 100C — 99A open item 2): dunning recipients come from THE roster.
    const dun = blankStrings(stripComments(readFileSync(join(process.cwd(), "lib/billing/dunning.ts"), "utf8")))
    const dunKeep = stripComments(readFileSync(join(process.cwd(), "lib/billing/dunning.ts"), "utf8"))
    check("dunning in-app recipients spread TENANT_COMMERCE_ADMIN_USER_TYPES (lib/auth/resolve-user-role.ts) — no retyped role literal",
      /\.in\("user_type", \[\.\.\.TENANT_COMMERCE_ADMIN_USER_TYPES\]\)/.test(dunKeep) && !/\.in\(\s*"user_type"\s*,\s*\[\s*"broker"/.test(dunKeep) && dun.length > 0)
    check("POSITIVE CONTROL: the retyped-roster finder flags the pre-100C literal",
      /\.in\(\s*"user_type"\s*,\s*\[\s*"broker"/.test(`.in("user_type", ["broker", "admin"]).limit(20)`))
    const { TENANT_COMMERCE_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")
    check("the roster reaches every billing owner (broker_owner, broker_admin) and excludes compliance_officer (reads the books, never pays)",
      TENANT_COMMERCE_ADMIN_USER_TYPES.has("broker_owner") && TENANT_COMMERCE_ADMIN_USER_TYPES.has("broker_admin") && !TENANT_COMMERCE_ADMIN_USER_TYPES.has("compliance_officer"))

    check("request boundary: /dashboard/** is paywalled, the billing / onboarding / staff doors are not, /portal is not this gate",
      isPaywalledPath("/dashboard") && isPaywalledPath("/dashboard/agent/leads") && !isPaywalledPath("/dashboard/admin/billing")
      && !isPaywalledPath("/dashboard/admin/billing/invoices") && isPaywalledPath("/dashboard/admin/billingx")
      && !isPaywalledPath("/dashboard/onboarding/setup") && !isPaywalledPath("/dashboard/superadmin/home") && !isPaywalledPath("/portal"))

    const scrapeIds = activeSubscriberBrokerageIds([
      { brokerage_id: "live", status: "trialing", trial_end: future },
      { brokerage_id: "lapsed", status: "trialing", trial_end: past },
      { brokerage_id: "due", status: "past_due", trial_end: null },
      { brokerage_id: "paying", status: "active", trial_end: null },
    ], now)
    check("lead-scrape gate (delegated): an EXPIRED trial is no longer scraped; in-window trial + active are; past_due is not",
      scrapeIds.has("live") && scrapeIds.has("paying") && !scrapeIds.has("lapsed") && !scrapeIds.has("due"), [...scrapeIds].join(","))
  }

  // ── Layer 1d · TRIAL / RENEWAL LIFECYCLE (pure plans + once-per-cycle reminder) ──
  console.log("\n[Layer 1d · trial/renewal lifecycle]")
  {
    const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString()
    const t2 = planLifecycleReminder({ status: "trialing", trial_end: inDays(2), current_period_end: null, cancel_at: null, stripe_subscription_id: null }, now)
    const t5 = planLifecycleReminder({ status: "trialing", trial_end: inDays(5), current_period_end: null, cancel_at: null, stripe_subscription_id: null }, now)
    const tFallback = planLifecycleReminder({ status: "trialing", trial_end: null, current_period_end: null, cancel_at: null, stripe_subscription_id: null }, now, inDays(1))
    check("trial reminder is due inside the 3-day window (Stripe's trial_will_end lead), not before; tenant trial_ends_at fallback honoured",
      t2?.kind === "trial_end" && t2.cycle === reminderCycle("trial_end", inDays(2)) && t5 === null && tFallback?.kind === "trial_end")
    const r6 = planLifecycleReminder({ status: "active", trial_end: null, current_period_end: inDays(6), cancel_at: null, stripe_subscription_id: "sub_x" }, now)
    const rCancel = planLifecycleReminder({ status: "active", trial_end: null, current_period_end: inDays(6), cancel_at: inDays(6), stripe_subscription_id: "sub_x" }, now)
    const rLocal = planLifecycleReminder({ status: "active", trial_end: null, current_period_end: inDays(6), cancel_at: null, stripe_subscription_id: null }, now)
    check("renewal reminder: due 7 days out on a Stripe-linked renewing subscription; none when cancelling or not Stripe-linked (no charge coming)",
      r6?.kind === "renewal" && rCancel === null && rLocal === null)
    check("trial end plan: Stripe-linked → defer to Stripe; local + card → convert; local, no card → expire; running trial → none",
      planTrialEnd({ trialEnded: true, stripeLinked: true, hasPaymentMethod: false }) === "defer_to_stripe"
      && planTrialEnd({ trialEnded: true, stripeLinked: false, hasPaymentMethod: true }) === "convert"
      && planTrialEnd({ trialEnded: true, stripeLinked: false, hasPaymentMethod: false }) === "expire"
      && planTrialEnd({ trialEnded: false, stripeLinked: false, hasPaymentMethod: false }) === "none")

    // ONCE PER CYCLE — driven through the REAL withActionLedger against a fake ledger
    // that enforces the unique idempotency_key exactly as agent_action_ledger does (23505).
    const { withActionLedger } = await import("../lib/kernel/action-ledger")
    const ledger = new Map<string, { id: string; status: string; attempts: number; outcome: string | null; provider: string | null; provider_ref: string | null; idempotency_key: string }>()
    let seq = 0
    const ledgerClient = {
      from(_t: string) {
        let op: "insert" | "update" | "select" | null = null
        let payload: Record<string, any> = {}
        const filters: Record<string, unknown> = {}
        const exec = () => {
          if (op === "insert") {
            const key = payload.idempotency_key as string
            if (key && ledger.has(key)) return { data: null, error: { code: "23505", message: "duplicate key" } }
            const row = { id: `L${++seq}`, status: payload.status, attempts: 1, outcome: null, provider: null, provider_ref: null, idempotency_key: key }
            if (key) ledger.set(key, row)
            return { data: { id: row.id }, error: null }
          }
          if (op === "update") {
            const row = [...ledger.values()].find((r) => r.id === filters.id)
            if (row) Object.assign(row, payload)
            return { data: row ? [{ id: row.id }] : [], error: null }
          }
          const row = ledger.get(filters.idempotency_key as string) ?? null
          return { data: row, error: null }
        }
        const api: any = {
          insert(p: Record<string, any>) { op = "insert"; payload = p; return api },
          update(p: Record<string, any>) { op = "update"; payload = p; return api },
          select() { if (!op) op = "select"; return api },
          eq(k: string, v: unknown) { filters[k] = v; return api },
          single: async () => exec(), maybeSingle: async () => exec(),
          then(ok: (v: unknown) => unknown) { return Promise.resolve(exec()).then(ok) },
        }
        return api
      },
    }
    const providerCalls: string[] = []
    // The dispatchEmail ledger context, as lib/providers/dispatch.ts ledgerContextFor builds it
    // from params.ledger (subject + cycle) — asserted against the source just below.
    const send = (p: any) => withActionLedger(
      { brokerageId: p.brokerageId, action: "comms.email.send", channel: "email", actor: { type: "system" }, subject: p.ledger.subject, cycle: p.ledger.cycle, reasonCode: p.ledger.reasonCode },
      async () => { providerCalls.push(p.to); return { success: true, providerKey: "sendgrid" } },
      { settle: () => ({ status: "executed" as const, outcome: "sent", provider: "sendgrid" }),
        replay: (c) => ({ success: c.kind === "replay", providerKey: "action_ledger" }) },
      { client: ledgerClient },
    )
    const emitted: string[] = []
    const svc = fakeSvc({
      users: { data: [{ id: "u1", email: "owner@wave99.test" }, { id: "u2", email: "admin@wave99.test" }], error: null },
      brokerages: { data: { name: "W99 Realty" }, error: null },
    })
    const plan = planLifecycleReminder({ status: "trialing", trial_end: inDays(2), current_period_end: null, cancel_at: null, stripe_subscription_id: null }, now)!
    const deps = { send, emit: async (e: { dedupeKey: string }) => { emitted.push(e.dedupeKey) } }
    const first = await sendSubscriptionReminder(svc, { id: "sub-1", brokerage_id: "b1" }, plan, deps)
    const second = await sendSubscriptionReminder(svc, { id: "sub-1", brokerage_id: "b1" }, plan, deps)
    check("the trial reminder reaches the PROVIDER once per recipient per cycle — a second sweep/webhook in the same cycle replays from the ledger",
      first.attempted === 2 && providerCalls.length === 2 && second.attempted === 2 && providerCalls.length === 2, `provider calls ${providerCalls.length}`)
    const nextCycle = { ...plan, cycle: reminderCycle("trial_end", inDays(9)), aboutIso: inDays(9) }
    await sendSubscriptionReminder(svc, { id: "sub-1", brokerage_id: "b1" }, nextCycle, deps)
    check("↺ control: a NEW cycle (an extended trial end) sends again — the dedupe is per cycle, not forever",
      providerCalls.length === 4, `provider calls ${providerCalls.length}`)
    check("the reminder event is deduped on the cycle key", emitted.length >= 1 && emitted.every((k) => k.startsWith("trial_end:")))
    const dispatchCode = stripComments(readFileSync(join(process.cwd(), "lib/providers/dispatch.ts"), "utf8"))
    check("dispatchEmail's ledger context takes subject + cycle from params.ledger (what the replay above relies on)",
      /subject = params\.ledger\?\.subject/.test(dispatchCode) && /cycle: params\.ledger\?\.cycle \?\? null/.test(dispatchCode))
  }

  // ── Layer 1e · THE DUPLICATE CHECKS NOW DELEGATE (stripped source — a tombstone is not a call site) ──
  console.log("\n[Layer 1e · delegation to the one resolver]")
  {
    const code = (p: string) => blankStrings(stripComments(readFileSync(join(process.cwd(), p), "utf8")))
    const count = (src: string, token: string) => src.split(token).length - 1
    const models = code("lib/ai/models.ts")
    check("lib/ai/models.ts: NO direct checkAIFairUse( call left; the four entry points + the helper use affordAI(",
      count(models, "checkAIFairUse(") === 0 && count(models, "affordAI(") === 5 && /mayUseAndAfford\(\{ brokerageId, capability: "ai\.generate"/.test(stripComments(readFileSync(join(process.cwd(), "lib/ai/models.ts"), "utf8"))),
      `checkAIFairUse(=${count(models, "checkAIFairUse(")} affordAI(=${count(models, "affordAI(")}`)
    check("↺ control: the counter sees a live call in a specimen", count(blankStrings(stripComments("// checkAIFairUse(\nconst x = await checkAIFairUse({})")), "checkAIFairUse(") === 1)
    const dispatchRaw = stripComments(readFileSync(join(process.cwd(), "lib/providers/dispatch.ts"), "utf8"))
    const pre = dispatchRaw.slice(dispatchRaw.indexOf("async function vendorBudgetPreflight"), dispatchRaw.indexOf("async function recordBudgetLedgerEvent"))
    check("dispatch egress pre-flight asks mayUseAndAfford (comms.send / billing.notice) and no longer calls checkVendorBudget( itself",
      /mayUseAndAfford\(/.test(pre) && /"billing\.notice" : "comms\.send"/.test(pre) && count(pre, "checkVendorBudget(") === 0 && pre.length > 0)
    check("…and an access refusal is a billing_gate refusal, while a throw of the access check REFUSES (fail closed)",
      /providerKey: "billing_gate", error: `Outbound blocked: subscription access could not be checked/.test(pre))
    const gate = code("lib/lead-pipeline/subscription-gate.ts")
    check("lead-pipeline subscription gate delegates to resolveBillingAccess under PAID_CAPABILITIES['lead.scrape']",
      /resolveBillingAccess\(/.test(gate) && /PAID_CAPABILITIES\[/.test(gate))
    const proxyCode = stripComments(readFileSync(join(process.cwd(), "proxy.ts"), "utf8"))
    check("proxy.ts enforces the resolver at the request boundary for the SESSION user (user.id), and a throw refuses",
      /if \(isPaywalledPath\(pathname\)\)/.test(proxyCode) && /resolveRequestAccess\(createServiceClient\(\), user\.id\)/.test(proxyCode)
      && /reason: `paywall_threw`/.test(proxyCode)
      && proxyCode.indexOf("resolveRequestAccess(") > proxyCode.indexOf("supabase.auth.getUser()"))
    const cron = stripComments(readFileSync(join(process.cwd(), "app/api/cron/billing-dunning/route.ts"), "utf8"))
    check("the lifecycle sweep rides the EXISTING billing-dunning cron, after the Stripe reconcile",
      cron.indexOf("runSubscriptionLifecycleSweep(svc)") > cron.indexOf("reconcileSubscriptionsFromStripe(svc)") && cron.indexOf("reconcileSubscriptionsFromStripe(svc)") > 0)
    const wh = stripComments(readFileSync(join(process.cwd(), "app/api/billing/webhook/route.ts"), "utf8"))
    check("the webhook handles customer.subscription.trial_will_end through the SAME reminder sender, and emits every status transition",
      /case "customer\.subscription\.trial_will_end":/.test(wh) && /sendSubscriptionReminder\(supabase,/.test(wh) && count(wh, "emitWebhookTransition(") >= 4)
    const seatSync = stripComments(readFileSync(join(process.cwd(), "lib/billing/seat-sync.ts"), "utf8"))
    check("the daily Stripe reconcile (seat-sync survivor) now mirrors STATUS through toStoredSubscriptionStatus",
      /toStoredSubscriptionStatus\(r\.sub\?\.status\)/.test(seatSync) && /onStatusChange\(/.test(seatSync))
  }

  console.log("\n[Layer 2 · gate + de-hardcoded pricing wiring]")
  const onboardingSrc = readFileSync(join(process.cwd(), "lib/kernel/onboarding.ts"), "utf8")
  check("login resolver has the paywall gate (blocked → /dashboard/admin/billing)",
    /loadBillingAccess/.test(onboardingSrc) && /billing_required/.test(onboardingSrc) && /\/dashboard\/admin\/billing/.test(onboardingSrc))
  // RE-ANCHORED (wave 99A): the login gate delegates to the ONE resolver and fails CLOSED.
  const onboardingCode = stripComments(onboardingSrc)
  check("login gate asks mayUseAndAfford('app.access') with the platform_role actor, and a throw routes to billing",
    /mayUseAndAfford\(\{[\s\S]{0,200}?capability: "app\.access"[\s\S]{0,120}?actor: \{ platformRole, userType \}/.test(onboardingCode)
    && /let allowed = false/.test(onboardingCode) && !/loadBillingAccess\(/.test(onboardingCode))
  // These two used to grep for an inline from("subscription_tiers") in page.tsx
  // and a priceByTier[t.id] lookup in the form. Both were refactored into
  // lib/platform/public-tiers.ts (loadPublicTiers + formatTierPrice, shared with
  // /pricing) and the assertions kept failing on code that was CORRECT — they
  // pinned the shape of the implementation, not the promise. The promise is:
  // prices come from the DB and no dollar figure is written into the page.
  const pageSrc = readFileSync(join(process.cwd(), "app/get-started/page.tsx"), "utf8")
  const tiersSrc = readFileSync(join(process.cwd(), "lib/platform/public-tiers.ts"), "utf8")
  check("signup page loads prices from subscription_tiers (source of truth)",
    /loadPublicTiers/.test(pageSrc) && /from\("subscription_tiers"\)/.test(tiersSrc)
    && /monthly_price_cents/.test(tiersSrc))
  const formSrc = readFileSync(join(process.cwd(), "app/get-started/trial-funnel-form.tsx"), "utf8")
  check("signup form renders DB prices, NO hardcoded price strings",
    /monthlyCents/.test(formSrc) && !/price:\s*"\$/.test(formSrc)
    && !/\$\d{2,}/.test(formSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live paywall]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `BillAcc${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live paywall]")
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: `${TAG} Brokerage` }).select("id").single()
    const brokerageId = (brk as any).id
    cleanup.push({ table: "brokerages", id: brokerageId })
    const { data: anyTier } = await svc.from("subscription_tiers").select("id").limit(1).single()

    // Trialing with an EXPIRED trial → blocked.
    const { data: sub } = await svc.from("subscriptions").insert({
      brokerage_id: brokerageId, tier_id: (anyTier as any)?.id ?? null, status: "trialing",
      trial_end: new Date(Date.now() - 86_400_000).toISOString(), created_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "subscriptions", id: (sub as any).id })

    const blocked = await loadBillingAccess(svc, brokerageId)
    check("live: expired-trial tenant is BLOCKED (routes to the paywall)", blocked.blocked && blocked.state === "expired", JSON.stringify(blocked))

    // Pay → active → access restored.
    await svc.from("subscriptions").update({ status: "active" }).eq("id", (sub as any).id)
    const active = await loadBillingAccess(svc, brokerageId)
    check("live: after activation the tenant has ACCESS (paywall lifts)", !active.blocked && active.state === "active", JSON.stringify(active))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("brokerages").select("id", { count: "exact", head: true }).eq("name", `${TAG} Brokerage`)
    check("cleanup verified — 0 seeded brokerages remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
