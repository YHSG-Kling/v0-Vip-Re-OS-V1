#!/usr/bin/env tsx
/**
 * scripts/lead-import-list-cost-guard.ts   (npm run test:lead-import-list-cost)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 89E (wave 89) — a PURCHASED LIST's cost is TENANT spend (lane 88B's recorded next step;
 * owner wave 88: "spend should be what the tenant spent for that lead"; owner wave 89: "add any
 * fields necessary if there is a beneficial reason to add"). m678 adds lead_imports.list_cost_usd.
 *
 * Proven on the REAL code (no DB, no network — the service-client edge is scripts/in-memory-supabase.ts):
 *   A · the ONE payer vocabulary carries the part: purchasedListShare is TENANT-paid
 *       (computeLeadAcquisitionCost sums it; computePlatformPaidLeadCost never does).
 *   B · purchasedListShareUsd: list ÷ rows, cents-rounded; null when no cost / no rows / negative.
 *   C · stampPurchasedListCost on the in-memory client: a CREATED contact carries its share; a MERGED
 *       contact has the share ADDED to what it carried; a refused write is RETURNED; a wrong-tenant
 *       id (zero rows matched) is reported, never "stamped"; a null share is a no-op.
 *   D · the import action reads list_cost_usd + total_rows, calls the stamp per captured row, and
 *       createImportRecord writes list_cost_usd (never negative); the import page carries the field
 *       and the history column; the migration declares the column with a non-negative CHECK.
 * Every absence rule has a POSITIVE CONTROL. Rule, not waypoint: no "applied/not applied" pin, no
 * row count, no date.
 * Run: npx tsx scripts/lead-import-list-cost-guard.ts
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('not used by this proof') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const C1 = "c1000000-0000-4000-8000-000000000001"
const C2 = "c1000000-0000-4000-8000-000000000002"

async function main() {
  console.log("\n[A · purchasedListShare is a TENANT-paid part of the ONE payer vocabulary]")
  const L = await import("../lib/lead-pipeline/source-conversion-learning")
  ok("computeLeadAcquisitionCost({ purchasedListShare: 0.5 }) = 0.50 (tenant)", L.computeLeadAcquisitionCost({ purchasedListShare: 0.5 }) === 0.5)
  ok("computePlatformPaidLeadCost({ purchasedListShare: 0.5 }) = null (the platform never paid for the list)", L.computePlatformPaidLeadCost({ purchasedListShare: 0.5 }) === null)
  ok("a list share ADDS to the tenant's campaign share (0.5 + 25 = 25.5), never to the platform's raw/enrichment",
    L.computeLeadAcquisitionCost({ costPerRecord: 0.5, enrichmentSpend: 0.32, campaignCostShare: 25, purchasedListShare: 0.5 }) === 25.5
    && L.computePlatformPaidLeadCost({ costPerRecord: 0.5, enrichmentSpend: 0.32, campaignCostShare: 25, purchasedListShare: 0.5 }) === 0.82)
  const learning = code("lib/lead-pipeline/source-conversion-learning.ts")
  ok("LEAD_COST_PAYER names purchasedListShare: \"tenant\" (a part lands with its payer or it does not compile)", /purchasedListShare:\s*"tenant"/.test(learning))
  ok("POSITIVE CONTROL: the payer finder would flag a platform assignment", /purchasedListShare:\s*"tenant"/.test(`purchasedListShare: "platform"`) === false && /purchasedListShare:\s*"platform"/.test(`purchasedListShare: "platform"`))

  console.log("\n[B · purchasedListShareUsd — the pure split]")
  const S = await import("../lib/lead-import/list-cost-stamp")
  ok("$250 over 1,000 rows = $0.25 per row", S.purchasedListShareUsd(250, 1000) === 0.25)
  ok("$100 over 3 rows is cents-rounded (33.33)", S.purchasedListShareUsd(100, 3) === 33.33)
  ok("no cost → null (\"unknown\" is not $0)", S.purchasedListShareUsd(null, 100) === null && S.purchasedListShareUsd(undefined, 100) === null)
  ok("zero or negative cost → null; zero rows → null", S.purchasedListShareUsd(0, 100) === null && S.purchasedListShareUsd(-5, 100) === null && S.purchasedListShareUsd(50, 0) === null)

  console.log("\n[C · stampPurchasedListCost on the in-memory client]")
  const svc = memSupabase({
    contacts: [
      { id: C1, brokerage_id: BRK, acquisition_cost: null },
      { id: C2, brokerage_id: BRK, acquisition_cost: 12 },
    ],
  })
  const created = await S.stampPurchasedListCost(svc, { brokerageId: BRK, contactId: C1, shareUsd: 0.25, merged: false })
  ok("a CREATED contact carries its share (0.25)", created.ok && created.stamped === 1 && svc.tables.contacts.find((r) => r.id === C1)?.acquisition_cost === 0.25, JSON.stringify(created))
  const merged = await S.stampPurchasedListCost(svc, { brokerageId: BRK, contactId: C2, shareUsd: 0.25, merged: true })
  ok("a MERGED contact has the share ADDED to what it carried (12 + 0.25 = 12.25) — the tenant paid for that record too",
    merged.ok && svc.tables.contacts.find((r) => r.id === C2)?.acquisition_cost === 12.25, JSON.stringify(merged))
  const wrongTenant = await S.stampPurchasedListCost(svc, { brokerageId: OTHER, contactId: C1, shareUsd: 0.25, merged: false })
  ok("a wrong-tenant contact id matches ZERO rows and is REPORTED, never \"stamped\" (CLAUDE.md §3: a no-match resolves too)",
    !wrongTenant.ok && wrongTenant.stamped === 0 && /matched no row/.test(wrongTenant.error ?? ""), JSON.stringify(wrongTenant))
  const noop = await S.stampPurchasedListCost(svc, { brokerageId: BRK, contactId: C1, shareUsd: null, merged: false })
  ok("a null share is a no-op (not a purchased list)", noop.ok && noop.stamped === 0 && svc.tables.contacts.find((r) => r.id === C1)?.acquisition_cost === 0.25)
  const refused = memSupabase({ contacts: [{ id: C1, brokerage_id: BRK }] }, { refuse: { contacts: "permission denied for table contacts" } })
  const r = await S.stampPurchasedListCost(refused, { brokerageId: BRK, contactId: C1, shareUsd: 0.25, merged: false })
  ok("a REFUSED write is returned as the error, never swallowed", !r.ok && /refused/.test(r.error ?? "") && /permission denied/.test(r.error ?? ""), JSON.stringify(r))
  const refusedMerge = await S.stampPurchasedListCost(refused, { brokerageId: BRK, contactId: C1, shareUsd: 0.25, merged: true })
  ok("a REFUSED read on the merge path is returned too", !refusedMerge.ok && /read refused/.test(refusedMerge.error ?? ""), JSON.stringify(refusedMerge))

  console.log("\n[D · the writer, the stamp call, the page, the migration]")
  const actions = code("app/actions/lead-import/import-actions.ts")
  ok("processImportRows reads list_cost_usd + total_rows off the import row", /select\('brokerage_id, total_rows, list_cost_usd'\)/.test(actions))
  ok("…derives the share through purchasedListShareUsd (the ONE split, never a hand division)", /purchasedListShareUsd\(/.test(actions) && !/list_cost_usd\s*\/\s*total_rows/.test(actions))
  ok("…and stamps EVERY captured row through stampPurchasedListCost with the session tenant, merged by the capture verdict",
    /stampPurchasedListCost\(supabase,\s*\{\s*brokerageId,\s*contactId,\s*shareUsd:\s*listShareUsd,\s*merged:\s*action !== 'created'/.test(actions))
  ok("…and a refused stamp lands in the import's per-row error_details (never a silent $0)", /list cost not recorded/.test(actions))
  ok("createImportRecord accepts listCostUsd and writes list_cost_usd, refusing a negative", /listCostUsd\?: number \| null/.test(actions) && /list_cost_usd:\s*listCost === null \? null/.test(actions) && /cannot be negative/.test(actions))
  ok("listImports returns list_cost_usd", /failed_count, list_cost_usd, created_at/.test(actions))
  ok("POSITIVE CONTROL: the stamp finder does NOT match the retired import loop (capture with no stamp)",
    !/stampPurchasedListCost\(/.test(`const { action } = await captureContact({ brokerageId })\nif (action === 'created') created++`))
  const page = code("app/dashboard/admin/import/page.tsx")
  ok("the import page asks \"What did this list cost you?\" and passes listCostUsd to createImportRecord", /What did this list cost you\?/.test(page) && /listCostUsd,\s*\}\)/.test(page))
  ok("…refuses a negative amount client-side and says platform-covered sourcing is never the tenant's spend", /0 or more/.test(page) && /platform-covered/.test(page))
  ok("…and the history table shows the list cost", /List cost/.test(page) && /imp\.list_cost_usd/.test(page))
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /^m678-/.test(f))
  ok("m678 exists", migrations.length === 1, migrations.join(","))
  const mig = migrations[0] ? readFileSync(join(ROOT, "supabase/migrations", migrations[0]), "utf8") : ""
  ok("m678 adds lead_imports.list_cost_usd with a non-negative CHECK", /ADD COLUMN IF NOT EXISTS list_cost_usd numeric/.test(mig) && /list_cost_usd IS NULL OR list_cost_usd >= 0/.test(mig))
  ok("m678 retires global_settings.zapier_api_key (Zapier is outbound-only; the inbound door is gone)", /ALTER TABLE public\.global_settings DROP COLUMN IF EXISTS zapier_api_key/.test(mig))
  ok("the GlobalSettingsRow type no longer declares zapier_api_key (no writer can target a dropped column)", !/^\s*zapier_api_key:/m.test(code("lib/kernel/global-settings.ts")))

  console.log("\n[registration]")
  const dom = MAINTENANCE_DOMAINS["lead_import_list_cost"]
  ok("MAINTENANCE_DOMAINS.lead_import_list_cost is owned (finance_manager) with data_steward as co-owner, named in prose",
    dom?.manager === "finance_manager" && (dom?.coOwners ?? []).includes("data_steward") && /data_steward|Data Steward/.test(dom?.what ?? ""))
  ok("its proof is this script's npm target", dom?.proof === "test:lead-import-list-cost")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(fail === 0 ? " ✅ LEAD_IMPORT_LIST_COST_PASS — a purchased list is the tenant's spend, per row, through the one payer vocabulary" : " ❌ LEAD_IMPORT_LIST_COST_FAIL")
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
