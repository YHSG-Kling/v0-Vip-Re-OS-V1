#!/usr/bin/env tsx
/**
 * scripts/ai-reply-style-simulator.ts   (npm run test:ai-reply-style)
 * ─────────────────────────────────────────────────────────────────────────────
 * A SETTINGS ROW NOTHING READ, BEHIND A SAVE THAT WORKED EXACTLY ONCE.
 *
 * agent_chat_preferences has carried `preferred_model` and `tone` for a long
 * time. The drafting prompt hardcoded openai/gpt-4o-mini and never mentioned
 * tone, so the columns were decoration: an agent could pick a style and see no
 * difference in a single generated reply. Now resolveReplyStyle feeds both the
 * model argument and a tone directive in the prompt, and the control is exposed
 * at Settings → Assistant.
 *
 * THREE WRITE BUGS, ALL CONFIRMED AGAINST THE LIVE DATABASE:
 *
 *  1. agent_chat_preferences has UNIQUE (agent_id). `upsert` with no conflict
 *     target defaults to the PRIMARY KEY; no id is supplied, so a fresh uuid is
 *     generated, ON CONFLICT (id) never fires, and the SECOND save raises
 *     23505. Verified live: the plain re-insert raised unique_violation and
 *     `on conflict (agent_id)` updated in place. An agent could set their
 *     preferences exactly once, ever.
 *
 *  2. message_access_control has UNIQUE (conversation_id, user_id) and the same
 *     upsert bug — re-granting access to the same person errored instead of
 *     updating their permissions. Verified live the same way.
 *
 *  3. messages.compliance_issues is character varying[] (udt _varchar), while
 *     checkMessageCompliance returns an array of OBJECTS. Writing them straight
 *     in fails with 42804 — verified live. Labels now go to the column it is
 *     typed for and the structured detail is kept in metadata (jsonb).
 *
 * AND THE READ THAT COULD NOT RESOLVE: getMessageAccessList embedded
 * `users(...)`, but message_access_control has NO foreign key to users, so
 * PostgREST cannot build that join — the read threw on every call.
 *
 * ALSO: the file's own header warned that "every write fails silently at
 * runtime" and that it had "no functional callers" — an invitation to delete
 * it. Re-verified against the live schema: public.messages carries sender_type,
 * sender_id, body, them_first_analysis, compliance_flagged, compliance_issues,
 * metadata and type. The drift the warning described was closed by a later
 * migration and nobody updated the comment. Stale warnings that say "this is
 * all broken" are how working code gets deleted.
 */
import { readFileSync, existsSync } from "node:fs"
import {
  REPLY_TONES,
  REPLY_MODELS,
  DEFAULT_REPLY_MODEL,
  DEFAULT_REPLY_TONE,
  resolveReplyStyle,
  isReplyModel,
  isReplyTone,
} from "../lib/ai/reply-style"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

console.log("\n── a stored preference can never break the generator ──")
{
  check("every offered tone resolves to itself",
    REPLY_TONES.every((t) => resolveReplyStyle({ tone: t.value }).tone === t.value))
  check("every offered model resolves to itself",
    REPLY_MODELS.every((m) => resolveReplyStyle({ preferred_model: m.value }).model === m.value))

  // The columns are free text. A typo, a migration, or a hand-edited row must
  // not put an unroutable id in front of the model router.
  const junk = resolveReplyStyle({ preferred_model: "openai/gpt-9-turbo", tone: "shouty" })
  check("an unrecognised model falls back to the default", junk.model === DEFAULT_REPLY_MODEL)
  check("an unrecognised tone falls back to the default", junk.tone === DEFAULT_REPLY_TONE)
  check("…and the fallback is REPORTED, not hidden", junk.usedFallback)

  check("no row at all is the default, and is NOT reported as a fallback",
    (() => { const s = resolveReplyStyle(null); return s.model === DEFAULT_REPLY_MODEL && !s.usedFallback })())
  check("an empty row is the same", !resolveReplyStyle({}).usedFallback)

  check("every tone carries a real directive for the prompt",
    REPLY_TONES.every((t) => resolveReplyStyle({ tone: t.value }).toneDirective.length > 20))
  check("the directives are DISTINCT — a tone that reads the same is decoration",
    new Set(REPLY_TONES.map((t) => resolveReplyStyle({ tone: t.value }).toneDirective)).size === REPLY_TONES.length)

  check("the validators agree with the offered lists",
    REPLY_MODELS.every((m) => isReplyModel(m.value)) && REPLY_TONES.every((t) => isReplyTone(t.value)))
  check("…and reject everything else", !isReplyModel("gpt-4o") && !isReplyTone("professional ") && !isReplyModel(null))
}

console.log("\n── the preference actually reaches the generator ──")
{
  const a = src("app/actions/ai-chat.ts")
  check("the drafting call takes the resolved model, not a hardcoded id",
    /model: style\.model/.test(a) && !/model: "openai\/gpt-4o-mini"/.test(a))
  check("the prompt carries the tone directive", /style\.toneDirective/.test(a))
  check("the style is resolved from the agent on the conversation, not a guess",
    /\.eq\("agent_id", session\.agent_id\)/.test(a) && /resolveReplyStyle\(prefRow\)/.test(a))
  const ui = src("app/dashboard/settings/assistant/reply-style-panel.tsx")
  check("the agent can actually choose it", /updateAgentChatPreferences\(agentId, \{ tone, preferred_model: model \}\)/.test(ui))
  check("…and the settings page mounts that panel",
    /<ReplyStylePanel/.test(src("app/dashboard/settings/assistant/page.tsx")))
  check("a failed save is shown rather than swallowed",
    /setError\(err\?\.message \?\? "Could not save your reply style\."\)/.test(ui))
}

console.log("\n── the three write bugs stay fixed ──")
{
  const a = src("app/actions/ai-chat.ts")

  check("the preferences upsert names UNIQUE(agent_id) as its conflict target",
    /\.from\("agent_chat_preferences"\)[\s\S]{0,200}?onConflict: "agent_id"/.test(a))
  check("the access-control upsert names UNIQUE(conversation_id,user_id)",
    /onConflict: "conversation_id,user_id"/.test(a))
  check("compliance labels are flattened for the varchar[] column",
    /compliance_issues: complianceIssueLabels\(/.test(a))
  check("…by a function that really returns strings",
    (() => {
      const fn = /function complianceIssueLabels[\s\S]*?\n\}/.exec(a)?.[0] ?? ""
      return /: string\[\]/.test(fn) && /JSON\.stringify/.test(fn)
    })())
  check("…and the structured detail survives in metadata (jsonb)",
    /compliance_issues: complianceCheck\.issues/.test(a))

  check("preferences are no longer spread from an untyped bag onto the row",
    !/preferences: any/.test(a) && !/\.\.\.preferences,/.test(a))
  check("a tone or model the generator cannot honour is refused at the write",
    /Unsupported reply model/.test(a) && /Unsupported reply tone/.test(a))
}

console.log("\n── the reader hands back ONE shape ──")
{
  const a = src("app/actions/ai-chat.ts")
  // It used to return six keys that are not columns when no row existed, and
  // the real row when one did — so no consumer could be written against both.
  for (const invented of [
    "auto_suggest_responses", "them_first_coaching", "compliance_alerts",
    "lead_insights_enabled", "preferred_tone", "custom_prompts",
  ]) {
    check(`the fallback no longer invents \`${invented}\``, !new RegExp(`${invented}`).test(a))
  }
  check("the reader selects the columns that actually exist",
    /\.select\("preferred_model, tone, preferences"\)/.test(a))
  check("…and returns a declared type rather than a bare row",
    /Promise<AgentChatPreferences>/.test(a))
}

console.log("\n── the read that PostgREST could not resolve ──")
{
  const a = src("app/actions/ai-chat.ts")
  const fn = /export async function getMessageAccessList[\s\S]*?\n\}/.exec(a)?.[0] ?? ""
  check("getMessageAccessList exists", fn.length > 0)
  check("…and no longer embeds users through a foreign key that does not exist",
    !/from\("message_access_control"\)[\s\S]{0,200}?users \(/.test(a))
  check("…it resolves the names with a second query instead",
    /from\("users"\)/.test(fn) && /\.in\("id", rows\.map/.test(fn))
  check("…and an empty access list short-circuits rather than querying for nothing",
    /if \(rows\.length === 0\) return \[\]/.test(fn))
}

console.log("\n── the alias that crossed id spaces is gone ──")
{
  const a = readFileSync("app/actions/ai-chat.ts", "utf8")
  const code = src("app/actions/ai-chat.ts")
  check("getChatSessions is no longer defined", !/export async function getChatSessions\b/.test(code))
  check("…its replacement is named in the file that dropped it", a.includes("getAgentChatSessions"))
  check("the replacement is real and takes agents.id",
    /export async function getAgentChatSessions\(agentId: string\)/.test(code))
  check("…and filters the column that id space belongs to", /\.eq\("agent_id", agentId\)/.test(code))
}

console.log("\n── the stale warning that invited deletion is corrected ──")
{
  const a = readFileSync("app/actions/ai-chat.ts", "utf8")

  // NOT a substring hunt for the old phrases — the corrected header QUOTES them
  // to explain what was wrong, so "does the string appear" cannot tell a
  // standing claim from a description of a fixed one. Assert instead that the
  // actionable stale parts are gone and the correction is on the record.
  check("the migrate-this-file work order is gone (the drift it described is closed)",
    !/RESOLUTION \(future work/.test(a) &&
    !/should\s*\n?\s*\*\s*write to chat_sessions \+ chat_messages/.test(a))
  check("…the header no longer opens as a standing drift warning",
    !/^\/\*\*\s*\n \* ⚠️ SCHEMA-DRIFT WARNING/m.test(a))
  check("…it records that the claim was re-verified against the live schema",
    /Re-verified against the live database/.test(a))
  check("…and names the one defect that really did survive",
    /character varying\[\]/.test(a) && /42804/.test(a))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ AI_REPLY_STYLE_FAIL"); process.exit(1) }
console.log(" ✅ AI_REPLY_STYLE_PASS — the style is chosen, saved more than once, and changes the draft")
