/**
 * scripts/suppression-everywhere-guard.ts  (npm run test:suppression-everywhere — no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150PU — directive lane 150U: "Consent/STOP/unsubscribe and suppression across the seven known Contact doors,
 * forms/events/ads and downstream journeys; mark provider legal-content unknown until verified." Canary 10's consent half
 * ("email/SMS follow-up legal consent and unsubscribe in one canonical place") and canary 18's "Meta legal-consent uncertainty".
 *
 * ONE CANONICAL PLACE, proven by what it refuses (each section names its positive control):
 *   §1 THE ONE READ — checkSuppression (lib/kernel/compliance/check-suppression.ts): the PLATFORM list binds every channel incl.
 *      MAIL and every identity the person has (a contact-id-only send asks about the contact's own email / phone); the reason
 *      decides reach (federal_dnc = calls + texts only); a refused read refuses.
 *   §2 THE TENANT-LESS PLATFORM QUESTIONS (lib/platform/suppression-list.ts — distribution engine, prospect follow-up, predictive
 *      auto-send, staff mail): a refused read answers SUPPRESSED (fail closed), never "not on the list".
 *   §3 THE ONE WRITE — a STOP from an OPEN LEAD is written to the lead through THE one writer (flags + the number-keyed list
 *      row), so the number refuses at T0+1 in any spelling and the flags ride the lead → contact promotion; a GLOBAL opt-out
 *      ends the person's sequence enrollments ('unsubscribed') — the downstream journey stops, not just each send.
 *   §4 ONE VOCABULARY — no inbound door keeps a private STOP keyword list (census over app/ + lib/, stripped source).
 *   §5 THE SEVEN DOORS + FORMS + EVENTS + PORTAL + EMAIL — every door re-renders the ONE consent component server-side, every
 *      revocation surface lands on the one writer / addSuppression, every sender reads the one gate (static; the runtime of
 *      these is test:one-door-consent §D/§E).
 *   §6 ADS — a Meta lead form's legal content is fetched, stored UNKNOWN, and never arms a consent until a person verified it;
 *      a verified plain disclaimer does; a verified form with checkboxes does not (the per-lead answer is not read).
 *
 * BLIND SPOTS: memSupabase enforces no CHECK / FK / RLS / unique partial indexes; the Meta Graph call is stubbed (the field
 * path is UNVERIFIED — WAITING_EXTERNAL, a live form check); the HTTP routes are read as stripped source; "every send goes
 * through dispatch" is scripts/egress-send-guard-simulator.ts's proof (cited, not re-proven).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__150U = { svc: null as MemClient | null, graph: [] as any[], graphReply: null as any }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__150U.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__150U.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ return { inserted: true, lifecycleEventId: 'ev-1', fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: { id: 'ev-1' }, error: null } }",
  "@/lib/kernel/notification-engine": "export async function processKernelEvent(e){ }",
  "@/lib/enrichment/contact-enrichment-core": "export async function queueContactEnrichment(p){ return { queued: true } }",
  "@/lib/kernel/client-welcome": "export async function ensureClientWelcome(){ return {} }; export function resolveWelcomeManagers(){ return ['listing_concierge'] }",
  "@/lib/portal/portal-invite-core": "export async function createSystemPortalInvite(){ return { granted: true } }",
  "@/lib/contact-promotion/welcome-avatar-video": "export async function ensureWelcomeAvatarVideo(){ return { warnings: [] } }",
  "@/lib/providers/meta/client": "export async function graphGet(token, path, params){ globalThis.__150U.graph.push({ path, params }); return globalThis.__150U.graphReply ?? { ok: false, status: 500, data: null, error: 'stub' } }; export async function graphPost(){ return { ok: false, status: 500, data: null, error: 'stub' } }",
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
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

const A = "00000000-0000-4000-8000-0000000150ua"
const CON = "00000000-0000-4000-8000-00000150c001", CLEAN = "00000000-0000-4000-8000-00000150c002"
function seed(extra: Record<string, any[]> = {}, opts: Record<string, unknown> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: A, name: "Alpha Realty", plan_tier: "brokerage" }],
    agents: [{ id: "00000000-0000-4000-8000-00000150a001", brokerage_id: A, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" }],
    contacts: [], leads: [], contact_consent_events: [], contact_suppression_list: [], platform_suppression_list: [], compliance_events: [], activities: [],
    sequence_enrollments: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [], person_identities: [],
    person_identity_evidence: [], lead_score_history: [], assignment_rules: [], teams: [], notifications: [], transactions: [], platform_credentials: [],
    ad_lead_form_legal_content: [], contact_lead_history: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]], ad_lead_form_legal_content: [["brokerage_id", "platform", "form_id"]] }, ...opts } as never)
}

// ═════════════════════════════════════════════════════════════════════════════
async function section1() {
  console.log("\n§1 — THE ONE READ: the platform list binds every channel (mail included) and every identity the person has")
  const S = await import("../lib/kernel/compliance/check-suppression")
  const ask = (svc: MemClient, p: Record<string, unknown>) => S.checkSuppression({ brokerageId: A, ...p } as never, { client: svc })
  const people = [
    { id: CON, brokerage_id: A, email: "litigator@example.test", phone: "(813) 555-0147" },
    { id: CLEAN, brokerage_id: A, email: "olive@example.test", phone: "(813) 555-0999" },
  ]
  const lit = seed({ contacts: people, platform_suppression_list: [{ id: "p1", email: "litigator@example.test", reason: "litigator" }] })
  check("a contact-id-only DIRECT MAIL send to a platform-listed person (litigator, by their email) is REFUSED — the arm used to skip mail",
    (await ask(lit, { contactId: CON, channel: "mail" })).suppressed)
  check("POSITIVE CONTROL: another person in the tenant is still mailable", !(await ask(lit, { contactId: CLEAN, channel: "mail" })).suppressed)
  const optout = seed({ contacts: people, platform_suppression_list: [{ id: "p2", phone_digits: "8135550147", reason: "explicit_opt_out" }] })
  check("an EMAIL to a person whose PHONE said stop platform-wide is refused (every identity, every channel — 'via any channel')",
    (await ask(optout, { contactId: CON, email: "litigator@example.test", channel: "email" })).suppressed)
  const dnc = seed({ contacts: people, platform_suppression_list: [{ id: "p3", phone_digits: "8135550147", reason: "federal_dnc" }] })
  const dncSms = await ask(dnc, { contactId: CON, channel: "sms" }), dncEmail = await ask(dnc, { contactId: CON, channel: "email" }), dncMail = await ask(dnc, { contactId: CON, channel: "mail" })
  check("federal_dnc is a TELEPHONE rule: the text is refused, the email and the postcard are not", dncSms.suppressed && !dncEmail.suppressed && !dncMail.suppressed, JSON.stringify({ dncSms, dncEmail, dncMail }))
  const refused = seed({ contacts: people }, { refuse: { platform_suppression_list: "permission denied" } })
  check("FAIL CLOSED: an unreadable platform list refuses the mail send too", (await ask(refused, { contactId: CON, channel: "mail" })).suppressed)
}

// ═════════════════════════════════════════════════════════════════════════════
async function section2() {
  console.log("\n§2 — the tenant-less platform questions fail closed")
  const P = await import("../lib/platform/suppression-list")
  const listed = seed({ platform_suppression_list: [{ id: "p1", phone_digits: "8135550147", reason: "spam_complaint" }, { id: "p2", email: "spam@example.test", reason: "spam_complaint" }] })
  check("POSITIVE CONTROL: a listed number / email answers true, an unlisted one false",
    (await P.isPhoneOnSuppressionList("+1 (813) 555-0147", listed)) && (await P.isEmailOnSuppressionList("SPAM@example.test", listed))
    && !(await P.isPhoneOnSuppressionList("8135550000", listed)) && !(await P.isEmailOnSuppressionList("ok@example.test", listed)))
  const shut = seed({}, { refuse: { platform_suppression_list: "permission denied" } })
  check("a REFUSED read answers SUPPRESSED for a phone, an email and isSuppressedAny (it used to read as 'not listed')",
    (await P.isPhoneOnSuppressionList("8135550000", shut)) && (await P.isEmailOnSuppressionList("ok@example.test", shut)) && (await P.isSuppressedAny({ email: "ok@example.test" }, shut)))
  check("no reader in the module keeps an unread `const { data } =` read", !/const \{ data \} = await/.test(src("lib/platform/suppression-list.ts")))
}

// ═════════════════════════════════════════════════════════════════════════════
async function section3() {
  console.log("\n§3 — THE ONE WRITE: an open lead's STOP lands on the lead; a global opt-out ends the journeys")
  const W = await import("../lib/ai-isa/opt-out-writer")
  const S = await import("../lib/kernel/compliance/check-suppression")
  const U = await import("../lib/ai-isa/opt-out-utils")
  const LEAD = "00000000-0000-4000-8000-0000150ead01"
  const svc = seed({
    leads: [{ id: LEAD, brokerage_id: A, first_name: "Lee", last_name: "Open", email: "lee@example.test", phone: "+18135550188", phone_digits: "18135550188", contact_id: null, opt_out_channels: [] }],
    contacts: [{ id: CON, brokerage_id: A, first_name: "Sam", last_name: "Stop", email: "sam@example.test", phone: "(813) 555-0147", opt_out_channels: [] }],
    sequence_enrollments: [
      { id: "se-1", brokerage_id: A, contact_id: CON, status: "active" }, { id: "se-2", brokerage_id: A, contact_id: CON, status: "paused" },
      { id: "se-3", brokerage_id: A, contact_id: CON, status: "completed" }, { id: "se-4", brokerage_id: A, lead_id: LEAD, status: "active" },
    ],
  })
  G.__150U.svc = svc
  const stop = U.detectOptOutIntent("STOP")
  const lw = await W.processOptOutFromVerifiedInbound({ entityType: "lead", entityId: LEAD, channel: stop.channel, source: "inbound_sms", rawMessage: "STOP" }, { client: svc as never, emit: (async () => {}) as never })
  const lead = rows(svc, "leads")[0]
  check("an OPEN LEAD's STOP is written to the LEAD's flags (sms + phone + email + mail) through the one writer", lw.success && lead.sms_opt_out === true && lead.phone_opt_out === true && lead.email_opt_out === true, JSON.stringify({ lw, lead: { s: lead.sms_opt_out, p: lead.phone_opt_out } }))
  check("…and on the number-keyed list, so a later send to the number in ANOTHER spelling refuses at T0+1",
    (await S.checkSuppression({ brokerageId: A, contactId: null, phone: "813-555-0188", channel: "sms" }, { client: svc })).suppressed)
  check("…and the lead's own journey is ended ('unsubscribed')", rows(svc, "sequence_enrollments").find((e) => e.id === "se-4")?.status === "unsubscribed")
  const cw = await W.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: CON, channel: stop.channel, source: "inbound_sms", rawMessage: "STOP" }, { client: svc as never, emit: (async () => {}) as never })
  const st = Object.fromEntries(rows(svc, "sequence_enrollments").map((e) => [e.id, e.status]))
  check("a GLOBAL opt-out ends the contact's ACTIVE and PAUSED enrollments as 'unsubscribed' and leaves a completed one alone", cw.success && cw.enrollmentsEnded === 2 && st["se-1"] === "unsubscribed" && st["se-2"] === "unsubscribed" && st["se-3"] === "completed", JSON.stringify({ ended: cw.enrollmentsEnded, st }))
  const one = seed({ contacts: [{ id: CON, brokerage_id: A, email: "sam@example.test", phone: "(813) 555-0147", opt_out_channels: [] }], sequence_enrollments: [{ id: "se-9", brokerage_id: A, contact_id: CON, status: "active" }] })
  const ew = await W.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: CON, channel: "email", source: "inbound_email", rawMessage: "please stop emailing me" }, { client: one as never, emit: (async () => {}) as never })
  check("POSITIVE CONTROL: a SINGLE-CHANNEL opt-out leaves the journey running (its other channels are lawful; the send gate refuses email)",
    ew.success && !ew.globalDNC && rows(one, "sequence_enrollments")[0].status === "active", JSON.stringify({ ew, s: rows(one, "sequence_enrollments")[0].status }))
  const route = src("app/api/sms/inbound-optout/route.ts")
  check("the SMS STOP route matches OPEN leads by phone_digits (tenant-pinned when the owning number resolves) and writes them through processOptOutFromVerifiedInbound",
    /from\('leads'\)\.select\('id, brokerage_id'\)\.in\('phone_digits', digitForms\)\.is\('contact_id', null\)/.test(route) && /openLeadsQuery = openLeadsQuery\.eq\('brokerage_id', owner\.brokerageId\)/.test(route) && /entityType: 'lead'/.test(route))
  check("…and a refused lead / number-owner read answers 503 (the carrier retries), never a STOP acknowledged and dropped",
    /openLeadsError[\s\S]{0,160}status: 503/.test(route) && /numberOwnerError[\s\S]{0,200}status: 503/.test(route))
}

// ═════════════════════════════════════════════════════════════════════════════
function section4() {
  console.log("\n§4 — ONE VOCABULARY: no door keeps a private STOP keyword list")
  const PRIVATE = [/\/\^\\s\*\((\?:)?stop\|/i, /\[\s*["']stop["']\s*,\s*["'](stopall|unsubscribe|cancel|end|quit)["']/i, /\bSTOP_KEYWORDS\s*=/]
  const files = [...walk(join(ROOT, "app"), [".ts", ".tsx"]), ...walk(join(ROOT, "lib"), [".ts", ".tsx"])].filter((f) => !f.endsWith("lib/ai-isa/opt-out-utils.ts"))
  const offenders = files.filter((f) => { const code = stripComments(readFileSync(f, "utf8")); return PRIVATE.some((re) => re.test(code)) }).map((f) => relative(ROOT, f))
  check(`no private STOP vocabulary outside lib/ai-isa/opt-out-utils.ts REVOCATION_KEYWORDS (${files.length} files, ${offenders.length} offenders)`, offenders.length === 0, offenders.join(", "))
  check("POSITIVE CONTROL: the census sees each retired shape, and not a tombstone naming one",
    PRIVATE[0].test(`const HARD_STOP = /^\\s*(stop|cancel|end)\\s*$/i`) && PRIVATE[1].test(`const words = ["stop", "unsubscribe"]`) && PRIVATE[2].test(`const STOP_KEYWORDS = /x/`)
    && !PRIVATE.some((re) => re.test(stripComments(`// TOMBSTONE: const STOP_KEYWORDS = /^stop$/ stood here\nconst x = 1`))))
  const utils = src("lib/ai-isa/opt-out-utils.ts")
  check("the ONE list carries the carrier words AND the FCC revocation words", /REVOCATION_KEYWORDS = \[[^\]]*"stopall"[^\]]*"revoke"[^\]]*\]/.test(utils))
}

// ═════════════════════════════════════════════════════════════════════════════
function section5() {
  console.log("\n§5 — the seven doors, forms, events, portal and email: one component in, one writer / one gate out")
  const DOORS = ["app/api/qr/submit/route.ts", "app/api/embed/capture/route.ts", "app/api/widget/capture-lead/route.ts", "app/api/widget/intake/route.ts",
    "app/api/open-house/attend/route.ts", "lib/kernel/lead-magnets.ts", "app/actions/home-value.ts", "app/actions/agent-public-profile.ts",
    "app/actions/listing-landing.ts", "app/actions/seller-open-house.ts", "lib/open-house/event-attendance.ts"]
  const notReRendering = DOORS.filter((d) => !/consentGrantsFromComponent\(/.test(src(d)))
  check(`every consented door (forms, QR, embed, widgets, open house + events, magnets, home value, profile, listing) re-renders the ONE component server-side (${DOORS.length - notReRendering.length}/${DOORS.length})`, notReRendering.length === 0, notReRendering.join(", "))
  const comp = src("lib/kernel/compliance/consent-component.ts")
  check("the ONE component's wording names the unsubscribe link and STOP in its footer, and the SMS box carries the carrier disclosure", /unsubscribe link/.test(comp) && /Reply STOP to opt out/.test(comp))
  check("portal preferences → THE one opt-out writer (source portal)", /writeOptOut\(svc, access\.brokerageId, \{ entityType: "contact", entityId: contactId, channel, source: "portal" \}\)/.test(src("app/actions/portal-settings.ts")))
  check("the email unsubscribe link + RFC 8058 one-click → addSuppression (the one list)", /addSuppression\(/.test(src("app/api/unsubscribe/route.ts")) && /One-Click/.test(src("app/api/unsubscribe/route.ts")))
  check("the mail unsubscribe door → addSuppression (direct mail lands on the same list)", /addSuppression\(/.test(src("lib/direct-mail/mail-unsubscribe.ts")))
  const disp = src("lib/providers/dispatch.ts")
  check("every sender reads the one gate: dispatch email + SMS + direct mail and the outbound call gates call checkSuppression",
    (disp.match(/checkSuppression\(/g) ?? []).length >= 5 && /checkSuppression\(/.test(src("lib/voice/outbound-call-gates.ts")))
  check("ads: the persona audience build reads the one suppression list (C26 floor) before an audience member is synced", /contact_suppression_list/.test(src("lib/kernel/ads.ts")))
}

// ═════════════════════════════════════════════════════════════════════════════
async function section6() {
  console.log("\n§6 — ads: a Meta lead form's legal content is UNKNOWN until a person verifies it")
  const M = await import("../lib/ads/connectors/meta")
  const mapVia = async (data: unknown) => { G.__150U.graphReply = { ok: true, status: 200, data, error: null }; const r = await M.fetchMetaLeadFormLegalContent("tok", "form-x"); return r.ok ? r.legal : "error" }
  const garbage = [undefined, null, "x", 7, {}, { legal_content: null }, { legal_content: { custom_disclaimer: { body: { text: "  " } } } }]
  const mappedGarbage = await Promise.all(garbage.map(mapVia))
  check("the mapper is TOTAL (garbage, null, a string, an empty legal_content → null; never a throw)", mappedGarbage.every((v) => v === null), JSON.stringify(mappedGarbage))
  const mapped = await mapVia({ legal_content: { privacy_policy: { url: "https://alpha.example/privacy" }, custom_disclaimer: { body: { text: " By submitting you agree Alpha Realty may call or text you. " }, checkboxes: [{ key: "c1", is_required: true }] } } }) as any
  check("POSITIVE CONTROL: a shaped payload maps verbatim (trimmed text, checkbox keys, required flag, policy url)",
    mapped?.disclosureText === "By submitting you agree Alpha Realty may call or text you." && mapped?.checkboxKeys.join() === "c1" && mapped?.requiredCheckbox === true && mapped?.privacyPolicyUrl === "https://alpha.example/privacy")
  G.__150U.graphReply = { ok: false, status: 500, data: null, error: "boom" }
  const failed = await M.fetchMetaLeadFormLegalContent("tok", "form-x")
  check("a Graph failure is a REASON, never a guessed disclosure", !failed.ok && (failed as { error: string }).error === "boom")

  const I = await import("../lib/ads/ad-lead-intake")
  const PAGE = "page-150", FORM = "form-150"
  const fields = (email: string) => [{ name: "first_name", values: ["Dana"] }, { name: "last_name", values: ["Reed"] }, { name: "email", values: [email] }, { name: "phone_number", values: ["+18135550123"] }]
  const cred = [{ id: "pc-1", platform: "facebook", account_id: PAGE, brokerage_id: A, access_token: "tok-plain" }]
  const consentFor = (svc: MemClient, contactId?: string) => rows(svc, "contact_consent_events").filter((e) => e.contact_id === contactId && e.consented !== false)

  // (a) First lead from a form the OS has never seen: fetched, stored UNKNOWN, no consent.
  G.__150U.graph = []; G.__150U.graphReply = { ok: true, status: 200, data: { legal_content: { custom_disclaimer: { body: { text: "Alpha Realty may call or text you about homes." } } } }, error: null }
  const a = seed({ platform_credentials: cred }); G.__150U.svc = a
  const ra = await I.ingestMetaLeadByRef(a as never, { pageId: PAGE, leadgenId: "lg-1", formId: FORM, inlineFields: fields("dana@example.test") })
  const rowA = rows(a, "ad_lead_form_legal_content")[0]
  check("first sight of a form: its legal_content is FETCHED once and STORED with status 'unknown' (the writer), verbatim",
    ra.ok && G.__150U.graph.length === 1 && /legal_content/.test(String(G.__150U.graph[0]?.params?.fields)) && rowA?.legal_content_status === "unknown" && rowA?.disclosure_text === "Alpha Realty may call or text you about homes.", JSON.stringify({ ra, graph: G.__150U.graph.length, rowA }))
  check("UNKNOWN never arms a consent: the person is a contact, with NO consent row and tcpa_consent false",
    consentFor(a, ra.contactId).length === 0 && rows(a, "contacts").find((c) => c.id === ra.contactId)?.tcpa_consent === false, JSON.stringify(consentFor(a, ra.contactId)))
  // (b) The same form after a person verified it against the live form: the verified wording is the consent text. No refetch.
  rowA.legal_content_status = "verified"; rowA.verified_at = "2026-11-06T12:00:00Z"
  G.__150U.graph = []
  const rb = await I.ingestMetaLeadByRef(a as never, { pageId: PAGE, leadgenId: "lg-2", formId: FORM, inlineFields: fields("eli@example.test") })
  const cb = consentFor(a, rb.contactId)
  check("VERIFIED plain disclaimer: the lead's consent rows carry THAT wording (and the form is not re-fetched)",
    rb.ok && G.__150U.graph.length === 0 && cb.length >= 1 && cb.every((e) => e.consent_text === "Alpha Realty may call or text you about homes."), JSON.stringify({ rb, n: cb.length, graph: G.__150U.graph.length }))
  // (c) Verified, but the form has checkboxes: the per-lead answer is not read → no consent.
  const c = seed({ platform_credentials: cred, ad_lead_form_legal_content: [{ id: "lc-1", brokerage_id: A, platform: "facebook", form_id: FORM, legal_content_status: "verified", disclosure_text: "Tick to agree to texts.", checkbox_keys: ["c1"], verified_at: "2026-11-06T12:00:00Z" }] })
  G.__150U.svc = c
  const rc = await I.ingestMetaLeadByRef(c as never, { pageId: PAGE, leadgenId: "lg-3", formId: FORM, inlineFields: fields("fay@example.test") })
  check("VERIFIED but the form asks a CHECKBOX: the person's own answer is not read, so no consent is claimed", rc.ok && consentFor(c, rc.contactId).length === 0)
  // (d) The table is not there yet (m978 unapplied): unreadable → no consent, the lead still lands.
  const d = seed({ platform_credentials: cred }, { refuse: { ad_lead_form_legal_content: "relation does not exist" } }); G.__150U.svc = d
  const rd = await I.ingestMetaLeadByRef(d as never, { pageId: PAGE, leadgenId: "lg-4", formId: FORM, inlineFields: fields("gus@example.test") })
  check("m978 not yet applied: the read is refused → 'unreadable', no consent, the paid lead still lands as a contact", rd.ok && consentFor(d, rd.contactId).length === 0 && rows(d, "contacts").length === 1)
  // (e) A refused credential read is retryable, not 'no_credential'.
  const e = seed({}, { refuse: { platform_credentials: "permission denied" } }); G.__150U.svc = e
  const re = await I.ingestMetaLeadByRef(e as never, { pageId: PAGE, leadgenId: "lg-5", formId: FORM, inlineFields: fields("hal@example.test") })
  check("a REFUSED page-credential read parks as retryable (graph_error), never 'this page is not mapped'", !re.ok && re.stage === "graph_error", JSON.stringify(re))
  const m978 = raw("supabase/migrations/m978-ad-lead-form-legal-content.sql")
  check("m978 is stamped (lane OR applied), its status CHECK holds unknown | verified | not_provided, and 'verified' needs a date and the wording",
    /^-- (WRITTEN, NOT APPLIED \(wave 150, lane 150PU\)|── APPLIED LIVE )/.test(m978) && /CHECK \(legal_content_status IN \('unknown', 'verified', 'not_provided'\)\)/.test(m978) && /legal_content_status <> 'verified' OR \(verified_at IS NOT NULL AND disclosure_text IS NOT NULL\)/.test(m978))
}

async function main() {
  console.log("━━ CONSENT · STOP · UNSUBSCRIBE · SUPPRESSION EVERYWHERE (wave 150, lane 150PU / directive 150U) ━━")
  await section1()
  await section2()
  await section3()
  section4()
  section5()
  await section6()
  console.log(`\nBLIND SPOTS: memSupabase has no CHECK/FK/RLS/partial unique indexes; the Meta Graph call is stubbed and its legal_content field path is UNVERIFIED (WAITING_EXTERNAL: a live form check); routes and forms are stripped-source census; "every send goes through dispatch" is scripts/egress-send-guard-simulator.ts's proof.`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ SUPPRESSION_EVERYWHERE_PASS" : ""}`)
  if (fail) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
