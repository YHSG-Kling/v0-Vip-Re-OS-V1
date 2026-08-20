#!/usr/bin/env tsx
/**
 * scripts/ai-overage-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OVER-QUOTA AI IS SERVED AND BILLED, NOT REFUSED (m479).
 *
 * Owner ruling (verbatim): "ai is a platform covered and their tier plan
 * determines usage to bill them extra if goes over a quota."
 *
 * PURE:   deriveAIOverage — under quota → 0; over → the exact excess; an
 *         approved override EXTENDS the included quota (overage starts after
 *         included+override); unlimited (−1) can never produce overage; the
 *         amount is ceil(over × rate / 1000) cents and 0 when terms are off.
 * SOURCE: fair-use serves overage ONLY when the tier's terms allow it (terms
 *         off / missing → today's hard block; superadmin bypass + override
 *         lookup untouched); the reader derives from usage_counters (ONE usage
 *         canon — no second accrual, no private period math, readers key on
 *         period_start); the writethrough claims the UNIQUE idempotency row
 *         BEFORE Stripe and marks billed only WITH the provider result;
 *         no-Stripe-creds → loud refusal recording nothing.
 * LIVE:   Stripe + DB writes are creds-gated; the no-creds refusal IS executed
 *         here.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveAIOverage, runAIOverageBilling } from "../lib/billing/ai-overage"
import { validateAIOverageTermsInput } from "../lib/billing/plan-catalog"
import { blankComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** Strip comments so prose cannot satisfy (or trip) a scan. */
const code = (s: string) => blankComments(s)
/** Strip SQL comments for migration scans. */
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, (m) => " ".repeat(m.length))

const FAIR = read("lib/ai/fair-use.ts")
const OVER = read("lib/billing/ai-overage.ts")
const MIG  = read("supabase/migrations/m479-over-quota-ai-is-served-and-billed-not-refused.sql")
const CRON = read("app/api/cron/ai-overage-billing/route.ts")
const REG  = read("lib/kernel/cron-dispatch.ts")
const PAGE = read("app/dashboard/admin/ai-usage/page.tsx")

async function main() {

console.log("\n[derivation — the overage math contract, executed]")
{
  const RATE = { overageAllowed: true, overageRateCentsPer1k: 2 }
  const under = deriveAIOverage({ usedTokens: 1_500_000, includedLimit: 2_000_000, overrideTokens: 0, ...RATE })
  check("under quota → 0 overage, 0 cents", under.overageTokens === 0 && under.overageAmountCents === 0)
  const at = deriveAIOverage({ usedTokens: 2_000_000, includedLimit: 2_000_000, overrideTokens: 0, ...RATE })
  check("exactly AT quota → still 0 overage (overage is strictly past included)", at.overageTokens === 0 && at.overageAmountCents === 0)
  const over = deriveAIOverage({ usedTokens: 2_350_000, includedLimit: 2_000_000, overrideTokens: 0, ...RATE })
  check("over quota → the EXACT excess (350K)", over.overageTokens === 350_000)
  check("...amount = ceil(350000 × 2 / 1000) = 700 cents", over.overageAmountCents === 700)
  const covered = deriveAIOverage({ usedTokens: 2_100_000, includedLimit: 2_000_000, overrideTokens: 200_000, ...RATE })
  check("an override EXTENDS included: 2.1M used, 2M + 200K override → 0 overage", covered.includedTokens === 2_200_000 && covered.overageTokens === 0)
  const partly = deriveAIOverage({ usedTokens: 2_100_000, includedLimit: 2_000_000, overrideTokens: 50_000, ...RATE })
  check("...and overage starts AFTER included+override (2.1M vs 2.05M → 50K over)", partly.overageTokens === 50_000)
  const unlimited = deriveAIOverage({ usedTokens: 9_999_999_999, includedLimit: -1, overrideTokens: 0, ...RATE })
  check("unlimited included (−1) can never produce overage", unlimited.includedTokens === -1 && unlimited.overageTokens === 0 && unlimited.overageAmountCents === 0)
  const termsOff = deriveAIOverage({ usedTokens: 2_500_000, includedLimit: 2_000_000, overrideTokens: 0, overageAllowed: false, overageRateCentsPer1k: 2 })
  check("terms OFF → the excess is still MEASURED (500K) but the amount is 0 (never bill unagreed overage)", termsOff.overageTokens === 500_000 && termsOff.overageAmountCents === 0)
  const partial = deriveAIOverage({ usedTokens: 2_000_100, includedLimit: 2_000_000, overrideTokens: 0, overageAllowed: true, overageRateCentsPer1k: 1 })
  check("a partial 1K block rounds UP to the next cent (100 tokens @ 1¢/1K → 1¢)", partial.overageAmountCents === 1)
  const clamped = deriveAIOverage({ usedTokens: -50, includedLimit: 2_000_000, overrideTokens: -10, ...RATE })
  check("negative inputs clamp to 0 — the math can't mint negative overage", clamped.usedTokens === 0 && clamped.overageTokens === 0 && clamped.overageAmountCents === 0)
}

console.log("\n[fair-use — served under terms, hard-blocked without them]")
{
  const c = code(FAIR)
  check("FairUseResult carries overageActive + overageTokens", /overageActive:\s*boolean/.test(c) && /overageTokens:\s*number/.test(c))
  check("the over-quota path consults the tier's TERMS (readOverageTerms) before serving", /readOverageTerms\(params\.brokerageId\)/.test(c))
  check("...and serves ONLY inside terms.allowed, with overageActive true", /if \(terms\.allowed\) \{[\s\S]*?allowed:\s*true,[\s\S]*?overageActive:\s*true,/.test(c))
  check("terms off / missing / refused read as OFF — the fail-safe direction", /const OFF = \{ allowed: false, rateCentsPer1k: 0 \}/.test(c) && /return OFF/.test(c))
  check("the final return keeps TODAY'S hard block (allowed: reAllowed) when overage doesn't apply", /allowed:\s*reAllowed,/.test(c) && /overageActive:\s*false,/.test(c))
  check("superadmin/bypass pass-through unchanged (no-brokerage/bypass early return intact)", /if \(!params\.brokerageId \|\| params\.bypass\)/.test(c))
  check("override lookup intact: an override extends the INCLUDED quota (limit + overrideTokens)", /readActiveOverrideTokens\(params\.brokerageId\)/.test(c) && /cap\.limit \+ overrideTokens/.test(c))
  check("the terms read happens ONLY on the over-quota branch (guarded by !reAllowed)", /if \(!reAllowed && effectiveLimit >= 0\) \{[\s\S]*?readOverageTerms/.test(c))
}

console.log("\n[the reader — ONE usage canon, derived not re-accrued]")
{
  const c = code(OVER)
  check("overage derives from usage_counters at read time (max(0, used − included))", /Math\.max\(0,\s*usedTokens\s*-\s*includedTokens\)/.test(c))
  check("the reader imports the ONE period canon", /import \{ currentUsagePeriod \} from "@\/lib\/usage\/period"/.test(OVER))
  check("...and carries NO private UTC re-derivation (a second canon is still a second canon)", !/Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\)/.test(c) && !/new Date\(now\.getFullYear\(\), now\.getMonth\(\)/.test(c))
  check("usage_counters reads key on period_start alone — never pin period_end", !/from\("usage_counters"\)[\s\S]{0,300}?\.eq\("period_end"/.test(c))
  check("NO second accrual: this module never inserts/updates usage_counters", !/from\("usage_counters"\)\s*\.\s*(insert|update|upsert)/.test(c))
  check("the reader returns the full money-shaped result", /includedTokens/.test(c) && /overageRateCents/.test(c) && /overageAmountCents/.test(c))
  for (const name of ["brokerageError", "limitError", "overridesError", "counterError", "countersError", "existingError", "subError", "claimError", "releaseError", "markError"]) {
    check(`error destructured + handled: ${name}`, new RegExp(`error:\\s*${name}`).test(c) && new RegExp(`${name}[\\)\\s]`).test(c))
  }
  check("a refused counter read is a REFUSAL, not a zero", /usage_counters read refused/.test(OVER))
}

console.log("\n[the writethrough — idempotent claim, provider-result-or-nothing]")
{
  const c = code(OVER)
  check("no Stripe creds → the RUN refuses before touching anything", /if \(!isStripeConfigured\(\)\) \{\s*return \{ ok: false/.test(c))
  const claimAt  = c.indexOf('from("ai_overage_invoices")\n      .insert(')
  const stripeAt = c.indexOf("stripe.invoiceItems.create(")
  check("the idempotency row is CLAIMED before Stripe is called (insert precedes invoiceItems.create)", claimAt !== -1 && stripeAt !== -1 && claimAt < stripeAt)
  check("claim status is 'pending' — billed is not assumable", /status:\s*"pending",/.test(c))
  check("a duplicate claim (23505) stands down instead of double-billing", /23505/.test(c) && /claimed_by_concurrent_run/.test(c))
  check("an existing billed marker → skipped (rerun cannot double-bill)", /already_billed/.test(c))
  check("a pending claim without provider outcome → needs_reconciliation, never re-billed", /pending_claim_without_provider_result/.test(c))
  check("billed is marked only WITH the provider invoice-item id", /\.update\(\{ status: "billed", stripe_invoice_item_id: invoiceItemId/.test(c))
  check("a provider refusal RELEASES the claim so a rerun can retry", /\.delete\(\)\s*[\s\S]{0,80}\.eq\("status", "pending"\)/.test(c))
  check("the invoice item lands on the SUBSCRIPTION customer", /customer:\s*customerId,/.test(c) && /subscription:\s*sub\.stripe_subscription_id/.test(c))
  check("no stripe customer → skipped and NOTHING recorded", /no_stripe_customer/.test(c))
  check("overage with terms off is surfaced, never billed", /overage_not_allowed_for_tier/.test(c))
}

console.log("\n[live — the no-creds refusal, executed]")
if (!process.env.STRIPE_SECRET_KEY) {
  const r = await runAIOverageBilling({ now: new Date("2026-08-18T00:00:00Z") })
  check("runAIOverageBilling with no STRIPE_SECRET_KEY → ok:false, loud, names the missing provider", r.ok === false && /STRIPE_SECRET_KEY/.test((r as any).error) && /REFUSED/.test((r as any).error))
} else {
  console.log("  ⊘ STRIPE_SECRET_KEY present in this env — refusal path not exercised here")
}

console.log("\n[the migration — terms + billing-event table, postconditioned]")
{
  const m = sqlCode(MIG)
  check("plan_limits gains overage_allowed (default FALSE — off unless seeded)", /add column if not exists overage_allowed boolean not null default false/.test(m))
  check("...and overage_rate_cents_per_1k (integer cents per 1K, >= 0)", /overage_rate_cents_per_1k integer not null default 0/.test(m) && /check \(overage_rate_cents_per_1k >= 0\)/.test(m))
  check("terms seeded for the four live tiers on ai_tokens_monthly only", /metric = 'ai_tokens_monthly'/.test(m) && /'solo_agent'/.test(m) && /'multi_location'/.test(m))
  check("ai_overage_invoices carries THE idempotency key (brokerage, period_start, metric)", /unique \(brokerage_id, period_start, metric\)/.test(m))
  check("'billed' without a provider result is unrepresentable (CHECK)", /check \(status <> 'billed' or stripe_invoice_item_id is not null\)/.test(m))
  check("the period canon is pinned (half-open month CHECK)", /check \(period_end = period_start \+ interval '1 mon'\)/.test(m))
  check("RLS on; reads only for platform staff + tenant finance admins; NO tenant write lane", /enable row level security/.test(m) && /is_brokerage_finance_admin\(\) and has_brokerage_access\(brokerage_id\)/.test(m) && !/for (insert|update|delete)/.test(m))
  check("postconditions RAISE (measured migration, m474/m476 style)", (m.match(/raise exception/g) ?? []).length >= 5)
}

console.log("\n[the cron + the surface]")
{
  const c = code(CRON)
  const authAt = c.indexOf("verifyCronAuth(req)")
  const runAt = c.indexOf("runAIOverageBilling()")
  check("cron auth runs BEFORE the billing run (fail-closed)", authAt !== -1 && runAt !== -1 && authAt < runAt)
  check("a refused run returns 503, never a quiet 200", /status: 503/.test(c))
  check("the route is registered in the dispatcher (a route without a schedule never fires)", /\/api\/cron\/ai-overage-billing/.test(REG))
  const p = code(PAGE)
  check("the admin surface shows included / used / overage for the period", /includedTokens/.test(p) && /usedTokens/.test(p) && /overageTokens/.test(p))
  check("the projected DOLLAR figure is gated on the finance-admin roster", /isBrokerageFinanceAdmin/.test(p) && /isFinanceAdmin && \(/.test(p))
  check("a refused overage read renders nothing, not a fake zero", /overage && overage\.ok \? overage : null/.test(p))
}

console.log("\n[the admin lane — overage terms administrable like the tier price]")
{
  // Owner ruling (verbatim): "the billing for overage needs to be coded so
  // that we can pass in the cent per limit so the same as how we are handling
  // the subscription tier amount." The terms are configured through the
  // plan-catalog action lane — same superadmin gate, same pure-validator
  // discipline, same audit trail — never hardcoded, never edited raw.

  // Pure validator, EXECUTED (not scanned):
  const good = validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2 })
  check("valid terms normalize — metric pinned to ai_tokens_monthly, rate kept as integer cents", good.ok && good.value.metric === "ai_tokens_monthly" && good.value.overageRateCentsPer1k === 2)
  const off = validateAIOverageTermsInput({ planTier: "brokerage", overageAllowed: false, overageRateCentsPer1k: 0 })
  check("terms OFF with a 0 rate is valid (the disabled state)", off.ok && !off.value.overageAllowed)
  check("negative rate → refused", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: -1 }).ok)
  check("non-integer rate → refused (money is never silently rounded here)", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2.5 }).ok)
  check("NaN/Infinity rate → refused", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: NaN }).ok && !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: Infinity }).ok)
  check("non-canonical tier → refused", !validateAIOverageTermsInput({ planTier: "enterprise", overageAllowed: true, overageRateCentsPer1k: 2 }).ok)
  check("any metric other than ai_tokens_monthly → refused (m479 postcondition BY CONSTRUCTION)", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2, metric: "emails_sent" }).ok)
  check("enabled with a 0 rate → refused (never serve unlimited AI unbilled by accident)", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 0 }).ok)

  // The action lane — same gate + validator as the tier-price upsert:
  const ACT = read("app/actions/superadmin/plan-catalog.ts")
  const a = code(ACT)
  check("listAIOverageTermsAction + upsertAIOverageTermsAction exist in the plan-catalog action module", /export async function listAIOverageTermsAction/.test(a) && /export async function upsertAIOverageTermsAction/.test(a))
  check("both are behind the SAME superadmin gate as upsertPlanTierAction", /listAIOverageTermsAction[\s\S]{0,200}?requireSuperadmin\(\)/.test(a) && /upsertAIOverageTermsAction[\s\S]{0,200}?requireSuperadmin\(\)/.test(a))
  check("the upsert goes through the pure validator, import-pinned to lib/billing/plan-catalog", /validateAIOverageTermsInput/.test(a) && /from "@\/lib\/billing\/plan-catalog"/.test(blankComments(ACT)))
  check("...and refuses BEFORE any write (validator result gates the update)", /const v = validateAIOverageTermsInput\(input\)\s*\n\s*if \(!v\.ok\) return \{ ok: false, error: v\.error \}/.test(a))
  check("the metric is pinned to the ONE constant on both read and write (.eq(\"metric\", AI_OVERAGE_METRIC))", (a.match(/\.eq\("metric", AI_OVERAGE_METRIC\)/g) ?? []).length >= 2)
  check("UPDATE-only: the action can never mint a plan_limits row (no insert/upsert on plan_limits)", !/from\("plan_limits"\)[\s\S]{0,400}?\.(insert|upsert)\(/.test(a))
  check("a missing (tier, metric) row is a REFUSAL, not a silent create", /seed the included limit first/.test(a))
  check("supabase errors are destructured + refusals are refusals in the terms lane", /listAIOverageTermsAction[\s\S]*?\{ data, error \}[\s\S]*?if \(error\) return \{ ok: false, error: error\.message \}/.test(a))
  check("the terms upsert AUDITS like the tier upsert (superadmin_audit_log via the same helper)", /audit\(auth\.userId, "plan_limits\.ai_overage_terms_updated"/.test(a))

  // The surface — the UI reads/writes THROUGH the action, never the table:
  const PLANS = read("app/dashboard/superadmin/plans/page.tsx")
  const CARDSRC = read("app/dashboard/superadmin/plans/ai-overage-terms-card.tsx")
  const pp = code(PLANS)
  const cc = code(CARDSRC)
  check("the plans page loads terms through listAIOverageTermsAction and renders the card", /listAIOverageTermsAction\(\)/.test(pp) && /AIOverageTermsCard/.test(pp))
  check("the card saves through upsertAIOverageTermsAction (no raw supabase in the surface)", /upsertAIOverageTermsAction\(/.test(cc) && !/createClient|createServiceClient|from\(["']plan_limits["']\)/.test(cc) && !/supabase/.test(cc))
  check("each tier row shows the INCLUDED tokens (limit_value) beside the terms", /limit_value/.test(cc) && /Included/.test(cc))
  check("the rate is presented as integer CENTS per 1K (tier-price presentation discipline; $/1M is display-only)", /¢ per 1K/.test(CARDSRC) && /overage_rate_cents_per_1k/.test(cc) && /perMillion/.test(cc))
  check("a failed terms load is surfaced on the page, not a fake empty state", /Failed to load AI overage terms/.test(PLANS))
}

console.log("\n[negative controls — the scans can fail]")
{
  check("NEGATIVE — the comment mask hides code-shaped prose", !/stripe\.invoiceItems\.create\(/.test(code('// stripe.invoiceItems.create(...)')))
  check("NEGATIVE — the claim-before-provider ordering scan flags the inverted order",
    (() => {
      const bad = 'stripe.invoiceItems.create(x); await svc.from("ai_overage_invoices")\n      .insert('
      const claimAt = bad.indexOf('from("ai_overage_invoices")\n      .insert(')
      const stripeAt = bad.indexOf("stripe.invoiceItems.create(")
      return !(claimAt !== -1 && stripeAt !== -1 && claimAt < stripeAt)
    })())
  check("NEGATIVE — the second-accrual scan trips on a usage_counters writer",
    /from\("usage_counters"\)\s*\.\s*(insert|update|upsert)/.test('svc.from("usage_counters").insert({ metric: "ai_overage" })'))
  check("NEGATIVE — the derivation would catch an off-by-inclusion bug (at-quota is NOT overage)",
    deriveAIOverage({ usedTokens: 100, includedLimit: 100, overrideTokens: 0, overageAllowed: true, overageRateCentsPer1k: 1 }).overageTokens !== 1)
  check("NEGATIVE — the comment mask hides a masked terms-upsert call (prose can't satisfy the UI scan)",
    !/upsertAIOverageTermsAction\(/.test(code('// upsertAIOverageTermsAction({ planTier })')))
  check("NEGATIVE — the UPDATE-only scan trips on a plan_limits insert (a minted row would fail the run)",
    /from\("plan_limits"\)[\s\S]{0,400}?\.(insert|upsert)\(/.test('svc.from("plan_limits")\n  .insert({ plan_tier: "team", metric: "emails_sent", overage_allowed: true })'))
  check("NEGATIVE — the validator refuses even a plausible-looking near-metric spelling",
    !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2, metric: "ai_tokens" }).ok)
}

console.log("\n" + "─".repeat(78))
console.log(`${pass} passed, ${fail} failed`)
if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
console.log(" ✅ AI_OVERAGE_PASS — over-quota AI is served under tier terms, derived from the one usage canon, and billed idempotently with a provider result or not at all")
}
main()
