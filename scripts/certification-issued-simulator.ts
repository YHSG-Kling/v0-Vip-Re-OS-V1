#!/usr/bin/env tsx
/**
 * scripts/certification-issued-simulator.ts   (npm run test:certification-issued)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the certification_issued multi-manager play — the positive mirror of license_lapsing. When an
 * agent earns a certification, the Recruiting Manager (owns certs) HANDS it to the Campaign Orchestrator
 * (content owner), who proposes a GATED social-proof post (nothing auto-publishes). A compliance/education
 * milestone becomes a marketing asset.
 *
 * SOURCE: awardCertification publishes recruiting_manager → campaign_orchestrator certification_issued;
 *         the handler proposes ONE gated social_posts row (approval pending), idempotent per cert award;
 *         catalogued in SIGNAL_REGISTRY with a real handler.
 * LIVE (creds-gated): drive the handler with a real cert → assert a gated social post lands (draft/pending,
 *         agent name in copy) → idempotent second run adds nothing → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — award publishes the handoff; the handler proposes gated social proof]")
  const eng = src("lib/onboarding/certification-engine.ts")
  check("awardCertification publishes recruiting_manager → campaign_orchestrator certification_issued", /fromManager: "recruiting_manager", toManager: "campaign_orchestrator",\s*\n?\s*signalType: "certification_issued"/.test(eng))
  check("the signal carries certId + agentId + certName (entityId = certId, distinct per award)", /entityId: cert\.id,\s*\n?\s*payload: \{ certId: cert\.id, agentId, certName \}/.test(eng))
  const sig = src("lib/kernel/manager-signals.ts")
  check("the handler proposes a GATED social post (approval_status pending, nothing auto-publishes)", /"campaign_orchestrator:certification_issued":[\s\S]*?from\("social_posts"\)\.insert\(\{[\s\S]*?approval_status: "pending"/.test(sig))
  check("the handler is idempotent per cert award (post_brief carries certId)", /CERTIFICATION SOCIAL PROOF — cert:\$\{certId\}/.test(sig))
  check("the agent name is sanitized before entering client-facing copy", /sanitizeProperNoun\(full, 60\)/.test(sig))
  check("certification_issued is catalogued (consumer campaign_orchestrator)", /certification_issued:\s*\{ consumers: \["campaign_orchestrator"\]/.test(src("lib/kernel/signal-registry.ts")))
  check("the coordination classifier renders it as a handoff", /certification_issued/.test(src("lib/kernel/coordination-kind.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] drive the handler with a real agent+cert → gated social post → idempotent → clean up")
  const { data: ag } = await svc.from("agents").select("id, brokerage_id, user_id").not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const brokerageId = (ag as any).brokerage_id, agentRowId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: cert } = await svc.from("agent_certifications").insert({ agent_id: agentRowId, brokerage_id: brokerageId, certification_name: "Luxury Home Specialist (test)", cert_type: "onboarding", issued_at: new Date().toISOString() }).select("id").single()
    cleanup.push({ table: "agent_certifications", id: (cert as any).id })

    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    const handler = (SIGNAL_HANDLERS as any)["campaign_orchestrator:certification_issued"]
    const signal = { entityId: (cert as any).id, entityType: "agent_certification", payload: { certId: (cert as any).id, agentId: agentRowId, certName: "Luxury Home Specialist (test)" } }
    const ctx = { supabase: svc as any, brokerageId }
    const r1 = await handler(signal, ctx)
    check("live: handler proposed a gated social-proof post", typeof r1 === "string" && /social-proof/.test(r1))
    const { data: post } = await svc.from("social_posts").select("id, status, approval_status, content").eq("brokerage_id", brokerageId).eq("agent_id", agentRowId).ilike("post_brief", `%cert:${(cert as any).id}%`).maybeSingle()
    if (post) cleanup.push({ table: "social_posts", id: (post as any).id })
    check("live: the post is DRAFT + pending approval (nothing auto-publishes)", (post as any)?.status === "draft" && (post as any)?.approval_status === "pending")
    check("live: the copy congratulates on the certification", /Congratulations[\s\S]*Luxury Home Specialist/.test((post as any)?.content ?? ""))

    const r2 = await handler(signal, ctx)
    check("live: idempotent — a second run does NOT add another post", /already proposed/.test(String(r2)))
    const { count } = await svc.from("social_posts").select("id", { count: "exact", head: true }).eq("agent_id", agentRowId).ilike("post_brief", `%cert:${(cert as any).id}%`)
    check("live: exactly ONE cert social post per award", count === 1)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CERTIFICATION_ISSUED_FAIL"); process.exit(1) }
  console.log(" ✅ CERTIFICATION_ISSUED_PASS — an earned credential auto-becomes a gated social-proof post (Recruiting → Campaign)")
}
main()
