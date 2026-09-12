// scripts/phone-plan-simulator.ts   (npm run test:phone-plan)
// ─────────────────────────────────────────────────────────────────────────────
// PHONE BILLING BUNDLED INTO TIERS WITH METERING — proves the commercial model:
// every tier bundles a phone allowance (included numbers + AI-voice minutes + SMS
// segments); inside the bundle is free, beyond it is metered overage, and a hard
// cap is the runaway backstop. PURE evaluators (unit-tested here) + SOURCE
// assertions that the provisioning gate + finance rollup resolve through them.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  PHONE_ALLOWANCE_DEFAULTS,
  DEFAULT_PHONE_ALLOWANCE,
  resolvePhoneAllowance,
  evaluateNumberProvisioning,
  evaluatePhoneMetering,
} from "../lib/billing/phone-plan"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── every canonical tier bundles a phone allowance ──")
{
  for (const tier of ["solo_agent", "team", "brokerage", "multi_location"] as const) {
    const a = PHONE_ALLOWANCE_DEFAULTS[tier]
    check(`${tier}: included numbers + minutes + sms are all positive`,
      a.includedNumbers > 0 && a.includedVoiceMinutes > 0 && a.includedSmsSegments > 0)
  }
  // Higher tiers bundle more.
  check("bundles grow with the tier (solo < team < brokerage < multi_location minutes)",
    PHONE_ALLOWANCE_DEFAULTS.solo_agent.includedVoiceMinutes < PHONE_ALLOWANCE_DEFAULTS.team.includedVoiceMinutes &&
    PHONE_ALLOWANCE_DEFAULTS.team.includedVoiceMinutes < PHONE_ALLOWANCE_DEFAULTS.brokerage.includedVoiceMinutes &&
    PHONE_ALLOWANCE_DEFAULTS.brokerage.includedVoiceMinutes < PHONE_ALLOWANCE_DEFAULTS.multi_location.includedVoiceMinutes)
  check("multi_location has an unlimited number cap (metered, not blocked)",
    PHONE_ALLOWANCE_DEFAULTS.multi_location.maxNumbers === null)
  check("solo/team/brokerage carry a finite runaway backstop",
    typeof PHONE_ALLOWANCE_DEFAULTS.solo_agent.maxNumbers === "number" &&
    typeof PHONE_ALLOWANCE_DEFAULTS.team.maxNumbers === "number" &&
    typeof PHONE_ALLOWANCE_DEFAULTS.brokerage.maxNumbers === "number")
}

console.log("\n── resolvePhoneAllowance: defaults + Superadmin → Plans overrides ──")
{
  check("unknown/legacy tier fails SAFE to the solo (tightest) bundle",
    resolvePhoneAllowance("legacy_enterprise").includedNumbers === DEFAULT_PHONE_ALLOWANCE.includedNumbers)
  check("null tier fails SAFE to solo",
    resolvePhoneAllowance(null).includedVoiceMinutes === DEFAULT_PHONE_ALLOWANCE.includedVoiceMinutes)
  const overridden = resolvePhoneAllowance("solo_agent", { included_phone_numbers: 9, included_voice_minutes: 999, overage_voice_minute_cents: 7 })
  check("features.limits overrides win over the default (numbers/minutes/rate)",
    overridden.includedNumbers === 9 && overridden.includedVoiceMinutes === 999 && overridden.overageVoiceMinuteCents === 7)
  check("an absent override key keeps the tier default",
    overridden.includedSmsSegments === PHONE_ALLOWANCE_DEFAULTS.solo_agent.includedSmsSegments)
  check("max_phone_numbers: -1 means unlimited",
    resolvePhoneAllowance("team", { max_phone_numbers: -1 }).maxNumbers === null)
  check("max_phone_numbers: explicit null means unlimited",
    resolvePhoneAllowance("team", { max_phone_numbers: null }).maxNumbers === null)
  check("max_phone_numbers: a positive override caps it",
    resolvePhoneAllowance("team", { max_phone_numbers: 42 }).maxNumbers === 42)
  check("a garbage override is ignored (default kept)",
    resolvePhoneAllowance("team", { included_phone_numbers: "lots" as any }).includedNumbers === PHONE_ALLOWANCE_DEFAULTS.team.includedNumbers)
}

console.log("\n── evaluateNumberProvisioning: bundle → overage → hard cap ──")
{
  const allowance = resolvePhoneAllowance("solo_agent") // included 1, max 3
  const first = evaluateNumberProvisioning({ allowance, activeNumbers: 0 })
  check("the 1st number is inside the bundle (free, allowed)",
    first.allowed && first.billing === "included" && first.monthlyOverageCents === 0)
  const second = evaluateNumberProvisioning({ allowance, activeNumbers: 1 })
  check("the 2nd number is allowed but METERED overage (not blocked)",
    second.allowed && second.billing === "overage" && second.monthlyOverageCents === allowance.overageNumberCents)
  const past = evaluateNumberProvisioning({ allowance, activeNumbers: 3 })
  check("past the hard cap (maxNumbers) the purchase is BLOCKED with an upgrade reason",
    !past.allowed && !!past.reason)
  const uncapped = evaluateNumberProvisioning({ allowance: resolvePhoneAllowance("multi_location"), activeNumbers: 100000 })
  check("an unlimited-cap tier is never blocked (still metered)",
    uncapped.allowed && uncapped.billing === "overage")
}

console.log("\n── evaluatePhoneMetering: included vs billable overage ──")
{
  const allowance = resolvePhoneAllowance("solo_agent") // 250 min, 500 sms, 1 number
  const inside = evaluatePhoneMetering({ allowance, voiceMinutes: 100, smsSegments: 100, activeNumbers: 1 })
  check("usage inside the bundle bills nothing",
    inside.overageTotalCents === 0 && inside.overageVoiceMinutes === 0 && inside.overageNumbers === 0)
  const over = evaluatePhoneMetering({ allowance, voiceMinutes: 340, smsSegments: 700, activeNumbers: 2 })
  check("voice overage = (340-250) minutes × rate",
    over.overageVoiceMinutes === 90 && over.overageVoiceCents === 90 * allowance.overageVoiceMinuteCents)
  check("sms overage = (700-500) segments × rate",
    over.overageSmsSegments === 200 && over.overageSmsCents === 200 * allowance.overageSmsCents)
  check("number overage = (2-1) × monthly number rate",
    over.overageNumbers === 1 && over.overageNumberCents === allowance.overageNumberCents)
  check("total overage sums the three lines",
    over.overageTotalCents === over.overageVoiceCents + over.overageSmsCents + over.overageNumberCents)
  check("overage counts never go negative",
    evaluatePhoneMetering({ allowance, voiceMinutes: 0, smsSegments: 0, activeNumbers: 0 }).overageTotalCents === 0)
}

console.log("\n── the provisioning gate + finance rollup resolve through the bundle ──")
{
  const resolve = src("lib/billing/phone-plan-resolve.ts")
  check("phone-plan-resolve reads the tenant tier + features.limits and resolves the allowance",
    resolve.includes("resolvePhoneAllowance") && resolve.includes("plan_tier") && resolve.includes("features"))
  check("evaluateTenantNumberProvisioning counts ACTIVE numbers and evaluates the verdict",
    resolve.includes('.eq("is_active", true)') && resolve.includes("evaluateNumberProvisioning"))
  check("loadTenantPhoneMeter folds real voice + sms usage into the meter",
    resolve.includes("loadVoiceUsage") && resolve.includes("evaluatePhoneMetering") && resolve.includes('.eq("type", "sms")'))

  const core = src("lib/voice/number-provisioning.ts")
  check("the shared provisioning core enforces the allowance when enforceTenantAllowance is set",
    core.includes("enforceTenantAllowance") && core.includes("evaluateTenantNumberProvisioning"))
  check("past the hard cap the core returns capReached (blocks the purchase)",
    core.includes("capReached: true"))
  check("the purchased-number audit line stamps the billing disposition (bundle vs overage)",
    core.includes('plan:${billing}'))

  const action = src("app/actions/phone-provisioning.ts")
  check("the tenant provisioning action turns enforcement ON",
    action.includes("enforceTenantAllowance: true"))
}

console.log("\n── ownership + wiring ──")
{
  const reg = src("lib/kernel/manager-registry.ts")
  check("phone-billing burn domain is registered with a runnable proof",
    /phone_billing_bundle:\s*\{[^}]*proof:\s*"test:phone-plan"/.test(reg))
  check("package.json wires the proof",
    /"test:phone-plan":\s*"tsx scripts\/phone-plan-simulator\.ts"/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PHONE_PLAN_FAIL"); process.exit(1) }
console.log(" ✅ PHONE_PLAN_PASS — phone billing bundled into every tier, metered past the bundle")
