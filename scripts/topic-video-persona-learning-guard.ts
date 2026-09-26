#!/usr/bin/env tsx
/**
 * scripts/topic-video-persona-learning-guard.ts  (npm run test:topic-video-persona-learning)
 * — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * TOPIC VIDEOS LEARN WHICH CONTACT PERSONAS RESPOND (wave 83, lane 83F).
 *
 * Lane 83B's finding: content_asset_persona_performance.asset_type's CHECK did not
 * admit `situational_reel` (the asset type topic videos claim under), and the
 * performance aggregator had no pass reading video outcomes — so pickTopics'
 * per-persona read for topic videos could only ever come back empty.
 *
 * Asserted:
 *   §check    the asset type is admitted by content_asset_persona_performance's CHECK
 *             — in the live cache (scripts/check-vocabularies.ts) OR by a migration
 *             that re-adds the FULL cached list plus it (nothing narrowed) and carries
 *             a postcondition DO block. Derived from the cache, never a restated list
 *             (+ POSITIVE CONTROLS: a specimen that drops a live value, and one that
 *             omits situational_reel, are both flagged).
 *   §signal   every outcome column the pass reads EXISTS (scripts/schema-snapshot.ts)
 *             and has a WRITER in the tree (named file + code token, comment-stripped);
 *             the lossy share_rate is not read (+ POSITIVE CONTROL: an invented column
 *             is flagged by the same existence check).
 *   §pass     the aggregator pass reads situational_reel claims, the persona stamp,
 *             checks tenant equality on every signal, writes situational_reel rows
 *             keyed by persona with a .select()-ed, counted upsert, only columns that
 *             exist; mounted in aggregatePerformance → the existing aggregator cron
 *             (CRON_REGISTRY) (+ POSITIVE CONTROL: the pre-83F aggregator is flagged).
 *   §runner   the runner stamps the SAME persona it passed pickTopics as
 *             recipientPersona, tenant-scoped and counted, merged (never replacing
 *             video_metadata) (+ POSITIVE CONTROL: the pre-83F runner is flagged).
 *   §pick     pickTopics reads content_asset_persona_performance by (persona, asset_type)
 *             with a samples floor the pass's floor meets.
 *   §score    the pure scorer: noise floor, ordering, cap within the table's 0..30 CHECK.
 *
 * BLIND SPOTS (published): attribution is per VIDEO (the persona the video spoke to),
 * not per viewer — a topic video's viewers have no recipient lifecycle. Live data is
 * zero today (read 2026-09-26: 0 situational_reel claims, 0 project-keyed tracking
 * rows, 0 synced social posts), so this proves the wiring, not a learned ranking.
 * manager-signals' contact reels also claim `situational_reel` but key their pick on
 * a contact_type-derived persona and carry no stamp — the pass skips them BY NAME
 * (no_persona_stamp) rather than guess. The SQL is proven by text, not by applying it.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import {
  TOPIC_VIDEO_ASSET_TYPE, TOPIC_VIDEO_MIN_SAMPLES, TOPIC_VIDEO_PERSONA_KEY, scoreTopicVideoPersona,
  type TopicVideoOutcome,
} from "../lib/video/topic-video"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => stripComments(read(rel))

let failures = 0
let checks = 0
function ok(cond: boolean, label: string, detail = "") {
  checks++
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const AGG = "lib/content-intel/performance-aggregator.ts"
const RUNNER = "lib/video/topic-video-runner.ts"
const BANK = "lib/content-intel/topic-bank.ts"
const MIGRATION = "supabase/migrations/m663-topic-video-persona-performance.sql"
const TABLE = "content_asset_persona_performance"

// ── §check ───────────────────────────────────────────────────────────────────
console.log("§check — the CHECK admits the asset type topic videos claim under")
const liveAdmitted = CHECK_VOCABULARIES[TABLE]?.asset_type ?? []
ok(liveAdmitted.length > 0, `the cache carries ${TABLE}.asset_type (${liveAdmitted.length} values)`)
ok((CHECK_VOCABULARIES.content_topic_uses?.asset_type ?? []).includes(TOPIC_VIDEO_ASSET_TYPE),
  `content_topic_uses.asset_type admits '${TOPIC_VIDEO_ASSET_TYPE}' (the claim side is storable)`)

/** The values an `add constraint … check (asset_type in (…))` admits, or null. */
function widenedValues(sql: string): string[] | null {
  const body = stripSqlComments(sql)
  const m = /add\s+constraint\s+\w+\s+check\s*\(\s*asset_type\s+in\s*\(([^)]*)\)/i.exec(body)
  if (!m) return null
  return Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1])
}
function migrationWidens(sql: string, live: readonly string[]): string[] {
  const why: string[] = []
  const body = stripSqlComments(sql)
  if (!new RegExp(`alter\\s+table\\s+public\\.${TABLE}`, "i").test(body)) why.push(`does not alter ${TABLE}`)
  if (!/drop\s+constraint\s+if\s+exists\s+\w+asset_type_check/i.test(body)) why.push("does not drop the old asset_type CHECK")
  const vals = widenedValues(sql)
  if (!vals) { why.push("re-adds no asset_type CHECK"); return why }
  const lost = live.filter((v) => !vals.includes(v))
  if (lost.length) why.push(`narrows the CHECK (drops ${lost.join(", ")})`)
  if (!vals.includes(TOPIC_VIDEO_ASSET_TYPE)) why.push(`does not admit '${TOPIC_VIDEO_ASSET_TYPE}'`)
  if (!/do\s+\$\$[\s\S]*raise\s+exception[\s\S]*end\s+\$\$/i.test(body)) why.push("carries no postcondition DO block")
  return why
}
const inCache = liveAdmitted.includes(TOPIC_VIDEO_ASSET_TYPE)
const migSql = existsSync(join(root, MIGRATION)) ? read(MIGRATION) : ""
const migWhy = migSql ? migrationWidens(migSql, liveAdmitted) : ["migration file absent"]
ok(inCache || migWhy.length === 0,
  inCache ? `the live CHECK already admits '${TOPIC_VIDEO_ASSET_TYPE}'` : `${MIGRATION} widens the CHECK (full live list + '${TOPIC_VIDEO_ASSET_TYPE}', postcondition)`,
  migWhy.join("; "))
if (migSql) ok(migWhy.length === 0, "the migration itself is a pure widening with a postcondition", migWhy.join("; "))
// POSITIVE CONTROLS — the same detector must flag a narrowing and an omission.
const narrowing = migSql.split(`'${liveAdmitted[0]}',`).join("")
ok(migrationWidens(narrowing, liveAdmitted).some((w) => w.startsWith("narrows")), `control: a specimen dropping '${liveAdmitted[0]}' is flagged as narrowing`)
const omitting = migSql.replace(/,\s*'situational_reel'/, "")
ok(migrationWidens(omitting, liveAdmitted).some((w) => w.includes("does not admit")), "control: a specimen omitting situational_reel is flagged")
// A commented-out CHECK must not count (stripped before scanning).
ok(widenedValues(`-- add constraint x check (asset_type in ('situational_reel'))\nselect 1;`) === null,
  "control: a CHECK inside a SQL comment is not read as the widening")

// ── §signal ──────────────────────────────────────────────────────────────────
console.log("§signal — the pass reads only outcome columns that exist AND are written")
const SIGNALS: Array<{ table: string; columns: string[]; writers: Array<{ file: string; token: RegExp }> }> = [
  {
    table: "video_performance_tracking",
    columns: ["video_project_id", "brokerage_id", "total_views", "average_completion_rate", "click_through_rate", "lead_conversions"],
    writers: [
      { file: "app/api/video/engagement/route.ts", token: /\.from\("video_performance_tracking"\)[\s\S]{0,40}\.insert\(|video_project_id:\s*videoProjectId/ },
      { file: "app/actions/video-generation.ts", token: /video_project_id:\s*data\.videoProjectId/ },
    ],
  },
  {
    table: "ai_video_projects",
    columns: ["id", "brokerage_id", "video_url", "view_count", "video_metadata"],
    writers: [{ file: "app/actions/listing-video.ts", token: /rpc\('increment'[\s\S]{0,160}column_name:\s*'view_count'/ }],
  },
  {
    table: "social_posts",
    columns: ["brokerage_id", "media_urls", "engagement_data"],
    writers: [{ file: "lib/social/analytics-sync.ts", token: /\.update\(\{\s*engagement_data:\s*engagementData\s*\}\)/ }],
  },
]
const absentColumns = (table: string, cols: string[]) => cols.filter((c) => !(SCHEMA_SNAPSHOT[table] ?? []).includes(c))
const aggCode = code(AGG)
for (const s of SIGNALS) {
  const absent = absentColumns(s.table, s.columns)
  ok(absent.length === 0, `${s.table}: every read column exists`, `absent: ${absent.join(", ")}`)
  ok(aggCode.includes(`.from("${s.table}")`), `${s.table}: the aggregator reads it`)
  for (const w of s.writers) ok(w.token.test(code(w.file)), `${s.table}: written by ${w.file}`)
}
ok(absentColumns("video_performance_tracking", ["video_project_views"]).length === 1, "control: an invented column is flagged by the same existence check")
const passStart = aggCode.indexOf("async function aggregateTopicVideoPersonaPerformance(")
const passEnd = aggCode.indexOf("\nasync function ", passStart + 10) > 0 ? aggCode.indexOf("\nasync function ", passStart + 10) : aggCode.length
const pass = passStart >= 0 ? aggCode.slice(passStart, passEnd) : ""
ok(!/share_rate/.test(pass), "the lossy share_rate is NOT read (app/types/video-generation.ts)")

// ── §pass ────────────────────────────────────────────────────────────────────
console.log("§pass — the aggregator pass writes situational_reel rows keyed by persona, tenant-scoped, counted")
function passDefects(src: string): string[] {
  const c = stripComments(src)
  const i = c.indexOf("async function aggregateTopicVideoPersonaPerformance(")
  if (i < 0) return ["no topic-video persona pass"]
  const j = c.indexOf("\nasync function ", i + 10)
  const p = c.slice(i, j > 0 ? j : c.length)
  const code = blankStrings(p)
  const why: string[] = []
  if (!/aggregatePerformance\(\)[\s\S]*await aggregateTopicVideoPersonaPerformance\(svc, since\)/.test(c)) why.push("not mounted in aggregatePerformance")
  if (!/\.eq\("asset_type", TOPIC_VIDEO_ASSET_TYPE\)/.test(p)) why.push("does not read situational_reel claims")
  if (!/TOPIC_VIDEO_PERSONA_KEY/.test(code)) why.push("does not read the persona stamp")
  if ((code.match(/brokerage_id !== /g) ?? []).length < 3) why.push("tenant equality not checked on project, tracking and social rows")
  if (!/\.from\("content_asset_persona_performance"\)[\s\S]{0,120}\.upsert\([\s\S]{0,120}\.select\(/.test(p)) why.push("the upsert is not .select()-ed")
  if (!/rowsWritten \+= /.test(code)) why.push("writes are not counted")
  if (!/asset_type: TOPIC_VIDEO_ASSET_TYPE/.test(code)) why.push("rows not stamped situational_reel")
  if (!/\bpersona,/.test(code)) why.push("rows not keyed by persona")
  if (!/isCampaignPersona\(persona\)/.test(code)) why.push("persona not validated against contacts.contact_persona")
  return why
}
const aggDefects = passDefects(read(AGG))
ok(aggDefects.length === 0, "the pass is complete and mounted", aggDefects.join("; "))
// Every column the pass writes exists on the table.
const writtenCols = ["topic_id", "asset_type", "persona", "persona_open_rate", "persona_click_rate", "persona_samples_count", "performance_score", "computed_at"]
const writeBlock = /upserts\.push\(\{([\s\S]*?)\}\)/.exec(pass)?.[1] ?? ""
const passWrites = Array.from(writeBlock.matchAll(/^\s*(\w+)[,:]/gm), (m) => m[1])
ok(passWrites.length === writtenCols.length && passWrites.every((c) => writtenCols.includes(c)), `the pass writes exactly ${writtenCols.length} columns`, passWrites.join(","))
ok(absentColumns(TABLE, passWrites).length === 0, `every written column exists on ${TABLE} (no PGRST204)`, absentColumns(TABLE, passWrites).join(","))
// Mounted on the EXISTING aggregator cron.
const cronRoute = "app/api/cron/content-performance-aggregator/route.ts"
ok(/await aggregatePerformance\(\)/.test(code(cronRoute)), `${cronRoute} runs aggregatePerformance`)
ok(CRON_REGISTRY.some((c) => c.path === "/api/cron/content-performance-aggregator"), "the aggregator cron is in CRON_REGISTRY")
// POSITIVE CONTROL — the pre-83F aggregator (no pass) must be flagged.
const pre83F = read(AGG).replace(/async function aggregateTopicVideoPersonaPerformance\([\s\S]*?\n\}\n/, "").replace(/await aggregateTopicVideoPersonaPerformance\(svc, since\)/, "void 0")
ok(passDefects(pre83F).length > 0, "control: an aggregator without the pass is flagged")
// A tombstone naming the pass in a COMMENT must not count as the pass.
ok(passDefects(`// async function aggregateTopicVideoPersonaPerformance(svc, since) { }\nexport async function aggregatePerformance() {}`).length > 0,
  "control: the pass named only in a comment is flagged")

// ── §runner ──────────────────────────────────────────────────────────────────
console.log("§runner — the runner stamps the SAME persona it picked with")
function runnerDefects(src: string): string[] {
  const c = blankStrings(stripComments(src))
  const raw = stripComments(src)
  const why: string[] = []
  if (!/recipientPersona: persona,/.test(c)) why.push("pickTopics is not asked for the slot persona")
  if (!/assetType: "situational_reel"/.test(raw)) why.push("pickTopics is not asked for situational_reel")
  if (!/\[TOPIC_VIDEO_PERSONA_KEY\]: persona/.test(c)) why.push("the persona is not stamped")
  if (!/\.\.\.meta, \[TOPIC_VIDEO_PERSONA_KEY\]/.test(c)) why.push("video_metadata is replaced, not merged")
  if (!/\.select\("video_metadata"\)\.eq\("id", r\.videoProjectId\)\.eq\("brokerage_id", t\.id\)/.test(raw)) why.push("the metadata read is not tenant-scoped")
  if (!/\.update\(patch\)\s*\.eq\("id", r\.videoProjectId\)\.eq\("brokerage_id", t\.id\)\.select\("id"\)/.test(raw)) why.push("the stamp write is not tenant-scoped and .select()-ed")
  if (!/persona_stamped/.test(raw) || !/persona_stamp_unreadable/.test(raw)) why.push("the stamp outcome is not counted by name")
  return why
}
const rDefects = runnerDefects(read(RUNNER))
ok(rDefects.length === 0, "the runner stamps, merges, scopes and counts", rDefects.join("; "))
const preRunner = read(RUNNER).replace(/\[TOPIC_VIDEO_PERSONA_KEY\]: persona/g, "")
ok(runnerDefects(preRunner).length > 0, "control: a runner that does not stamp is flagged")

// ── §pick ────────────────────────────────────────────────────────────────────
console.log("§pick — pickTopics reads the rows the pass writes")
const bank = stripComments(read(BANK))
ok(/\.from\("content_asset_persona_performance"\)[\s\S]{0,200}\.eq\("persona", args\.recipientPersona\)[\s\S]{0,80}\.eq\("asset_type", args\.assetType/.test(bank),
  "pickTopics filters content_asset_persona_performance by (recipientPersona, assetType)")
const floor = Number(/MIN_RELIABLE_SAMPLES = (\d+)/.exec(bank)?.[1] ?? NaN)
ok(Number.isFinite(floor) && TOPIC_VIDEO_MIN_SAMPLES >= floor, `the pass's floor (${TOPIC_VIDEO_MIN_SAMPLES}) meets pickTopics' read floor (${floor}) — no written row is invisible`)
ok(TOPIC_VIDEO_PERSONA_KEY.length > 0 && !/\s/.test(TOPIC_VIDEO_PERSONA_KEY), `one metadata key: '${TOPIC_VIDEO_PERSONA_KEY}'`)

// ── §score ───────────────────────────────────────────────────────────────────
console.log("§score — the pure scorer")
const o = (p: Partial<TopicVideoOutcome>): TopicVideoOutcome => ({ trackedViews: 0, completionPct: 0, clickPct: 0, leadConversions: 0, publicViews: 0, socialEngagements: 0, ...p })
ok(scoreTopicVideoPersona([]) === null, "no outcomes → no row")
ok(scoreTopicVideoPersona([o({ trackedViews: 2, publicViews: 1, socialEngagements: 1 })]) === null, "4 touches (below the floor) → no row")
const low = scoreTopicVideoPersona([o({ trackedViews: 20, completionPct: 10, clickPct: 0 })])
const high = scoreTopicVideoPersona([o({ trackedViews: 20, completionPct: 90, clickPct: 40, leadConversions: 2, socialEngagements: 300 })])
ok(!!low && !!high && high.performanceScore > low.performanceScore, `a responsive persona outranks a flat one (${high?.performanceScore} > ${low?.performanceScore})`)
const maxed = scoreTopicVideoPersona([o({ trackedViews: 1e6, completionPct: 500, clickPct: 500, leadConversions: 99, socialEngagements: 1e9 })])
ok(!!maxed && maxed.performanceScore <= 16 && maxed.completionRate <= 100 && maxed.clickRate <= 100, `capped: score ${maxed?.performanceScore} ≤ 16, rates ≤ 100`)
const weighted = scoreTopicVideoPersona([o({ trackedViews: 90, completionPct: 100 }), o({ trackedViews: 10, completionPct: 0 })])
ok(weighted?.completionRate === 90, `rates are view-weighted across a persona's videos (${weighted?.completionRate} = 90)`)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) { console.log(`FAILED — ${failures}`); process.exit(1) }
console.log("OK — topic videos write situational_reel persona rows that pickTopics reads")
