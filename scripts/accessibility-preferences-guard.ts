#!/usr/bin/env tsx
/**
 * scripts/accessibility-preferences-guard.ts   (npm run test:accessibility-preferences — wave 145, lane 145H)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * OWNER RULING 18 (2026-10-27): accessibility preferences — "Should be added as fields if important and necessary."
 * Explicit, user-controllable fields (communication format, captions / transcripts, language, text size / display,
 * preferred portal modality) with REAL readers AND writers; never inferred from age or demographics. Contract C3:
 * `contacts.accessibility_preferences` (m868) + lib/contacts/accessibility-preferences.ts readAccessibilityPreferences
 * (svc, brokerageId, contactId) + the writer; lane 145E's welcome and this lane's education read through it only.
 *
 *   A  m868 — line-1 status (the lane stamp OR "APPLIED LIVE"); the CHECK function's arrays EQUAL the TS vocabulary;
 *      language is NOT a key (contacts.preferred_language is the survivor); nothing dropped.
 *   B  the READER — tenant-pinned, refusal = ok:false (never "nothing stated"), absent column = notApplied.
 *   C  the WRITER — validates (unknown key / value refuses the WHOLE write), null clears, language through THE
 *      language vocabulary, the UPDATE is counted, provenance is stamped with who set it.
 *   D  the two DOORS — the contact's own (isContactSelf) and staff AT THE CONTACT'S REQUEST (attested), tenant from the
 *      gate, never the body; every export async.
 *   E  NEVER INFERRED — the module reads no age / birthday / demographic column and imports no age helper; nothing
 *      else in app/ or lib/ writes the column.
 *   F  the READERS are wired: education producer, education plan, the portal display; the settings forms render.
 *   G  the AGE-BAND PATHS ARE GONE (lane brief: DELIVERY_MATRIX, CHANNEL_ORDER_BY_BAND) — every band gets the same
 *      delivery and rail; a STATED preference moves them (positive control). ageGroupChannelAffinity is lane 145E's
 *      file: PUBLISHED, not asserted.
 *
 * Measurement: code tokens are read from STRIPPED source (scripts/strip-comments.ts) — a tombstone naming
 * DELIVERY_MATRIX is a comment, not a definition. Every absence check has a positive control.
 * BLIND SPOTS: the database is in memory (scripts/in-memory-supabase.ts) — the m868 CHECK is proven by its SQL text,
 * not executed; RLS is not modelled; the doors' session gates are proven by source, not by a live session.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type Row } from "./in-memory-supabase"
import { blankStrings, stripComments } from "./strip-comments"
import {
  ACCESSIBILITY_FLAGS, ACCESSIBILITY_PREFERENCE_KEYS, COMMUNICATION_FORMATS, PORTAL_MODALITIES, TEXT_SIZES,
  accessibilityAdaptations, accessibilityPreferenceOptions, portalDisplayFor,
  readAccessibilityPreferences, writeAccessibilityPreferences,
} from "../lib/contacts/accessibility-preferences"
import { AGE_SEGMENTS, getEducationDelivery } from "../lib/kernel/education"
import { pickEducationChannel } from "../lib/agents/education-delivery-producer"
import { resolveContactDeliveryFormat } from "../lib/education/delivery-format"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeWithStrings = (p: string) => stripComments(read(p))
const sameSet = (a: readonly string[] | null | undefined, b: readonly string[]) => !!a && a.length === b.length && b.every((x) => a.includes(x))

const B1 = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001", C2 = "c2c2c2c2-0000-4000-8000-000000000002"
const U1 = "a1a1a1a1-0000-4000-8000-000000000001"
const seed = (): Record<string, Row[]> => ({
  contacts: [
    { id: C1, brokerage_id: B1, accessibility_preferences: { captions: true, text_size: "large" }, preferred_language: "en", enrichment_profile: {} },
    { id: C2, brokerage_id: B2, accessibility_preferences: {}, preferred_language: null, enrichment_profile: {} },
  ],
})

async function main() {
  // ═══ A. m868 ═════════════════════════════════════════════════════════════════════════════════════════════
  section("A m868 — line-1 status, the CHECK arrays equal the TS vocabulary, language is not a key, nothing dropped")
  const mig = readdirSync("supabase/migrations").find((f) => /contact-accessibility-preferences/.test(f)) ?? ""
  const sql = read(join("supabase/migrations", mig))
  const sqlCode = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check(`the migration exists (${mig || "missing"})`, !!mig)
  check("line 1 states its status (the lane stamp until applied; APPLIED LIVE once the integrator applied it)",
    /^-- (WRITTEN, NOT APPLIED \(wave 145, lane 145H\)|── APPLIED LIVE )/.test(sql.split("\n")[0]))
  const arr = (re: RegExp) => { const m = re.exec(sqlCode); return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null }
  const keysArr = arr(/k\.key <> ALL \(ARRAY\[([^\]]*)\]\)/)
  check("the CHECK's key list = ACCESSIBILITY_PREFERENCE_KEYS", sameSet(keysArr, ACCESSIBILITY_PREFERENCE_KEYS), String(keysArr))
  check("communication_format values = COMMUNICATION_FORMATS", sameSet(arr(/'communication_format'\) = ANY \(ARRAY\[([^\]]*)\]\)/), COMMUNICATION_FORMATS))
  check("text_size values = TEXT_SIZES", sameSet(arr(/'text_size'\)\s+= ANY \(ARRAY\[([^\]]*)\]\)/), TEXT_SIZES))
  check("portal_modality values = PORTAL_MODALITIES", sameSet(arr(/'portal_modality'\)\s+= ANY \(ARRAY\[([^\]]*)\]\)/), PORTAL_MODALITIES))
  check("every flag is CHECK-bound to a boolean", ACCESSIBILITY_FLAGS.every((f) => new RegExp(`jsonb_typeof\\(p -> '${f}'\\)\\s*= 'boolean'`).test(sqlCode)))
  check("the column is jsonb NOT NULL DEFAULT '{}' and the CHECK calls the function",
    /ADD COLUMN IF NOT EXISTS accessibility_preferences jsonb NOT NULL DEFAULT '\{\}'::jsonb/.test(sqlCode) && /CHECK \(public\.contact_accessibility_preferences_valid\(accessibility_preferences\)\)/.test(sqlCode))
  check("LANGUAGE is not a key here — contacts.preferred_language stays the one language field", !ACCESSIBILITY_PREFERENCE_KEYS.includes("language" as never) && !/'language'/.test(sqlCode))
  check("nothing is dropped", !/DROP (COLUMN|INDEX|CONSTRAINT|TABLE)/i.test(sqlCode))
  check("POSITIVE CONTROL — the array reader sees a drifted SQL list", !sameSet(["text", "video"], COMMUNICATION_FORMATS))

  // ═══ B. THE READER ═══════════════════════════════════════════════════════════════════════════════════════
  section("B the reader — tenant-pinned; a refusal is ok:false (never 'nothing stated'); an absent column is notApplied")
  {
    const db = memSupabase(seed())
    const r = await readAccessibilityPreferences(db, B1, C1)
    check("a stated preference is read back exactly", r.ok && r.stated && r.preferences.captions === true && r.preferences.text_size === "large" && r.language === "en", JSON.stringify(r))
    const empty = await readAccessibilityPreferences(db, B2, C2)
    check("{} reads as NOTHING STATED (stated:false), not as a default someone chose", empty.ok && !empty.stated && Object.keys(empty.preferences).length === 0)
    const foreign = await readAccessibilityPreferences(db, B2, C1)
    check("TENANT PIN — another brokerage cannot read this contact's preferences (not found, not empty)", !foreign.ok && /not found/.test(foreign.error))
    const refused = await readAccessibilityPreferences(memSupabase(seed(), { refuse: { contacts: "permission denied" } }), B1, C1)
    check("a REFUSED read is ok:false — never laundered into 'nothing stated'", !refused.ok && !refused.notApplied)
    const pre = await readAccessibilityPreferences(memSupabase(seed(), { missingColumns: { contacts: ["accessibility_preferences"] } }), B1, C1)
    check("before m868 (column absent → 42703) the read says notApplied", !pre.ok && pre.notApplied === true)
    const legacy = await readAccessibilityPreferences(memSupabase({ contacts: [{ id: C1, brokerage_id: B1, accessibility_preferences: { captions: "yes", text_size: "huge", age_band: "65+", portal_modality: "audio" } }] }), B1, C1)
    check("a legacy / out-of-vocabulary stored value is DROPPED on read (never trusted, never a crash)",
      legacy.ok && JSON.stringify(legacy.preferences) === JSON.stringify({ portal_modality: "audio" }), JSON.stringify(legacy))
  }

  // ═══ C. THE WRITER ═══════════════════════════════════════════════════════════════════════════════════════
  section("C the writer — validated, whole-or-nothing, null clears, language through the ONE vocabulary, counted, provenance")
  {
    const db = memSupabase(seed())
    const w = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { communication_format: "video", text_size: null, transcript: true, language: "es-MX" }, writer: { userId: U1, kind: "contact" } })
    const row = db.tables.contacts.find((c) => c.id === C1)!
    check("the write lands: video, transcript on, text size CLEARED, captions kept", w.ok && row.accessibility_preferences.communication_format === "video" && row.accessibility_preferences.transcript === true && !("text_size" in row.accessibility_preferences) && row.accessibility_preferences.captions === true, JSON.stringify(row.accessibility_preferences))
    check("language is written to contacts.preferred_language through THE language vocabulary (es-MX → es)", row.preferred_language === "es")
    const fp = (row.enrichment_profile?.field_provenance ?? {}) as Record<string, { source?: string; purpose?: string; actor?: string }>
    check("provenance is stamped: the CONTACT set it, self-service, with their user id", fp.accessibility_preferences?.source === "contact" && fp.accessibility_preferences?.purpose === "self_service" && fp.accessibility_preferences?.actor === U1 && !!fp.preferred_language)
    const before = JSON.stringify(db.tables.contacts.find((c) => c.id === C1)!.accessibility_preferences)
    const bad = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { captions: false, age_band: "65+" }, writer: { userId: U1, kind: "contact" } })
    check("an UNKNOWN key refuses the WHOLE write (nothing changes — a dropped field would read as 'saved')", !bad.ok && JSON.stringify(db.tables.contacts.find((c) => c.id === C1)!.accessibility_preferences) === before)
    const badVal = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { text_size: "huge" }, writer: { userId: U1, kind: "contact" } })
    check("an out-of-vocabulary value refuses the write", !badVal.ok)
    const badLang = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { language: "klingon" }, writer: { userId: U1, kind: "contact" } })
    check("an unsupported language refuses the write (fail closed)", !badLang.ok)
    const staff = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { high_contrast: true }, writer: { userId: U1, kind: "staff_on_request" } })
    const fp2 = (db.tables.contacts.find((c) => c.id === C1)!.enrichment_profile?.field_provenance ?? {}) as Record<string, { source?: string; capability?: string }>
    check("a staff write at the contact's request is stamped as STAFF, capability staff_on_request", staff.ok && fp2.accessibility_preferences?.source === "staff" && fp2.accessibility_preferences?.capability === "contact.accessibility.staff_on_request")
    const wrongTenant = await writeAccessibilityPreferences(db, { brokerageId: B2, contactId: C1, input: { captions: true }, writer: { userId: U1, kind: "contact" } })
    check("TENANT PIN — a write naming another brokerage changes nothing and says so", !wrongTenant.ok)
    const noop = await writeAccessibilityPreferences(db, { brokerageId: B1, contactId: C1, input: { high_contrast: true }, writer: { userId: U1, kind: "contact" } })
    check("an unchanged value writes nothing (changed: [])", noop.ok && noop.changed.length === 0)
    const pre = await writeAccessibilityPreferences(memSupabase(seed(), { missingColumns: { contacts: ["accessibility_preferences"] } }), { brokerageId: B1, contactId: C1, input: { captions: true }, writer: { userId: U1, kind: "contact" } })
    check("before m868 the writer refuses and names the migration — nothing is written", !pre.ok && /m868/.test(pre.error))
  }

  // ═══ D. THE DOORS ═══════════════════════════════════════════════════════════════════════════════════════
  section("D the two doors — the contact's own, staff at the contact's request; tenant from the gate; every export async")
  {
    const doorRaw = read("app/actions/contacts/accessibility-preferences.ts")
    const door = blankStrings(stripComments(doorRaw))
    check("a 'use server' file whose every export is async", /^"use server"/.test(doorRaw.trimStart()) && !/export\s+(?!async\s)(function|const)/.test(door))
    const self = door.split("export async function saveMyAccessibilityPreferences")[1]?.split("export async function")[0] ?? ""
    const staff = door.split("export async function saveContactAccessibilityPreferences")[1] ?? ""
    check("SELF door: requireContactAccess, and only the account holder (isContactSelf)", /requireContactAccess\(/.test(self) && /access\.isContactSelf/.test(self) && /brokerageId: access\.brokerageId/.test(self) && /kind: "contact"/.test(codeWithStrings("app/actions/contacts/accessibility-preferences.ts")))
    check("STAFF door: refuses without the contact's request, then the canonical CRM write gate; tenant from the contact row",
      /contactRequested !== true/.test(staff) && /assertCanActOnContact\([\s\S]{0,80}intent: "write"/.test(codeWithStrings("app/actions/contacts/accessibility-preferences.ts")) && /brokerageId: gate\.contact\.brokerage_id/.test(staff) && /gate\.actorUserId/.test(staff))
    check("no door reads a brokerage from its body", !/input\.brokerageId|input\?\.brokerageId/.test(door))
    check("POSITIVE CONTROL — the async finder sees a sync export", /export\s+(?!async\s)(function|const)/.test("export function leak() {}"))
  }

  // ═══ E. NEVER INFERRED ══════════════════════════════════════════════════════════════════════════════════
  section("E never inferred — no age / demographic read, no age helper, and nothing else writes the column")
  {
    const mod = code("lib/contacts/accessibility-preferences.ts")
    const modStr = codeWithStrings("lib/contacts/accessibility-preferences.ts")
    const DEMOGRAPHIC = /\b(age_range|birthday|birth_date|age_band|ageSegment|AgeSegment|generation|gender|household_income|marital_status|net_worth_range|education_level)\b/
    check("the module names no age / demographic column or helper (stripped source, strings kept)", !DEMOGRAPHIC.test(modStr), (modStr.match(DEMOGRAPHIC) ?? [])[0] ?? "")
    check("…and imports nothing from the education kernel's age bands", !/from "@\/lib\/kernel\/education"/.test(modStr))
    check("POSITIVE CONTROL — the demographic finder sees an age read", DEMOGRAPHIC.test(`.select("age_range, birthday")`))
    check("the module has exactly ONE update (the writer) and no insert", (mod.match(/\.update\(/g) ?? []).length === 1 && !/\.insert\(/.test(mod))
    // Census: any other file that writes the column (an object key `accessibility_preferences:` in stripped code).
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e.startsWith(".")) continue
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.(ts|tsx)$/.test(e)) out.push(p)
      }
      return out
    }
    const writerRe = /\baccessibility_preferences\s*:/
    const others = [...walk("app"), ...walk("lib")].filter((p) => p !== join("lib", "contacts", "accessibility-preferences.ts") && writerRe.test(stripComments(read(p))))
    check(`no other file in app/ or lib/ writes accessibility_preferences (found: ${others.join(", ") || "0"})`, others.length === 0)
    check("POSITIVE CONTROL — the writer census sees a payload key", writerRe.test(`svc.from("contacts").update({ accessibility_preferences: x })`))
  }

  // ═══ F. THE READERS ARE WIRED ═══════════════════════════════════════════════════════════════════════════
  section("F every field has a reader: education producer + plan, the portal display; the forms render on both sides")
  {
    const producer = code("lib/agents/education-delivery-producer.ts")
    check("the education producer reads THROUGH the C3 function and passes the statement to the rail/format choice",
      /readAccessibilityPreferences\(supabase, brokerageId, contactId\)/.test(producer) && /accessibility,\s*\}\)/.test(producer))
    check("…and records captions / transcript / the source on the assignment", /accessibility_captions: adapt\.captions/.test(producer) && /accessibility_transcript: adapt\.transcript/.test(producer) && /accessibility_source: accessibilitySource/.test(producer))
    const edu = code("lib/kernel/education.ts")
    check("the education plan reads THROUGH the C3 function and builds the delivery from it", /readAccessibilityPreferences\(supabase, contact\.brokerage_id/.test(edu) && /getEducationDelivery\(\{ accessibility \}\)/.test(edu))
    const layout = code("app/portal/[contactId]/layout.tsx")
    check("the portal display reads THROUGH the C3 function and applies portalDisplayFor", /readAccessibilityPreferences\(supabase, contact\.brokerage_id/.test(layout) && /portalDisplayFor\(/.test(layout) && /style=\{display\.style\}/.test(layout))
    check("the CRM contact page renders the staff form (read through C3 after the gate)", /<AccessibilityPreferencesCard[\s\S]{0,80}mode=/.test(codeWithStrings("app/crm/contacts/[contactId]/page.tsx")) && /readAccessibilityPreferences\(createServiceClient\(\), brokerageId, contactId\)/.test(code("app/crm/contacts/[contactId]/page.tsx")))
    check("the portal settings page renders the self form", /<AccessibilityPreferencesCard/.test(code("app/components/portal/PortalSettingsPage.tsx")) && /readAccessibilityPreferences\(supabase, contact\.brokerage_id/.test(code("app/portal/[contactId]/settings/page.tsx")))
    check("C3 — readAccessibilityPreferences(svc, brokerageId, contactId) is exported with exactly that signature", /export async function readAccessibilityPreferences\(svc: Svc, brokerageId: string, contactId: string\)/.test(codeWithStrings("lib/contacts/accessibility-preferences.ts")))
    const opts = accessibilityPreferenceOptions()
    check("the form's options are the ONE vocabulary (passed as props, never retyped in the client)", sameSet(opts.formats.map((o) => o.value), COMMUNICATION_FORMATS) && sameSet(opts.flags.map((o) => o.value), ACCESSIBILITY_FLAGS)
      && !/"extra_large"|"screen_reader"/.test(codeWithStrings("app/components/contact/AccessibilityPreferencesCard.tsx")))
    check("the portal display: nothing stated → no class, no style (renders exactly as before)", (() => { const d = portalDisplayFor({}); return d.className === "" && Object.keys(d.style).length === 0 })())
    check("…large text zooms, high contrast and reduced motion add their classes", (() => { const d = portalDisplayFor({ text_size: "large", high_contrast: true, reduce_motion: true }); return d.style.zoom === 1.125 && /contrast-125/.test(d.className) && /animate-none/.test(d.className) })())
    check("a screen-reader portal implies a transcript and no auto-play (deterministic, no model)", (() => { const a = accessibilityAdaptations({ portal_modality: "screen_reader" }); return a.transcript && a.noAutoplay && a.stated })())
  }

  // ═══ G. THE AGE-BAND PATHS ARE GONE ═════════════════════════════════════════════════════════════════════
  section("G no age band chooses a delivery, a format or a rail (DELIVERY_MATRIX / CHANNEL_ORDER_BY_BAND tombstoned)")
  {
    const edu = code("lib/kernel/education.ts"), producer = code("lib/agents/education-delivery-producer.ts")
    check("DELIVERY_MATRIX is not defined in lib/kernel/education.ts (stripped — the tombstone does not count)", !/\bDELIVERY_MATRIX\b/.test(edu) && /TOMBSTONE[\s\S]{0,200}DELIVERY_MATRIX/.test(read("lib/kernel/education.ts")))
    check("CHANNEL_ORDER_BY_BAND is not defined in the producer (stripped) and its tombstone names the survivor", !/\bCHANNEL_ORDER_BY_BAND\b/.test(producer) && /TOMBSTONE[\s\S]{0,300}CHANNEL_ORDER_BY_BAND[\s\S]{0,400}DEFAULT_EDUCATION_CHANNEL_ORDER/.test(read("lib/agents/education-delivery-producer.ts")))
    check("POSITIVE CONTROL — the finder sees the table when it is code", /\bDELIVERY_MATRIX\b/.test("const DELIVERY_MATRIX: Record<AgeSegment, DeliveryConfig> = {}"))
    const consent = { tcpa_consent: true, dnc_status: false }
    const rails = AGE_SEGMENTS.map((b) => pickEducationChannel({ ageSegment: b, moduleChannels: ["article", "video"], consent, preferredChannel: null }))
    check("every band gets the SAME rail and the SAME (unadapted) format for the same lesson", rails.every((r) => r.channel === rails[0].channel && r.preferredFormat === null && r.railSource === "default"), rails.map((r) => `${r.ageSegment}:${r.channel}/${r.preferredFormat}`).join(" "))
    const stated = pickEducationChannel({ ageSegment: "65+", moduleChannels: ["article", "video"], consent, preferredChannel: null, accessibility: { communication_format: "video" } })
    check("POSITIVE CONTROL — the person's STATED format moves the format (video), whatever the band", stated.preferredFormat === "video")
    check("the delivery is one default for everyone — no band parameter exists", getEducationDelivery({}).primaryFormat === "guide" && !/ageSegment/.test(code("lib/kernel/education.ts").split("export interface GetEducationDeliveryParams")[1]?.split("}")[0] ?? "ageSegment"))
    check("resolveContactDeliveryFormat takes a STATED format, never an age (65+ no longer turns a video into a checklist)", resolveContactDeliveryFormat(null, "video") === "video" && resolveContactDeliveryFormat("checklist", "video") === "checklist")
    const nbt = code("lib/ai-isa/next-best-touch.ts")
    console.log(`    published (lane 145E's file, Outside-lane): lib/ai-isa/next-best-touch.ts ageGroupChannelAffinity ${/\bageGroupChannelAffinity\b/.test(nbt) ? "STILL PRESENT — the ISA fallback channel is still ordered by age group (exact change in lane 145H notes, Outside-lane)" : "removed"}`)
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ACCESSIBILITY_PREFERENCES_FAIL"); process.exit(1) }
  console.log(" ✅ ACCESSIBILITY_PREFERENCES_PASS — what the person stated, written only by them or at their request, read by education and the portal; no age chooses a delivery")
}

main().catch((e) => { console.error(e); process.exit(1) })
