/**
 * scripts/contact-intent-vocabulary-guard.ts — `npm run test:contact-intent-vocabulary`
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 149, LANE 149A — OWNER RULING 3 (2026-11-03): contact INTENT is buyer, seller or both — nothing else. "Intent is more
 * the contact persona's situation." `prospect` is a PLATFORM person (a potential VIPAgents subscriber, platform_prospects),
 * never a tenant lead type; the tenant ladder is raw lead → lead → contact, so `lead` is a TABLE, not a contact's type.
 *
 * WHAT IS ASSERTED (pure modules + STRIPPED-source census — CLAUDE.md §2):
 *   1  the vocabulary: CONTACT_INTENTS = buyer | seller | both; contact_type = the intents + the relationship classes that are
 *      NOT intent (lifetime_customer, sphere, vendor, referral_partner, other); 'lead' / 'prospect' are not storable;
 *   2  the ONE intent reader (normalizeContactIntent) maps every spelling writers used (buying / selling / buyer and seller …)
 *      and answers NULL for a non-intent (prospect, lead, investor — a persona — distress — a situation — unknown);
 *   3  the lead → contact decision: unknown intent → NULL (never 'prospect'), 'both' → 'both';
 *   4  the lead-desk intent types are the canonical intent (no 'buying' / 'distress' / 'investor' spelling);
 *   5  m935 carries its stamp, backfills, and writes EXACTLY CONTACT_TYPES into contacts_contact_type_check;
 *   6  CENSUS over lib/ + app/: no write of contact_type 'lead' / 'prospect', no contact_type filter naming them. Writers in a
 *      file another lane owns are PUBLISHED as pending Outside-lane items — RED the moment m935 is APPLIED while one remains
 *      (the database would then refuse that write, 23514).
 * Every absence has a POSITIVE CONTROL.
 *
 * BLIND SPOTS (published): the census reads literal spellings — a value assembled at runtime (a variable holding 'prospect')
 * passes; `leads.lead_type` is free text with no CHECK, so its writers are COUNTED, not judged; the live database is read
 * only through the generated CHECK cache (scripts/check-vocabularies.ts) and the migration text.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import {
  CONTACT_TYPES, CONTACT_INTENTS, RELATIONSHIP_CONTACT_TYPES, normalizeContactIntent, contactIntentOf, isStorableContactType,
} from "../lib/contact-types"
import { resolveContactType, motivationToContactType } from "../lib/contact-promotion/contact-creator"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join("|") === [...b].sort().join("|")

console.log("\n[1 — the vocabulary: intent is buyer | seller | both]")
check("CONTACT_INTENTS is exactly buyer, seller, both", same(CONTACT_INTENTS, ["buyer", "seller", "both"]))
check("contact_type = the three intents + the five relationship classes that are not intent", same(CONTACT_TYPES, [...CONTACT_INTENTS, ...RELATIONSHIP_CONTACT_TYPES]), CONTACT_TYPES.join(","))
check("'lead' and 'prospect' are NOT storable contact types", !isStorableContactType("lead") && !isStorableContactType("prospect"))
check("POSITIVE CONTROL — the storable test still admits an intent and a relationship class", isStorableContactType("both") && isStorableContactType("sphere"))
check("contactIntentOf reads an intent from contact_type and NULL from a relationship class", contactIntentOf("seller") === "seller" && contactIntentOf("sphere") === null && contactIntentOf(null) === null)

console.log("\n[2 — the ONE intent reader]")
const spellings: Array<[string, string | null]> = [["buyer", "buyer"], ["Buying", "buyer"], ["home_buyer", "buyer"], ["selling", "seller"], ["SELLER", "seller"],
  ["both", "both"], ["buyer and seller", "both"], ["buying_and_selling", "both"], ["prospect", null], ["lead", null], ["investor", null], ["distress", null], ["unknown", null], ["", null]]
const wrong = spellings.filter(([s, want]) => normalizeContactIntent(s) !== want)
check(`normalizeContactIntent maps ${spellings.length} spellings (intents to buyer/seller/both; prospect / lead / investor / distress / unknown to NULL)`, wrong.length === 0, JSON.stringify(wrong))

console.log("\n[3 — the lead → contact decision]")
check("unknown intent → NULL contact_type (never 'prospect', never the refused 'unknown')", resolveContactType(null, "unknown") === null && resolveContactType("search_intent", null) === null)
check("'both' → 'both' (a dual intent is never collapsed to buyer)", motivationToContactType("both") === "both" && resolveContactType("both", null) === "both")
check("POSITIVE CONTROL — a stated side still resolves", resolveContactType("motivated_seller", "unknown") === "seller" && resolveContactType(null, "buyer") === "buyer")

console.log("\n[4 — the lead-desk intent types are the canonical intent]")
const intentTypeFiles = ["app/types/lead-management.ts", "lib/application/lead-application-service.ts"]
const LEGACY_INTENT_TYPE = /type\s+LeadIntent\s*=\s*[^\n]*["'](buying|selling|distress|investor|investing|renting)["']/
const legacy = intentTypeFiles.filter((f) => LEGACY_INTENT_TYPE.test(blankComments(raw(f))))
check("no LeadIntent type spells intent as buying / selling / distress / investor (both files alias ContactIntent)",
  legacy.length === 0 && intentTypeFiles.every((f) => /type\s+LeadIntent\s*=\s*ContactIntent/.test(blankComments(raw(f)))), legacy.join(","))
check("POSITIVE CONTROL — the legacy-type finder sees the retired shape", LEGACY_INTENT_TYPE.test(`export type LeadIntent = "buying" | "selling" | "distress" | "investor"`))
check("the lead-desk filter offers buyer / seller / both and reads intent through the one reader",
  /SelectItem value="buyer"/.test(raw("app/leads/page.tsx")) && !/SelectItem value="(buying|distress)"/.test(blankComments(raw("app/leads/page.tsx")))
  && /normalizeContactIntent\(params\.intent\)/.test(blankComments(raw("lib/application/lead-application-service.ts"))))

console.log("\n[5 — m935]")
const migs = readdirSync(join(ROOT, "supabase/migrations"))
const m935f = migs.find((n) => /^m935-/.test(n))
const m935 = m935f ? raw(`supabase/migrations/${m935f}`) : ""
const line1 = m935.split("\n")[0] ?? ""
const m935Applied = /^-- ── APPLIED LIVE /.test(line1)
check("m935 exists with a valid line-1 stamp (lane stamp, or APPLIED LIVE once applied)", !!m935f && (/^-- WRITTEN, NOT APPLIED \(wave 149, lane 149A\)/.test(line1) || m935Applied), line1)
const sql935 = m935.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
const arr = [...(sql935.match(/ADD CONSTRAINT\s+contacts_contact_type_check[\s\S]*?ARRAY\[([^\]]*)\]/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
check("m935 writes EXACTLY CONTACT_TYPES into contacts_contact_type_check", same(arr, CONTACT_TYPES), arr.join(","))
check("m935 backfills 'lead' / 'prospect' rows (a linked lead's stated intent, else NULL) before the CHECK", /SET contact_type = l\.lead_type/.test(sql935) && /SET contact_type = NULL\s+WHERE contact_type IN \('lead', 'prospect'\)/.test(sql935)
  && sql935.indexOf("SET contact_type = NULL") < sql935.indexOf("ADD CONSTRAINT"))

console.log("\n[6 — census: no writer or filter names 'lead' / 'prospect' as a contact type (stripped source, lib/ + app/)]")
const walk = (d: string, out: string[] = []) => { if (!existsSync(join(ROOT, d))) return out; for (const n of readdirSync(join(ROOT, d))) { if (n === "node_modules" || n.startsWith(".")) continue; const p = `${d}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p) } return out }
const files = [...walk("lib"), ...walk("app")]
const FINDERS: Array<[string, RegExp]> = [
  ["write", /contact_type\s*:[^,\n]*["'](lead|prospect)["']/],
  ["filter", /\.(in|eq|neq)\(\s*["']contact_type["']\s*,[^)\n]*["'](lead|prospect)["']/],
  ["intent map", /CONTACT_TYPE_FOR_INTENT[^=\n]*=[\s\S]{0,400}?:\s*["'](lead|prospect)["']/],
]
const hits: Array<{ file: string; kind: string; line: number }> = []
for (const f of files) {
  const t = blankComments(raw(f))
  for (const [kind, re] of FINDERS) {
    const m = re.exec(t)
    if (m) hits.push({ file: f, kind, line: t.slice(0, m.index).split("\n").length })
  }
}
// Files another 149 lane owns (lane F: lib/open-house/**) — published, never edited here; see lane 149A notes ## Outside-lane.
const OUTSIDE_LANE = new Set(["lib/open-house/event-attendance.ts", "lib/open-house/event-registry.ts"])
const mine = hits.filter((h) => !OUTSIDE_LANE.has(h.file))
const pending = hits.filter((h) => OUTSIDE_LANE.has(h.file))
check(`no lane-149A-reachable file writes or filters contact_type 'lead' / 'prospect' (${files.length} files scanned)`, mine.length === 0, mine.map((h) => `${h.file}:${h.line} (${h.kind})`).join(", "))
console.log(`  · PENDING Outside-lane (lane F owns the file): ${pending.length ? pending.map((h) => `${h.file}:${h.line} (${h.kind})`).join(", ") : "none"}`)
check("an Outside-lane 'prospect' writer may stand only while m935 is NOT applied (applied + writer = a refused insert, 23514)", !(m935Applied && pending.length > 0), pending.map((h) => h.file).join(","))
check("POSITIVE CONTROL — the finders see each retired shape and pass the canonical ones",
  FINDERS[0][1].test(`contact_type: "lead",`) && FINDERS[0][1].test(`contact_type: x ? y : "prospect",`) && FINDERS[1][1].test(`.in("contact_type", ["buyer", "lead"])`)
  && FINDERS[2][1].test(`export const CONTACT_TYPE_FOR_INTENT: R = Object.freeze({ buying: "buyer", learning: "prospect" })`)
  && !FINDERS[0][1].test(`contact_type: "buyer",`) && !FINDERS[1][1].test(`.in("contact_type", ["buyer", "both"])`))
check("POSITIVE CONTROL — a tombstone naming the retired value is NOT a writer (stripped before scanning)", !FINDERS[0][1].test(blankComments(`// contact_type: "lead" stood here\nconst a = 1`)))
const leadTypeWrites = files.filter((f) => /lead_type\s*:\s*["'][a-z_]+["']/.test(blankComments(raw(f))))
console.log(`  · published (not judged — leads.lead_type has no CHECK): ${leadTypeWrites.length} file(s) write a literal lead_type`)

console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ CONTACT_INTENT_VOCABULARY_PASS" : ""}`)
if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
