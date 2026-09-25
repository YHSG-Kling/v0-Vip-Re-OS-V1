#!/usr/bin/env tsx
/**
 * scripts/topic-pool-video-guard.ts  (npm run test:topic-pool-video) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TOPIC POOL FEEDS THE DIRECTOR, AUTONOMOUSLY, BY RULE — AND IT IS ONE POOL.
 *
 * OWNER (2026-09-25): "videos should also be derived by the topic pool which
 * should be autonomous."
 *
 * Asserted:
 *   §one-pool   the runner reads topics ONLY through pickTopics (content_topic_bank +
 *               the office claim); the pure rule module does no I/O; no new topic
 *               table is introduced (+ positive control on the detector).
 *   §vocab      every category the rule speaks (season sets, archetype rules, persona
 *               sets) is one the WRITERS write (derived by scanning lib/content-intel
 *               add("…") + promote-to-topic-bank) — §6: a scorer cannot match a
 *               writer across two spellings (+ positive control: market_update is
 *               caught as unwritten).
 *   §season     all 12 months map to a season; in-season lift < local/geo boosts.
 *   §persona    the weekly rotation visits all four personas in four weeks.
 *   §cadence    2 days/week Mar–Aug, 1 otherwise; tenants spread across weekdays.
 *   §shape      archetype by rule — first chain member whose needs are met; every
 *               chain ends in the needs-free explainer; every topic × persona ×
 *               {voiceover, avatar} brief PLANS; a silent host is refused (the
 *               runner's `unplanned` skip is reachable).
 *   §runner     compliance-first script (routed + booked, tenant from the row read),
 *               fair-housing scan BEFORE the Director, the ONE rail (pending_review),
 *               the claim logged AFTER the asset exists, every skip counted by name;
 *               mounted on the existing daily video-plays cron.
 *
 * BLIND SPOTS (published): the model's script quality is not judged here (the
 * Director's hook gate + human approval are the judges); pickTopics' SQL is proven
 * by shape, not against the live bank.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  PERSONA_AUDIENCE, TOPIC_ARCHETYPE_RULES, TOPIC_VIDEO_PERSONAS, isTopicVideoDay, personaForWeek, seasonalCategories,
  topicArchetypeFor, topicCategoriesForPersona, topicScriptPrompt, topicVideoBrief, topicVideoWeekdays, type TopicLike,
} from "../lib/video/topic-video"
import { planCustomVideo, archetypeHosts } from "../lib/video/custom-video-archetypes"
import type { BodyVisualAssets } from "../lib/video/body-visual-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const NONE: BodyVisualAssets = { avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }
const topic = (categories: string[], title = "What closing costs cover"): TopicLike => ({ id: "00000000-0000-4000-8000-000000000001", topic_title: title, value_angle: "a plain walk-through", categories })

console.log("\n── §one-pool · pickTopics is the only door ──")
{
  const runner = readStripped("lib/video/topic-video-runner.ts")
  const rule = readStripped("lib/video/topic-video.ts")
  const fromTables = (s: string) => Array.from(s.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)).map((m) => m[1])
  check("the runner picks through pickTopics (freshness · territory · persona performance · office claim)", /pickTopics\(\{/.test(runner))
  check("the runner never queries content_topic_bank directly", !fromTables(runner).includes("content_topic_bank"), fromTables(runner).join(", "))
  check("POSITIVE CONTROL: the table detector sees a direct bank read", fromTables(`svc.from("content_topic_bank").select("*")`).includes("content_topic_bank"))
  // Wave 82 integration: the runner now post-checks its script (compliance-first is both halves)
  // and PERSISTS any warnings on the row the Director staged — its one write, tenant-scoped and
  // counted. The RULE: it reads only brokerages + agents, and writes nothing but that note.
  check(`the runner reads only brokerages + agents, and its only other table is the counted compliance note on the Director-staged ai_video_projects row (${fromTables(runner).join(", ")})`,
    fromTables(runner).every((t) => t === "brokerages" || t === "agents" || t === "ai_video_projects")
    && (runner.match(/\.from\(\s*"ai_video_projects"\s*\)/g) ?? []).length === 1
    && /\.from\("ai_video_projects"\)\s*\.update\(\{ compliance_violations: complianceWarnings \}\)\s*\.eq\("id", r\.videoProjectId\)\.eq\("brokerage_id", t\.id\)\.select\("id"\)/.test(runner)
    && /await postcheckScript\(/.test(runner))
  check("the rule module is PURE (no supabase, no server-only, no model)", !/supabase|server-only|generateObjectRouted|fetch\(/.test(rule))
  const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => /^m66[2-9]/.test(f))
  const newPool = migrations.filter((f) => /create table[^;]*topic/i.test(read(`supabase/migrations/${f}`)))
  check("no migration this wave creates a second topic table", newPool.length === 0, newPool.join(", "))
  const bank = readStripped("lib/content-intel/topic-bank.ts")
  check("pickTopics carries the seasonal lift (boostCategories → SEASONAL_BOOST in adjusted_score)", /boostCategories\?:\s*string\[\]/.test(bank) && /\+ seasonBoost/.test(bank))
  const boost = Number(/SEASONAL_BOOST\s*=\s*(\d+)/.exec(bank)?.[1] ?? "NaN")
  check(`the season nudges, never outranks a local (+15) or geo (+20) story (SEASONAL_BOOST=${boost})`, boost > 0 && boost < 15)
}

console.log("\n── §vocab · the rule speaks the writers' categories ──")
const writerVocab = new Set<string>()
{
  for (const f of readdirSync(join(root, "lib/content-intel")).filter((f) => f.endsWith(".ts"))) {
    for (const m of readStripped(`lib/content-intel/${f}`).matchAll(/add\("([a-z_]+)"\)/g)) writerVocab.add(m[1])
  }
  if (/"competitor_intel"/.test(readStripped("lib/competitive-intel/promote-to-topic-bank.ts"))) writerVocab.add("competitor_intel")
  console.log(`    writer vocabulary (derived): ${Array.from(writerVocab).sort().join(", ")}`)
  check("the writer vocabulary was found (≥ 6 categories)", writerVocab.size >= 6)
  const unwritten = (cats: string[]) => cats.filter((c) => !writerVocab.has(c))
  check("POSITIVE CONTROL: an unwritten spelling (market_update) is caught", unwritten(["market_update"]).length === 1)
  const seasonCats = Array.from(new Set(Array.from({ length: 12 }, (_, m) => seasonalCategories(m).categories).flat()))
  check("every in-season category is a WRITTEN one", unwritten(seasonCats).length === 0, unwritten(seasonCats).join(", "))
  const ruleCats = TOPIC_ARCHETYPE_RULES.flatMap((r) => r.categories)
  const ruleWritten = ruleCats.filter((c) => writerVocab.has(c))
  check(`the archetype rules cover every written category (${ruleWritten.length}/${writerVocab.size})`, Array.from(writerVocab).every((c) => ruleCats.includes(c)), Array.from(writerVocab).filter((c) => !ruleCats.includes(c)).join(", "))
  for (const p of TOPIC_VIDEO_PERSONAS) {
    const cats = topicCategoriesForPersona(p)
    const hit = cats.filter((c) => writerVocab.has(c))
    check(`persona ${p}: its pick filter overlaps ≥ 2 written categories (${hit.join(", ")})`, hit.length >= 2)
  }
}

console.log("\n── §season · twelve months, four seasons ──")
{
  const seasons = Array.from({ length: 12 }, (_, m) => seasonalCategories(m).season)
  check("Dec–Feb winter, Mar–May spring, Jun–Aug summer, Sep–Nov fall", seasons.join(",") === "winter,winter,spring,spring,spring,summer,summer,summer,fall,fall,fall,winter")
  check("spring leads with the seller (listing season); summer with the buyer (relocation)", seasonalCategories(3).categories[0] === "seller_advice" && seasonalCategories(6).categories[0] === "buyer_advice")
  check("out-of-range months wrap (−1 → December, 12 → January)", seasonalCategories(-1).season === "winter" && seasonalCategories(12).season === "winter")
}

console.log("\n── §persona · the rotation visits everyone ──")
{
  const seen = new Set<string>()
  for (let w = 0; w < 4; w++) seen.add(personaForWeek(new Date(Date.UTC(2026, 8, 7 + w * 7)), "11111111-1111-4111-8111-111111111111"))
  check("four consecutive weeks → all four personas", seen.size === 4, Array.from(seen).join(", "))
  check("the audience lines describe a SITUATION, never a people-group (no protected-class words)",
    Object.values(PERSONA_AUDIENCE).every((a) => !/\b(famil|kid|child|young|old|senior|retire|single|married|christian|church|jewish|muslim|disab|wheelchair|men|women|race|ethnic)/i.test(a)))
}

console.log("\n── §cadence · load spread, seasonal intensity ──")
{
  check("peak months (Mar–Aug) run two weekdays, the rest one", topicVideoWeekdays("abc", 4).length === 2 && topicVideoWeekdays("abc", 10).length === 1)
  const firstDays = new Set<number>()
  for (let i = 0; i < 200; i++) firstDays.add(topicVideoWeekdays(`tenant-${i}`, 10)[0])
  check(`200 tenants spread over all 7 weekdays (${firstDays.size})`, firstDays.size === 7)
  const tenant = "22222222-2222-4222-8222-222222222222"
  let days = 0
  for (let d = 0; d < 7; d++) if (isTopicVideoDay(tenant, new Date(Date.UTC(2026, 4, 3 + d)))) days++
  check("a May week holds exactly two topic-video days for one tenant", days === 2)
}

console.log("\n── §shape · archetype by rule, every brief plans ──")
{
  const md = topicArchetypeFor(topic(["market_education"], "Inventory this quarter"), "voiceover", NONE)
  check("numbers topic with no stat cards → education_explainer, data_update skipped with its reason", md.archetype === "education_explainer" && md.skipped.some((s) => s.archetype === "data_update"))
  const mdStats = topicArchetypeFor(topic(["market_education"]), "voiceover", { ...NONE, statCards: 2 })
  const dataHosts = archetypeHosts("data_update")
  check(`numbers topic WITH stat cards → data_update when the host can carry it (hosts: ${dataHosts.join(", ")})`,
    dataHosts.includes("voiceover") ? mdStats.archetype === "data_update" : mdStats.archetype === "education_explainer")
  check("advice topic → education_explainer", topicArchetypeFor(topic(["seller_advice"]), "voiceover", NONE).archetype === "education_explainer")
  check("every rule chain ENDS in the needs-free explainer", TOPIC_ARCHETYPE_RULES.every((r) => r.chain[r.chain.length - 1] === "education_explainer"))
  check("the rule table is not mutated by a pick (chains copied)", TOPIC_ARCHETYPE_RULES.every((r) => r.chain.filter((a) => a === "education_explainer").length === 1))
  let planned = 0, total = 0
  const misses: string[] = []
  for (const cats of [["market_education"], ["neighborhood"], ["buyer_advice"], ["seller_advice"], ["finance"], ["home_improvement"], ["regulation"], ["competitor_intel"], []]) {
    for (const persona of TOPIC_VIDEO_PERSONAS) {
      total++
      const { brief } = topicVideoBrief({ topic: topic(cats), persona, host: "avatar", assets: { ...NONE, avatarClip: true } })
      const r = planCustomVideo(brief)
      if (r.ok) planned++
      else misses.push(`${cats.join("+") || "none"}/${persona}: ${r.reason}`)
    }
  }
  check(`every topic × persona brief on the runner's host (a ready twin) PLANS (${planned}/${total})`, planned === total, misses.slice(0, 3).join(" | "))
  // The needs-free archetypes are avatar-only (derived) — which is WHY the runner picks an agent with a ready twin.
  const needsFree = (["education_explainer", "talking_head_message"] as const)
  check(`the needs-free archetypes are carried by the avatar host only (derived: ${needsFree.map((a) => `${a}→${archetypeHosts(a).join("/")}`).join(", ")}) — the runner's twin probe is required`,
    needsFree.every((a) => archetypeHosts(a).includes("avatar") && !archetypeHosts(a).includes("voiceover")))
  const bareVoice = planCustomVideo(topicVideoBrief({ topic: topic(["buyer_advice"]), persona: "buyer", host: "voiceover", assets: NONE }).brief)
  check("NEGATIVE CONTROL: a voiceover host with no assets is refused (so the runner must never commission without a twin)", !bareVoice.ok)
  const photoVoice = planCustomVideo(topicVideoBrief({ topic: topic(["neighborhood"], "Walking the riverfront district"), persona: "buyer", host: "voiceover", assets: { ...NONE, propertyPhotos: 4 } }).brief)
  check("a place topic WITH photos plans on the voiceover host as a photo story (the chain's first member)", photoVoice.ok && photoVoice.plan.archetype === "photo_story", photoVoice.ok ? photoVoice.plan.archetype : photoVoice.reason)
  const runnerSrc = readStripped("lib/video/topic-video-runner.ts")
  check("the runner probes for a ready twin (bounded) and skips a tenant with none BY NAME", /MAX_TWIN_PROBES/.test(runnerSrc) && /p\.canRender/.test(runnerSrc) && /"no_twin_ready"/.test(runnerSrc))
  const silent = planCustomVideo(topicVideoBrief({ topic: topic(["buyer_advice"]), persona: "buyer", host: "silent", assets: NONE }).brief)
  check("NEGATIVE CONTROL: a silent host is refused by the planner (the runner's `unplanned` skip is reachable)", !silent.ok)
  const prompt = topicScriptPrompt({ topic: topic(["finance"]), persona: "buyer", words: 120, archetype: "education_explainer" })
  check("the script prompt is compliance-FIRST (Fair Housing in the writing prompt, no invented numbers, not salesy)",
    /Fair Housing Act/.test(prompt) && /Never invent numbers/.test(prompt) && /Not salesy/.test(prompt))
}

console.log("\n── §runner · compliance-first, the ONE rail, the claim after the asset ──")
{
  const r = readStripped("lib/video/topic-video-runner.ts")
  const at = (re: RegExp) => { const m = re.exec(r); return m ? m.index : -1 }
  check("routed + booked: generateObjectRouted with brokerageId from the tenant row (t.id) and a feature key", /generateObjectRouted\(\{[\s\S]{0,200}feature:\s*"video_script_generation"[\s\S]{0,80}brokerageId:\s*t\.id/.test(r))
  check("compliance system blocks + spoken standards wrap the prompt", /buildComplianceSystemBlocks\(t\.id/.test(r) && /withSpokenScriptStandards\(topicScriptPrompt\(/.test(r))
  const scan = at(/detectFairHousingRedFlags\(/), commission = at(/commissionCustomVideo\(brief/), claim = at(/logTopicUses\(\{/)
  check("order: fair-housing scan → Director → claim", scan > 0 && commission > scan && claim > commission, `scan@${scan} commission@${commission} claim@${claim}`)
  check("the claim is logged only for a NEWLY staged video, with the project as the asset", /r\.status !== "staged"/.test(r) && /assetId:\s*r\.videoProjectId/.test(r))
  check("pickTopics is asked with territory, persona, season and markUsed:false (claim later)",
    /recipientLocation:\s*\{\s*city:\s*t\.city,\s*state:\s*t\.state,\s*zip_code:\s*t\.zip\s*\}/.test(r) && /recipientPersona:\s*persona/.test(r) && /boostCategories:\s*season\.categories/.test(r) && /markUsed:\s*false/.test(r))
  check("refusals are READ ({ data, error } on the tenant and agent reads)", /\{\s*data:\s*tenants,\s*error:\s*tenantErr\s*\}/.test(r) && /\{\s*data:\s*agents,\s*error:\s*agentErr\s*\}/.test(r))
  check("every skip is counted by name (bump) — demo, day, no agent, empty pool, unplanned, red flag, director status",
    ["demo_tenant", "not_this_tenants_day", "no_active_agent", "pool_empty_for_persona", "unplanned", "fair_housing_red_flag"].every((k) => r.includes(`"${k}"`)) && /director_\$\{r\.status\}/.test(r))
  const director = readStripped("lib/video/video-director.ts")
  check("the ONE rail stages pending_review (a human approves every customer-facing video)", /approval_status:\s*"pending_review"/.test(director) && /export async function commissionCustomVideo/.test(director))
  const cron = readStripped("app/api/cron/video-plays/route.ts")
  check("mounted on the EXISTING daily video-plays cron (no new cron)", /runTopicPoolVideos\(svc\)/.test(cron) && /"\/api\/cron\/video-plays"/.test(readStripped("lib/kernel/cron-dispatch.ts")))
}

console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:topic-pool-video runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:topic-pool-video"] === "tsx scripts/topic-pool-video-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:topic-pool-video") > guard.indexOf("npm run test:scrapers"))
  check("manager-registry: MAINTENANCE_DOMAINS.topic_pool_video names asset_manager with co-owners", /topic_pool_video:\s*\{ manager: "asset_manager", proof: "test:topic-pool-video", coOwners: \[[^\]]+\]/.test(readStripped("lib/kernel/manager-registry.ts")))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
