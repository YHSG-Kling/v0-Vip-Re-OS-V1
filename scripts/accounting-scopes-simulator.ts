#!/usr/bin/env tsx
/**
 * scripts/accounting-scopes-simulator.ts
 *   run: npx tsx --conditions=react-server scripts/accounting-scopes-simulator.ts
 *   suggested npm script (NOT added here — package.json is owned elsewhere):
 *     "test:accounting-scopes": "tsx --conditions=react-server scripts/accounting-scopes-simulator.ts"
 *
 * ROUND 36 PROOF — "platform, vendors, brokerages, teams and agents should have
 * quickbooks and/or stripe options" — as ONE coherent scope-aware connection
 * model, not five copies:
 *
 *  Layer 1 (pure): the offering matrix (per-level QuickBooks/Stripe:
 *    connectable / managed-elsewhere / not-offered with documented verdicts),
 *    owner resolution per scope (no cross-scope fallback), storage-key rules.
 *  Layer 2 (isolation): no cross-scope token leakage — exact-owner filters
 *    differ across scopes, the platform's own books live under a DISTINCT
 *    storage key the tenant alias set can never resolve, and the export lanes
 *    never use the credential cascade.
 *  Layer 3 (behavioral, stubbed I/O — no network): the export lanes are
 *    honest — not-connected ⇒ { attempted:false } (renders "Not synced");
 *    missing migration ⇒ honest error BEFORE any egress; already-exported ⇒
 *    idempotent return with no credential read; and the credential filter a
 *    team/agent export actually issues is its OWN owner, never another's.
 *  Layer 4 (source locks): keep-one card reuse across all five surfaces, the
 *    dead /api/auth/quickbooks/connect path is gone, the OAuth route carries
 *    the realmId + platform-scope fixes, vendor-quickbooks rides the shared
 *    layer, and the not-offered verdicts are rendered — not dead buttons.
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
// scoped-accounting-export imports `server-only`, which throws outside a Server
// Component. Neutralize it in the require cache BEFORE importing anything that
// transitively pulls it (the buyer-intent-conversion sim's established idiom).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
import {
  ACCOUNTING_SCOPES,
  ACCOUNTING_OFFERINGS,
  QUICKBOOKS_OAUTH_START,
  PLATFORM_OWNER_ID,
  PLATFORM_BOOKS_STORAGE_KEY,
  quickbooksStorageKey,
  isAccountingConnectorOffered,
  resolveAccountingOwner,
  accountingOwnerFilter,
  type AccountingScope,
} from "../lib/connections/accounting-scopes"
import { aliasesFor } from "../lib/integrations/connection-manager"
import { isConnectSupported, connectionScopeForUserType } from "../lib/connections/field-spec"
import {
  QB_RECONCILIATION_HEADER,
  reconcileLedgerRows,
  reconcileAgainstSyncLog,
  monthLabelsBetween,
  loadTeamQbReconciliation,
  loadAgentQbReconciliation,
  loadVendorQbReconciliation,
  loadPlatformQbReconciliation,
} from "../lib/finance/qb-reconciliation"
// Dynamic import: static ESM imports hoist above the server-only shim, so the
// tainted module must load AFTER the require-cache neutralization runs.
const { pushTeamPnlToQuickBooks, pushAgentCommissionToQuickBooks } = await import("../lib/finance/scoped-accounting-export")

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(title: string) { console.log(`\n■ ${title}`) }

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1 — offering matrix (per-level QuickBooks and/or Stripe, honest verdicts)")

check("five accounting scopes, no contact", ACCOUNTING_SCOPES.length === 5 && !ACCOUNTING_SCOPES.includes("contact" as AccountingScope))

for (const scope of ACCOUNTING_SCOPES) {
  const o = ACCOUNTING_OFFERINGS[scope]
  check(`${scope}: QuickBooks is CONNECTABLE via the one real OAuth route`,
    o.quickbooks.status === "connectable" && o.quickbooks.connectPath === QUICKBOOKS_OAUTH_START)
}
check("vendor: Stripe CONNECTABLE (Connect onboarding — the only scope with a real payout consumer)",
  ACCOUNTING_OFFERINGS.vendor.stripe.status === "connectable" && ACCOUNTING_OFFERINGS.vendor.stripe.connectPath === "/vendor/earnings")
check("team: Stripe NOT-OFFERED with a documented no-team-billing verdict (not a dead button)",
  ACCOUNTING_OFFERINGS.team.stripe.status === "not-offered"
  && ACCOUNTING_OFFERINGS.team.stripe.connectPath === null
  && /no team billing/i.test(ACCOUNTING_OFFERINGS.team.stripe.verdict))
check("agent: Stripe NOT-OFFERED with a documented no-payout-lane verdict",
  ACCOUNTING_OFFERINGS.agent.stripe.status === "not-offered"
  && ACCOUNTING_OFFERINGS.agent.stripe.connectPath === null
  && ACCOUNTING_OFFERINGS.agent.stripe.verdict.length > 40)
check("platform: Stripe MANAGED-ELSEWHERE (it IS the billing spine, never a connectable credential)",
  ACCOUNTING_OFFERINGS.platform.stripe.status === "managed-elsewhere"
  && /billing spine/i.test(ACCOUNTING_OFFERINGS.platform.stripe.verdict))
check("brokerage: Stripe MANAGED-ELSEWHERE (billing customer on the platform's Stripe)",
  ACCOUNTING_OFFERINGS.brokerage.stripe.status === "managed-elsewhere"
  && ACCOUNTING_OFFERINGS.brokerage.stripe.connectPath === "/settings/billing")
check("isAccountingConnectorOffered mirrors the matrix",
  isAccountingConnectorOffered("vendor", "stripe") === true
  && isAccountingConnectorOffered("team", "stripe") === false
  && isAccountingConnectorOffered("platform", "quickbooks") === true)
check("every non-connectable offering carries a non-empty verdict",
  ACCOUNTING_SCOPES.every((s) =>
    (["quickbooks", "stripe"] as const).every((c) => {
      const o = ACCOUNTING_OFFERINGS[s][c]
      return o.status === "connectable" || o.verdict.trim().length > 20
    })))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1b — owner resolution (each scope resolves its OWN entity, no fallback)")

const ids = { brokerageId: "b-1", teamId: "t-1", agentUserId: "u-1", vendorId: "v-1" }
check("platform → sentinel 'platform' owner",
  resolveAccountingOwner("platform", {})?.ownerId === PLATFORM_OWNER_ID)
check("brokerage → brokerage id", resolveAccountingOwner("brokerage", ids)?.ownerId === "b-1")
check("team → team id", resolveAccountingOwner("team", ids)?.ownerId === "t-1")
check("agent → auth USER id (what the OAuth callback writes)", resolveAccountingOwner("agent", ids)?.ownerId === "u-1")
check("vendor → vendor id", resolveAccountingOwner("vendor", ids)?.ownerId === "v-1")
check("team WITHOUT a team anchor → honest null (never falls back to the brokerage)",
  resolveAccountingOwner("team", { brokerageId: "b-1" }) === null)
check("agent WITHOUT a user anchor → honest null",
  resolveAccountingOwner("agent", { brokerageId: "b-1", teamId: "t-1" }) === null)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 2 — no cross-scope token leakage")

check("platform books use the DISTINCT storage key (m273 idiom)",
  quickbooksStorageKey("platform") === PLATFORM_BOOKS_STORAGE_KEY && String(PLATFORM_BOOKS_STORAGE_KEY) !== "quickbooks")
check("tenant scopes share the 'quickbooks' key (rows differ by owner)",
  (["brokerage", "team", "agent", "vendor"] as const).every((s) => quickbooksStorageKey(s) === "quickbooks"))
check("the tenant alias set can NEVER resolve the company's books",
  !aliasesFor("quickbooks").includes(PLATFORM_BOOKS_STORAGE_KEY))

// A team token can never serve a brokerage export (and so on): the exact-owner
// filter is unique per (scope, owner) — even for an identical id string.
const filters = ACCOUNTING_SCOPES.map((s) => accountingOwnerFilter(s, "same-id"))
const uniq = new Set(filters.map((f) => `${f.owner_type}|${f.owner_id}|${f.platform}`))
check("exact-owner filters are unique per scope (same id, five distinct filters)", uniq.size === 5)
check("team filter is owner_type='team' (never brokerage)",
  accountingOwnerFilter("team", "t-1").owner_type === "team")

const scopesSrc = src("lib/connections/accounting-scopes.ts")
const exportSrc = src("lib/finance/scoped-accounting-export.ts")
check("accounting layer never uses the credential CASCADE (exact owner match only — no resolve-scoped import, no cascade call)",
  !scopesSrc.includes("resolve-scoped") && !scopesSrc.includes("scopeCascade(")
  && !exportSrc.includes("resolve-scoped") && !exportSrc.includes("scopeCascade("))
check("brokerage-book exports remain exclusively accounting-egress (this lane loads team/agent credentials only)",
  /loadScopedQuickBooksCredential\(svc, "team"/.test(exportSrc)
  && /loadScopedQuickBooksCredential\(svc, "agent"/.test(exportSrc)
  && !/loadScopedQuickBooksCredential\(svc, "brokerage"/.test(exportSrc))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3 — honest export behavior (stubbed I/O, zero network)")

type StubResult = { data: unknown; error: { message: string } | null }
/** Minimal chainable Supabase stub: per-table maybeSingle results + access log. */
function stubSvc(tables: Record<string, StubResult | StubResult[]>, log: Array<{ table: string; filters: Record<string, unknown> }>) {
  const consume = (table: string): StubResult => {
    const r = tables[table]
    if (Array.isArray(r)) return r.shift() ?? { data: null, error: null }
    return r ?? { data: null, error: null }
  }
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {}
    const b: any = {
      select: () => b,
      update: () => b,
      insert: () => b,
      eq: (k: string, v: unknown) => { filters[k] = v; return b },
      in: (k: string, v: unknown) => { filters[k] = v; return b },
      is: (k: string, v: unknown) => { filters[`is:${k}`] = v; return b },
      gte: (k: string, v: unknown) => { filters[`gte:${k}`] = v; return b },
      lt: (k: string, v: unknown) => { filters[`lt:${k}`] = v; return b },
      not: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => { log.push({ table, filters }); return consume(table) },
      then: (res: any, rej: any) => { log.push({ table, filters }); return Promise.resolve(consume(table)).then(res, rej) },
    }
    return b
  }
  return { from: (table: string) => builder(table) } as any
}

{
  // Missing migration → honest error, NO credential read, NO egress.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    team_earnings: { data: null, error: { message: 'column team_earnings.quickbooks_export_id does not exist' } },
  }, log)
  const out = await pushTeamPnlToQuickBooks(svc, { teamId: "t-1", periodLabel: "2026-07" })
  check("team export, missing migration → attempted:false + honest 'requires migration' error",
    out.attempted === false && out.success === false && /migration/i.test(out.error ?? ""))
  check("…and the credential store was never touched", !log.some((l) => l.table === "platform_credentials"))
}
{
  // Not connected → attempted:false ("Not synced" in the UI), never a fake marker.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    team_earnings: { data: { team_id: "t-1", brokerage_id: "b-1", period_label: "2026-07", gross_commission: 12000, quickbooks_export_id: null }, error: null },
    platform_credentials: { data: null, error: null },
  }, log)
  const out = await pushTeamPnlToQuickBooks(svc, { teamId: "t-1", periodLabel: "2026-07" })
  check("team export, not connected → { attempted:false } (honest unsynced state)",
    out.attempted === false && out.success === false && !out.externalId)
  const credRead = log.find((l) => l.table === "platform_credentials")
  check("…credential read used the TEAM's exact owner filter (never the brokerage's)",
    !!credRead && credRead.filters.owner_type === "team" && credRead.filters.owner_id === "t-1" && credRead.filters.platform === "quickbooks")
}
{
  // Already exported → idempotent success, no credential read, no second receipt.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    team_earnings: { data: { team_id: "t-1", brokerage_id: "b-1", period_label: "2026-07", gross_commission: 12000, quickbooks_export_id: "QB-77" }, error: null },
  }, log)
  const out = await pushTeamPnlToQuickBooks(svc, { teamId: "t-1", periodLabel: "2026-07" })
  check("team export, already exported → idempotent return of the existing QBO id",
    out.attempted === true && out.success === true && out.externalId === "QB-77")
  check("…with no credential read at all", !log.some((l) => l.table === "platform_credentials"))
}
{
  // Agent export: ownership verified; not-connected path uses the AGENT's exact owner filter.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    agents: { data: { id: "a-9", brokerage_id: "b-1" }, error: null },
    agent_commissions: { data: { id: "c-1", agent_id: "a-9", gross_commission: 9000, agent_commission: 7200, property_address: "1 Main St", close_date: "2026-07-01", quickbooks_export_id: null }, error: null },
    platform_credentials: { data: null, error: null },
  }, log)
  const out = await pushAgentCommissionToQuickBooks(svc, { agentUserId: "u-1", commissionId: "c-1" })
  check("agent export, not connected → { attempted:false } (honest unsynced state)",
    out.attempted === false && out.success === false)
  const credRead = log.find((l) => l.table === "platform_credentials")
  check("…credential read used the AGENT's exact owner filter (owner_id = auth user id)",
    !!credRead && credRead.filters.owner_type === "agent" && credRead.filters.owner_id === "u-1" && credRead.filters.platform === "quickbooks")
}
{
  // No agent profile → nothing attempted (one agent can never export another's record).
  const svc = stubSvc({ agents: { data: null, error: null } }, [])
  const out = await pushAgentCommissionToQuickBooks(svc, { agentUserId: "u-nobody", commissionId: "c-1" })
  check("agent export without an agent profile → attempted:false", out.attempted === false && out.success === false)
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3b — connect-flow gating (role → scope, buttons only where real)")

check("field-spec: QuickBooks OAuth is owner-scoped for ANY owner-capable actor (vendor included)",
  isConnectSupported("financial", "quickbooks", { canOwn: true, hasAgentId: false, isBrokerageManager: false, hasBrokerage: true }).available === true)
check("field-spec: no ownership anchor → no connect",
  isConnectSupported("financial", "quickbooks", { canOwn: false, hasAgentId: false, isBrokerageManager: false, hasBrokerage: true }).available === false)
check("role → scope mapping covers all five levels",
  connectionScopeForUserType("superadmin").scope === "platform"
  && connectionScopeForUserType("broker").scope === "brokerage"
  && connectionScopeForUserType("team_lead").scope === "team"
  && connectionScopeForUserType("agent").scope === "agent"
  && connectionScopeForUserType("vendor").scope === "vendor")

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 4 — source locks (keep-one reuse, real routes, honest wiring)")

const cardSrc = src("app/settings/accounting/provider-connection-card.tsx")
check("the ONE card: dead /api/auth/quickbooks/connect path is GONE", !cardSrc.includes("/api/auth/quickbooks/connect"))
check("the ONE card renders not-offered verdicts and managed-elsewhere notes (no dead buttons)",
  cardSrc.includes('"not-offered"') && cardSrc.includes('"managed-elsewhere"') && cardSrc.includes("Not offered"))
check("the ONE card scopes disconnect (brokerage action vs owner-scoped action + vendor owner hint)",
  cardSrc.includes("disconnectBrokerageAccounting") && cardSrc.includes("disconnectOwnerScoped"))

const surfaces: Array<[string, string]> = [
  ["brokerage", "app/settings/accounting/page.tsx"],
  ["team", "app/dashboard/financials/team/page.tsx"],
  ["agent", "app/dashboard/financials/agent/page.tsx"],
  ["platform", "app/dashboard/superadmin/platform/page.tsx"],
  ["vendor", "app/vendor/invoices/invoices-client.tsx"],
]
for (const [level, file] of surfaces) {
  check(`${level} surface reuses the ONE card (${file})`, src(file).includes("provider-connection-card"))
}
check("team surface documents the Stripe not-offered verdict", src("app/dashboard/financials/team/page.tsx").includes("ACCOUNTING_OFFERINGS.team.stripe"))
check("agent surface documents the Stripe not-offered verdict", src("app/dashboard/financials/agent/page.tsx").includes("ACCOUNTING_OFFERINGS.agent.stripe"))
check("platform surface uses the distinct platform books key + sentinel owner",
  src("app/dashboard/superadmin/platform/page.tsx").includes("PLATFORM_BOOKS_STORAGE_KEY")
  && src("app/dashboard/superadmin/platform/page.tsx").includes("PLATFORM_OWNER_ID"))

const routeSrc = src("app/api/integrations/oauth/[provider]/route.ts")
check("OAuth route captures Intuit's callback realmId (query param — was silently dropped before)",
  routeSrc.includes('searchParams.get("realmId")'))
check("OAuth route stores the platform's OWN QuickBooks under the distinct key",
  routeSrc.includes('"platform_quickbooks"'))
check("OAuth route: platform scope gets sentinel owner + no brokerage requirement",
  routeSrc.includes('ownerId = "platform"') && routeSrc.includes('scope !== "platform"'))
check("OAuth route guards tenant-only side effects when no brokerage anchors the connect",
  /if \(stateData\.brokerageId\) \{/.test(routeSrc))

const vendorQbSrc = src("lib/connections/vendor-quickbooks.ts")
check("vendor-quickbooks refactored ONTO the shared layer (keep-one QBO helpers)",
  vendorQbSrc.includes('from "@/lib/connections/accounting-scopes"')
  && vendorQbSrc.includes("loadScopedQuickBooksCredential")
  && !vendorQbSrc.includes("async function loadVendorQBCredential"))
check("vendor-quickbooks keeps the honest sync marker contract", vendorQbSrc.includes("quickbooks_invoice_id"))

const fieldSpecSrc = src("lib/connections/field-spec.ts")
check("field-spec no longer falsely claims QuickBooks is brokerage-only",
  !fieldSpecSrc.includes("Connect QuickBooks at the brokerage level."))

const acctSyncSrc = src("app/actions/accounting-sync.ts")
check("brokerage status/disconnect now see the owner-scoped row the OAuth callback writes",
  acctSyncSrc.includes('"owner_type", "brokerage"'))

check("export lanes carry the honest markers (attempted:false + migration pre-flight)",
  exportSrc.includes("attempted: false") && /quickbooks_export_id/i.test(exportSrc) && exportSrc.includes("missingMigrationError"))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 5 — QuickBooks reconciliation math (round 37: coverage %, unexported detection)")

{
  const rows = [
    { id: "a", label: "Commission A", amount: 1000, exportId: "QB-1", syncedAt: "2026-07-01" },
    { id: "b", label: "Commission B", amount: 2000, exportId: "QB-2", syncedAt: "2026-07-02" },
    { id: "c", label: "Commission C", amount: 3000, exportId: null, syncedAt: null },
    { id: "d", label: "Commission D", amount: 500, exportId: "QB-3", syncedAt: "2026-07-03" },
  ]
  const t = reconcileLedgerRows(rows)
  check("marker-based: coverage % is row-based (3/4 → 75%)", t.coveragePct === 75 && t.exportedRows === 3 && t.totalRows === 4)
  check("marker-based: amount totals BOTH sides (6500 ledger / 3500 exported / 3000 unexported)",
    t.totalAmount === 6500 && t.exportedAmount === 3500 && t.unexportedAmount === 3000)
  check("marker-based: unexported DETECTION names the exact row", t.unexported.length === 1 && t.unexported[0].id === "c")
}
{
  const t = reconcileLedgerRows([])
  check("empty period → coveragePct null (never a fake 0% or 100%)", t.coveragePct === null && t.totalRows === 0 && t.unexported.length === 0)
}
{
  const rows = [
    { id: "e1", label: "Expense", amount: 100 },
    { id: "e2", label: "Expense", amount: 200 },
    { id: "c1", label: "Commission", amount: 9000 },
    { id: "c2", label: "Commission", amount: 5000 },
    { id: "c3", label: "Commission", amount: 4000 },
  ]
  const t = reconcileAgainstSyncLog(rows, 3)
  check("log-based (brokerage lane): count-based coverage (3 completed / 5 rows → 60%)",
    t.coveragePct === 60 && t.exportedRows === 3 && t.unexportedRows === 2)
  check("log-based: exported AMOUNTS are honestly null (the log records counts, not row identity)",
    t.exportedAmount === null && t.unexportedAmount === null && t.totalAmount === 18300)
  const capped = reconcileAgainstSyncLog(rows, 10)
  check("log-based: completed pushes can never claim >100% coverage", capped.coveragePct === 100 && capped.exportedRows === 5)
}
check("monthLabelsBetween covers the window months, exclusive end",
  JSON.stringify(monthLabelsBetween("2026-05-01T00:00:00Z", "2026-08-01T00:00:00Z")) === JSON.stringify(["2026-05", "2026-06", "2026-07"]))
check("the standing honesty header says it is NOT a live QuickBooks pull",
  /not a live QuickBooks pull/i.test(QB_RECONCILIATION_HEADER))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 5b — reconciliation loaders (stubbed I/O: honesty + scope isolation)")

const RECON_PERIOD = { periodStart: "2026-05-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z", periodLabel: "May – Jul 2026" }

{
  // Missing marker columns → honest 'requires_migration' — numbers are never invented.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    team_earnings: { data: null, error: { message: "column team_earnings.quickbooks_export_id does not exist" } },
    platform_credentials: { data: null, error: null },
  }, log)
  const r = await loadTeamQbReconciliation(svc, { teamId: "t-1", ...RECON_PERIOD })
  check("team reconciliation, missing migration → status 'requires_migration' with zeroed totals",
    r.status === "requires_migration" && r.totals.totalRows === 0 && /migration/i.test(r.statement))
}
{
  // Team rows reconcile; the query is the TEAM's own (scope isolation), monthly labels.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    team_earnings: {
      data: [
        { period_label: "2026-06", gross_commission: 12000, quickbooks_export_id: "QB-7", quickbooks_synced_at: "2026-07-01" },
        { period_label: "2026-07", gross_commission: 8000, quickbooks_export_id: null, quickbooks_synced_at: null },
      ],
      error: null,
    },
    platform_credentials: { data: { id: "pc-1", access_token: "tok", refresh_token: "r", account_id: "realm-1", account_name: "Team Co", token_expires_at: null, config: {}, is_active: true }, error: null },
  }, log)
  const r = await loadTeamQbReconciliation(svc, { teamId: "t-1", ...RECON_PERIOD })
  check("team reconciliation → 50% coverage, the unexported month named",
    r.status === "reconciled" && r.connected === true && r.totals.coveragePct === 50
    && r.totals.unexported.length === 1 && r.totals.unexported[0].id === "2026-07")
  const earnRead = log.find((l) => l.table === "team_earnings")
  check("…ledger read is the TEAM's own rows (team_id filter + mtd period rows)",
    !!earnRead && earnRead.filters.team_id === "t-1" && earnRead.filters.period_type === "mtd")
  const credRead = log.find((l) => l.table === "platform_credentials")
  check("…connected check uses the TEAM's exact owner filter (never another scope's)",
    !!credRead && credRead.filters.owner_type === "team" && credRead.filters.owner_id === "t-1")
}
{
  // Agent reconciliation resolves the caller's OWN agent row first (isolation).
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    agents: { data: { id: "a-9" }, error: null },
    agent_commissions: {
      data: [
        { id: "c-1", close_date: "2026-06-15", gross_commission: 9000, agent_commission: 7200, quickbooks_export_id: null, quickbooks_synced_at: null },
      ],
      error: null,
    },
    platform_credentials: { data: null, error: null },
  }, log)
  const r = await loadAgentQbReconciliation(svc, { agentUserId: "u-1", ...RECON_PERIOD })
  check("agent reconciliation, not connected → status 'not_connected' with the honest unexported count",
    r.status === "not_connected" && r.connected === false && r.totals.unexportedRows === 1 && r.totals.totalAmount === 7200)
  const commRead = log.find((l) => l.table === "agent_commissions")
  check("…commission read is scoped to the caller's OWN agent row", !!commRead && commRead.filters.agent_id === "a-9")
}
{
  // Vendor reconciliation filters the VENDOR's own invoices (isolation).
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({
    vendor_invoices: {
      data: [
        { id: "i-1", invoice_number: "INV-1", total_amount: 450, created_at: "2026-06-01", quickbooks_invoice_id: "QBI-1", quickbooks_synced_at: "2026-06-02" },
        { id: "i-2", invoice_number: "INV-2", total_amount: 300, created_at: "2026-07-01", quickbooks_invoice_id: null, quickbooks_synced_at: null },
      ],
      error: null,
    },
    platform_credentials: { data: { id: "pc-2", access_token: "tok", refresh_token: "r", account_id: "realm-9", account_name: "Vendor Co", token_expires_at: null, config: {}, is_active: true }, error: null },
  }, log)
  const r = await loadVendorQbReconciliation(svc, { vendorId: "v-1", ...RECON_PERIOD })
  check("vendor reconciliation → 50% coverage against the m1104 markers",
    r.status === "reconciled" && r.totals.coveragePct === 50 && r.totals.unexported[0]?.id === "i-2")
  const invRead = log.find((l) => l.table === "vendor_invoices")
  check("…invoice read is the VENDOR's own (vendor_id filter)", !!invRead && invRead.filters.vendor_id === "v-1")
}
{
  // Platform: honest 'no export lane' — a stated absence, never an invented number.
  const svc = stubSvc({ platform_credentials: { data: null, error: null } }, [])
  const r = await loadPlatformQbReconciliation(svc, RECON_PERIOD)
  check("platform reconciliation → status 'no_export_lane' with the honest statement",
    r.status === "no_export_lane" && r.totals.totalRows === 0 && /no OS export lane/i.test(r.statement))
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 5c — reconciliation source locks (one card, five mounts, monthly rail)")

const reconCardSrc = src("app/settings/accounting/qb-reconciliation-card.tsx")
check("the ONE reconciliation card states the not-a-live-pull honesty in its description",
  /not a live\s*\n?\s*QuickBooks pull/i.test(reconCardSrc.replace(/\s+/g, " ")))
const reconSurfaces: Array<[string, string]> = [
  ["brokerage", "app/settings/accounting/page.tsx"],
  ["team", "app/dashboard/financials/team/page.tsx"],
  ["agent", "app/dashboard/financials/agent/page.tsx"],
  ["vendor", "app/vendor/invoices/page.tsx"],
  ["platform", "app/dashboard/superadmin/platform/page.tsx"],
]
for (const [level, file] of reconSurfaces) {
  check(`${level} surface mounts the ONE reconciliation card`, src(file).includes("QbReconciliationCard"))
}
const packetSrc = src("lib/kernel/board-packet.ts")
check("board packet (monthly rail) carries the reconciliation section OMIT-WHEN-EMPTY",
  packetSrc.includes("qbReconciliation") && packetSrc.includes("recon.connected === true && recon.totals.totalRows > 0"))
const reconLibSrc = src("lib/finance/qb-reconciliation.ts")
check("reconciliation is READ-SIDE only (no Intuit egress: no qboRequest, no token refresh)",
  !reconLibSrc.includes("qboRequest") && !reconLibSrc.includes("ensureFreshQuickBooksToken"))
check("brokerage lane is honestly count-based (log_based status + null exported amounts)",
  reconLibSrc.includes('"log_based"') && reconLibSrc.includes("exportedAmount: null"))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}\n${fail === 0 ? "✅" : "❌"} accounting-scopes simulator: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
