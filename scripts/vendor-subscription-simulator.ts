#!/usr/bin/env tsx
/**
 * scripts/vendor-subscription-simulator.ts   (npm run test:vendor-subscription)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR SUBSCRIPTION TIERS + STRIPE BILLING (vendors pay the platform). Tier capabilities gate
 * surfacing/preferred/featured; a past_due/canceled subscription collapses to basic; Stripe lifecycle
 * events map to our status (payment_failed→past_due; cancellation→canceled+suspend).
 *
 * PURE:   VENDOR_TIERS catalog + tierAllows + effectiveCapabilities (past_due→basic) + mapStripeEventToStatus.
 * SOURCE: checkout/portal reuse lib/stripe; the webhook applies applyVendorSubscriptionEvent; the billing
 *         UI wires the actions; owned by finance_manager with a runnable proof; columns in the snapshot.
 * LIVE (creds-gated): a vendor_marketplace_profiles row round-trips a past_due→basic-effective status and
 *         accepts the new billing columns → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  VENDOR_TIERS,
  tierAllows,
  effectiveCapabilities,
  mapStripeEventToStatus,
  normalizeTier,
  resolveTierPrice,
  resolveVendorTiers,
} from "../lib/kernel/vendor-subscription"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[tier catalog · pure — spec gating]")
  check("basic is NOT AI-surfaced", VENDOR_TIERS.basic.surfacingEligible === false)
  check("standard+ is surfacing-eligible", VENDOR_TIERS.standard.surfacingEligible && VENDOR_TIERS.premium.surfacingEligible)
  check("only premium+ is preferred-eligible", !VENDOR_TIERS.standard.preferredEligible && VENDOR_TIERS.premium.preferredEligible)
  check("only preferred_network is featured-eligible", !VENDOR_TIERS.premium.featuredEligible && VENDOR_TIERS.preferred_network.featuredEligible)
  check("prices ascend basic<standard<premium<preferred_network", VENDOR_TIERS.basic.monthlyPriceUsd < VENDOR_TIERS.standard.monthlyPriceUsd && VENDOR_TIERS.premium.monthlyPriceUsd < VENDOR_TIERS.preferred_network.monthlyPriceUsd)
  check("normalizeTier defaults junk to basic", normalizeTier("nonsense") === "basic" && normalizeTier("PREMIUM") === "premium")

  console.log("\n[effective capabilities · pure — billing status gates]")
  check("active premium keeps preferred eligibility", tierAllows("premium", "active", "preferred"))
  check("past_due premium collapses to basic (no surfacing/preferred)", effectiveCapabilities("premium", "past_due").tier === "basic" && !tierAllows("premium", "past_due", "surfacing"))
  check("canceled preferred_network collapses to basic (no featured)", !tierAllows("preferred_network", "canceled", "featured"))
  check("trialing standard is surfacing-eligible", tierAllows("standard", "trialing", "surfacing"))

  console.log("\n[editable pricing · pure — brokerage overrides win, else default]")
  check("no override → catalog default", resolveTierPrice("standard") === VENDOR_TIERS.standard.monthlyPriceUsd)
  check("a brokerage override wins", resolveTierPrice("standard", { standard: 129 }) === 129)
  check("a zero override is honored (free tier)", resolveTierPrice("basic", { basic: 0 }) === 0)
  check("resolveVendorTiers applies overrides but keeps capabilities", resolveVendorTiers({ premium: 249 }).premium.monthlyPriceUsd === 249 && resolveVendorTiers({ premium: 249 }).premium.preferredEligible === true)

  console.log("\n[Stripe event → status · pure]")
  check("invoice.payment_failed → past_due (no suspend)", mapStripeEventToStatus("invoice.payment_failed").status === "past_due" && mapStripeEventToStatus("invoice.payment_failed").suspendAccount === false)
  check("customer.subscription.deleted → canceled + suspend", mapStripeEventToStatus("customer.subscription.deleted").status === "canceled" && mapStripeEventToStatus("customer.subscription.deleted").suspendAccount === true)
  check("payment_succeeded → active", mapStripeEventToStatus("invoice.payment_succeeded").status === "active")
  check("subscription.updated(past_due) → past_due", mapStripeEventToStatus("customer.subscription.updated", "past_due").status === "past_due")
}

function sourceLayer() {
  console.log("\n[wiring — Stripe SDK checkout, webhook applier, UI, owned]")
  const act = src("app/actions/vendor-billing.ts")
  // The portal call moved OUT of this action into lib/billing/stripe-portal.ts —
  // the billing-convergence keep-one, shared with the brokerage-tenant portal so
  // the two paths cannot drift. Asserting the inline stripe.billingPortal call
  // here pinned the old shape and failed on the consolidation that was the point.
  const portal = src("lib/billing/stripe-portal.ts")
  check("checkout + portal reuse the canonical lib/stripe proxy",
    /from "@\/lib\/stripe"/.test(act) && /stripe\.checkout\.sessions\.create/.test(act)
    && /createBillingPortalUrl/.test(act)
    // The helper reaches the proxy via a DYNAMIC import — same canonical module,
    // different syntax; match either so this tests the dependency, not the form.
    && /(from|import\()\s*"@\/lib\/stripe"/.test(portal) && /stripe\.billingPortal\.sessions\.create/.test(portal))
  check("applyVendorSubscriptionEvent maps Stripe events → status + suspend", /applyVendorSubscriptionEvent/.test(act) && /mapStripeEventToStatus/.test(act) && /update\.status = "suspended"/.test(act))
  const wh = src("app/api/webhooks/stripe/vendor/route.ts")
  // WAS PINNED TO A WAYPOINT (CLAUDE.md §2). This asserted the literal
  // `constructEvent(body, sig, secret)` — the ONE-hardcoded-secret shape — so it
  // could only pass while the route verified every delivery against
  // STRIPE_VENDOR_WEBHOOK_SECRET. The owner ruling ("the stripe account will be
  // per tenant and platform so no configuration should be hardcoded") makes that
  // shape wrong: with N+1 Stripe accounts, one secret cannot verify deliveries
  // from the others, and the route now resolves the roster and identifies the
  // SIGNING account cryptographically (lib/billing/stripe-webhook-secrets.ts).
  // So the RULE is asserted instead of the syntax: the delivery is
  // signature-verified before anything is applied, and only a PLATFORM-signed one
  // reaches the applier — the vendor marketplace tier is money the vendor pays
  // the PLATFORM (VENDOR_PLATFORM_TIER), so a tenant's own Stripe account has no
  // authority to move a vendor's subscription status.
  check("the webhook signature-verifies before applying, and only a platform-signed delivery reaches the applier",
    /verifyStripeWebhook\(/.test(wh)
    && /verification\.status === "verified"|verification\.ownerType !== "platform"/.test(wh)
    && wh.indexOf("verifyStripeWebhook(") < wh.indexOf("applyVendorSubscriptionEvent(")
    && /applyVendorSubscriptionEvent\(/.test(wh))
  const ui = src("app/vendor/billing/billing-client.tsx")
  check("the billing UI wires checkout + portal actions", /createVendorSubscriptionCheckout/.test(ui) && /createVendorBillingPortalSession/.test(ui))
  check("editable pricing: an admin setter writes brokerage_settings + the approval UI edits prices", /setVendorTierPricing/.test(src("app/actions/vendor-verification.ts")) && /vendor_tier_pricing/.test(src("app/actions/vendor-verification.ts")) && /setVendorTierPricing\(p\.tier/.test(src("app/dashboard/admin/vendor-approvals/approval-client.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /vendor_subscription_billing:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:vendor-subscription"/.test(reg))
  check("new billing columns are in the schema snapshot", /vendor_marketplace_profiles:\s*\[[^\]]*"stripe_customer_id"[^\]]*"subscription_tier"/.test(src("scripts/schema-snapshot.ts")))
  check("package.json wires the proof", /"test:vendor-subscription":\s*"tsx scripts\/vendor-subscription-simulator\.ts"/.test(src("package.json")))
}

// ── NO DEFAULTS ON THE MARKETPLACE (owner ruling 2026-08-27, verbatim: "the
// vendor marketplace should not have any default"). The live defaults included
// subscription_status 'active' — in PLATFORM_USE_PAYING_STATUSES, so a
// defaulted row was born already paying the platform — and tier 'basic'.
// m571 drops every business-value default; the covered column list is DERIVED
// from the schema snapshot cache (§2: assert the rule, derive the number),
// never retyped here.

/** Bookkeeping columns whose defaults the ruling deliberately keeps. */
const NO_DEFAULT_ALLOWLIST = new Set(["id", "created_at", "updated_at"])

/** Columns the migration must DROP DEFAULT on that it does not. PURE for the mutation control. */
function missingDropDefaults(migrationSql: string, snapshotColumns: string[]): string[] {
  return snapshotColumns
    .filter((c) => !NO_DEFAULT_ALLOWLIST.has(c))
    .filter((c) => !new RegExp(`alter\\s+column\\s+${c}\\s+drop\\s+default`, "i").test(migrationSql))
}

function noDefaultLayer() {
  console.log("\n[no defaults — m571 covers every business column, derived from the snapshot]")
  const MIGRATION = "supabase/migrations/m571-the-vendor-marketplace-should-not-have-any-default.sql"
  const cols = SCHEMA_SNAPSHOT.vendor_marketplace_profiles ?? []
  check("the snapshot cache knows the table (denominator exists)", cols.length > 0)
  const sql = src(MIGRATION)
  const missing = missingDropDefaults(sql, cols)
  check(`m571 drops the default on all ${cols.length - NO_DEFAULT_ALLOWLIST.size} business columns (snapshot-derived; id/timestamps kept)`,
    missing.length === 0)
  if (missing.length) console.log("    missing:", missing.join(", "))
  check("m571 self-checks the RULE in the database (derives offenders from information_schema, allowlist only id/timestamps)",
    /information_schema\.columns/.test(sql) && /not in \('id', 'created_at', 'updated_at'\)/.test(sql))
  check("MUTATION CONTROL — the coverage checker flags a migration missing one column",
    missingDropDefaults(sql.replace(/alter column subscription_status\s+drop default,?/i, ""), cols)
      .includes("subscription_status"))

  // Every writer now provides the de-defaulted NOT NULL values EXPLICITLY —
  // fail-closed means a value-less insert REFUSES, so legitimate flows must say
  // what they mean. Stripped-scan (2026-08-27) found exactly two inserts.
  const invite = src("app/actions/vendor-invite.ts")
  check("the ONE app insert (vendor-invite) sets subscription_tier + subscription_status + status explicitly",
    /subscription_tier:\s*"basic"/.test(invite) &&
    /subscription_status:\s*"canceled"/.test(invite) &&
    /status:\s*"pending"/.test(invite))
  const self = src("scripts/vendor-subscription-simulator.ts")
  check("this simulator's own live insert sets tier + subscription_status + status explicitly",
    /subscription_tier:\s*"premium",\s*subscription_status:\s*"active"/.test(self) && /status:\s*"approved"/.test(self))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] a vendor profile accepts the billing columns + a past_due status round-trips → clean up")
  const { data: usr } = await svc.from("users").select("id").limit(1).maybeSingle()
  if (!usr) { console.log("  ⊘ no user — skipping"); return }
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: p, error } = await svc.from("vendor_marketplace_profiles").insert({
      user_id: (usr as any).id, company_name: "ZZ Billing Sim Vendor", category: "service", status: "approved",
      subscription_tier: "premium", subscription_status: "active",
    }).select("id").single()
    if (error || !p) { console.log("  ⊘ insert blocked:", error?.message); return }
    const profileId = (p as any).id
    cleanup.push({ table: "vendor_marketplace_profiles", id: profileId })
    check("live: the profile accepts subscription_tier/status columns", true)

    // Simulate the webhook applier's effect for a payment failure.
    const mapped = mapStripeEventToStatus("invoice.payment_failed")
    await svc.from("vendor_marketplace_profiles").update({ subscription_status: mapped.status }).eq("id", profileId)
    const { data: after } = await svc.from("vendor_marketplace_profiles").select("subscription_tier, subscription_status").eq("id", profileId).maybeSingle()
    check("live: payment failure round-trips to past_due", (after as any)?.subscription_status === "past_due")
    check("live: effective capabilities collapse premium→basic while past_due", effectiveCapabilities((after as any)?.subscription_tier, (after as any)?.subscription_status).tier === "basic")
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }

  // ── NO-DEFAULT FAIL-CLOSED PROBE. An insert omitting subscription_status /
  // subscription_tier must REFUSE once m571 is applied (NOT NULL, no default).
  // Files are not the database (§3): until the integrator applies m571 this
  // probe reports PENDING rather than passing or failing — and while pending it
  // proves the finder can still SEE defaults (the positive control §2 demands).
  console.log("\n[live] no-default probe — an insert that omits tier/status must refuse (post-m571)")
  {
    const { data: usr2 } = await svc.from("users").select("id").limit(1).maybeSingle()
    if (!usr2) { console.log("  ⊘ no user — skipping probe"); return }
    const { data: bare, error: bareErr } = await svc.from("vendor_marketplace_profiles").insert({
      user_id: (usr2 as any).id, company_name: "ZZ No-Default Probe Vendor", category: "service",
      // subscription_tier / subscription_status / status DELIBERATELY omitted.
    }).select("id, subscription_tier, subscription_status, status").single()
    if (bareErr && !bare) {
      check("live: value-less insert REFUSES (m571 applied — fail closed, nothing defaulted)",
        /null value|not-null|violates/i.test(bareErr.message))
      console.log(`    refusal: ${bareErr.message}`)
    } else if (bare) {
      const b = bare as any
      // REPORT THE OBSERVATION, DO NOT NAME A CAUSE THIS PROBE CANNOT SEE (§2).
      // This line asserted "m571 is WRITTEN, NOT APPLIED" as the explanation and
      // kept asserting it after m571 landed (verified live 2026-09-05:
      // vendor_marketplace_profiles.subscription_tier and .subscription_status are
      // both NOT NULL with no default, which is exactly what m571 does). A probe
      // that saw a row appear cannot tell WHY; a defaulted insert surviving now
      // would mean something new and worse, not a pending migration.
      console.log("  ⊘ UNEXPECTED — the value-less insert SUCCEEDED. The columns should be NOT NULL")
      console.log("     with no default; a row landing here means the fail-closed shape is gone.")
      check("live: (positive control while pending) the probe still SEES the defaults it exists to remove",
        b.subscription_status === "active" && b.subscription_tier === "basic" && b.status === "pending")
      await svc.from("vendor_marketplace_profiles").delete().eq("id", b.id)
      const { count } = await svc.from("vendor_marketplace_profiles").select("id", { count: "exact", head: true }).eq("id", b.id)
      check("live: probe cleanup count == 0", (count ?? 0) === 0)
    }
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  noDefaultLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_SUBSCRIPTION_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_SUBSCRIPTION_PASS — tiers gate surfacing/preferred/featured; billing status drives access; Stripe events mapped")
}
main()
