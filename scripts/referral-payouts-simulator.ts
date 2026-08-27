#!/usr/bin/env tsx
/**
 * scripts/referral-payouts-simulator.ts   (npm run test:referral-payouts)
 * ─────────────────────────────────────────────────────────────────────────────
 * SUBSCRIBER-REFERRAL PAYOUTS: POSTED AND RECEIVED (owner ruling, verbatim:
 * "make sure referral payouts are posted and received by the recipient").
 *
 * WHAT THIS GUARDS: "paid" used to be a superadmin_audit_log line read back
 * from the log — a trail, not a ledger, with no recipient and no surface the
 * referrer could see. Now:
 *   POSTED   — a referral_payouts row (m573; UNIQUE(prospect_id, period) =
 *              idempotent posting; insert .select()ed and READ per §3), with
 *              the recipient resolved at post time from the referrer's email.
 *   RECEIVED — the recipient tenant's billing page lists posted payouts and
 *              acknowledges them (posted → received; COUNTED, session-scoped).
 *   TERMS    — ONE home (§6): platform_settings.referral_fee_percent (m573),
 *              code default only as a REPORTED fallback until applied.
 *
 * Layer 1 (behavior): the REAL lib/platform/referral-payouts.ts functions run
 *   against an injected in-memory client (the only edge stubbed) — recipient
 *   resolution, idempotent posting (23505 → "already posted"), pre-m573
 *   degradation (42P01 → "ledger_unavailable", never a throw), counted
 *   received-flip scoped to the recipient tenant, void exclusion.
 * Layer 2 (source, STRIPPED per §2 — these files' comments name the very
 *   tokens scanned): the superadmin action posts through the ledger and only
 *   falls back to the legacy audit line when the ledger is unavailable; the
 *   recipient action derives tenancy from the SESSION (§4); the billing page
 *   renders the card; the migration carries the unique key + RLS-no-policy
 *   posture; registry + package.json wired.
 * Layer 3 (agreement): the status vocabulary in code equals the m573 CHECK —
 *   parsed from the migration, not pinned (§2: assert the rule, derive the set).
 *
 * POSITIVE CONTROLS (§2): every finder is first proven against a specimen
 * carrying the defect it was written to catch — a broken regex and a clean
 * tree both report zero.
 *
 * BLIND SPOTS, published beside the numbers:
 *   · NO LIVE LAYER: this lane is live-DB read-only AND referral_payouts does
 *     not exist until the integrator applies m573 — live posting/receipt is
 *     proven by the injected-client behavior layer only.
 *   · The cash rail to a NON-TENANT referrer (external transfer) and the
 *     Stripe customer-balance credit for a tenant referrer are NOT built —
 *     both need a declared money path in lib/billing/stripe-account-scope.ts
 *     (integrator decision, published in lib/platform/referral-payouts.ts).
 *
 * Run: npx tsx scripts/referral-payouts-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  parseReferrerEmail,
  computeReferralFeeCents,
  REFERRAL_FEE_PERCENT,
  REFERRAL_PAYOUT_STATUSES,
} from "../lib/platform/subscriber-referrals"
import {
  getReferralFeeTerms,
  resolveReferralRecipient,
  postReferralPayout,
  listReferralEarningsForBrokerage,
  markReferralPayoutReceived,
  summarizeLedgerByProspect,
} from "../lib/platform/referral-payouts"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const src = (p: string) => stripComments(raw(p))

// ── In-memory PostgREST-ish client — the ONLY thing stubbed ─────────────────
type Tables = Record<string, any[]>
function fakeSvc(tables: Tables, opts?: { missingTables?: string[]; missingColumns?: Record<string, string[]> }) {
  const missingTables = new Set(opts?.missingTables ?? [])
  const missingColumns = opts?.missingColumns ?? {}
  const from = (table: string) => {
    const q: any = {
      op: "select", patch: null, cols: "*", filters: [] as Array<(r: any) => boolean>,
      _order: null as null | { col: string; asc: boolean }, _limit: null as number | null,
      select(cols?: string) { if (q.op === "select") q.cols = cols ?? "*"; else q.returning = true; return q },
      eq(col: string, v: any) { q.filters.push((r: any) => r[col] === v); return q },
      neq(col: string, v: any) { q.filters.push((r: any) => r[col] !== v); return q },
      in(col: string, vals: any[]) { q.filters.push((r: any) => vals.includes(r[col])); return q },
      is(col: string, v: any) { q.filters.push((r: any) => r[col] === v); return q },
      like(col: string, pat: string) { const p = pat.replace(/%/g, ""); q.filters.push((r: any) => String(r[col] ?? "").startsWith(p)); return q },
      order(col: string, o?: { ascending?: boolean }) { q._order = { col, asc: o?.ascending !== false }; return q },
      limit(n: number) { q._limit = n; return q },
      insert(row: any) { q.op = "insert"; q.patch = row; return q },
      update(patch: any) { q.op = "update"; q.patch = patch; return q },
      _run() {
        if (missingTables.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } }
        const missing = missingColumns[table] ?? []
        if (q.op === "select" && missing.some((c) => String(q.cols).includes(c))) {
          return { data: null, error: { code: "42703", message: `column ${table}.${missing[0]} does not exist` } }
        }
        const rows: any[] = tables[table] ?? (tables[table] = [])
        if (q.op === "insert") {
          if (table === "referral_payouts") {
            // UNIQUE(prospect_id, period) — the m573 idempotency key.
            if (rows.some((r) => r.prospect_id === q.patch.prospect_id && r.period === q.patch.period)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"referral_payouts_prospect_period_key\"" } }
            }
          }
          const row = { id: `row-${rows.length + 1}`, ...q.patch }
          rows.push(row)
          return { data: [{ id: row.id }], error: null }
        }
        let matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === "update") {
          for (const r of matched) Object.assign(r, q.patch)
          return { data: matched.map((r) => ({ ...r })), error: null }
        }
        if (q._order) {
          const { col, asc } = q._order
          matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
        }
        if (q._limit != null) matched = matched.slice(0, q._limit)
        return { data: matched.map((r) => ({ ...r })), error: null }
      },
      then(resolve: (v: any) => void) { return resolve(q._run()) },
      maybeSingle() { const r = q._run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }) },
      single() {
        const r = q._run()
        if (r.error) return Promise.resolve(r)
        const row = r.data?.[0] ?? null
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } })
      },
    }
    return q
  }
  return { from } as any
}

async function behaviorLayer() {
  console.log("\n[Layer 1 · behavior — the real functions against an injected client]")

  // Terms: one home, reported source, honest fallbacks.
  {
    const svc = fakeSvc({ platform_settings: [{ id: "s1", created_at: "2026-01-01", referral_fee_percent: 15 }] })
    const t = await getReferralFeeTerms(svc)
    check("terms: platform_settings.referral_fee_percent wins and names its source", t.percent === 15 && t.source === "platform_settings")
  }
  {
    // Pre-m573 the singleton row simply has no referral_fee_percent field —
    // the resolver reads the row whole (select("*")) so the missing column is
    // undefined, never a 42703 refusal, and the default is REPORTED as such.
    const svc = fakeSvc({ platform_settings: [{ id: "s1", created_at: "2026-01-01" }] })
    const t = await getReferralFeeTerms(svc)
    check("terms: pre-m573 (column absent on the live row) falls back to the default AND says default_constant", t.percent === REFERRAL_FEE_PERCENT && t.source === "default_constant")
  }
  {
    const svc = fakeSvc({ platform_settings: [{ id: "s1", created_at: "2026-01-01", referral_fee_percent: 999 }] })
    const t = await getReferralFeeTerms(svc)
    check("terms: a garbage stored value (999%) is refused in favor of the default", t.percent === REFERRAL_FEE_PERCENT && t.source === "default_constant")
  }

  // Recipient resolution: who a referrer IS.
  const baseTables = () => ({
    platform_settings: [{ id: "s1", created_at: "2026-01-01", referral_fee_percent: 10 }],
    users: [{ id: "u-jane", email: "jane@acme.com", brokerage_id: "brk-jane" }],
    brokerages: [{ id: "brk-jane", name: "Jane Realty" }],
    referral_payouts: [] as any[],
  }); // the semicolon is load-bearing: without it, tsc reparses `({...})` as the parameter list of an arrow whose body is the next bare block
  {
    const svc = fakeSvc(baseTables())
    const r1 = await resolveReferralRecipient("Jane Doe <jane@acme.com>", svc)
    check("recipient: 'Name <email>' resolves the tenant referrer (users.email → brokerage)", r1.brokerageId === "brk-jane" && r1.userId === "u-jane" && r1.brokerageName === "Jane Realty")
    const r2 = await resolveReferralRecipient("stranger@nowhere.com", svc)
    check("recipient: an email matching no users row = non-tenant referrer (email kept, no brokerage)", r2.email === "stranger@nowhere.com" && r2.brokerageId === null)
    const r3 = await resolveReferralRecipient("Just A Name", svc)
    check("recipient: a name-only referrer resolves to nothing (no invented identity)", r3.email === null && r3.brokerageId === null)
  }

  // Posting: idempotent, counted, honestly degraded.
  {
    const tables = baseTables()
    const svc = fakeSvc(tables)
    const p1 = await postReferralPayout(svc, { prospectId: "pr-1", referrer: "Jane Doe <jane@acme.com>", amountCents: 4900, feePercent: 10, period: "2026-08", note: "Aug fee", postedBy: "staff-1" })
    check("post: a payout row is POSTED with the recipient resolved onto it", p1.ok && tables.referral_payouts.length === 1 && tables.referral_payouts[0].recipient_brokerage_id === "brk-jane" && tables.referral_payouts[0].status === "posted")
    const p2 = await postReferralPayout(svc, { prospectId: "pr-1", referrer: "Jane Doe <jane@acme.com>", amountCents: 4900, feePercent: 10, period: "2026-08", postedBy: "staff-1" })
    check("post: same (prospect, period) again → 23505 reported as already_posted, ledger still holds ONE row", !p2.ok && (p2 as any).reason === "already_posted" && tables.referral_payouts.length === 1)
    const p3 = await postReferralPayout(svc, { prospectId: "pr-1", referrer: "x", amountCents: 0, feePercent: 10, period: "2026-08", postedBy: "staff-1" })
    const p4 = await postReferralPayout(svc, { prospectId: "pr-1", referrer: "x", amountCents: 100, feePercent: 10, period: "August", postedBy: "staff-1" })
    check("post: zero amount and a malformed period are refused as invalid", !p3.ok && (p3 as any).reason === "invalid" && !p4.ok && (p4 as any).reason === "invalid")
  }
  {
    const svc = fakeSvc(baseTables(), { missingTables: ["referral_payouts"] })
    const p = await postReferralPayout(svc, { prospectId: "pr-1", referrer: "jane@acme.com", amountCents: 4900, feePercent: 10, period: "2026-08", postedBy: "staff-1" })
    check("post: pre-m573 (42P01) reports ledger_unavailable naming the migration — never a throw, never fake success",
      !p.ok && (p as any).reason === "ledger_unavailable" && /m573/.test((p as any).error))
  }

  // The RECEIVED half: recipient-scoped read + counted acknowledgment.
  {
    const tables = baseTables()
    tables.referral_payouts = [
      { id: "pay-1", prospect_id: "pr-1", referrer: "Jane <jane@acme.com>", recipient_brokerage_id: "brk-jane", recipient_email: "jane@acme.com", amount_cents: 4900, fee_percent: 10, period: "2026-07", status: "posted", note: null, posted_at: "2026-07-31", received_at: null },
      { id: "pay-2", prospect_id: "pr-1", referrer: "Jane <jane@acme.com>", recipient_brokerage_id: "brk-jane", recipient_email: "jane@acme.com", amount_cents: 4900, fee_percent: 10, period: "2026-06", status: "void", note: null, posted_at: "2026-06-30", received_at: null },
      { id: "pay-3", prospect_id: "pr-2", referrer: "other", recipient_brokerage_id: "brk-OTHER", recipient_email: null, amount_cents: 1000, fee_percent: 10, period: "2026-07", status: "posted", note: null, posted_at: "2026-07-31", received_at: null },
    ]
    const svc = fakeSvc(tables)
    const list = await listReferralEarningsForBrokerage("brk-jane", svc)
    check("earnings list: ONLY the recipient tenant's rows, void excluded", list.ok && list.rows.length === 1 && list.rows[0].id === "pay-1")

    const wrongTenant = await markReferralPayoutReceived(svc, { payoutId: "pay-1", brokerageId: "brk-OTHER", userId: "u-x" })
    check("received: another tenant acknowledging MY payout matches 0 rows and is REFUSED (§3 counted, §4 scoped)", !wrongTenant.ok && tables.referral_payouts[0].status === "posted")
    const ack = await markReferralPayoutReceived(svc, { payoutId: "pay-1", brokerageId: "brk-jane", userId: "u-jane" })
    check("received: the recipient's acknowledgment flips posted → received with received_at/by", ack.ok && tables.referral_payouts[0].status === "received" && !!tables.referral_payouts[0].received_at && tables.referral_payouts[0].received_by === "u-jane")
    const again = await markReferralPayoutReceived(svc, { payoutId: "pay-1", brokerageId: "brk-jane", userId: "u-jane" })
    check("received: a second acknowledgment matches 0 (already received) and is refused, not re-stamped", !again.ok)

    const summary = await summarizeLedgerByProspect(["pr-1", "pr-2"], svc)
    const s1 = summary.byProspect.get("pr-1")
    check("summary: per-prospect totals — void excluded, received summed separately, latest posting first",
      !summary.unavailable && s1?.postedCents === 4900 && s1?.receivedCents === 4900 && s1?.recipientBrokerageId === "brk-jane" && summary.byProspect.get("pr-2")?.postedCents === 1000)
  }
  {
    const svc = fakeSvc(baseTables(), { missingTables: ["referral_payouts"] })
    const list = await listReferralEarningsForBrokerage("brk-jane", svc)
    const summary = await summarizeLedgerByProspect(["pr-1"], svc)
    check("pre-m573 reads: earnings + summary report unavailable with zero rows — degraded and SAID, never an empty lie",
      list.ok && list.unavailable && list.rows.length === 0 && summary.unavailable && summary.error === null)
  }
}

function pureLayer() {
  console.log("\n[Layer 2 · pure — parsing + fee math]")
  check("parseReferrerEmail: 'Jane Doe <jane@x.com>' → jane@x.com (lowered)", parseReferrerEmail("Jane Doe <JANE@X.com>") === "jane@x.com")
  check("parseReferrerEmail: bare email and embedded email both parse", parseReferrerEmail("jane@x.com") === "jane@x.com" && parseReferrerEmail("Jane jane@x.com ref") === "jane@x.com")
  check("parseReferrerEmail: name-only / garbage / empty → null", parseReferrerEmail("Jane Doe") === null && parseReferrerEmail("<not-an-email>") === null && parseReferrerEmail("") === null && parseReferrerEmail(null) === null)
  check("fee math: floor of MRR × percent / 100; garbage in → 0, never NaN into a ledger",
    computeReferralFeeCents(49900, 10) === 4990 && computeReferralFeeCents(999, 10) === 99
    && computeReferralFeeCents(-5, 10) === 0 && computeReferralFeeCents(NaN, 10) === 0 && computeReferralFeeCents(100, 0) === 0)
}

function sourceLayer() {
  console.log("\n[Layer 3 · source wiring — stripped scans with positive controls]")

  // POSITIVE CONTROLS first (§2): a broken finder and a clean tree both say 0.
  const commentSpecimen = "// legacy referral_fee.paid line lives only in this comment\nconst x = 1\n"
  check("control: stripComments removes a commented token (a tombstone is not a call site)",
    /referral_fee\.paid/.test(commentSpecimen) && !/referral_fee\.paid/.test(stripComments(commentSpecimen)))
  const countedRe = /\.update\([\s\S]*?\)[\s\S]{0,300}?\.select\("id"\)/
  check("control: the counted-update finder flags a fire-and-forget update",
    !countedRe.test(`await svc.from("referral_payouts").update({ status: "received" }).eq("id", id)\nreturn`)
    && countedRe.test(`await svc.from("referral_payouts").update({ status: "received" }).eq("id", id).select("id")`))
  const policyRe = /create\s+policy/i
  check("control: the RLS no-policy finder recognises a policy when one exists",
    policyRe.test("create policy tenant_read on public.referral_payouts for select using (true);") && !policyRe.test("alter table public.referral_payouts enable row level security;"))

  const lib = src("lib/platform/referral-payouts.ts")
  check("lib: the received-flip is scoped to recipient tenant + status AND counted (§3/§4)",
    /\.eq\("recipient_brokerage_id", input\.brokerageId\)/.test(lib) && /\.eq\("status", "posted"\)/.test(lib) && countedRe.test(lib))
  check("lib: the posting insert is .select()ed and its error READ (23505 / 42P01 branches)",
    /\.select\("id"\)\s*\.single\(\)/.test(lib) && /"23505"/.test(lib) && /42P01/.test(lib))
  check("lib: terms read platform_settings (one home) and report their source",
    /from\("platform_settings"\)/.test(lib) && /\.referral_fee_percent/.test(lib) && /"default_constant"/.test(lib) && /"platform_settings"/.test(lib))

  const act = src("app/actions/superadmin/subscriber-referrals.ts")
  check("action: mark-paid POSTS through the ledger (postReferralPayout) with the terms' percent",
    /postReferralPayout\(svc, \{/.test(act) && /feePercent: terms\.percent/.test(act))
  check("action: a ledger post writes the TRAIL action, never the legacy payment action (no double count)",
    /POSTED_TRAIL_ACTION/.test(act) && /"referral_payout\.posted"/.test(act))
  check("action: the legacy audit-line write survives ONLY as the labeled degraded path (m573 unapplied)",
    /reason !== "ledger_unavailable"/.test(act) && /ledger_unavailable: "referral_payouts missing — apply m573"/.test(act) && /"audit_log_legacy"/.test(act))
  check("action: fee display derives from getReferralFeeTerms, not the constant (the constant import is gone)",
    /getReferralFeeTerms\(svc\)/.test(act) && /computeReferralFeeCents\(mrrCents, terms\.percent\)/.test(act) && !/REFERRAL_FEE_PERCENT/.test(act))

  const recip = src("app/actions/admin/referral-earnings.ts")
  check("recipient action: tenant comes from the SESSION profile — never from a caller parameter (§4)",
    /auth\.brokerageId/.test(recip) && /\.eq\("id", user\.id\)/.test(recip)
    && !/input\.brokerageId/.test(recip) && !/params\.brokerageId/.test(recip))
  check("recipient action: gated by the tenant finance-admin predicate, fail closed",
    /isBrokerageFinanceAdmin\(/.test(recip) && /return \{ ok: false, error: "Unauthorized" \}/.test(recip))

  const page = src("app/dashboard/admin/billing/page.tsx")
  check("recipient surface: the tenant billing page fetches + renders the earnings card for its own admins",
    /getReferralEarningsAction\(\)/.test(page) && /<ReferralEarningsCard initialRows=\{referralEarnings\}/.test(page) && /isTenantBillingAdmin && \(userProfile as any\)\.brokerage_id/.test(page))

  const card = src("app/dashboard/admin/billing/referral-earnings-card.tsx")
  check("recipient card: acknowledges through the session-gated action (no direct table access in the client)",
    /acknowledgeReferralPayoutAction\(\{ payoutId \}\)/.test(card) && !/createServiceClient|createClient\(/.test(card))

  const growth = src("app/dashboard/superadmin/growth/subscriber-referrals-card.tsx")
  check("superadmin card: shows the ledger's posted/received state beside lifetime history",
    /ledgerPostedCents/.test(growth) && /ledgerReceivedCents/.test(growth))

  const migPath = "supabase/migrations/m573-a-paid-referral-fee-was-a-log-line-and-the-referrer-never-saw-it.sql"
  const mig = raw(migPath)
  check("m573: idempotency key UNIQUE(prospect_id, period) exists", /unique \(prospect_id, period\)/.test(mig))
  check("m573: terms column on platform_settings with a range CHECK", /platform_settings\s+add column if not exists referral_fee_percent/.test(mig) && /referral_fee_percent >= 0 and referral_fee_percent <= 50/.test(mig))
  check("m573: ledger is RLS-on with NO policy (service-role only — the same posture as platform_config_snapshots)",
    /alter table public\.referral_payouts enable row level security/.test(mig) && !policyRe.test(mig))
  check("m573: money history survives people/prospect churn (restrict on prospect, set null on users)",
    /references public\.platform_prospects\(id\) on delete restrict/.test(mig) && /references public\.users\(id\) on delete set null/.test(mig))

  const reg = src("lib/kernel/manager-registry.ts")
  check("registry: referral_payouts stewarded by finance_manager; domain entry carries this proof",
    /referral_payouts:\s*"finance_manager"/.test(reg) && /referral_payout_posting:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:referral-payouts"/.test(reg))
  check("package.json wires the proof", /"test:referral-payouts":\s*"tsx scripts\/referral-payouts-simulator\.ts"/.test(raw("package.json")))
}

function agreementLayer() {
  console.log("\n[Layer 4 · vocabulary agreement — code set == m573 CHECK set, derived not pinned]")
  const mig = raw("supabase/migrations/m573-a-paid-referral-fee-was-a-log-line-and-the-referrer-never-saw-it.sql")
  const m = /status in \(([^)]*)\)/.exec(mig)
  const sqlSet = new Set((m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean))
  const codeSet = new Set<string>(REFERRAL_PAYOUT_STATUSES)
  check(`referral_payouts.status: code vocabulary equals the migration CHECK ({${[...sqlSet].join(", ")}})`,
    sqlSet.size > 0 && sqlSet.size === codeSet.size && [...codeSet].every((s) => sqlSet.has(s)))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Subscriber-referral payouts — posted + received")
  console.log("══════════════════════════════════════════════════")
  await behaviorLayer()
  pureLayer()
  sourceLayer()
  agreementLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(" BLIND SPOTS: no live layer (lane read-only; referral_payouts absent until m573 is applied);")
  console.log(" external-referrer cash rail + Stripe balance-credit application unbuilt (declared, needs a")
  console.log(" STRIPE_MONEY_PATHS entry — see lib/platform/referral-payouts.ts header).")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ REFERRAL_PAYOUTS_PASS — posted = an idempotent ledger row with a resolved recipient; received = the recipient's own counted acknowledgment")
}
main().catch((e) => { console.error(e); process.exit(1) })
