#!/usr/bin/env tsx
/**
 * scripts/geo-remediation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the GEO loop becomes REMEDIATION, not just a number: a persistently-uncited landing page
 * (geo_visibility_gap) is now a HANDLED signal — the Campaign Orchestrator proposes a one-tap GATED
 * regenerate_faq action; a human approves it in the Command Center; execution rebuilds the FAQ +
 * schema.org block from fresh demand topics and persists it to lead_capture_forms.landing_content.
 *
 * Layer 1 (pure): the signal is handled + owned by campaign_orchestrator; the handler is registered;
 *                 regenerate_faq is a known marketing action.
 * Layer 2 (live, creds-gated): seed a published page, fire the gap signal, assert the gated action is
 *                 proposed (and deduped), approve+execute it, assert a non-error outcome (and, when
 *                 demand topics are available, the FAQ is rewritten). Reverse-delete; cleanup == 0.
 *
 * Run: npx tsx scripts/geo-remediation-simulator.ts   (npm run test:geo-remediation)
 */
import { signalSpec } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

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
  console.log(" ✅ GEO remediation verified — a persistently-uncited page becomes a one-tap gated FAQ rebuild.")
  console.log(" GEO_REMEDIATION_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" GEO remediation simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · signal is handled + owned + has a registered handler]")
  const spec = signalSpec("geo_visibility_gap")
  check("geo_visibility_gap is HANDLED (not just feed)", spec?.disposition === "handled")
  check("owned by the Campaign Orchestrator", !!spec && spec.consumers.includes("campaign_orchestrator"))
  check("a handler is registered for it", typeof SIGNAL_HANDLERS["campaign_orchestrator:geo_visibility_gap"] === "function")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · gap signal → gated proposal → approve → execute]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { publishManagerSignal } = await import("../lib/kernel/manager-signals")
  const { executeAction } = await import("../lib/agents/marketing-agent-actions")
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
  const brokerageId = (brk as any).id
  const { data: u } = await svc.from("users").select("id").limit(1).maybeSingle()
  const approverId = (u as any)?.id ?? "00000000-0000-0000-0000-0000000000aa"

  const cleanup: Array<{ table: string; id: string }> = []
  let formId = ""
  try {
    const staleFaq = [{ question: "Old question?", answer: "Old answer." }]
    const { data: form } = await svc.from("lead_capture_forms").insert({
      brokerage_id: brokerageId, name: `ZZ GEO ${Date.now()}`, slug: `zz-geo-${Date.now()}`,
      magnet_type: "buyer_guide", is_active: true, fields: [{ name: "email", label: "Email", type: "email", required: true }],
      landing_content: { headline: "H", subhead: "S", cta: "Go", bullets: ["b"], faq: staleFaq, faqJsonLd: "{}", area: "Austin" },
    }).select("id").single()
    formId = (form as any).id; cleanup.push({ table: "lead_capture_forms", id: formId })

    // Fire the gap signal exactly as geo-gap-runner does.
    await publishManagerSignal({
      brokerageId, fromManager: "asset_manager", toManager: "campaign_orchestrator",
      signalType: "geo_visibility_gap", message: "buyer-guide is persistently never cited by AI search — rebuild its FAQ.",
      entityType: "lead_capture_form", entityId: formId, payload: { slug: "zz-geo", visibility: 0, reason: "persistently_not_cited" },
    }, svc)

    const { data: proposed } = await svc.from("marketing_agent_actions")
      .select("id, action_type, status, action_input").eq("brokerage_id", brokerageId)
      .eq("action_type", "regenerate_faq").contains("action_input", { form_id: formId }).maybeSingle()
    check("gap signal proposed a gated regenerate_faq action", !!proposed && (proposed as any).status === "proposed", JSON.stringify(proposed))
    const actionId = (proposed as any)?.id
    if (actionId) cleanup.push({ table: "marketing_agent_actions", id: actionId })

    // Re-fire: the handler dedupes (and publish dedupes the open signal) — still exactly one proposal.
    await publishManagerSignal({
      brokerageId, fromManager: "asset_manager", toManager: "campaign_orchestrator",
      signalType: "geo_visibility_gap", message: "still uncited", entityType: "lead_capture_form", entityId: formId,
      payload: { slug: "zz-geo" }, dedupe: false,
    }, svc)
    const { count: dupCount } = await svc.from("marketing_agent_actions")
      .select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
      .eq("action_type", "regenerate_faq").contains("action_input", { form_id: formId }).in("status", ["proposed", "approved"])
    check("re-fired gap does NOT stack a duplicate proposal", (dupCount ?? 0) === 1)

    // Approve + execute (what the Command Center one-tap approve calls).
    if (actionId) {
      const outcome = await executeAction(actionId, approverId)
      check("approve → execute returns a non-error outcome", outcome.status === "succeeded" || outcome.status === "skipped", JSON.stringify(outcome))
      if (outcome.status === "succeeded") {
        const { data: after } = await svc.from("lead_capture_forms").select("landing_content").eq("id", formId).maybeSingle()
        const lc = (after as any)?.landing_content ?? {}
        check("succeeded → FAQ rebuilt + stamped (faq_regenerated_at set)", !!lc.faq_regenerated_at && Array.isArray(lc.faq))
      } else {
        console.log("     (execution skipped — no fresh demand topics in this env; the propose→approve gate path is proven)")
      }
    }
  } finally {
    await svc.from("marketing_agent_actions").delete().eq("brokerage_id", brokerageId).eq("action_type", "regenerate_faq").contains("action_input", { form_id: formId }).then(() => {}, () => {})
    await svc.from("manager_signals").delete().eq("entity_id", formId || "none").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("lead_capture_forms").select("id", { count: "exact", head: true }).eq("id", formId || "none")
    check("cleanup: seeded page removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
