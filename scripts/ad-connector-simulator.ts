#!/usr/bin/env tsx
/**
 * scripts/ad-connector-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 42 — the AD CONNECTOR layer (Meta + Google): PII is normalized + SHA-256
 * hashed before leaving our server, provider responses map cleanly to
 * ad_performance, audiences route by type (custom upload / lookalike seed /
 * platform-native), and an audience never fake-succeeds without a connected
 * account.
 *
 *   Layer 1 — pure: PII normalization + hashing (Meta/Google match-key spec);
 *     Meta Insights + Google report → normalized performance; deriveMetrics;
 *     toAdPerformanceRow column mapping.
 *   Layer 2 — live (gated): a custom audience with NO connected account records a
 *     REAL not-connected sync run (no fake success) and counts only CONSENTED
 *     contacts as attempted; ad_performance accepts the mapped row; cleanup.
 *
 * Run: npx tsx scripts/ad-connector-simulator.ts  (npm run test:ad-connector)
 */
import { normalizeEmail, normalizePhoneE164, sha256Hex, hashMatchKey, hashAudienceMembers } from "../lib/ads/connectors/pii"
import { deriveMetrics } from "../lib/ads/connectors/types"
import { mapInsights } from "../lib/ads/connectors/meta"
import { mapReport } from "../lib/ads/connectors/google"
// ad-performance-ingest became `server-only` when the creative-fatigue runner was
// wired beside its insert (wave 26), and `server-only` THROWS outside a Server
// Component. Neutralize the marker in the require cache BEFORE importing anything
// that pulls it — the accounting-scopes / deadline-watcher idiom — then reach the
// pure mapper through a DYNAMIC import, because a static one would hoist above
// the shim.
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
const { toAdPerformanceRow } = await import("../lib/ads/ad-performance-ingest")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · PII normalization + hashing]")
  check("email is trimmed + lowercased", normalizeEmail("  TEST@Example.COM ") === "test@example.com")
  check("invalid email → null", normalizeEmail("not-an-email") === null)
  check("bare 10-digit US phone → E.164 with country code", normalizePhoneE164("(415) 555-0132") === "14155550132")
  check("already-international phone preserved", normalizePhoneE164("+44 20 7946 0958") === "442079460958")
  check("junk phone → null", normalizePhoneE164("123") === null)
  check("sha256 is 64-char lowercase hex + deterministic", /^[0-9a-f]{64}$/.test(sha256Hex("x")) && sha256Hex("x") === sha256Hex("x"))
  check("normalization happens BEFORE hashing (case/space-insensitive)", hashMatchKey({ email: " TEST@Example.com " })!.email_sha256 === sha256Hex("test@example.com"))
  check("raw PII is never the hash (privacy)", hashMatchKey({ email: "test@example.com" })!.email_sha256 !== "test@example.com")
  check("contact with no identifier → rejected (null)", hashMatchKey({ email: null, phone: null }) === null)
  const batch = hashAudienceMembers([{ email: "a@b.com" }, { phone: "4155550132" }, { email: null, phone: null }])
  check("batch hashes valid members + counts rejects", batch.hashed.length === 2 && batch.rejected === 1)

  console.log("\n[Layer 1 · provider performance → normalized row]")
  const meta = mapInsights({ spend: "100.50", impressions: "5000", clicks: "200", actions: [{ action_type: "lead", value: "5" }] })
  check("Meta insights: leads parsed from actions[]", meta.leads === 5 && meta.spend === 100.5)
  check("Meta insights: cost-per-lead derived ($100.50/5)", meta.costPerLead === 20.1)
  const noLeads = mapInsights({ spend: "50", impressions: "1000", clicks: "10", actions: [] })
  check("Meta insights: 0 leads → costPerLead null", noLeads.leads === 0 && noLeads.costPerLead === null)
  const google = mapReport({ metrics: { costMicros: "120000000", impressions: "8000", clicks: "300", conversions: "6", conversionsValue: "1500" } })
  check("Google report: micros → dollars ($120)", google.spend === 120)
  check("Google report: conversions → leads + revenue", google.leads === 6 && google.revenue === 1500 && google.costPerLead === 20)

  console.log("\n[Layer 1 · metrics + column mapping]")
  const m = deriveMetrics({ spend: 200, impressions: 10000, clicks: 250, leads: 8 })
  check("deriveMetrics ctr + cost-per-lead", m.ctr === 0.025 && m.costPerLead === 25)
  const row = toAdPerformanceRow("brk", "camp", google)
  check("toAdPerformanceRow maps onto ad_performance columns", row.ad_campaign_id === "camp" && row.cost_per_lead === 20 && row.revenue_attributed === 1500 && typeof row.captured_at === "string")
}

async function testLive() {
  console.log("\n[Layer 2 · live audience routing + ad_performance contract]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { syncAudience } = await import("../lib/kernel/ads")
  const svc = createServiceClient()
  const TAG = `__conn_${Date.now()}__`
  let audienceId: string | null = null; let campaignId: string | null = null; let perfId: string | null = null
  const contactIds: string[] = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // One consented + one unconsented contact (only the consented should be attempted).
    for (const [n, consent] of [["yes", true], ["no", false]] as Array<[string, boolean]>) {
      const { data } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: "C", last_name: "", email: `${TAG}${n}@example.com`, tcpa_consent: consent, lifecycle_state: "new",
      }).select("id").single()
      contactIds.push((data as { id: string }).id)
    }

    const { data: aud } = await svc.from("facebook_custom_audiences").insert({
      brokerage_id: brokerageId, scope_type: "brokerage", audience_name: `${TAG} retarget`, audience_type: "custom",
      source_rule: { type: "contact_list", filters: {} }, consent_basis: "ad_lead_form", status: "draft", target_platform: "facebook",
    }).select("id").single()
    audienceId = (aud as { id: string }).id

    const res = await syncAudience({ ctx: { brokerageId, agentId: "", userId: "" }, audienceId })
    check("syncAudience runs the real connector path", res.success === true, res.error)
    const { data: run } = await svc.from("audience_sync_runs").select("run_status, records_attempted, provider_response").eq("audience_id", audienceId).order("completed_at", { ascending: false }).limit(1).maybeSingle()
    const r = run as any
    check("no connected account → NOT a fake success (real not-connected state)", r?.run_status === "error" && r?.provider_response?.not_connected === true)
    check("only the CONSENTED contact is attempted (consent gate holds)", r?.records_attempted === 1)
    const { data: a2 } = await svc.from("facebook_custom_audiences").select("status").eq("id", audienceId).single()
    check("audience marked error (no silent 'synced')", (a2 as { status: string }).status === "error")

    // ad_performance accepts the connector-mapped row shape.
    const { data: camp } = await svc.from("ad_campaigns").insert({
      brokerage_id: brokerageId, campaign_name: `${TAG} camp`, platform: "google", objective: "leads", status: "live", daily_budget: 50,
    }).select("id").single()
    campaignId = (camp as { id: string }).id
    const perf = mapReport({ metrics: { costMicros: "100000000", impressions: "5000", clicks: "200", conversions: "5", conversionsValue: "900" } })
    const { data: pf, error: pErr } = await svc.from("ad_performance").insert(toAdPerformanceRow(brokerageId, campaignId, perf)).select("id").single()
    check("ad_performance accepts the connector-mapped row", !pErr && !!pf, pErr?.message)
    perfId = (pf as { id: string } | null)?.id ?? null
  } finally {
    if (perfId) { try { await svc.from("ad_performance").delete().eq("id", perfId) } catch {} }
    if (campaignId) { try { await svc.from("ad_campaigns").delete().eq("id", campaignId) } catch {} }
    if (audienceId) { try { await svc.from("audience_sync_runs").delete().eq("audience_id", audienceId) } catch {}; try { await svc.from("facebook_custom_audiences").delete().eq("id", audienceId) } catch {} }
    for (const id of contactIds) { try { await svc.from("contacts").delete().eq("id", id) } catch {} }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("email", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Ad connector simulator (Meta + Google: PII, performance, audiences)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Connectors hash PII, map performance, route audiences — no fake sync without a connected account")
}
main().catch((e) => { console.error(e); process.exit(1) })
