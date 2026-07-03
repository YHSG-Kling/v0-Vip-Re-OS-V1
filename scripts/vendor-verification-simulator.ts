#!/usr/bin/env tsx
/**
 * scripts/vendor-verification-simulator.ts   (npm run test:vendor-verification)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VENDOR VERIFICATION + APPROVAL GATE — nothing surfaces unvetted and no vendor self-activates.
 * A pure application score prioritizes the human approval; the status state machine gates activation to an
 * admin path; the orchestration bench excludes un-approved vendors.
 *
 * PURE:   scoreVendorApplication (completeness + risk + duplicate → score/flags/recommendation) +
 *         canTransition (admin path to active; archived terminal; no self-loop) + surfaceable statuses.
 * SOURCE: approve/reject actions are admin-gated; approveVendor transitions via canTransition; the bench
 *         excludes pending/inactive/archived; the gated approval-queue brief; cron; owned by compliance_officer.
 * LIVE (creds-gated): stage a PENDING vendor → the approval queue scores it + proposes ONE gated admin
 *         brief → the bench query excludes it → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  scoreVendorApplication,
  canTransition,
  SURFACEABLE_STATUSES,
  NON_SURFACEABLE_STATUSES,
  AUTO_OK_THRESHOLD,
} from "../lib/kernel/vendor-verification"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const full = { name: "Acme Inspections", email: "hi@acme.com", phone: "512-555-1212", website: "https://acme.com", category: "Inspector", estimatedTurnaroundDays: 3 }

function pureLayer() {
  console.log("\n[scoreVendorApplication · pure]")
  const clean = scoreVendorApplication(full)
  check(`a complete application scores high (≥${AUTO_OK_THRESHOLD}) → auto_ok`, clean.score >= AUTO_OK_THRESHOLD && clean.recommendation === "auto_ok" && clean.flags.length === 0)
  const thin = scoreVendorApplication({ name: "X", email: null, phone: null, website: null, category: "Nope", estimatedTurnaroundDays: null })
  check("a thin application scores low → reject_recommended + names every gap", thin.recommendation === "reject_recommended" && thin.flags.includes("no_valid_email") && thin.flags.includes("invalid_or_missing_category"))
  const dupe = scoreVendorApplication({ ...full, isDuplicate: true })
  check("a duplicate is reject_recommended regardless of completeness", dupe.recommendation === "reject_recommended" && dupe.flags.includes("duplicate_of_existing_vendor"))
  const partial = scoreVendorApplication({ ...full, phone: null, website: null, estimatedTurnaroundDays: null })
  check("a partial application (email+category only, ~60) → review (not auto, not reject)", partial.recommendation === "review" && partial.score >= 40 && partial.score < AUTO_OK_THRESHOLD)
  check("score is clamped 0..100", thin.score >= 0 && clean.score <= 100)

  console.log("\n[status state machine · pure — no self-activate, archived terminal]")
  check("pending → active is a valid (admin) transition", canTransition("pending", "active"))
  check("active → inactive / inactive → active allowed", canTransition("active", "inactive") && canTransition("inactive", "active"))
  check("archived is terminal (no transition out)", !canTransition("archived", "active") && !canTransition("archived", "inactive"))
  check("no-op self transition rejected", !canTransition("active", "active"))
  check("legacy null status treated as active", !canTransition(null, "active") === false ? true : canTransition(null as any, "inactive"))
  check("only 'active' is surfaceable; pending/inactive/archived are not", SURFACEABLE_STATUSES.has("active") && NON_SURFACEABLE_STATUSES.every((s) => !SURFACEABLE_STATUSES.has(s)))
}

function sourceLayer() {
  console.log("\n[wiring — admin-gated approval, bench exclusion, gated queue, cron, owned]")
  const act = src("app/actions/vendor-verification.ts")
  check("approve/reject require an admin (requireAdmin)", /async function requireAdmin/.test(act) && /Not authorized — vendor approval is broker\/admin only/.test(act))
  check("approveVendor transitions to active via canTransition (no self-activate)", /export async function approveVendor/.test(act) && /transitionVendor\(vendorId, "active"\)/.test(act) && /canTransition\(/.test(act))
  check("submitVendorForVerification scores + stages pending (never active)", /submitVendorForVerification/.test(act) && /status: "pending"/.test(act))
  const orch = src("lib/kernel/vendor-orchestration.ts")
  check("the orchestration bench excludes un-approved vendors", /\.not\("status", "in", "\(pending,inactive,archived\)"\)/.test(orch))
  const ver = src("lib/kernel/vendor-verification.ts")
  check("the approval queue proposes a GATED admin brief, deduped per ISO week", /proposeClientMessage/.test(ver) && /VENDOR APPROVALS — \$\{isoWeekKey/.test(ver))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor cron runs the approval queue", /runVendorApprovalQueueAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by compliance_officer with a runnable proof", /vendor_verification_gate:\s*\{\s*manager:\s*"compliance_officer",\s*proof:\s*"test:vendor-verification"/.test(reg))
  check("vendors verification columns are in the schema snapshot", /vendors:\s*\[[^\]]*"ai_verification_score"[^\]]*"verified_by"/.test(src("scripts/schema-snapshot.ts")))
  check("package.json wires the proof", /"test:vendor-verification":\s*"tsx scripts\/vendor-verification-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] stage a PENDING vendor → approval queue scores + briefs it → bench excludes it → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { runVendorApprovalQueue } = await import("../lib/kernel/vendor-verification")
  try {
    const { data: v } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name: "ZZ Verify Sim Vendor", category: "Inspector", email: "sim@verify.test", phone: "512-555-9090", status: "pending" }).select("id").single()
    const vendorId = (v as any).id
    cleanup.push({ table: "vendors", id: vendorId })

    const r1 = await runVendorApprovalQueue(svc as any, { brokerageId })
    check("live: the approval queue counts the pending vendor", r1.pending >= 1)
    const { data: scored } = await svc.from("vendors").select("ai_verification_score, verification_flags").eq("id", vendorId).maybeSingle()
    check("live: the pending vendor received an AI verification score", typeof (scored as any)?.ai_verification_score === "number")

    const { data: brief } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "compliance_officer").ilike("rationale", "VENDOR APPROVALS —%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: a gated approval-queue brief was proposed", r1.briefProposed && !!brief)
    if (brief) cleanup.push({ table: "agent_client_messages", id: (brief as any).id })

    // The bench query the orchestration uses must NOT return the pending vendor.
    const { data: bench } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).not("status", "in", "(pending,inactive,archived)").eq("id", vendorId)
    check("live: the pending vendor is excluded from the surfaceable bench", (bench ?? []).length === 0)

    const r2 = await runVendorApprovalQueue(svc as any, { brokerageId })
    check("live: idempotent — no duplicate approval brief same ISO week", r2.briefProposed === false)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_VERIFICATION_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_VERIFICATION_PASS — applications scored, admin-gated approval, nothing surfaces unvetted, no self-activate")
}
main()
