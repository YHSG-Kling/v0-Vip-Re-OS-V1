#!/usr/bin/env tsx
/**
 * scripts/topic-video-cadence-guard.ts  (npm run test:topic-video-cadence) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * TOP OF MIND IS A CADENCE, NOT ONE VIDEO A WEEK — AND IT IS THE TENANT'S TO SET.
 *
 * OWNER (2026-09-26, verbatim): "an agent needs to stay top of mind for their
 * market so one video a week, doesn't seem like enough."
 *
 * Asserted (the RULE; numbers derived, never pinned to a waypoint):
 *   §default   the default off-peak cadence is at least the researched short-form
 *              floor (3/week — sources cited in lib/video/topic-video.ts), above the
 *              82C baseline the owner rejected (1/week), and the peak never lowers it.
 *   §bounds    whatever is stored resolves into [MIN, MAX] (junk, strings, 0, 99, NaN);
 *              MAX is one a day (the runner rides a daily cron); switched off → 0 days.
 *   §spread    for every count 1..MAX in every month: that many DISTINCT weekdays, spread
 *              as evenly as the week allows (circular gaps differ by ≤ 1), and tenants
 *              spread across all seven starting days (load, cost-down).
 *   §slots     each of the week's slots is ASSIGNED a distinct contact persona while the
 *              rotation is long enough; a short rotation never repeats back-to-back; the
 *              claim ledger (pickTopics' office claim) keeps topics from repeating.
 *   §gates     every slot still passes compliance-first + postcheckScript + the Director's
 *              pending_review approval (shape of the runner).
 *   §settings  per-tenant in brokerage_settings.settings (jsonb, no migration): the runner
 *              reads the ONE key through the ONE resolver; the door is session-tenant,
 *              admin-gated, bounded and counts its write (+ positive controls).
 *   §cost      the approval load and the render estimate are published per cadence.
 *
 * BLIND SPOTS (published): the research numbers are cited, not re-fetched here; the
 * render estimate is the avatar leg (estimateAvatarRenderCostUsd) — a voiceover-host
 * video costs less (no D-ID seconds); the model-call cost of the script is booked on
 * ai_tool_usage at run time and not estimated here.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  TOPIC_VIDEO_CADENCE_DEFAULT, TOPIC_VIDEO_CADENCE_KEY, TOPIC_VIDEO_CADENCE_MAX, TOPIC_VIDEO_CADENCE_MIN, TOPIC_VIDEO_PERSONAS,
  isTopicVideoDay, personaForSlot, personaRotation, resolveTopicVideoCadence, topicScriptWords, topicVideoSlotToday,
  topicVideoWeekdays, topicVideosPerWeek,
} from "../lib/video/topic-video"
import { PURPOSE_DURATION_RULES } from "../lib/video/duration-model"
import { estimateAvatarRenderCostUsd } from "../lib/video/realism-profile"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const OFF_PEAK = 10 // November
const PEAK = 4      // May

console.log("\n── §default · the researched floor, above the rejected baseline ──")
{
  const RESEARCH_FLOOR = 3 // realtor.com 2025-07 · reel-e.ai 2026-02 · listingclip.com 2026-05 · kristamashore.com 2026-06
  const REJECTED_BASELINE = 1 // 82C: one a week off-peak (owner: "doesn't seem like enough")
  const d = TOPIC_VIDEO_CADENCE_DEFAULT
  check(`default off-peak ${topicVideosPerWeek(d, OFF_PEAK)}/week ≥ the research floor (${RESEARCH_FLOOR}) and > the rejected baseline (${REJECTED_BASELINE})`,
    topicVideosPerWeek(d, OFF_PEAK) >= RESEARCH_FLOOR && topicVideosPerWeek(d, OFF_PEAK) > REJECTED_BASELINE)
  check(`the peak never lowers it (peak ${topicVideosPerWeek(d, PEAK)} ≥ off-peak ${topicVideosPerWeek(d, OFF_PEAK)}); the lift is on by default`,
    topicVideosPerWeek(d, PEAK) >= topicVideosPerWeek(d, OFF_PEAK) && d.seasonalLift && d.enabled)
  const header = read("lib/video/topic-video.ts")
  const cited = ["realtor.com 2025-07", "reel-e.ai 2026-02", "listingclip.com", "kristamashore.com"].filter((s) => header.includes(s))
  check(`the default cites its research in the rule module (${cited.length}/4 sources)`, cited.length === 4)
}

console.log("\n── §bounds · whatever is stored resolves into the bounds ──")
{
  const r = resolveTopicVideoCadence
  check(`MIN ${TOPIC_VIDEO_CADENCE_MIN} ≤ default ${TOPIC_VIDEO_CADENCE_DEFAULT.perWeek} ≤ MAX ${TOPIC_VIDEO_CADENCE_MAX} = 7 (one a day — a daily cron)`,
    TOPIC_VIDEO_CADENCE_MIN >= 1 && TOPIC_VIDEO_CADENCE_DEFAULT.perWeek >= TOPIC_VIDEO_CADENCE_MIN && TOPIC_VIDEO_CADENCE_DEFAULT.perWeek <= TOPIC_VIDEO_CADENCE_MAX && TOPIC_VIDEO_CADENCE_MAX === 7)
  check("nothing stored → the default", JSON.stringify(r(undefined)) === JSON.stringify(TOPIC_VIDEO_CADENCE_DEFAULT) && JSON.stringify(r(null)) === JSON.stringify(TOPIC_VIDEO_CADENCE_DEFAULT))
  check("junk → the default (a string count, NaN, an array)", r({ perWeek: "5" }).perWeek === TOPIC_VIDEO_CADENCE_DEFAULT.perWeek && r({ perWeek: NaN }).perWeek === TOPIC_VIDEO_CADENCE_DEFAULT.perWeek && r([]).perWeek === TOPIC_VIDEO_CADENCE_DEFAULT.perWeek)
  check("0 → MIN, 99 → MAX, 4.6 → 5", r({ perWeek: 0 }).perWeek === TOPIC_VIDEO_CADENCE_MIN && r({ perWeek: 99 }).perWeek === TOPIC_VIDEO_CADENCE_MAX && r({ perWeek: 4.6 }).perWeek === 5)
  check("the peak lift never exceeds MAX (7 + lift = 7)", topicVideosPerWeek(r({ perWeek: 7 }), PEAK) === TOPIC_VIDEO_CADENCE_MAX)
  check("seasonalLift:false → the same count all year", topicVideosPerWeek(r({ perWeek: 3, seasonalLift: false }), PEAK) === 3)
  const off = r({ enabled: false })
  check("switched OFF → zero a week and no day is a topic-video day", topicVideosPerWeek(off, PEAK) === 0 && topicVideoWeekdays("t", PEAK, off).length === 0
    && Array.from({ length: 7 }, (_, i) => isTopicVideoDay("t", new Date(Date.UTC(2026, 4, 3 + i)), off)).every((x) => !x))
}

console.log("\n── §spread · distinct days, evenly spread, tenants spread ──")
{
  const bad: string[] = []
  for (let n = TOPIC_VIDEO_CADENCE_MIN; n <= TOPIC_VIDEO_CADENCE_MAX; n++) {
    for (const month of [OFF_PEAK, PEAK]) {
      const cad = resolveTopicVideoCadence({ perWeek: n, seasonalLift: true })
      const want = topicVideosPerWeek(cad, month)
      for (const tenant of ["a", "tenant-7", "33333333-3333-4333-8333-333333333333"]) {
        const days = topicVideoWeekdays(tenant, month, cad)
        const sorted = [...days].sort((a, b) => a - b)
        const gaps = sorted.map((d, i) => ((sorted[(i + 1) % sorted.length] - d + 7) % 7) || 7)
        if (days.length !== want || new Set(days).size !== want || (want > 1 && Math.max(...gaps) - Math.min(...gaps) > 1)) bad.push(`${tenant} n=${n} m=${month}: ${days.join(",")}`)
      }
    }
  }
  check(`every count ${TOPIC_VIDEO_CADENCE_MIN}..${TOPIC_VIDEO_CADENCE_MAX} × {peak, off-peak}: that many DISTINCT weekdays, circular gaps within 1 of each other`, bad.length === 0, bad.slice(0, 3).join(" | "))
  const lumpy = (days: number[]) => { const s = [...days].sort((a, b) => a - b); const g = s.map((d, i) => ((s[(i + 1) % s.length] - d + 7) % 7) || 7); return Math.max(...g) - Math.min(...g) > 1 }
  check("POSITIVE CONTROL: the spread check flags three videos bunched Mon-Tue-Wed", lumpy([1, 2, 3]) && !lumpy([0, 2, 4]))
  const firstDays = new Set<number>()
  for (let i = 0; i < 200; i++) firstDays.add(topicVideoWeekdays(`tenant-${i}`, OFF_PEAK)[0])
  check(`200 tenants spread over all 7 starting weekdays (${firstDays.size})`, firstDays.size === 7)
  const tenant = "22222222-2222-4222-8222-222222222222"
  const count = (month: number, day0: number) => Array.from({ length: 7 }, (_, d) => isTopicVideoDay(tenant, new Date(Date.UTC(2026, month, day0 + d)))).filter(Boolean).length
  check(`a real May week holds ${count(4, 3)} topic-video days and a November week ${count(10, 1)} (default cadence, derived)`,
    count(4, 3) === topicVideosPerWeek(TOPIC_VIDEO_CADENCE_DEFAULT, PEAK) && count(10, 1) === topicVideosPerWeek(TOPIC_VIDEO_CADENCE_DEFAULT, OFF_PEAK))
  const idx = Array.from({ length: 7 }, (_, d) => topicVideoSlotToday(tenant, new Date(Date.UTC(2026, 4, 3 + d)))).filter((i) => i >= 0).sort()
  check(`the week's slot indexes are 0..n-1, one per day (${idx.join(",")})`, idx.join() === Array.from({ length: idx.length }, (_, i) => i).join())
}

console.log("\n── §slots · each slot ASSIGNED a persona; topics never repeat ──")
{
  const tenant = "44444444-4444-4444-8444-444444444444"
  const d = new Date(Date.UTC(2026, 4, 4))
  const bad: string[] = []
  for (let n = 1; n <= TOPIC_VIDEO_CADENCE_MAX; n++) {
    const week = Array.from({ length: n }, (_, i) => personaForSlot(d, tenant, i, n))
    if (new Set(week).size !== n) bad.push(`n=${n}: ${week.join(",")}`)
  }
  check(`with the full roster (${TOPIC_VIDEO_PERSONAS.length}), every count 1..${TOPIC_VIDEO_CADENCE_MAX} gives the week's slots DISTINCT personas`, bad.length === 0, bad.join(" | "))
  const two = personaRotation(["investor", "senior", "investor"])
  const w = Array.from({ length: 4 }, (_, i) => personaForSlot(d, tenant, i, 4, two))
  check(`a two-persona book at 4/week alternates (${w.join(", ")}) — never the same persona back-to-back`, w.every((p, i) => i === 0 || p !== w[i - 1]))
  const runner = readStripped("lib/video/topic-video-runner.ts")
  check("the runner picks ONE topic per slot through the claim-aware pickTopics and claims it after the video exists (so the week's next slot cannot pick it)",
    /pickTopics\(\{[\s\S]{0,400}limit:\s*1[\s\S]{0,120}markUsed:\s*false/.test(runner) && /logTopicUses\(\{ topicIds: \[topic\.id\], brokerageId: t\.id, assetType: "situational_reel"/.test(runner))
  const bank = readStripped("lib/content-intel/topic-bank.ts")
  check("the claim ledger blocks the SAME asset type for the SAME agent too (only a cross-format reuse by the same agent passes)",
    /const ownCrossFormat = askerAgent !== null && c\.agent_id === askerAgent && c\.asset_type !== askedAssetType/.test(bank))
  check("content_topic_uses admits the claim's asset type (situational_reel in the live CHECK)", (CHECK_VOCABULARIES.content_topic_uses?.asset_type ?? []).includes("situational_reel"))
}

console.log("\n── §gates · more videos, the same gates on every one ──")
{
  const r = readStripped("lib/video/topic-video-runner.ts")
  check("every slot: compliance blocks in the writing prompt → fair-housing refusal → postcheckScript → commissionCustomVideo (pending_review)",
    /buildComplianceSystemBlocks\(t\.id/.test(r) && /detectFairHousingRedFlags\(/.test(r) && /await postcheckScript\(/.test(r) && /commissionCustomVideo\(brief/.test(r))
  check("the Director stages every one for a human (approval_status pending_review)", /approval_status:\s*"pending_review"/.test(readStripped("lib/video/video-director.ts")))
  check("a tenant runs at most ONE slot per daily tick (one slot index per day; no loop over slots)", /const slot = topicVideoSlotToday\(t\.id, now, cadence\)/.test(r) && !/for\s*\(\s*let\s+\w+\s*=\s*0;\s*\w+\s*<\s*topicVideosPerWeek/.test(r))
}

console.log("\n── §settings · per tenant, jsonb, the ONE key, the ONE resolver, a session door ──")
{
  const r = blankStrings(readStripped("lib/video/topic-video-runner.ts"))
  const rRaw = readStripped("lib/video/topic-video-runner.ts")
  check(`the runner reads brokerage_settings.settings->${TOPIC_VIDEO_CADENCE_KEY} (one read for every tenant) and resolves it through resolveTopicVideoCadence`,
    /\.from\("brokerage_settings"\)\s*\.select\(`brokerage_id, cadence:settings->\$\{TOPIC_VIDEO_CADENCE_KEY\}`\)/.test(rRaw) && /resolveTopicVideoCadence\(cadenceByTenant\.get\(t\.id\)\)/.test(r))
  check("a refused cadence read is COUNTED and falls to the default (never silently 'every tenant off')", /"cadence_read_refused_default_used"/.test(rRaw))
  check(`no CHECK constrains brokerage_settings.settings (jsonb) — no migration needed`, !CHECK_VOCABULARIES.brokerage_settings?.settings)
  const door = read("app/actions/video/topic-video-cadence.ts")
  const doorS = readStripped("app/actions/video/topic-video-cadence.ts")
  const exportsSync = Array.from(doorS.matchAll(/export\s+(?!async\s+function|interface|type)(const|function|let)\s+(\w+)/g)).map((m) => m[2])
  check("the door is \"use server\" and every exported value is an async function", /^"use server"/.test(door.trimStart()) && exportsSync.length === 0, exportsSync.join(", "))
  check("the tenant comes from the SESSION (requireTenantAdminOrSoloOwner → auth.brokerageId), never the body", /requireTenantAdminOrSoloOwner\(\)/.test(doorS) && /\.eq\("brokerage_id", auth\.brokerageId\)/.test(doorS) && !/input\??\.brokerageId|brokerageId\s*:\s*string\s*[;,}]/.test(doorS.split("export async function setTopicVideoCadenceAction")[1] ?? ""))
  check("POSITIVE CONTROL: the body-tenant detector flags `input.brokerageId`", /input\??\.brokerageId/.test("svc.eq('brokerage_id', input.brokerageId)"))
  check("gate FIRST, then the service client (the auth call precedes createServiceClient in the setter)",
    (() => { const s = doorS.split("export async function setTopicVideoCadenceAction")[1] ?? ""; return s.indexOf("requireTenantAdminOrSoloOwner") >= 0 && s.indexOf("requireTenantAdminOrSoloOwner") < s.indexOf("createServiceClient") })())
  check("the stored value is bounded by the ONE resolver and the write is COUNTED (an update that matches nothing is a refusal)",
    /resolveTopicVideoCadence\(\{/.test(doorS) && /wrote\.length !== 1/.test(doorS) && /\.select\("id"\)/.test(doorS))
  const client = readStripped("app/settings/campaign-bundles/client.tsx")
  check("the tenant's admin can reach it: TopicVideoCadenceCard is mounted on the campaign-bundles settings page", /<TopicVideoCadenceCard\s*\/>/.test(client) && /from "\.\/topic-video-cadence-card"/.test(client))
}

console.log("\n── §cost · the approval load and the render estimate, published ──")
{
  const words = topicScriptWords(PURPOSE_DURATION_RULES.explainer.idealSeconds, "avatar")
  const sample = Array.from({ length: words }, (_, i) => (i % 12 === 11 ? "home." : "home")).join(" ")
  const perVideo = estimateAvatarRenderCostUsd(sample)
  const rows: string[] = []
  for (const n of [1, 3, 4, 5, 7]) {
    const perMonth = Math.round(n * 52 / 12 * 10) / 10
    rows.push(`${n}/wk → ${perMonth} videos + ${perMonth} approvals a month ≈ $${(perMonth * perVideo).toFixed(2)} avatar render`)
  }
  console.log(`    per video (avatar, ${words} words ≈ ${PURPOSE_DURATION_RULES.explainer.idealSeconds}s): ≈ $${perVideo.toFixed(4)} (ElevenLabs chars + D-ID seconds, realism-profile.ts)`)
  for (const row of rows) console.log(`      ${row}`)
  check("the per-video estimate is derived from the ONE cost helper and is > $0 (never a free-looking cadence)", perVideo > 0)
  check("the default's monthly load is published (videos = approvals: every one waits for a person)", rows.some((r) => r.startsWith(`${TOPIC_VIDEO_CADENCE_DEFAULT.perWeek}/wk`)))
}

console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:topic-video-cadence runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:topic-video-cadence"] === "tsx scripts/topic-video-cadence-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:topic-video-cadence") > guard.indexOf("npm run test:scrapers"))
  check("manager-registry: MAINTENANCE_DOMAINS.topic_video_cadence names asset_manager with co-owners",
    /topic_video_cadence:\s*\{ manager: "asset_manager", proof: "test:topic-video-cadence", coOwners: \[[^\]]+\]/.test(readStripped("lib/kernel/manager-registry.ts")))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
