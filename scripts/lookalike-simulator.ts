#!/usr/bin/env tsx
/** scripts/lookalike-simulator.ts — first-party lookalike from the closing table. */
import { composeLookalike, runLookalikeAudience, MIN_SEED } from "../lib/kernel/lookalike-audience"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const report = () => { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) } console.log(" ✅ Lookalike verified") }
async function main() {
  console.log("══ Lookalike simulator ══\n[Layer 1 · compose]")
  check("thin seed (< MIN) → null (noise, not signal)", composeLookalike({ seedCount: MIN_SEED - 1, cities: ["X"] }) === null)
  const spec = composeLookalike({ seedCount: 8, cities: ["Oakdale", "Springfield"] })
  check("real seed → lookalike spec from the closing table", !!spec && (spec!.targeting as any).seed_source === "closing_table" && (spec!.targeting as any).seed_count === 8)
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no creds"); report(); return }
  const { createServiceClient } = await import("../lib/supabase/service"); const svc = createServiceClient()
  const TAG = `Look${Date.now()}`; const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    // Seed MIN_SEED closed buyers each tied to a listing with a city.
    const ids: string[] = []
    for (let i = 0; i < MIN_SEED; i++) {
      const { data: c } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: "B", last_name: `${TAG}${i}`, contact_type: "buyer" }).select("id").single()
      cleanup.push({ table: "contacts", id: (c as any).id })
      const { data: l } = await svc.from("listings").insert({ brokerage_id: brokerageId, address: `${TAG} ${i} St`, city: `${TAG}ville`, status: "sold", agent_id: (agent as any).id }).select("id").single()
      cleanup.push({ table: "listings", id: (l as any).id })
      const { data: t } = await svc.from("transactions").insert({ brokerage_id: brokerageId, deal_name: `${TAG}${i}`, status: "closed", buyer_contact_id: (c as any).id, listing_id: (l as any).id, agent_id: (agent as any).id }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id }); ids.push((t as any).id)
    }
    const r1 = await runLookalikeAudience(brokerageId, {}, svc)
    check("lookalike staged from >= MIN closings", r1.staged && r1.seedCount >= MIN_SEED)
    const { data: ad } = await svc.from("ad_campaigns").select("id, status, targeting_config").ilike("campaign_name", "Lookalike — %past buyers%").gte("created_at", new Date(Date.now() - 60000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (ad) cleanup.push({ table: "ad_campaigns", id: (ad as any).id })
    check("staged as a DRAFT ad with closing-table seed", (ad as any)?.status === "draft" && (ad as any)?.targeting_config?.seed_source === "closing_table")
    const r2 = await runLookalikeAudience(brokerageId, {}, svc)
    check("idempotency: not re-staged same week", !r2.staged)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
