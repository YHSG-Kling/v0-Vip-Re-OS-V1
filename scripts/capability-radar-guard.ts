#!/usr/bin/env tsx
/**
 * scripts/capability-radar-guard.ts   (npm run test:capability-radar) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OS WATCHES THE WEB FOR WHAT IT DOES NOT DO YET, AND SAYS SO ONCE.
 *
 * Owner, 2026-09-06: the OS "needs to consistantly check for any new ideas or
 * capability out on the web … autonomously builds it in as a new capability
 * annoucemtn to stay ahead of the curve. autonomous loops."
 *
 * Proved: (1) the radar searches through the ONE external rail and judges
 * against the LIVE capability vocabulary (derived from four registries, not
 * typed); (2) a new capability is recorded ONCE on feature_flags as a disabled
 * beta radar flag (no second ledger), deduped by feature_key, every write read
 * for its error; (3) platform staff are told once per run through the one
 * notifier; (4) the loop is scheduled in the cron registry; (5) the verdict
 * parser drops malformed rows instead of trusting the model.
 *
 * BLIND SPOTS (§2): static + the pure parser. The model's have_it verdict is
 * recorded beside the vocabulary it was given, not proved. The radar proposes
 * and announces; it does not write code.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { RADAR_WATCHLIST } from "../lib/kernel/capability-radar"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const RADAR = src("lib/kernel/capability-radar.ts")
const CRON  = src("app/api/cron/capability-radar/route.ts")

console.log("══════════════════════════════════════════════════")
console.log(" The capability radar: search → judge against the live vocabulary → record once → announce")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · one rail, a derived vocabulary ──")
check("searches through lib/ai/web-search (the one gated external rail)", /import\("@\/lib\/ai\/web-search"\)/.test(RADAR) && /webSearch\(\{/.test(RADAR))
check("the vocabulary is derived from the four registries, never typed",
  /APP_CAPABILITY_REGISTRY/.test(RADAR) && /TEAM_COMMANDS/.test(RADAR) && /AD_CAMPAIGN_PLATFORMS/.test(RADAR) && /MANAGERS/.test(RADAR))
check("…and is handed to the model in the prompt", /VOCABULARY: \$\{vocabulary\.join/.test(RADAR))
check("the watchlist names ChatGPT ads and text-driven AI marketing agents (the two ideas that started this)",
  RADAR_WATCHLIST.some((w) => w.key === "chatgpt_ads") && RADAR_WATCHLIST.some((w) => w.key === "ai_cmo_text_agents"))

console.log("\n── 2 · recorded ONCE, on the ledger that already exists ──")
check("writes feature_flags, no new table", /from\("feature_flags"\)\.insert\(/.test(RADAR) && !/create table|radar_findings/i.test(RADAR))
check("deduped by feature_key before the insert", /from\("feature_flags"\)\.select\("id"\)\.eq\("feature_key", finding\.featureKey\)/.test(RADAR))
check("a refused dedupe READ is a skip, never a 'new' capability", /readErr\) \{[^\n]*skipped\+\+; continue/.test(RADAR))
check("the insert's error is read and an unmatched insert is an error", /insErr\) \{/.test(RADAR) && /inserted\.length === 0/.test(RADAR))
check("the row is a DISABLED, BETA, superadmin-only flag (the platform flips it when it ships)",
  /enabled:\s*false/.test(RADAR) && /beta:\s*true/.test(RADAR) && /superadmin_only:\s*true/.test(RADAR))
check("a capability the OS already has is skipped, not announced", /if \(finding\.haveIt\) \{ result\.skipped\+\+; continue \}/.test(RADAR))

console.log("\n── 3 · announced once per run through the one notifier ──")
check("notifyPlatformStaff, once, after the loop", /notifyPlatformStaff\(svc, \{/.test(RADAR) && (RADAR.match(/notifyPlatformStaff\(/g) ?? []).length === 1)
check("…only when something new was recorded", /if \(announced\.length > 0\)/.test(RADAR))

console.log("\n── 4 · scheduled ──")
const entry = CRON_REGISTRY.find((c) => c.path === "/api/cron/capability-radar")
check("registered in CRON_REGISTRY", !!entry)
check("…weekly (five fields, a fixed weekday)", !!entry && /^\d+ \d+ \* \* \d$/.test(entry.schedule), entry?.schedule)
check("the cron route verifies cron auth before running", /verifyCronAuth\(req\)\s*if \(unauth\) return unauth[\s\S]{0,200}runCapabilityRadar/.test(CRON))

console.log("\n── 5 · the parser trusts nothing (proved by source shape — the parser is internal, not a proof-only export) ──")
const PARSER = RADAR.slice(RADAR.indexOf("function parseRadarVerdicts("), RADAR.indexOf("export async function runCapabilityRadar("))
check("the parser is internal and the driver is the one export the cron route reaches",
  !/export function parseRadarVerdicts|export function radarFeatureKey|export async function knownCapabilityVocabulary/.test(RADAR)
  && /export async function runCapabilityRadar\(/.test(RADAR) && PARSER.length > 0)
check("non-JSON is an empty list, not a throw", /const m = raw\.match\(\/\\\[\[\\s\\S\]\*\\\]\/\)\s*if \(!m\) return \[\]/.test(PARSER) && /catch \{ return \[\] \}/.test(PARSER))
check("a non-array is an empty list", /if \(!Array\.isArray\(arr\)\) return \[\]/.test(PARSER))
check("a row is kept ONLY with a string capability, a string url and a BOOLEAN have_it",
  /typeof \(x as \{ capability\?: unknown \}\)\.capability === "string"/.test(PARSER)
  && /typeof \(x as \{ url\?: unknown \}\)\.url === "string"/.test(PARSER)
  && /typeof \(x as \{ have_it\?: unknown \}\)\.have_it === "boolean"/.test(PARSER))
check("feature keys are stable lower-case slugs under the radar: namespace, never empty",
  /replace\(\/\[\^a-z0-9\]\+\/g, "_"\)/.test(RADAR) && /`radar:\$\{slug \|\| "unnamed"\}`/.test(RADAR))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the ledger finder would catch a second table", /create table|radar_findings/i.test('svc.from("radar_findings").insert('))
check("BLINDNESS CONTROL: scans read comment-STRIPPED source", !stripComments("// from(\"feature_flags\").insert(\n").includes("feature_flags"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static + pure parser. The have_it verdict is the model's,")
console.log(" recorded beside the vocabulary it saw. The radar proposes; a build session builds.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ CAPABILITY_RADAR_FAIL"); process.exit(1) }
console.log(" ✅ CAPABILITY_RADAR_PASS — the OS scans, judges against what it has, records once, and tells the platform")
