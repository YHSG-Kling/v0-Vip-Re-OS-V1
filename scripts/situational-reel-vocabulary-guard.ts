/**
 * scripts/situational-reel-vocabulary-guard.ts
 *
 * test:situational-reel-vocabulary — ONE PERSONA VOCABULARY UNDER asset_type 'situational_reel'.
 *
 * CLAUDE.md §6: two spellings of one idea are a defect — scorers cannot match writers across
 * them. content_asset_persona_performance rows for 'situational_reel' are written by ONE pass
 * (lib/content-intel/performance-aggregator.ts aggregateTopicVideoPersonaPerformance), keyed by
 * the CONTACT PERSONA vocabulary (contacts.contact_persona = CAMPAIGN_PERSONAS, 'other'
 * excluded) read off the project's stamp video_metadata[TOPIC_VIDEO_PERSONA_KEY]. Until wave
 * 84E, lib/kernel/manager-signals.ts's two contact reels asked pickTopics for
 * ('buyer'|'seller'|'both'|'lifetime', situational_reel) — the contact TYPE vocabulary, which no
 * writer ever writes there — and stamped nothing, so the aggregator skipped them by name.
 *
 * THE RULE (derived; callers DISCOVERED across app/ lib/ with comments and strings blanked):
 *   R1. Every pickTopics({ assetType: situational_reel }) passes a recipientPersona that is
 *       absent/null or in the contact-persona vocabulary: a CAMPAIGN_PERSONAS literal other than
 *       'other', or a value produced by the one normaliser family in lib/video/topic-video.ts
 *       (topicPersonaOf / personaForSlot / personaRotation). A contact-TYPE literal or a
 *       contactReelPersona(...)-derived value is a violation.
 *   R2. Every writer of the persona stamp `[TOPIC_VIDEO_PERSONA_KEY]: X` feeds X from that
 *       same family.
 *   R3. A file that asks for a persona-ranked situational_reel pick ALSO writes the stamp — a
 *       persona read whose claims never carry the persona is a writerless read of that key.
 *   R4. The one row writer validates the stamp against the contact-persona vocabulary.
 * Positive controls: the pre-84E manager-signals shapes are fed to each rule and must be flagged.
 * Blind spots: one assignment hop; a persona laundered through a second helper reads
 * "unknown" and FAILS (never passes silently). custom-video's office pick passes no persona
 * (no audience) — allowed by R1, and it writes no stamp, so the aggregator skips its claims.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { CAMPAIGN_PERSONAS } from "../lib/campaigns/contact-sources"

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const PERSONA_VOCAB = new Set<string>(CAMPAIGN_PERSONAS.filter((p) => p !== "other"))
const CONTACT_TYPE_VOCAB = new Set(["buyer", "seller", "both", "lifetime", "renter", "investor_type", "sphere"])
const NORMALISERS = /\b(topicPersonaOf|personaForSlot|personaRotation|normalizeContactPersona)\(/
const TYPE_DERIVERS = /\bcontactReelPersona\(/

type Verdict = "persona" | "none" | "contact_type" | "unknown"

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** Classify a persona expression. `code` = comments blanked, strings intact (literal values readable). */
export function classifyPersona(exprRaw: string, code: string, depth = 0): Verdict {
  const expr = exprRaw.trim()
  if (expr === "" || expr === "null" || expr === "undefined") return "none"
  const lit = /^["'`]([\w-]+)["'`]$/.exec(expr)
  if (lit) return PERSONA_VOCAB.has(lit[1]) ? "persona" : CONTACT_TYPE_VOCAB.has(lit[1]) || lit[1] === "other" ? "contact_type" : "unknown"
  if (TYPE_DERIVERS.test(expr)) return "contact_type"
  if (NORMALISERS.test(expr)) return "persona"
  const id = /^([A-Za-z_$][\w$]*)$/.exec(expr)
  if (!id || depth > 1) return "unknown"
  const n = escapeRe(id[1])
  const verdicts = new Set<Verdict>()
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+${n}(?:\\s*:[^=]+)?\\s*=\\s*([^\\n;]+)`, "g"))) {
    verdicts.add(classifyPersona(m[1].replace(/^await\s+/, ""), code, depth + 1))
  }
  // A function parameter of that name is judged by its call sites' argument (the one-hop rule
  // above already classifies the locals those callers pass, which share the name here).
  verdicts.delete("none")
  if (verdicts.size === 0) return "unknown"
  if (verdicts.has("contact_type")) return "contact_type"
  if (verdicts.size === 1) return [...verdicts][0]
  return "unknown"
}

function balancedFrom(code: string, open: number): string {
  const o = code[open]
  const c = o === "{" ? "}" : ")"
  let d = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) d++
    else if (code[i] === c) { d--; if (d === 0) return code.slice(open, i + 1) }
  }
  return code.slice(open)
}

export interface Pick { line: number; persona: string | null }
/** pickTopics calls whose assetType is situational_reel (the literal or the named constant). */
export function situationalPicks(raw: string): { picks: Pick[]; commented: string } {
  const masked = blankStrings(raw)
  const commented = blankComments(raw)
  const picks: Pick[] = []
  for (const m of masked.matchAll(/(?<![\w.$])pickTopics\s*\(/g)) {
    const open = m.index! + m[0].length - 1
    const argMasked = balancedFrom(masked, open)
    const arg = commented.slice(open, open + argMasked.length) // same offsets, literals readable
    if (!/assetType\s*:\s*("situational_reel"|TOPIC_VIDEO_ASSET_TYPE)/.test(arg)) continue
    const pm = /recipientPersona\s*:\s*([^,\n}]+)/.exec(arg)
    picks.push({ line: masked.slice(0, m.index!).split("\n").length, persona: pm ? pm[1].trim() : null })
  }
  return { picks, commented }
}

export function stampWrites(commented: string): string[] {
  return [...commented.matchAll(/\[TOPIC_VIDEO_PERSONA_KEY\]\s*:\s*([^,\n}]+)/g)].map((m) => m[1].trim())
}

const ROOTS = ["app", "lib"]
function walk(dir: string, out: string[]) {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) out.push(p)
  }
}

console.log("\n── R1 / R2 / R3: every situational_reel pick and persona stamp (discovered) ──")
const files: string[] = []
for (const r of ROOTS) walk(join(process.cwd(), r), files)
let pickCount = 0
let stampCount = 0
for (const abs of files) {
  const rel = abs.slice(process.cwd().length + 1)
  const raw = readFileSync(abs, "utf8")
  if (!/pickTopics|TOPIC_VIDEO_PERSONA_KEY/.test(raw)) continue
  const { picks, commented } = situationalPicks(raw)
  const stamps = /\[TOPIC_VIDEO_PERSONA_KEY\]/.test(blankStrings(raw)) ? stampWrites(commented) : []
  for (const p of picks) {
    pickCount++
    const v = p.persona === null ? "none" : classifyPersona(p.persona, commented)
    ok(`${rel}:${p.line} pickTopics(situational_reel) recipientPersona ${p.persona ?? "(absent)"} → ${v}`,
      v === "persona" || v === "none")
  }
  for (const s of stamps) {
    stampCount++
    const v = classifyPersona(s, commented)
    ok(`${rel} stamps [TOPIC_VIDEO_PERSONA_KEY]: ${s} → ${v}`, v === "persona")
  }
  const ranked = picks.filter((p) => p.persona !== null && classifyPersona(p.persona, commented) !== "none")
  if (ranked.length > 0) {
    ok(`${rel}: ${ranked.length} persona-ranked situational_reel pick(s) AND writes the persona stamp its claims are learned by`,
      stamps.length > 0)
  }
}
ok(`denominator: ${pickCount} situational_reel picks, ${stampCount} stamp writes (a zero means the finder is blind)`,
  pickCount >= 1 && stampCount >= 1)

console.log("\n── R4: the one row writer validates the stamp against the contact-persona vocabulary ──")
{
  const agg = blankStrings(read("lib/content-intel/performance-aggregator.ts"))
  ok("aggregateTopicVideoPersonaPerformance reads the stamp and drops a non-persona value (isCampaignPersona, 'other' excluded)",
    /TOPIC_VIDEO_PERSONA_KEY/.test(agg) && /isCampaignPersona\(persona\)/.test(agg))
}

console.log("\n── positive controls: the pre-84E contact-reel shapes are flagged ──")
{
  const oldReel = `
    const persona = contactReelPersona(cr.contact_type)
    const topics = await pickTopics({ brokerageId, recipientPersona: persona, assetType: "situational_reel", limit: 1 })
    await ctx.supabase.from("content_topic_uses").insert({ asset_type: "situational_reel" })
  `
  const a = situationalPicks(oldReel)
  ok("control: recipientPersona from contactReelPersona(contact_type) is flagged contact_type",
    a.picks.length === 1 && classifyPersona(a.picks[0].persona!, a.commented) === "contact_type")
  ok("control: that file writes no stamp, so R3 would flag it", stampWrites(a.commented).length === 0)

  const oldSeller = `const topics = await pickTopics({ recipientPersona: "seller", assetType: "situational_reel", limit: 1 })`
  const b = situationalPicks(oldSeller)
  ok("control: a contact-TYPE literal ('seller') is flagged", b.picks.length === 1 && classifyPersona(b.picks[0].persona!, b.commented) === "contact_type")

  const newer = `
    const learningPersona = topicPersonaOf(cr.contact_persona)
    const topics = await pickTopics({ recipientPersona: learningPersona, assetType: "situational_reel" })
    patch.video_metadata = { ...meta, [TOPIC_VIDEO_PERSONA_KEY]: learningPersona }
  `
  const c = situationalPicks(newer)
  ok("control: a topicPersonaOf-derived persona reads as the contact-persona vocabulary",
    c.picks.length === 1 && classifyPersona(c.picks[0].persona!, c.commented) === "persona" && classifyPersona(stampWrites(c.commented)[0], c.commented) === "persona")

  const mention = `// pickTopics({ recipientPersona: "seller", assetType: "situational_reel" })\nconst s = "pickTopics({ assetType: 'situational_reel' })"`
  ok("control: a comment / string mention is not a pick", situationalPicks(mention).picks.length === 0)

  const newsletter = `pickTopics({ recipientPersona: "seller", assetType: "newsletter_campaign" })`
  ok("control: a non-situational_reel pick is out of scope (not counted)", situationalPicks(newsletter).picks.length === 0)

  ok("control: 'other' is not a learning persona", classifyPersona(`"other"`, "") === "contact_type")
  ok("control: a laundered value reads unknown (fails, never passes silently)", classifyPersona("x", "const x = somethingElse(y)") === "unknown")
}

console.log(`\n${"═".repeat(70)}`)
console.log(`SITUATIONAL REEL VOCABULARY — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("OK — every situational_reel pick and stamp speaks the contact-persona vocabulary the one writer keys rows by")
