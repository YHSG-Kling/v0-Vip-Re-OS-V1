/**
 * scripts/one-door-consent-guard.ts  (npm run test:one-door-consent — no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148B — "One intake door, one consent component, suppression by law".
 *
 * OWNER, verbatim (2026-11-01):
 *   · "all seven doors that create contacts need to be on the same door"                                   (ruling 4)
 *   · "all forms need to have the same consent boxes along with follow up that has an easy way to unsubscribe
 *      including on SMS to comply with the law"                                                              (ruling 3)
 *   · "all forms … should be created with other fields for identity and attributes about that person's situation.
 *      These will also hold the agent/user that creates so the person gets assigned back to them."         (ruling 12)
 *
 * WHAT THIS PROVES (each section names its positive control — a broken finder and a clean tree both read zero):
 *   §A  ONE DOOR — a census of every `contacts` INSERT/UPSERT in app/ + lib/ (stripped source): only the survivor
 *       (lib/contact-pipeline/contact-capture.ts) and the CLASSIFIED non-form paths remain; every named door's body calls
 *       captureContact / captureConsentedContact.
 *   §B  ONE CONSENT COMPONENT (C15) — a DERIVED census of form producers (every .tsx that submits to a contact door):
 *       each renders ConsentBoxes, posts `consent:`, and renders no consent checkbox of its own; every door re-renders the
 *       wording server-side (consentGrantsFromComponent) — the browser never supplies the stored words.
 *   §C  THE CONTRACT, run — wording, strict parse (consent never fabricated), per-box grants, brand mismatch = evidence only.
 *   §D  THE INJECTED-CLIENT CONTRACT, run on an in-memory client — captureContact dedupes before insert (exact email = the same
 *       person; a refused dedupe read refuses; a filter-injection email widens nothing), a merge sends NO second welcome or
 *       invite, the creator is recorded and assigned, the situation lands; captureConsentedContact writes one consent row per
 *       ticked box, nothing for an unticked one, and a replay writes nothing twice.
 *   §E  SUPPRESSION SYNC (C16), run — a STOP at T0 (the ONE vocabulary incl. the FCC revocation words) written through the ONE
 *       opt-out writer lands on the flags AND the one list, and at T0+1 checkSuppression refuses every channel — by contact id,
 *       by the bare number in another spelling, by the bare email; the platform list binds; a refused read fails closed.
 *       Statically: every sender (dispatch email / SMS / mail, the call gates) reads checkSuppression, with and without an id;
 *       marketing email carries List-Unsubscribe (+ one-click with the token); the STOP route has no vocabulary of its own.
 *
 * BLIND SPOTS (published beside the numbers): the doors' HTTP layers and the React components are proven by stripped-source
 * census, not rendered; memSupabase enforces no CHECK / FK / RLS; the egress "every sender goes through dispatch" property is
 * scripts/egress-send-guard-simulator.ts's, cited not re-proven; a census heuristic for "a consent checkbox" is a checkbox
 * within 400 chars of consent / tcpa / "agree to … contact" words.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__148B = { svc: null as MemClient | null, events: [] as any[] }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  // RECORDING (wave 148Z, lane J2 hand-off): every service client minted is COUNTED, so the injected-client contract can be
  // asserted end to end — a door given a client must mint none of its own.
  "@/lib/supabase/service": "export const createServiceClient = () => { globalThis.__148B.minted = (globalThis.__148B.minted ?? 0) + 1; return globalThis.__148B.svc }",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__148B.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__148B.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__148B.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: null } }",
  "@/lib/kernel/notification-engine": "export async function processKernelEvent(e){ globalThis.__148B.events.push({ fanout: true, ...e }) }",
  "@/lib/enrichment/contact-enrichment-core": "export async function queueContactEnrichment(p){ const s = p.supabase ?? globalThis.__148B.svc; await s.from('lead_enrichment_queue').insert({ contact_id: p.contactId, brokerage_id: p.brokerageId, status: 'pending', trigger_type: p.triggerType }); return { queued: true } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const src = (p: string) => stripComments(raw(p))
const rows = (c: MemClient, t: string) => (c.tables[t] ?? []) as any[]

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}
/** The body of a named top-level function (or `export async function`) in stripped source. */
function bodyOf(code: string, fn: string): string {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*[(<]`).exec(code)
  if (!m) return ""
  const rest = code.slice(m.index + m[0].length)
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[(<]/.exec(rest)
  return code.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length))
}

// ═════════════════════════════════════════════════════════════════════════════
// §A — ONE DOOR
// ═════════════════════════════════════════════════════════════════════════════
/** A contacts INSERT / UPSERT in (stripped) source — the shape every door used for its own contact. */
const CONTACT_WRITE = /\.from\(\s*["'`]contacts["'`]\s*\)\s*\.\s*(insert|upsert)\s*\(/g
/**
 * The writers that are NOT a form door, each with its reason. A file here is CLASSIFIED, not exempt from the rule: the
 * survivor is the door; the rest are a lead→contact promotion, inbound messages and staff paths (named in the lane notes).
 */
const CLASSIFIED_WRITERS: Record<string, string> = {
  "lib/contact-pipeline/contact-capture.ts": "THE ONE DOOR (captureContact — create + lead-conversion fast path)",
  "lib/contact-promotion/contact-creator.ts": "lead → contact PROMOTION (a qualified lead's lossless carry; contact-capture.ts LEAD_CONVERSION_SOURCES documents the split)",
  "app/api/webhooks/whatsapp/route.ts": "inbound MESSAGE (not a form) — texting in counts as consent; owner ruling 22 keeps it",
  "app/api/webhooks/linkedin/route.ts": "inbound MESSAGE (not a form)",
  "app/api/webhooks/meta-dm/route.ts": "inbound MESSAGE (not a form)",
  "app/api/webhooks/twitter/route.ts": "inbound MESSAGE (not a form)",
  "lib/inbound-mail/offer-intake.ts": "an inbound OFFER's buyer named by the buyer's agent (staff provenance, not a consent form)",
  // WAVE 148Z: "lib/kernel/crm.ts" LEFT this list — the CRM's staff create now rides captureContact (DOORS below). Its
  // classification would otherwise read as enforced while guarding nothing (the stale-classification check).
}
/** The doors lane 147Z named (+ the staff twins found on the way) — each must call the one door in its body. */
const DOORS: Array<{ door: string; file: string; fn: string }> = [
  { door: "seller open-house check-in (event-day)", file: "app/actions/seller-open-house.ts", fn: "checkInAttendee" },
  { door: "post-event attendee conversion", file: "app/actions/seller-open-house.ts", fn: "convertAttendeeToContact" },
  { door: "open-house walk-in (kernel)", file: "lib/kernel/open-house.ts", fn: "resolveOrCreateOpenHouseContact" },
  { door: "home value (public)", file: "app/actions/home-value.ts", fn: "submitHomeValueRequest" },
  { door: "home value (staff conversion)", file: "app/actions/home-value.ts", fn: "convertValuationRequestToContact" },
  { door: "agent public profile", file: "app/actions/agent-public-profile.ts", fn: "captureProfileLead" },
  { door: "listing seller contact", file: "lib/kernel/listings.ts", fn: "createOrAttachSellerContact" },
  { door: "lead application import", file: "lib/application/lead-application-service.ts", fn: "serviceImportLeads" },
  { door: "lead magnets / forms", file: "lib/kernel/lead-magnets.ts", fn: "captureFormSubmission" },
  { door: "ad lead intake", file: "lib/ads/ad-lead-intake.ts", fn: "ingestConsentedAdLead" },
  { door: "widget callback", file: "app/api/widget/live-agent-request/route.ts", fn: "POST" },
  // WAVE 148Z (lane 148B Still open 1): the CRM's staff create — the add dialog, the transaction sheet, the lead desk's manual conversion.
  { door: "CRM staff create", file: "lib/kernel/crm.ts", fn: "createOrUpdateContactFromDirectIntake" },
]

function sectionA() {
  console.log("\n§A — ONE DOOR: the contacts-writer census + every named door on captureContact / captureConsentedContact")
  const files = [...walk(join(ROOT, "app"), [".ts", ".tsx"]), ...walk(join(ROOT, "lib"), [".ts", ".tsx"])]
  const writers = new Map<string, number>()
  for (const f of files) {
    const rel = relative(ROOT, f)
    const n = (stripComments(readFileSync(f, "utf8")).match(CONTACT_WRITE) ?? []).length
    if (n > 0) writers.set(rel, n)
  }
  const unclassified = [...writers.keys()].filter((f) => !(f in CLASSIFIED_WRITERS))
  const stale = Object.keys(CLASSIFIED_WRITERS).filter((f) => !writers.has(f))
  console.log(`  · scanned ${files.length} files; contacts writers: ${[...writers.entries()].map(([f, n]) => `${f}×${n}`).join(", ")}`)
  check(`no contacts INSERT/UPSERT outside the survivor + the ${Object.keys(CLASSIFIED_WRITERS).length - 1} classified non-form paths (${unclassified.length} unclassified)`, unclassified.length === 0, unclassified.join(", "))
  check("every classified writer still writes (a stale classification would read as enforced while guarding nothing)", stale.length === 0, stale.join(", "))
  check("POSITIVE CONTROL: the finder sees a door's own insert, and NOT a tombstone comment that names one",
    (stripComments(`await svc.from("contacts").insert({ email })`).match(CONTACT_WRITE) ?? []).length === 1
    && (stripComments(`// TOMBSTONE: this used to be .from("contacts").insert({ email })\nconst x = 1`).match(CONTACT_WRITE) ?? []).length === 0)
  for (const d of DOORS) {
    const body = bodyOf(src(d.file), d.fn)
    check(`${d.door} (${d.file}::${d.fn}) rides the one door and writes no contact itself`,
      !!body && /\bcapture(Consented)?Contact\s*\(/.test(body) && !CONTACT_WRITE.test(body), body ? "" : "function not found")
    CONTACT_WRITE.lastIndex = 0
  }
  const cap = src("lib/contact-pipeline/contact-capture.ts")
  check("captureContact takes the injected-client contract (opts.client + opts.effects) and threads it into assignment and the enrichment queue",
    /export async function captureContact\(\s*params: CaptureContactParams,\s*opts: CaptureContactOptions = \{\}/.test(cap) && /client: supabase,?\s*\}\)/.test(cap) && /queueContactEnrichmentAndScore\([^)]*\{ client: p\.client(, notify)? \}/.test(cap))
  check("captureConsentedContact hands ITS client to captureContact (the capture rides the client the tenant was gated with)", /\}, \{ client: svc, effects: opts\.effects \}\)/.test(cap))
  check("resolveAgentForContact accepts the injected client", /client\?: \{ from: \(table: string\) => any \}/.test(src("lib/lead-assignment/contact-assignment.ts")) && /input\.client \?\? createServiceClient\(\)/.test(src("lib/lead-assignment/contact-assignment.ts")))
}

// ═════════════════════════════════════════════════════════════════════════════
// §B — ONE CONSENT COMPONENT (C15): the derived form-producer census
// ═════════════════════════════════════════════════════════════════════════════
/** A form producer = a .tsx that submits to a contact-creating door. Derived from the source, never a hand list. */
const DOOR_CALLS = /\/api\/(qr\/submit|embed\/capture|widget\/capture-lead|widget\/intake|widget\/live-agent-request|open-house\/attend|open-house\/register|forms\/submit)\b|\b(captureFormSubmissionAction|submitHomeValueRequest|captureHomeValueLead|captureProfileLead|submitShowingRequest|checkInAttendee)\s*\(/
/** A consent checkbox rendered outside the component: a checkbox within 400 chars of consent / tcpa / "agree to … contact". */
function ownConsentCheckbox(code: string): boolean {
  const re = /type=\{?["']checkbox["']\}?|<Checkbox\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const win = code.slice(Math.max(0, m.index - 400), m.index + 400)
    if (/tcpa|consent|agree to (receive|be contacted)/i.test(win)) return true
  }
  return false
}
const CONSENT_DOOR_FILES = [
  "app/api/qr/submit/route.ts", "app/api/embed/capture/route.ts", "app/api/widget/capture-lead/route.ts", "app/api/widget/intake/route.ts",
  "app/api/widget/live-agent-request/route.ts", "app/api/open-house/attend/route.ts", "lib/kernel/lead-magnets.ts", "app/actions/home-value.ts",
  "app/actions/home-value-lead.ts", "app/actions/agent-public-profile.ts", "app/actions/listing-landing.ts", "app/actions/seller-open-house.ts",
  // wave 148Z: the event registration door (lane 148H) re-renders through the same contract since its form moved onto ConsentBoxes.
  "lib/open-house/event-attendance.ts",
]

function sectionB() {
  console.log("\n§B — ONE CONSENT COMPONENT (C15): every form producer renders ConsentBoxes and posts the submission")
  const tsx = walk(join(ROOT, "app"), [".tsx"]).filter((f) => !f.endsWith("app/components/forms/ConsentBoxes.tsx"))
  const producers: string[] = []
  for (const f of tsx) {
    const code = stripComments(readFileSync(f, "utf8"))
    if (/["']use client["']/.test(code) && DOOR_CALLS.test(code)) producers.push(relative(ROOT, f))
  }
  console.log(`  · ${producers.length} form producers derived from ${tsx.length} .tsx files: ${producers.join(", ")}`)
  check("the census found the producers it exists for (≥ 12 — QR, embed, both chat widgets, kiosk, event-day, /forms, two magnet forms, two home-value forms, profile, two showing forms)", producers.length >= 12, String(producers.length))
  for (const p of producers) {
    const code = stripComments(raw(p))
    const renders = /<ConsentBoxes\b/.test(code) && /from ["']@\/app\/components\/forms\/ConsentBoxes["']/.test(code)
    const posts = /\bconsent:\s*[\w.]+\.submission\b|\bconsent:\s*kioskConsent\.submission\b|\bconsent=\{[\w.]+\.boxProps\}|consent=\{embedConsent\.boxProps\}/.test(code)
    check(`${p}: renders the ONE component, posts its submission, renders no consent checkbox of its own`, renders && posts && !ownConsentCheckbox(code), JSON.stringify({ renders, posts, own: ownConsentCheckbox(code) }))
  }
  check("POSITIVE CONTROL: a producer with its own TCPA checkbox is caught",
    ownConsentCheckbox(`<input type="checkbox" checked={tcpa} /> <span>I agree to receive calls and texts</span>`) && !ownConsentCheckbox(`<input type="checkbox" checked={pool} /> <span>Has a pool</span>`))
  const comp = src("app/components/forms/ConsentBoxes.tsx")
  check("the component renders the contract's words (consentComponentWording), one required service box, one box per offered channel, nothing pre-checked",
    /consentComponentWording\(/.test(comp) && /aria-required="true"/.test(comp) && /channels\.map\(/.test(comp) && /EMPTY_CONSENT_VALUE/.test(comp) && !/defaultChecked/.test(comp))
  for (const d of CONSENT_DOOR_FILES) {
    check(`${d}: re-renders the wording server-side from the submission (consentGrantsFromComponent) — never stores the browser's words`, /consentGrantsFromComponent\(/.test(src(d)))
  }
  const contract = src("lib/kernel/compliance/consent-component.ts")
  check("the contract module is client-safe (no node:crypto, no supabase, no next/*)", !/from ["'](node:crypto|@\/lib\/supabase|next\/)/.test(contract))
}

// ═════════════════════════════════════════════════════════════════════════════
// §C — THE CONTRACT, run
// ═════════════════════════════════════════════════════════════════════════════
async function sectionC() {
  console.log("\n§C — the C15 contract, run: wording · strict parse · per-box grants · brand evidence")
  const C = await import("../lib/kernel/compliance/consent-component")
  const cap = await import("../lib/contact-pipeline/contact-capture")
  const w = C.consentComponentWording({ door: "home_value", brandName: "Alpha Realty" })
  check("same (door, brand) → byte-identical wording (the page and the door cannot drift)", JSON.stringify(w) === JSON.stringify(C.consentComponentWording({ door: "home_value", brandName: "  Alpha   Realty " })))
  check("the service box names exactly its channels (email, phone call, text) and the thing asked for", /by email, phone call or text message/.test(w.serviceDelivery) && /home value estimate/.test(w.serviceDelivery))
  check("the SMS marketing box carries the carrier disclosure and STOP; the footer names the unsubscribe link and STOP; consent is not a condition",
    /Reply STOP to opt out/.test(w.marketing.sms) && /Msg & data rates may apply/.test(w.marketing.sms) && /unsubscribe link/.test(w.footer) && /reply STOP/.test(w.footer) && /not a condition/.test(w.footer))
  const good = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: true, sms: false, voice: true, direct_mail: true } }, { door: "home_value", brandName: "Alpha Realty" })
  check("a box the form did not OFFER cannot be ticked (direct_mail not offered → false)", good.marketing.direct_mail === false && good.marketing.voice === true)
  check("CONSENT NEVER FABRICATED: a malformed submission parses to NULL (string booleans, unknown door, old version, absent)",
    C.parseConsentSubmission({ ...good, service_delivery: "true" }) === null && C.parseConsentSubmission({ ...good, door: "made_up" }) === null
    && C.parseConsentSubmission({ ...good, version: "c15:1999-01-01" }) === null && C.parseConsentSubmission(undefined) === null)
  check("POSITIVE CONTROL: the well-formed submission parses", C.parseConsentSubmission(JSON.parse(JSON.stringify(good)))?.service_delivery === true)
  const grants = C.consentGrantsFor(good, w, { email: true, phone: false })
  check("no phone given → no phone grant at all (a phone consent with no number is a consent to nothing)", !grants.some((g) => g.family === "phone"))
  const both = C.consentGrantsFor(good, w, { email: true, phone: true })
  const slots = both.map((g) => `${g.family}:${g.slot}:${g.given ? 1 : 0}`).sort()
  check("one grant per box: service (email + phone), marketing email ✓, marketing sms ✗ (unticked → given:false, writes nothing), marketing voice ✓",
    JSON.stringify(slots) === JSON.stringify(["email:marketing:1", "email:service_delivery:1", "phone:marketing_sms:0", "phone:marketing_voice:1", "phone:service_delivery:1"]), slots.join(","))
  const fromServer = cap.consentGrantsFromComponent({ ...good, rendered_brand: "Evil Corp" }, { door: "home_value", brandName: "Alpha Realty", provided: { email: true, phone: true } })
  check("a browser that rendered another brand is EVIDENCE only — the stored words use the server's brand",
    fromServer.evidence.rendered_brand_mismatch === "Evil Corp" && fromServer.grants.every((g) => !String(g.text).includes("Evil Corp")) && fromServer.grants.some((g) => String(g.text).includes("Alpha Realty")))
  check("no submission → NO grants (the door then records no consent)", cap.consentGrantsFromComponent(null, { door: "qr_landing", brandName: "Alpha", provided: { email: true, phone: true } }).grants.length === 0)
  check("situationFromBody keeps only the CHECK vocabularies (timeline buckets, buyer/seller/both)",
    JSON.stringify(cap.situationFromBody({ intent: "buyer", timeline: "3-6_months" })) === JSON.stringify({ contact_type: "buyer", timeline: "3-6_months" })
    && JSON.stringify(cap.situationFromBody({ intent: "landlord", timeline: "30_days" })) === "{}")
}

// ═════════════════════════════════════════════════════════════════════════════
// §D — THE INJECTED-CLIENT CONTRACT, run
// ═════════════════════════════════════════════════════════════════════════════
const A = "00000000-0000-4000-8000-0000000148aa", B = "00000000-0000-4000-8000-0000000148bb"
const AGENT_A = "00000000-0000-4000-8000-00000148a001", AGENT_A2 = "00000000-0000-4000-8000-00000148a002"
function seed(extra: Record<string, any[]> = {}, opts: Record<string, unknown> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: A, name: "Alpha Realty" }, { id: B, name: "Beta Homes" }],
    agents: [
      { id: AGENT_A, brokerage_id: A, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: AGENT_A2, brokerage_id: A, user_id: "u-a2", is_active: true, status: "active", created_at: "2026-01-02T00:00:00Z" },
    ],
    users: [{ id: "u-a1", first_name: "Ann", last_name: "Agent" }],
    qr_codes: [{ id: "qr-a", brokerage_id: A, agent_id: AGENT_A, slug: "spring" }],
    contacts: [], leads: [], contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [],
    manager_completions: [], person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [], transactions: [],
    activities: [], notifications: [], contact_suppression_list: [], platform_suppression_list: [], compliance_events: [], teams: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]] }, ...opts } as never)
}

async function sectionD() {
  console.log("\n§D — the injected-client contract, run: dedupe before insert · no duplicate welcome · creator · consent per box · replay")
  const cap = await import("../lib/contact-pipeline/contact-capture")
  const C = await import("../lib/kernel/compliance/consent-component")
  const svc = seed(); G.__148B.svc = null // NOTHING may mint a service client: the injected one must carry every write
  G.__148B.minted = 0
  const welcomes: string[] = [], invites: string[] = [], notified: string[] = [], videos: string[] = []
  // WAVE 150 (lane 150PU, canary 4): the door gained a fourth EFFECT — the portal welcome video (ensureWelcomeAvatarVideo →
  // the avatar spine, which mints its own service client and does model work). The RULE is unchanged: the injected client
  // carries every write, and every effect that mints its own client is stubbed by the proof. Stubbed here like the other three.
  const effects = {
    notify: (async (e: { event: string }) => { notified.push(String(e.event)) }) as never,
    welcome: async (_s: unknown, c: { id: string }) => { welcomes.push(c.id) },
    portalInvite: async (p: { contactId: string }) => { invites.push(p.contactId) },
    welcomeVideo: async (_s: unknown, p: { contactId: string }) => { videos.push(p.contactId) },
  }
  const r1 = await cap.captureContact({
    brokerageId: A, creatorUserId: "u-a1", source: "web_form", first_name: "Jane", last_name: "Doe", email: "Jane.Doe@Example.com", phone: "(512) 555-0100",
    tcpa_consent: false, timeline: "3-6_months", contact_type: "buyer", status: "new",
  }, { client: svc, effects })
  const jane = rows(svc, "contacts").find((c) => c.id === r1.contactId)
  check("CREATE on the injected client (no service client minted) — assigned back to the creator, creator recorded, situation stored",
    r1.action === "created" && jane?.agent_id === AGENT_A && jane?.source_agent_id === "u-a1" && jane?.timeline === "3-6_months" && jane?.status === "new", JSON.stringify(jane ?? null).slice(0, 300))
  check("the welcome and the portal invite ran ONCE for the new contact", welcomes.length === 1 && invites.length === 1)
  check("enrichment was queued on the injected client", rows(svc, "lead_enrichment_queue").some((q) => q.contact_id === r1.contactId))
  // WAVE 148Z — lane J2's canary: the score step's fan-out called processKernelEvent directly (it mints its own service
  // client), so an injected-client capture still made one on create and one on merge. It now rides the door's `notify`.
  check("INJECTED CLIENT END TO END: the capture (dedupe → insert → score → fan-out) minted NO service client, and the score's CONTACT_SCORED fan-out went to the door's own notify",
    G.__148B.minted === 0 && notified.includes("contact_scored"), JSON.stringify({ minted: G.__148B.minted, notified }))
  {
    // NEGATIVE CONTROL — the recorder sees the defect it exists for: without the door's notify threaded through, the score's
    // fan-out goes to the module's own processKernelEvent (the one that mints a client in production), not to the door.
    const before = notified.length, engineBefore = G.__148B.events.filter((e: any) => e?.fanout && e.event === "contact_scored").length
    await cap.queueContactEnrichmentAndScore({ brokerageId: A, contactId: r1.contactId }, { client: svc })
    const engineAfter = G.__148B.events.filter((e: any) => e?.fanout && e.event === "contact_scored").length
    check("NEGATIVE CONTROL: the same step WITHOUT the threaded notify sends its fan-out to the engine, not to the door (the recorder can see the bypass)",
      notified.length === before && engineAfter === engineBefore + 1, JSON.stringify({ before, after: notified.length, engineBefore, engineAfter }))
  }
  // contacts.phone_digits is GENERATED live; the in-memory row carries what the database would derive.
  jane.phone_digits = "5125550100"
  const r2 = await cap.captureContact({
    brokerageId: A, creatorUserId: "u-a2", source: "qr_scan", first_name: "Janie", last_name: "Doe", email: "jane.doe@example.com", phone: "512-555-0199",
    tcpa_consent: false, timeline: "1-3_months",
  }, { client: svc, effects })
  const after = rows(svc, "contacts")
  check("DEDUPE BEFORE INSERT: the same email (another case, another phone, a nickname) is the SAME person — merged, no second contact",
    r2.action === "merged" && r2.contactId === r1.contactId && after.length === 1, JSON.stringify({ a: r2.action, n: after.length }))
  check("PRIOR HISTORY PRESERVED: the first owner / creator / timeline stay; the new answers are kept as conflict notes, never dropped",
    after[0].agent_id === AGENT_A && after[0].source_agent_id === "u-a1" && after[0].timeline === "3-6_months" && /1-3_months/.test(after[0].notes ?? "") && /512-555-0199/.test(after[0].notes ?? ""), String(after[0].notes))
  check("NO DUPLICATE WELCOME / INVITE / VIDEO: a merge sends none of them (the create commissioned exactly one video)", welcomes.length === 1 && invites.length === 1 && videos.length === 1, JSON.stringify({ welcomes: welcomes.length, invites: invites.length, videos: videos.length }))
  const r3 = await cap.captureContact({ brokerageId: A, source: "qr_scan", first_name: "Jane", last_name: "Doe", phone: "+1 512 555 0100", tcpa_consent: false }, { client: svc, effects })
  check("the phone in another spelling finds the same person through phone_digits", r3.action === "merged" && rows(svc, "contacts").length === 1)
  const inj = await cap.captureContact({ brokerageId: A, source: "web_form", first_name: "Mal", last_name: "Lory", email: "mal@x.test,id.not.is.null", tcpa_consent: false }, { client: svc, effects })
  check("FILTER INJECTION: an email carrying or-grammar widens nothing — a new contact, never a merge into someone else", inj.action === "created" && inj.contactId !== r1.contactId)
  const shut = seed({}, { refuse: { contacts: "permission denied" } })
  let threw = ""
  try { await cap.captureContact({ brokerageId: A, source: "web_form", first_name: "Ref", last_name: "Used", email: "r@x.test", tcpa_consent: false }, { client: shut, effects }) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  check("A REFUSED DEDUPE READ REFUSES (fail closed) — never an insert on 'no match'", /dedupe read \(email\) refused/.test(threw) && rows(shut, "contacts").length === 0, threw)

  // ── C8 + C15 on the injected client ──
  const csvc = seed(); G.__148B.svc = csvc
  const sub = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: true, sms: true, voice: false, direct_mail: false } }, { door: "qr_landing", brandName: "Alpha Realty" })
  const g = cap.consentGrantsFromComponent(sub, { door: "qr_landing", brandName: "Alpha Realty", provided: { email: true, phone: true } })
  const params = {
    brokerageId: A, ownerAgentId: AGENT_A, creatorUserId: "u-a1", source: "qr_scan", first_name: "Pat", last_name: "Lee", email: "pat@example.test", phone: "+15125550142",
    consents: g.grants, intake: { capturedAt: "2026-11-01T10:00:00.000Z", channel: "qr", evidence: { ...g.evidence, qr_code_id: "qr-a" }, formOwner: { table: "qr_codes" as const, id: "qr-a" } },
  }
  const c1 = await cap.captureConsentedContact(params as never, { client: csvc, effects })
  const ev = rows(csvc, "contact_consent_events").filter((e) => e.contact_id === c1.contactId)
  const types = ev.map((e) => `${e.consent_type}:${(e.channels ?? []).join("+")}:${e.evidence?.consent_box}`).sort()
  check("one consent row PER TICKED BOX (service email + service phone + marketing email + marketing sms), none for the unticked voice box",
    c1.ok && ev.length === 4 && JSON.stringify(types) === JSON.stringify(["email:email:marketing", "email:email:service_delivery", "tcpa:sms+voice:service_delivery", "tcpa:sms:marketing_sms"]), JSON.stringify({ ok: c1.ok, r: c1.reason, types }))
  check("each row stores the server-rendered words, the C15 version, the creator, and the marketing purposes only on marketing boxes",
    ev.every((e) => String(e.consent_text).includes("Alpha Realty") && String(e.consent_text_version).startsWith("c15:") && e.evidence?.creator_user_id === "u-a1")
    && ev.filter((e) => e.evidence?.consent_box === "service_delivery").every((e) => !(e.purposes ?? []).includes("market_updates"))
    && ev.filter((e) => String(e.evidence?.consent_box).startsWith("marketing")).every((e) => (e.purposes ?? []).includes("market_updates")))
  const n = { c: rows(csvc, "contacts").length, e: rows(csvc, "contact_consent_events").length }
  const c2 = await cap.captureConsentedContact(params as never, { client: csvc, effects })
  check("REPLAY of the same submission writes nothing twice (no second contact, no second consent row)", c2.replay === true && rows(csvc, "contacts").length === n.c && rows(csvc, "contact_consent_events").length === n.e)
  const noC15 = cap.consentGrantsFromComponent(undefined, { door: "qr_landing", brandName: "Alpha Realty", provided: { email: true, phone: true } })
  const c3 = await cap.captureConsentedContact({ ...params, email: "nobox@example.test", phone: "+15125550177", consents: noC15.grants.length ? noC15.grants : [{ family: "phone", given: false, text: null }], intake: { ...params.intake, capturedAt: "2026-11-01T11:00:00.000Z" } } as never, { client: csvc, effects })
  const nobox = rows(csvc, "contacts").find((c) => c.id === c3.contactId)
  check("CONSENT NEVER FABRICATED: no ticked box → the person is a contact with NO consent row and tcpa_consent false",
    c3.ok && nobox?.tcpa_consent === false && rows(csvc, "contact_consent_events").filter((e) => e.contact_id === c3.contactId).length === 0)
}

// ═════════════════════════════════════════════════════════════════════════════
// §E — SUPPRESSION SYNC (C16)
// ═════════════════════════════════════════════════════════════════════════════
async function sectionE() {
  console.log("\n§E — suppression sync (C16): a STOP at T0 refuses every channel's send at T0+1, across senders")
  const U = await import("../lib/ai-isa/opt-out-utils")
  check("THE ONE VOCABULARY: STOP / Stop. / REVOKE / opt out / STOPALL revoke ALL channels; 'stop by tomorrow?' does not",
    ["STOP", "Stop.", "REVOKE", "opt out", "STOPALL", "unsubscribe please"].every((t) => { const d = U.detectOptOutIntent(t); return d.isOptOut && d.channel === "all" && d.confidence === "high" })
    && !U.detectOptOutIntent("can you stop by tomorrow?").isOptOut)
  check("POSITIVE CONTROL: the FCC words the old route regex missed ARE in the one list", U.isRevocationKeyword("revoke") && U.isRevocationKeyword("opt-out") && !U.isRevocationKeyword("hello"))
  // Every door that recognises a STOP reads THE list — the SMS opt-out route, the communication spine's inbound STOP and the
  // AI ISA's hard stop (the last two each kept a private regex without "revoke"; their words were merged onto the list first).
  const STOP_DOORS = ["app/api/sms/inbound-optout/route.ts", "lib/communication-spine/ingest-message-service.ts", "lib/kernel/ai-isa.ts"]
  const PRIVATE_STOP_REGEX = /\/\^\\s\*\(stop\|[^/]*\)\\s\*\$\/i?/
  const stopBad = STOP_DOORS.filter((f) => !/\b(isRevocationKeyword|detectOptOutIntent)\s*\(/.test(src(f)) || PRIVATE_STOP_REGEX.test(src(f)))
  check("every STOP door reads the ONE revocation list and keeps no private keyword regex", stopBad.length === 0, stopBad.join(", "))
  check("POSITIVE CONTROL: the private-regex finder sees the retired shape (and not the tombstone that names it)",
    PRIVATE_STOP_REGEX.test(stripComments(`const HARD_STOP = /^\\s*(stop|cancel|end|quit)\\s*$/i`))
    && !PRIVATE_STOP_REGEX.test(stripComments(`// TOMBSTONE: a local HARD_STOP regex /^\\s*(stop|cancel)\\s*$/i stood here\nconst x = 1`))
    && U.isRevocationKeyword("remove me") && U.isRevocationKeyword("Remove."))

  const S = await import("../lib/kernel/compliance/check-suppression")
  const W = await import("../lib/ai-isa/opt-out-writer")
  const C = "00000000-0000-4000-8000-00000148c001", OTHER = "00000000-0000-4000-8000-00000148c002"
  const svc = seed({ contacts: [
    { id: C, brokerage_id: A, agent_id: AGENT_A, first_name: "Sam", last_name: "Stop", email: "sam@example.test", phone: "(813) 555-0147", opt_out_channels: [] },
    { id: OTHER, brokerage_id: A, agent_id: AGENT_A, first_name: "Olive", last_name: "Open", email: "olive@example.test", phone: "(813) 555-0999", opt_out_channels: [] },
  ] }); G.__148B.svc = svc
  const before = await S.checkSuppression({ brokerageId: A, contactId: C, phone: "+18135550147", channel: "sms" }, { client: svc })
  check("T0−1: the person is sendable (control — the gate is not simply always closed)", before.suppressed === false)
  // T0 — the STOP arrives on the verified inbound door and is written through THE one writer.
  const stop = U.detectOptOutIntent("STOP")
  const w = await W.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: C, channel: stop.channel, source: "inbound_sms", rawMessage: "STOP" }, { client: svc as never, emit: (async () => {}) as never })
  const list = rows(svc, "contact_suppression_list").filter((r) => r.contact_id === C)
  check("T0: the STOP lands on the contact flags (all four channels) AND one list row per channel (email, sms, phone, mail)",
    w.success && w.globalDNC && w.listSynced === true && JSON.stringify(list.map((r) => r.channel).sort()) === JSON.stringify(["email", "mail", "phone", "sms"]), JSON.stringify({ w, n: list.length }))
  check("…and the withdrawal is on the consent ledger (consented:false rows the scope answer reads)", rows(svc, "contact_consent_events").filter((e) => e.contact_id === C && e.consented === false).length >= 4)
  // T0+1 — every sender's read.
  const ask = (p: Record<string, unknown>) => S.checkSuppression({ brokerageId: A, ...p } as never, { client: svc })
  const t1 = await Promise.all([
    ask({ contactId: C, email: "sam@example.test", channel: "email" }),
    ask({ contactId: C, phone: "(813) 555-0147", channel: "sms" }),
    ask({ contactId: C, phone: "(813) 555-0147", channel: "phone" }),
    ask({ contactId: C, channel: "mail" }),
    ask({ contactId: null, phone: "+18135550147", channel: "sms" }),
    ask({ contactId: null, phone: "813-555-0147", channel: "phone" }),
    ask({ contactId: null, email: "SAM@example.test", channel: "email" }),
  ])
  check("T0+1: every channel refuses by contact id (email · sms · phone · mail)", t1.slice(0, 4).every((r) => r.suppressed), JSON.stringify(t1.slice(0, 4)))
  check("T0+1: a NUMBER-ONLY send in another spelling (+1… / 813-…) and an EMAIL-ONLY send (other case) refuse too", t1.slice(4).every((r) => r.suppressed), JSON.stringify(t1.slice(4)))
  const other = await ask({ contactId: OTHER, phone: "(813) 555-0999", channel: "sms" })
  check("POSITIVE CONTROL: another person in the same tenant is still sendable", other.suppressed === false)
  const dnc = seed({ contacts: [{ id: C, brokerage_id: A, phone: "(813) 555-0147", dnc_status: true }] })
  check("a DNC'd number is not TEXTED either (a text is a call under the TCPA)", (await S.checkSuppression({ brokerageId: A, contactId: C, channel: "sms" }, { client: dnc })).suppressed)
  const plat = seed({ platform_suppression_list: [{ id: "p1", phone_digits: "8135550999", reason: "spam_complaint" }] })
  check("the PLATFORM list binds (spam complaint / litigator / federal DNC — cross-tenant)", (await S.checkSuppression({ brokerageId: A, contactId: null, phone: "+1 (813) 555-0999", channel: "sms" }, { client: plat })).suppressed)
  const refused = seed({}, { refuse: { contact_suppression_list: "permission denied" } })
  check("FAIL CLOSED: an unreadable suppression list refuses the send", (await S.checkSuppression({ brokerageId: A, contactId: null, phone: "+18135550999", channel: "sms" }, { client: refused })).suppressed)

  // Statically — every sender reads the one gate (the egress guard proves every send goes through dispatch).
  const disp = src("lib/providers/dispatch.ts")
  const emailFn = bodyOf(disp, "dispatchEmail"), smsFn = bodyOf(disp, "dispatchSms"), mailFn = bodyOf(disp, "dispatchDirectMail")
  check("dispatchEmail reads checkSuppression WITH an id and WITHOUT one (by address)", (emailFn.match(/checkSuppression\(/g) ?? []).length >= 2 && /else if \(params\.to\)/.test(emailFn))
  check("dispatchSms reads checkSuppression WITH an id and WITHOUT one (by number)", (smsFn.match(/checkSuppression\(/g) ?? []).length >= 2 && /else if \(params\.to\)/.test(smsFn))
  check("dispatchDirectMail and the outbound call gates read checkSuppression", /checkSuppression\(/.test(mailFn) && /checkSuppression\(/.test(src("lib/voice/outbound-call-gates.ts")))
  check("marketing email carries List-Unsubscribe (+ List-Unsubscribe-Post one-click with the token) and the adapter puts headers on the wire",
    /List-Unsubscribe-Post/.test(src("lib/kernel/communications/assemble-email.ts")) && /headers: assembled\.headers/.test(emailFn) && /headers: params\.headers/.test(src("lib/providers/messaging/index.ts")))
  check("the unsubscribe route takes the token AND the RFC 8058 one-click form body", /List-Unsubscribe["']\]\s*\?\?\s*""\)\s*===\s*"One-Click"/.test(src("app/api/unsubscribe/route.ts")) && /unsubscribe_token/.test(src("app/api/unsubscribe/route.ts")))
  const route = src("app/api/sms/inbound-optout/route.ts")
  check("the SMS STOP route has NO vocabulary of its own and writes through the ONE opt-out writer", !/STOP_KEYWORDS/.test(route) && /detectOptOutIntent\(/.test(route) && /processOptOutFromVerifiedInbound\(/.test(route))
  check("POSITIVE CONTROL: the own-vocabulary finder sees the old regex", /STOP_KEYWORDS/.test("const STOP_KEYWORDS = /^stop$/i"))
  const m910 = readFileSync(join(ROOT, "supabase/migrations/m910-contacts-unsubscribe-token.sql"), "utf8")
  // ── WAVE 148Z — CONSENT PURPOSE on the one SMS send path (lane 148B Still open 3): a CAMPAIGN text to a person whose
  //    recorded SMS consent covers only the service they asked for is REFUSED; a marketing-box consent passes.
  const RC = await import("../lib/kernel/compliance/require-contact-consent")
  const PC = "00000000-0000-4000-8000-00000148c0de"
  const purposeDb = (purposes: string[], channels: string[]) => seed({
    contacts: [{ id: PC, brokerage_id: A, phone: "(813) 555-0188", tcpa_consent: true }],
    contact_consent_events: [{ id: "ce-1", brokerage_id: A, contact_id: PC, consent_type: "tcpa", consented: true, purposes, channels, created_at: "2026-11-01T10:00:00Z" }],
  })
  const serviceOnly = RC.answerConsentQuestion(await RC.consentScopeFor(purposeDb(["requested_information", "home_valuation"], ["sms", "voice"]), { brokerageId: A, contactId: PC }), { channel: "sms", purpose: "real_estate_services" })
  const marketingBox = RC.answerConsentQuestion(await RC.consentScopeFor(purposeDb(["real_estate_services", "market_updates", "listing_alerts"], ["sms"]), { brokerageId: A, contactId: PC }), { channel: "sms", purpose: "real_estate_services" })
  check("a SERVICE-ONLY SMS consent does not cover a marketing purpose (purpose_not_covered); a MARKETING-box consent does (positive control)",
    serviceOnly.basis === "purpose_not_covered" && !serviceOnly.allowed && marketingBox.allowed && marketingBox.basis === "consent_record", JSON.stringify({ serviceOnly: serviceOnly.basis, marketingBox: marketingBox.basis }))
  const refusing = /CAMPAIGN_SMS_REFUSING_BASES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(disp)?.[1] ?? ""
  check("dispatchSms asks the ONE consent-scope reader for a CAMPAIGN text (channelPurposeFor → consentScopeFor → answerConsentQuestion) and refuses purpose_not_covered + unreadable (fail closed)",
    /channelPurposeFor\(params\)\s*===\s*"campaign"/.test(smsFn) && /consentScopeFor\(/.test(smsFn) && /answerConsentQuestion\(/.test(smsFn) && /CAMPAIGN_SMS_REFUSING_BASES\.has\(/.test(smsFn)
    && /"purpose_not_covered"/.test(refusing) && /"unreadable"/.test(refusing), refusing)
  check("ONE channel-purpose inference for email AND sms (no second spelling inside dispatchEmail)",
    /channelPurposeFor\(params\)/.test(emailFn) && !/systemSource\?\.includes\("campaign"\)/.test(emailFn))
  check("the marketing SMS senders declare it: campaign-sequence steps and open-house invitations pass channelPurpose \"campaign\"",
    /channelPurpose:\s*"campaign"/.test(src("lib/workflow/adapters/sms.ts")) && /systemSource:\s*"open_house_invitation",[\s\S]{0,40}channelPurpose:\s*"campaign"/.test(src("lib/communications/send-invitation.ts")))
  check("POSITIVE CONTROL: the refusing-set reader would see a set that forgot purpose_not_covered",
    !/"purpose_not_covered"/.test(/CAMPAIGN_SMS_REFUSING_BASES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(`const CAMPAIGN_SMS_REFUSING_BASES: ReadonlySet<string> = new Set(["withdrawn"])`)?.[1] ?? ""))
  check("m910 is stamped (lane stamp OR applied) and adds the unique per-contact token", /^-- (WRITTEN, NOT APPLIED \(wave 148, lane 148B\)|── APPLIED LIVE )/.test(m910) && /ADD COLUMN IF NOT EXISTS unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid\(\)/.test(m910) && /UNIQUE INDEX/.test(m910))
}

async function main() {
  console.log("━━ ONE DOOR · ONE CONSENT COMPONENT · SUPPRESSION BY LAW (wave 148, lane 148B) ━━")
  sectionA()
  sectionB()
  await sectionC()
  await sectionD()
  await sectionE()
  console.log(`\nBLIND SPOTS: HTTP layers + React render proven by stripped-source census (not executed); memSupabase has no CHECK/FK/RLS; "every sender goes through dispatch" is scripts/egress-send-guard-simulator.ts's proof (cited).`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ ONE_DOOR_CONSENT_PASS" : ""}`)
  if (fail) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
