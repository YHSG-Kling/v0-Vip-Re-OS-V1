#!/usr/bin/env tsx
/**
 * scripts/ai-authored-record-simulator.ts   (npm run test:ai-authored-record) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THE AI ACTS, ITS RECORD MUST BE STORABLE.
 *
 * Three columns rejected the exact values the product's own autonomous surfaces
 * write. Every one of those writes is best-effort, so every one was lost in
 * silence — the feature reported success and persisted nothing.
 *
 * ── 1. The review automation persisted NOTHING ──────────────────────────────
 * app/actions/ai-review-automation.ts writes three artifacts to
 * ai_assistant_notes — a drafted review request, a negative-review recovery
 * plan, a monitoring config. It had FOUR separate reasons to fail:
 *
 *   note_type   'review_request_draft' / 'review_recovery_plan' /
 *               'review_monitoring_config' — the CHECK admitted none. (m295)
 *   source      'ai_review_automation' — the CHECK admits ai_assistant |
 *               ai_draft_human_approved | human. This one is NOT a missing
 *               value, it is a CATEGORY ERROR: source names the PRODUCER CLASS,
 *               not the subsystem. Deliberately not widened; the call sites are
 *               repointed to 'ai_assistant' and the subsystem now lives in
 *               note_type, which is where the distinction belongs.
 *   brokerage_id  NOT NULL — and two of the three inserts omitted it entirely.
 *               Widening the vocabularies alone would NOT have made those two
 *               land. Resolved once per action from the agent row.
 *   RLS         the tenant INSERT policy requires
 *               brokerage_id = current_user_brokerage_id(), so a null tenant
 *               fails twice over.
 *
 * The monitoring config is the sharpest of the three: aiSetupReviewMonitoring
 * returned "Review monitoring configured for google, zillow…" while storing
 * nothing at all. The success message was the only trace the setting ever
 * existed.
 *
 * ── 2. Two channels could re-spend a topic forever ──────────────────────────
 * content_topic_uses is the ledger that stops one topic being spent twice on
 * the same channel. Direct-mail postcards (marketing-agent-actions,
 * dispatch-farm-mail) and situational reels (manager-signals ×2) each log a use;
 * asset_type admitted neither, so both channels were invisible to
 * de-duplication AND to the per-persona performance aggregator that compounds
 * winning topics. Widening — not flattening to an existing value — is what
 * preserves de-duplication, because the reader
 * (lib/content-intel/performance-aggregator.ts) filters BY asset_type.
 *
 * ── 3. An AI-booked showing could not say it was AI-booked ──────────────────
 * showings.sync_source names where a showing came from and admitted only
 * manual / other / showingtime. The AI scheduler and the workflow sequence
 * adapter both write their own origin. 'other' was never the right fallback: it
 * erases exactly the fact that no human booked this. The privacy data-subject
 * export reads this column, so the origin is disclosed to the subject.
 *
 * ── 4. The floating assistant's note type is now clamped ────────────────────
 * app/api/internal/ai-note/route.ts takes noteType from the prepare_note model.
 * The prompt asks for one of nine values but cannot bind the model to them, and
 * that insert DOES check its error — it returns a 500 "Failed to save note". So
 * one creative answer costs the user their note with no way to tell why.
 * clampNoteType() falls back to 'general'.
 *
 * VERIFIED LIVE before this simulator was written: with m295 applied, all three
 * new note_types insert; both old `source` literals still raise check_violation
 * (they were never meant to be admitted); both new asset_types and both new
 * sync_sources insert; and a value outside each widened vocabulary is still
 * rejected — the widening is exact, not a hole. Probe rows were deleted and the
 * counts confirmed back to zero.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

/**
 * PURE — the top-level keys of the argument object of a `.from(table).insert({…})`
 * call, plus the literal each key was given. The window is cut at the next
 * `.from(` so a later insert in the same file is never attributed to this one,
 * and nesting depth is tracked so a key inside a nested object is not mistaken
 * for a column.
 */
export function insertPayloads(text: string, table: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const re = new RegExp(`\\.from\\("${table}"\\)[\\s\\S]*?\\.insert\\(\\s*\\{`, "g")
  for (const m of text.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length
    let depth = 1, i = start
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (c === "{") depth++
      else if (c === "}") depth--
      i++
    }
    const body = text.slice(start, i - 1)

    // Split on commas at depth 0 — NOT on newlines. Several of these payloads
    // put two or three columns on one line, and a line-based split silently
    // swallows every key after the first, which is exactly how the
    // situational_reel writes escaped an earlier version of this reader.
    const parts: string[] = []
    let d = 0, buf = "", q: string | null = null
    for (const c of body) {
      if (q) { buf += c; if (c === q) q = null; continue }
      if (c === '"' || c === "'" || c === "`") { q = c; buf += c; continue }
      if ("{[(".includes(c)) d++
      else if ("}])".includes(c)) d--
      if (c === "," && d === 0) { parts.push(buf); buf = "" } else buf += c
    }
    parts.push(buf)

    const fields: Record<string, string> = {}
    for (const part of parts) {
      const kv = /^\s*([a-z_]+)\s*:\s*([\s\S]+)$/.exec(part)
      if (kv) fields[kv[1]] = kv[2].trim()
    }
    out.push(fields)
  }
  return out
}

const unquote = (v: string) => /^"([^"]*)"$/.exec(v)?.[1] ?? null

console.log("══════════════════════════════════════════════════")
console.log(" AI-authored records (the write the AI makes must be storable)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure] the payload reader")
{
  const sample = `
    await db.from("t").insert({
      brokerage_id: bid,
      note_type: "a", source: "b",
      payload: { note_type: "NESTED" },
    })
    await db.from("other").insert({ note_type: "c" })`
  const p = insertPayloads(sample, "t")
  check("one payload for one insert", p.length === 1)
  check("top-level keys are read", p[0].note_type === `"a"` && p[0].brokerage_id === "bid")
  check("TWO keys on one line are BOTH read", p[0].source === `"b"`)
  check("a nested key is NOT read as a column", !Object.values(p[0]).includes(`"NESTED"`))
  check("a comma inside a string literal does not split a field",
    insertPayloads(`db.from("t").insert({ note_text: "a, b", note_type: "x" })`, "t")[0].note_type === `"x"`)
  check("a later insert on another table is not attributed",
    insertPayloads(sample, "other").length === 1)
}

console.log("\n── ai_assistant_notes: note_type carries the subsystem, source does not ──")
{
  const note = CHECK_VOCABULARIES.ai_assistant_notes?.note_type ?? []
  const source = CHECK_VOCABULARIES.ai_assistant_notes?.source ?? []

  for (const t of ["review_request_draft", "review_recovery_plan", "review_monitoring_config"]) {
    check(`note_type admits '${t}' (m295)`, note.includes(t))
  }
  check("the nine pre-existing note types are untouched — m295 is additive",
    ["action_item", "call_outcome", "decision", "follow_up", "general",
     "loan_update", "meeting_outcome", "observation", "vendor_update"].every((t) => note.includes(t)))

  check(`source is exactly the three producer classes (${source.join(", ")})`,
    source.length === 3 && ["ai_assistant", "ai_draft_human_approved", "human"].every((s) => source.includes(s)))
  check("source does NOT admit 'ai_review_automation' — a subsystem is not a producer class",
    !source.includes("ai_review_automation"))
  check("source does NOT admit 'internal_ai_assistant' either",
    !source.includes("internal_ai_assistant"))
}

console.log("\n── every ai_assistant_notes write in the repo is storable ──")
{
  const note = CHECK_VOCABULARIES.ai_assistant_notes?.note_type ?? []
  const source = CHECK_VOCABULARIES.ai_assistant_notes?.source ?? []
  const files = [
    "app/actions/ai-review-automation.ts",
    "app/api/internal/ai-note/route.ts",
    "lib/kernel/reporting.ts",
    "lib/kernel/ai-tools.ts",
  ]

  let payloads = 0
  for (const f of files) {
    for (const p of insertPayloads(src(f), "ai_assistant_notes")) {
      payloads++
      const nt = p.note_type ? unquote(p.note_type) : null
      const so = p.source ? unquote(p.source) : null
      if (nt !== null) check(`${f}: note_type '${nt}' is admitted`, note.includes(nt))
      if (so !== null) check(`${f}: source '${so}' is admitted`, source.includes(so))
      // brokerage_id is NOT NULL *and* required by the tenant INSERT policy.
      check(`${f}: the insert supplies brokerage_id`, "brokerage_id" in p)
    }
  }
  check("all four writer files were scanned and had payloads", payloads >= 5)
}

console.log("\n── the review automation resolves its tenant BEFORE it writes ──")
{
  const v = src("app/actions/ai-review-automation.ts")
  check("a shared brokerage resolver exists", /async function resolveNoteBrokerageId/.test(v))
  // WAS: "…and it tries BOTH id classes (agents.id or users.id)".
  // That assertion locked a WORKAROUND in as an invariant. Trying both columns
  // was never the design — it was the symptom of callers passing two different
  // id classes into the same parameter, and it kept the ambiguity alive
  // downstream. m346 declared the class (agents.id), corrected the caller that
  // disagreed, and resolves agents→users for the users-class columns. The guard
  // now asserts the resolution rather than the guessing.
  check("…and it takes ONE declared id class — agents.id — instead of guessing",
    /\.eq\("id", agentRecordId\)/.test(v) && !/user_id\.eq\./.test(v))
  // SPLIT BY m366, which re-pointed review_requests.agent_id from users(id) to
  // agents(id). This used to assert that BOTH columns were resolved to a users
  // id — true when it was written, half-wrong now. Verified live against
  // pg_constraint: review_requests.agent_id -> agents(id) ON DELETE CASCADE,
  // lifecycle_events.actor_user_id -> users(id). So one takes the declared
  // agents id straight, and the other still has to be RESOLVED. Asserting them
  // together is what made a correct change look like a regression.
  check("review_requests.agent_id takes the declared agents id directly, because " +
        "that column FKs agents(id) since m366",
    /agent_id:\s*params\.agentId,/.test(v) && !/agent_id:\s*agentUserId/.test(v))
  check("…while lifecycle_events.actor_user_id is still RESOLVED agents->users, " +
        "because THAT column still FKs users(id)",
    /resolveUserIdForAgentRecord\(supabase, params\.agentId\)/.test(v) &&
    /actor_user_id: agentUserId/.test(v))
  check("the producer class is a named constant, not a subsystem string",
    /const AI_NOTE_SOURCE = "ai_assistant"/.test(v))
  check("no call site still writes the subsystem into source",
    !/source:\s*"ai_review_automation"/.test(v))
  check("all three note writes go through the constant",
    (v.match(/source:\s*AI_NOTE_SOURCE/g) ?? []).length === 3)
  check("the monitoring config REFUSES to claim success when the tenant is unresolved",
    /monitoring was not saved/.test(v))
}

console.log("\n── the floating assistant clamps the model's note_type ──")
{
  const r = src("app/api/internal/ai-note/route.ts")
  const note = CHECK_VOCABULARIES.ai_assistant_notes?.note_type ?? []
  check("a clamp exists", /const clampNoteType/.test(r))
  check("it falls back to a real value", /\?\s*v\s*:\s*"general"/.test(r) && note.includes("general"))
  check("the raw model value is no longer inserted", !/note_type:\s*noteType,/.test(r))
  check("the clamped value is what is inserted", /note_type:\s*safeNoteType,/.test(r))
  check("…and what titles the activity, so the two cannot diverge",
    /NOTE_TYPE_TITLE\[safeNoteType\]/.test(r))
  check("the clamp's key set is inside the live vocabulary",
    ["general", "call_outcome", "meeting_outcome", "follow_up", "decision",
     "action_item", "loan_update", "vendor_update", "observation"].every((t) => note.includes(t)))
}

console.log("\n── content_topic_uses: the two blind channels can log a use ──")
{
  const live = CHECK_VOCABULARIES.content_topic_uses?.asset_type ?? []
  check("asset_type admits 'direct_mail_postcard' (m295)", live.includes("direct_mail_postcard"))
  check("asset_type admits 'situational_reel' (m295)", live.includes("situational_reel"))
  check("the six pre-existing asset types are untouched",
    ["blog_post", "marketing_plan_item", "newsletter_campaign", "newsletter_video",
     "podcast_episode", "social_post"].every((t) => live.includes(t)))

  let scanned = 0
  for (const f of [
    "lib/agents/marketing-agent-actions.ts",
    "lib/farm-mail/dispatch-farm-mail.ts",
    "lib/kernel/manager-signals.ts",
  ]) {
    for (const p of insertPayloads(src(f), "content_topic_uses")) {
      scanned++
      const a = p.asset_type ? unquote(p.asset_type) : null
      if (a !== null) check(`${f}: asset_type '${a}' is admitted`, live.includes(a))
      // topic_id and asset_type are the NOT NULL columns; used_at defaults.
      check(`${f}: the ledger row names its topic`, "topic_id" in p)
    }
  }
  check("all four ledger writers were found", scanned === 4)

  const agg = src("lib/content-intel/performance-aggregator.ts")
  check("asset_type has a real reader — which is why widening beats flattening",
    /\.eq\("asset_type",/.test(agg))
}

console.log("\n── showings.sync_source: an AI-booked showing says so ──")
{
  const live = CHECK_VOCABULARIES.showings?.sync_source ?? []
  check("sync_source admits 'ai_scheduler' (m295)", live.includes("ai_scheduler"))
  check("sync_source admits 'workflow_sequence' (m295)", live.includes("workflow_sequence"))
  check("the three pre-existing origins are untouched",
    ["manual", "other", "showingtime"].every((s) => live.includes(s)))

  let seen = 0
  for (const f of [
    "app/actions/ai-showing-management.ts",
    "lib/workflow/adapters/schedule-showing.ts",
    "app/actions/seller-showings.ts",
    "app/actions/tour-planner.ts",
  ]) {
    const t = src(f)
    for (const m of t.matchAll(/sync_source:\s*'?"?(\w+)'?"?/g)) {
      seen++
      check(`${f}: sync_source '${m[1]}' is admitted`, live.includes(m[1]))
    }
  }
  check("every sync_source writer in the repo was checked", seen === 6)

  const privacy = src("app/actions/privacy/data-subject-requests.ts")
  check("the origin is disclosed in the data-subject export — so it must be true",
    /sync_source/.test(privacy))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ AI_AUTHORED_RECORD_FAIL"); process.exit(1) }
console.log(" ✅ AI_AUTHORED_RECORD_PASS — every autonomous write lands, and says who made it")
