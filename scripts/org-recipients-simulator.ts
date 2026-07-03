#!/usr/bin/env tsx
/**
 * scripts/org-recipients-simulator.ts   (npm run test:org-recipients)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves TIER-SAFE org recipients: a brokerage-level red-flag reaches broker/admin staff when the org has
 * them, and falls back to the SOLO agent when it doesn't — so a one-person shop's flag is never dropped.
 *
 * PURE (stub svc): resolveOrgRecipients — staff present → staff; no staff → active agents (solo owner).
 * SOURCE: the retention radar + regulatory watcher resolve recipients tier-safely.
 * LIVE (creds-gated): on a real brokerage the resolver returns non-empty recipients.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { resolveOrgRecipients } from "../lib/kernel/org-recipients"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// A stub svc: usersRows for the users query, agentRows for the agents query.
function stub(usersRows: any[], agentRows: any[]) {
  return {
    from(table: string) {
      const rows = table === "users" ? usersRows : agentRows
      const q: any = {
        _rows: rows,
        select() { return q }, eq() { return q }, in() { return q }, not() { return q },
        async limit() { return { data: q._rows } },
      }
      return q
    },
  }
}

async function pureLayer() {
  console.log("\n[resolveOrgRecipients · tier-safe]")
  const team = await resolveOrgRecipients(stub([{ id: "broker-1" }, { id: "admin-2" }], [{ user_id: "agent-9" }]) as any, "b")
  check("team/brokerage org → broker/admin staff receive it", team.includes("broker-1") && team.includes("admin-2") && !team.includes("agent-9"))
  const solo = await resolveOrgRecipients(stub([], [{ user_id: "solo-agent-1" }]) as any, "b")
  check("SOLO org (no staff) → the solo agent receives it (never dropped)", solo.length === 1 && solo[0] === "solo-agent-1")
  const empty = await resolveOrgRecipients(stub([], []) as any, "b")
  check("no staff + no agents → empty (honest, nothing invented)", empty.length === 0)
  const deduped = await resolveOrgRecipients(stub([], [{ user_id: "a" }, { user_id: "a" }, { user_id: null }]) as any, "b")
  check("solo fallback dedupes + drops null user ids", deduped.length === 1 && deduped[0] === "a")
}

function sourceLayer() {
  console.log("\n[wiring — red-flag paths are tier-safe]")
  const radar = src("lib/recruiting/retention-radar.ts")
  check("retention radar resolves recipients tier-safely (solo included)", /resolveOrgRecipients\(svc, params\.brokerageId\)/.test(radar) && !/in\("user_type", \["broker", "broker_admin", "admin"\]\)/.test(radar))
  const watcher = src("lib/kernel/regulatory-watcher.ts")
  check("regulatory watcher resolves compliance recipients tier-safely", /resolveOrgRecipients\(supabase, brokerageId, \{ roles:/.test(watcher))

  console.log("\n[sweep — the remaining red-flag loops are tier-safe]")
  for (const f of [
    "lib/compliance/compliance-flag-reaper.ts", "lib/finance/commission-tracking-reaper.ts",
    "lib/kernel/ai-sentinel.ts", "lib/kernel/document-compliance-audit.ts",
    "lib/kernel/manager-signals.ts", "lib/intelligence/mobile-approval-queue.ts",
  ]) {
    check(`${f.split("/").pop()} uses resolveOrgRecipients (no raw broker/admin-only loop)`, /resolveOrgRecipients\(/.test(src(f)))
  }
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("\n[live] ⊘ no brokerage"); return }
  const recipients = await resolveOrgRecipients(svc as any, (brk as any).id)
  check("live: a real brokerage resolves at least one recipient", recipients.length >= 1)
}

async function main() {
  await pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ORG_RECIPIENTS_FAIL"); process.exit(1) }
  console.log(" ✅ ORG_RECIPIENTS_PASS — red-flags reach the broker in a team/brokerage, the agent in a solo shop")
}
main()
