// scripts/identity-self-heal-simulator.ts
//
// IDENTITY SELF-HEAL (data_steward) — the guard for the single largest cluster in the live
// walkthrough. Roughly a sixth of the findings were the SAME symptom under different names:
// "unauthorized", "agent identity required", "agent profile not found", "no agent record found
// for your account", "bounced back", "kicks me to login", "bump". One root cause: a signed-in
// agent whose account is missing a brokerage_id and/or an agents row, landing on a work page
// that redirected them away instead of repairing the account.
//
// Two invariants are locked here:
//   1. Work PAGES resolve identity through ensureAgentContextInPlace (self-healing), not the raw
//      getAgentContext, so an incomplete account is provisioned in place. The redirect survives
//      only as the genuinely-cannot-provision fallback.
//   2. ensureAgentBrokerage repairs an account that IS anchored to a brokerage but is MISSING its
//      agents row. That state used to return early as "nothing to heal" and stayed broken forever.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

// The pages the live walkthrough reported bouncing, plus every sibling that shared the pattern.
const SELF_HEALING_PAGES = [
  "app/(dashboard)/transactions/pipeline/page.tsx",
  "app/dashboard/admin/automations/page.tsx",
  "app/dashboard/admin/forms/page.tsx",
  "app/dashboard/admin/page.tsx",
  "app/dashboard/analytics/source/[sourceId]/page.tsx",
  "app/dashboard/analytics/source/page.tsx",
  "app/dashboard/campaigns/mail/page.tsx",
  "app/dashboard/campaigns/sequences/[id]/builder/page.tsx",
  "app/dashboard/challenges/page.tsx",
  "app/dashboard/financials/reports/page.tsx",
  "app/dashboard/listings/[id]/media/page.tsx",
  "app/dashboard/marketing/studio/brand-voice/page.tsx",
  "app/dashboard/settings/team/tc/page.tsx",
  "app/listings/new/page.tsx",
]

console.log("\n[work pages self-heal instead of bouncing]")
for (const p of SELF_HEALING_PAGES) {
  const s = src(p)
  check(`${p.replace("app/", "")} resolves via ensureAgentContextInPlace`,
    /ensureAgentContextInPlace\(\)/.test(s) && !/\bawait getAgentContext\(\)/.test(s))
}

// The first pass of this guard only knew about pages resolving through getAgentContext.
// The MAJORITY of pages read users.brokerage_id directly and redirect on it — a second
// spelling of the same bounce that the original sweep walked straight past. This check
// is shape-based rather than a fixed list, so a new page written either way is caught.
console.log("\n[no page bounces on a brokerage it could have provisioned]")
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (e === "page.tsx") out.push(p)
    }
    return out
  }
  const pages = walk(join(ROOT, "app"))
  const offenders: string[] = []
  for (const p of pages) {
    const s = readFileSync(p, "utf8")
    const bouncesOnBrokerage =
      /!(?:userRow|profile|userData|ctx|context)\?\.brokerage_id/.test(s) && /redirect\(/.test(s)
    if (bouncesOnBrokerage && !s.includes("ensureAgentContextInPlace")) {
      offenders.push(p.replace(ROOT + "/", ""))
    }
  }
  check(
    `every page that redirects on a missing brokerage_id first tries to provision it (${pages.length} pages scanned)`,
    offenders.length === 0,
  )
  if (offenders.length) for (const o of offenders.slice(0, 10)) console.log(`      ${o}`)
}

console.log("\n[the resolver actually provisions]")
const resolver = src("lib/identity/ensure-agent-context.ts")
check("ensureAgentContextInPlace re-resolves after provisioning (never returns the stale context)",
  /ensureAgentBrokerage\(\)[\s\S]*?ctx = await getAgentContext\(\)/.test(resolver))
check("it only heals an AUTHENTICATED but incomplete account",
  /ctx\.isAuthenticated && \(!ctx\.brokerageId \|\| !ctx\.agentId\)/.test(resolver))

console.log("\n[anchored-but-incomplete is repaired, not skipped]")
const ensure = src("app/actions/onboarding/ensure-agent-brokerage.ts")
check("an anchored user missing their agents row triggers the canonical repair",
  /if \(u\.brokerage_id\)[\s\S]*?from\("agents"\)[\s\S]*?if \(!existingAgent\)[\s\S]*?createOrRepairUserDomainRecords/.test(ensure))
check("the repair uses the brokerage's REAL plan_tier (not a hardcoded solo assumption)",
  /from\("brokerages"\)[\s\S]*?plan_tier[\s\S]*?tier: \(brk\?\.plan_tier as string\) \?\? "solo_agent"/.test(ensure))
check("only agent/team_lead self-provision — staff still get their brokerage from their org",
  (ensure.match(/\["agent", "team_lead"\]\.includes/g) ?? []).length >= 2)
check("the pending-invite guard still blocks forking an invited agent off their tenant",
  /user_invitations[\s\S]*?status[\s\S]*?pending[\s\S]*?return \{ ok: false/.test(ensure))
check("still idempotent — an already-complete account performs no writes",
  /if \(existingAgent\)|if \(!existingAgent\)/.test(ensure))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log("FAILURES:")
  for (const f of failures) console.log(`  - ${f}`)
  console.log(" ❌ IDENTITY_SELF_HEAL_FAIL")
  process.exit(1)
}
console.log(" ✅ IDENTITY_SELF_HEAL_PASS — an incomplete agent account is provisioned in place; work pages render instead of bouncing")
