#!/usr/bin/env tsx
/**
 * scripts/business-registration-branding-guard.ts   (npm run test:business-registration-branding)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUSINESS REGISTRATION IS A BRANDING SETTING (wave 84, lane 84D — owner
 * verbatim: "add the registration info needed for registration in as a
 * branding setting so that info is pulled for registration.").
 *
 * Proves, by DRIVING the real code against an in-memory database and a
 * simulated Twilio (no network, no DB):
 *   · the carrier loop / step machine PULL the registration from the branding
 *     setting (brokerage_settings.settings.business_registration) through the
 *     ONE reader, and file the tenant's OWN entity type / company type / rep —
 *     not the old hard-coded LLC / private / "Broker";
 *   · a missing field is LISTED by name (and the ring points at the Branding
 *     card), nothing is filed;
 *   · there is NO second store: nothing writes the retired a2p_business_profile
 *     key, only the one module reads the registration key, and resolving the
 *     profile writes nothing;
 *   · the EIN is validated (IRS prefixes), masked to every browser, never logged;
 *   · the port form pulls its LOA details from the same record (typed wins);
 *   · the card's door takes the tenant from the session, gates first, counts writes.
 * Positive controls: each finder is shown to catch a specimen of the defect it
 * guards; a tenant whose facts sit ONLY under the retired key is shown NOT to
 * file (so the loop is reading the branding key, not the old one).
 *
 * Run: npx tsx scripts/business-registration-branding-guard.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import {
  normalizeEin, maskEin, isHttpUrl, normalizeUsPhone, validateBusinessRegistrationInput, readBusinessRegistration,
  redactDraftForClient, loadBusinessRegistrationSources, pickRepresentative,
  BUSINESS_REGISTRATION_SETTINGS_KEY, BUSINESS_REGISTRATION_SETTINGS_PATH, BUSINESS_REGISTRATION_SETTINGS_LABEL,
  REGISTRATION_BUSINESS_TYPES,
} from "../lib/branding/business-registration"
import { deriveA2pProfile, resolveA2pProfile, runA2pRegistration, tollfreeBusinessType, type TwilioTransport } from "../lib/voice/a2p-registration"
import { advanceTenantCarrier } from "../lib/voice/carrier-registration-loop"
import { portInPrefillFromRegistration, fillPortInFromRegistration } from "../lib/voice/number-port-in"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const code = (p: string) => stripComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── In-memory database (the supabase-js surface these paths use) ─────────────
type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  const writes: Array<{ table: string; op: string }> = []
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" = "select"
    let patch: Row | null = null
    let newRow: Row | null = null
    let lim = Infinity
    const q: any = {}
    q.select = () => q
    q.order = () => q
    q.limit = (n: number) => { lim = n; return q }
    q.eq = (k: string, v: any) => { preds.push((r) => r[k] === v); return q }
    q.in = (k: string, vs: any[]) => { preds.push((r) => vs.includes(r[k])); return q }
    q.is = (k: string, v: any) => { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return q }
    q.not = (k: string, _op: string, v: any) => {
      if (k.includes("->")) { const [c, key] = k.split("->"); preds.push((r) => r[c]?.[key] != null) }
      else preds.push((r) => (v === null ? r[k] != null : r[k] !== v))
      return q
    }
    q.insert = (row: Row) => { op = "insert"; newRow = { id: `${table}-${++seq}`, ...row }; return q }
    q.update = (p: Row) => { op = "update"; patch = p; return q }
    const run = () => {
      const t = (tables[table] ??= [])
      if (op === "insert") { t.push(newRow!); writes.push({ table, op }); return { data: [newRow], error: null } }
      const hits = t.filter((r) => preds.every((p) => p(r)))
      if (op === "update") { hits.forEach((r) => Object.assign(r, patch)); writes.push({ table, op }); return { data: hits.map((r) => ({ id: r.id })), error: null } }
      return { data: JSON.parse(JSON.stringify(hits.slice(0, lim))), error: null }
    }
    q.maybeSingle = async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: r.error } }
    q.single = q.maybeSingle
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return q
  }
  return { tables, writes, from } as any
}

// ── Simulated Twilio: records every EndUser's attributes and every filing body ──
function fakeTwilio() {
  const endUsers: Array<{ type: string; attributes: any }> = []
  const bodies: Array<{ path: string; body: any }> = []
  const t: TwilioTransport = async ({ method, path, body }) => {
    bodies.push({ path, body })
    const ok = (data: any) => ({ ok: true, status: 200, data, error: null })
    if (method === "POST" && path === "/v1/CustomerProfiles") return ok({ sid: "BU_cp" })
    if (method === "POST" && path === "/v1/TrustProducts") return ok({ sid: "BU_tp" })
    if (method === "POST" && path === "/v1/EndUsers") { endUsers.push({ type: String(body?.Type), attributes: JSON.parse(String(body?.Attributes ?? "{}")) }); return ok({ sid: `IT_${endUsers.length}` }) }
    if (method === "POST" && path.endsWith("/Addresses.json")) return ok({ sid: "AD_1" })
    if (method === "POST" && path === "/v1/SupportingDocuments") return ok({ sid: "RD_1" })
    if (path.endsWith("/EntityAssignments")) return ok({ sid: "BV_1" })
    if (path.endsWith("/Evaluations")) return ok({ status: "compliant" })
    if (method === "POST" && /^\/v1\/(CustomerProfiles|TrustProducts)\/BU_/.test(path)) return ok({ status: "pending-review" })
    if (method === "POST" && path === "/v1/a2p/BrandRegistrations") return ok({ sid: "BN_1", status: "PENDING" })
    if (method === "GET" && path === "/v1/a2p/BrandRegistrations/BN_1") return ok({ status: "PENDING" })
    if (method === "POST" && path === "/v1/Services") return ok({ sid: "MG_1" })
    if (method === "POST" && path === "/v1/Services/MG_1/PhoneNumbers") return ok({ sid: "PN" })
    return { ok: false, status: 404, data: null, error: `unscripted ${method} ${path}` }
  }
  return { transport: t, endUsers, bodies }
}
const deps = (tw: ReturnType<typeof fakeTwilio>) => ({
  carrier: { transport: tw.transport, master: { accountSid: "AC_master", authToken: "x" }, tenantCreds: async () => ({ accountSid: "AC_sub", authToken: "y", tier: "subaccount" }) },
  port: { creds: null },
})

const BROKERAGE = { id: "b1", name: "Kling Realty Group Inc", dba: "Kling Group", address: "100 Congress Ave", address_line2: "Suite 400", city: "Austin", state: "TX", zip: "78701", phone: "+15125550100", email: "office@kling.example", website: "https://kling.example", slug: "kling-ab12" }
const OWNER = { id: "u-owner", brokerage_id: "b1", user_type: "broker_owner", first_name: "Dana", last_name: "Kling", email: "dana@kling.example", phone: "+15125550111", deleted_at: null }
const REG = {
  ein: "741234567", businessType: "Corporation", industry: "REAL_ESTATE", regionsOfOperation: "USA_AND_CANADA", companyType: "private",
  privacyPolicyUrl: "https://kling.example/privacy", termsUrl: "https://kling.example/terms",
  repFirstName: "Pat", repLastName: "Lee", repTitle: "Chief Operating Officer", repJobPosition: "VP", repEmail: "pat@kling.example", repPhone: "+15125550122",
}
function tenantDb(settings: Record<string, unknown> | null) {
  return fakeDb({
    brokerages: [{ ...BROKERAGE }],
    users: [{ ...OWNER }],
    brokerage_settings: settings === null ? [] : [{ id: "bs1", brokerage_id: "b1", settings }],
    tenant_phone_numbers: [{ id: "n1", brokerage_id: "b1", phone_number: "+15125551212", twilio_number_sid: "PN_1", is_active: true }],
    platform_credentials: [], phone_number_events: [], notifications: [],
  })
}

/** Every .ts/.tsx file under app/ and lib/ (the code this proof judges). */
function codeFiles(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(join(root, d))) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const rel = `${d}/${n}`
      const st = statSync(join(root, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(n)) out.push(rel)
    }
  }
  walk("app"); walk("lib")
  return out
}

async function main() {
  // ── 0 · controls on the finders ─────────────────────────────────────────────
  console.log("\n[0 · positive controls — every finder catches the defect it guards]")
  const stripCtl = stripComments('const a = 1 // a note with a /* and a "business_registration" in it\nconst b = 2')
  check("CONTROL: strip-comments keeps code after a // line containing /* (the recurring defect)", /const b = 2/.test(stripCtl) && !/business_registration/.test(stripCtl))
  const legacyWrite = /a2p_business_profile\s*:/
  check("CONTROL: the legacy-store writer finder catches `{ ...settings, a2p_business_profile: v }`", legacyWrite.test("const next = { ...settings, a2p_business_profile: v.value }"))
  // Two halves: the exact quoted key (read on comment-stripped code, strings
  // intact) and a property access (read with strings BLANKED, so registry prose
  // that names "settings.business_registration" is not a call site — §2).
  const keyQuoted = /["'`]business_registration["'`]/
  const keyDotted = /\.business_registration\b/
  const readsKey = (text: string) => keyQuoted.test(text) || keyDotted.test(blankStrings(text))
  check("CONTROL: the second-reader finder catches `settings.business_registration` and a bracket read", readsKey("const r = s.settings.business_registration") && readsKey('s["business_registration"]'))
  check("CONTROL: …and does NOT count prose inside a string (`\"…settings.business_registration…\"`) or the `_loop` domain key", !readsKey('const what = "stored under settings.business_registration"') && !readsKey("business_registration_loop: {}"))
  const einLog = /console\.(log|warn|error|info|debug)\([^;\n]*\bein\b/i
  check("CONTROL: the EIN-logging finder catches `console.log(\"saving\", profile.ein)`", einLog.test('console.log("saving", profile.ein)'))
  const einInput = /key:\s*["']ein["']/
  check("CONTROL: the typed-EIN-on-the-phone-card finder catches a field list entry `{ key: \"ein\" }`", einInput.test('{ key: "ein", label: "EIN (9 digits)" }'))

  // ── 1 · validation (pure) ───────────────────────────────────────────────────
  console.log("\n[1 · EIN, URL and phone validation — the one set of validators]")
  check("EIN 74-1234567 and 741234567 both normalize to 9 digits", (normalizeEin("74-1234567") as any).value === "741234567" && (normalizeEin("741234567") as any).value === "741234567")
  check("EIN with an unassigned IRS prefix (00, 07, 89, 96) is refused", ["00-1234567", "07-1234567", "89-1234567", "96-1234567"].every((e) => !normalizeEin(e).ok))
  check("EIN of 8 digits / letters / one repeated digit is refused", !normalizeEin("12-345678").ok && !normalizeEin("AB-1234567").ok && !normalizeEin("11-1111111").ok)
  check("a refused EIN's message never echoes the number", !JSON.stringify(normalizeEin("07-7654321")).includes("7654321"))
  check("maskEin shows the last four only", maskEin("741234567") === "••-•••4567" && !maskEin("741234567").includes("74123"))
  check("URLs: https://x.example ok; bare domain, javascript:, no TLD refused", isHttpUrl("https://kling.example/privacy") && !isHttpUrl("kling.example") && !isHttpUrl("javascript:alert(1)") && !isHttpUrl("https://localhost"))
  check("US phones normalize to E.164; 7 digits refused", normalizeUsPhone("(512) 555-0100") === "+15125550100" && normalizeUsPhone("555-0100") === null)
  {
    const keep = validateBusinessRegistrationInput({ businessType: "Corporation" }, { ein: "741234567" })
    check("a BLANK EIN on save keeps the EIN on file (the card only ever shows it masked)", keep.ok && keep.value.ein === "741234567")
    const bad = validateBusinessRegistrationInput({ ein: "00-1", businessType: "LLC", privacyPolicyUrl: "kling.example", repEmail: "nope", repPhone: "12" }, {})
    check("every problem is listed at once (EIN, business type vocabulary, URL, e-mail, phone)", !bad.ok && bad.errors.length === 5, !bad.ok ? bad.errors.join(" | ") : "ok")
    const pub = validateBusinessRegistrationInput({ companyType: "public" }, {})
    check("a PUBLIC company must name its stock exchange + ticker", !pub.ok && pub.errors.some((e) => /exchange/i.test(e)) && pub.errors.some((e) => /ticker/i.test(e)))
    const priv = validateBusinessRegistrationInput({ companyType: "private", stockExchange: "NYSE", stockTicker: "KLG" }, {})
    check("a non-public company's stock fields are DROPPED (Twilio 30796: omit unless public)", priv.ok && !priv.value.stockExchange && !priv.value.stockTicker)
  }

  // ── 2 · the derivation pulls from the branding setting ───────────────────────
  console.log("\n[2 · the filing profile is PULLED from the branding setting]")
  {
    const d = deriveA2pProfile({ registration: REG, brokerage: BROKERAGE, owner: OWNER, appUrl: "https://app.example" })
    check("registration record + brokerages row = a COMPLETE profile", d.validation.ok)
    const v = d.validation.ok ? d.validation.value : null
    check("identity comes from the brokerages row (legal name, DBA as brand, address incl. suite, support line)", !!v && v.legalName === BROKERAGE.name && v.brandName === "Kling Group" && v.street2 === "Suite 400" && v.supportPhone === BROKERAGE.phone && d.sources.legalName === "brokerage")
    check("the authorized representative on the record WINS over the owner seat", !!v && v.contactFirstName === "Pat" && v.contactJobPosition === "VP" && v.contactTitle === "Chief Operating Officer" && d.sources.contactFirstName === "registration")
    const noRep = deriveA2pProfile({ registration: { ...REG, repFirstName: "", repLastName: "", repTitle: "", repEmail: "", repPhone: "", repJobPosition: "" }, brokerage: BROKERAGE, owner: OWNER })
    check("a blank representative falls back to the owner seat (title from the seat, job position defaulted)", noRep.validation.ok && noRep.validation.value.contactFirstName === "Dana" && noRep.sources.contactFirstName === "owner_seat" && noRep.validation.value.contactTitle === "Broker / Owner" && noRep.sources.contactJobPosition === "default")
    const empty = deriveA2pProfile({ registration: null, brokerage: BROKERAGE, owner: OWNER })
    const miss = empty.validation.ok ? [] : empty.validation.missing
    check("with NO registration record, the missing list names EIN, business type, privacy and terms", ["EIN", "Business type", "Privacy", "Terms"].every((w) => miss.some((m) => m.includes(w))), miss.join(" | "))
    check("…and names NOTHING the brokerages row / owner seat / defaults already hold (no name, address, rep, industry)", miss.length === 4 && !miss.some((m) => /Legal business name|Street|City|representative|Industry|Regions|Company type/.test(m)), miss.join(" | "))
    const noTerms = deriveA2pProfile({ registration: { ...REG, termsUrl: "" }, brokerage: BROKERAGE, owner: OWNER })
    check("a single missing field is listed by name (terms URL removed → 'Terms & conditions URL')", !noTerms.validation.ok && noTerms.validation.missing.length === 1 && /Terms/.test(noTerms.validation.missing[0]))
    check("the EIN / entity type are NEVER derived from anything but the registration record", empty.sources.ein === undefined && empty.sources.businessType === undefined)
    check("redactDraftForClient masks the EIN and keeps the rest", redactDraftForClient(d.draft).ein === "••-•••4567" && redactDraftForClient(d.draft).legalName === BROKERAGE.name)
    check("pickRepresentative prefers broker_owner over admin", pickRepresentative([{ user_type: "admin", first_name: "A" }, { user_type: "broker_owner", first_name: "B" }])?.first_name === "B")
    check("toll-free BusinessType follows the record (public → PUBLIC_PROFIT, sole prop → SOLE_PROPRIETOR, private → PRIVATE_PROFIT)",
      tollfreeBusinessType({ businessType: "Corporation", companyType: "public" }) === "PUBLIC_PROFIT" && tollfreeBusinessType({ businessType: "Sole Proprietorship", companyType: "private" }) === "SOLE_PROPRIETOR" && tollfreeBusinessType({ businessType: "Limited Liability Corporation", companyType: "private" }) === "PRIVATE_PROFIT")
  }

  // ── 3 · the loop reads branding; the runner files the tenant's own answers ──
  console.log("\n[3 · the carrier loop PULLS from branding and files the tenant's own answers]")
  {
    const db = tenantDb({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: REG })
    const tw = fakeTwilio()
    const r = await advanceTenantCarrier(db, "b1", deps(tw))
    check("with the branding setting complete, the hourly tick files with NO typing on the phone page", r.ran.includes("10dlc") && tw.bodies.some((b) => b.path === "/v1/CustomerProfiles"))
    const biz = tw.endUsers.find((e) => e.type === "customer_profile_business_information")?.attributes ?? {}
    check("business_type filed = the tenant's answer ('Corporation'), not the old hard-coded LLC", biz.business_type === "Corporation")
    check("the EIN filed is the branding setting's (digits only)", biz.business_registration_number === "741234567")
    const rep = tw.endUsers.find((e) => e.type === "authorized_representative_1")?.attributes ?? {}
    check("the authorized representative filed = the record's (name, title, job position) — not the hard-coded 'Broker' / 'Director'", rep.first_name === "Pat" && rep.business_title === "Chief Operating Officer" && rep.job_position === "VP")
    const msg = tw.endUsers.find((e) => e.type === "us_a2p_messaging_profile_information")?.attributes ?? {}
    check("company_type filed from the record, and a private brand carries NO stock fields", msg.company_type === "private" && !("stock_ticker" in msg) && !("stock_exchange" in msg))
    const addr = tw.bodies.find((b) => b.path.endsWith("/Addresses.json"))?.body ?? {}
    check("the address filed carries the suite from the brokerages row (StreetSecondary)", addr.StreetSecondary === "Suite 400" && addr.CustomerName === BROKERAGE.name)
    check("no settings write happened on the way (the 83D derived-copy persist is retired — one store)", !db.writes.some((w: any) => w.table === "brokerage_settings"))
  }
  {
    const pubReg = { ...REG, companyType: "public", stockExchange: "NASDAQ", stockTicker: "KLG" }
    const db = tenantDb({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: pubReg })
    const tw = fakeTwilio()
    await runA2pRegistration(db, "b1", { deps: deps(tw).carrier })
    const msg = tw.endUsers.find((e) => e.type === "us_a2p_messaging_profile_information")?.attributes ?? {}
    check("a PUBLIC brand files its exchange + ticker + a brand contact e-mail (TCR 2FA)", msg.company_type === "public" && msg.stock_exchange === "NASDAQ" && msg.stock_ticker === "KLG" && msg.brand_contact_email === "pat@kling.example")
  }
  {
    const db = tenantDb({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: { ...REG, ein: "", termsUrl: "" } })
    const tw = fakeTwilio()
    const r = await advanceTenantCarrier(db, "b1", deps(tw))
    check("a missing EIN + terms → needs_input naming exactly those, ZERO Twilio calls", r.after === "needs_input" && r.needs.length === 2 && r.needs.some((n) => /EIN/.test(n)) && r.needs.some((n) => /Terms/.test(n)) && tw.bodies.length === 0, r.needs.join(" | "))
    const bell = db.tables.notifications.find((n: Row) => n.type === "carrier_registration")
    check("the ring points the tenant at the Branding card (label + path), not the phone page", !!bell && bell.body.includes(BUSINESS_REGISTRATION_SETTINGS_LABEL) && bell.body.includes(BUSINESS_REGISTRATION_SETTINGS_PATH))
  }
  {
    // POSITIVE CONTROL: the same complete facts under the RETIRED key are NOT read.
    const db = tenantDb({ a2p_business_profile: { ...REG, legalName: BROKERAGE.name } })
    const tw = fakeTwilio()
    const r = await advanceTenantCarrier(db, "b1", deps(tw))
    check("CONTROL: facts only under the retired a2p_business_profile key do NOT file (the loop reads the branding key)", r.after === "needs_input" && tw.bodies.length === 0)
  }
  {
    const refused = { ...tenantDb({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: REG }) }
    const inner = refused.from
    refused.from = (t: string) => {
      const q = inner(t)
      if (t !== "brokerage_settings") return q
      q.maybeSingle = async () => ({ data: null, error: { message: "permission denied" } })
      return q
    }
    const res = await resolveA2pProfile(refused, "b1")
    check("a REFUSED settings read is a refusal (named), never 'please type your EIN'", !res.ok && res.missing.length === 1 && /could not be read/.test(res.missing[0]))
    const src2 = await loadBusinessRegistrationSources(tenantDb({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: REG }), "b1")
    check("the ONE reader returns the record, the brokerages row and the representative seat", src2.ok && src2.registration.ein === "741234567" && src2.brokerage?.name === BROKERAGE.name && src2.owner?.first_name === "Dana")
  }

  // ── 4 · no second store ─────────────────────────────────────────────────────
  console.log("\n[4 · no second store — one writer per fact, one reader]")
  const files = codeFiles()
  const legacyWriters = files.filter((f) => legacyWrite.test(blankStrings(code(f)).replace(/\s+/g, " ")) || /a2p_business_profile\s*:/.test(code(f)))
  check(`no code under app/ or lib/ writes the retired a2p_business_profile key (${files.length} files scanned, comments stripped)`, legacyWriters.length === 0, legacyWriters.join(", "))
  const KEY_OWNERS = new Set(["lib/branding/business-registration.ts"])
  const secondReaders = files.filter((f) => !KEY_OWNERS.has(f) && readsKey(code(f)))
  check("the registration key is spelled in exactly ONE module — every other file goes through its constant / reader", secondReaders.length === 0, secondReaders.join(", "))
  const readerCallers = files.filter((f) => /\bloadBusinessRegistrationSources\s*\(|\bresolveA2pProfile\s*\(/.test(code(f)))
  check("the step machine, the loop's kick, the port door, the A2P card and the Branding card all pull through the one reader", ["lib/voice/a2p-registration.ts", "app/actions/phone-port-in.ts", "app/actions/a2p-registration.ts", "app/actions/settings/business-registration.ts"].every((f) => readerCallers.includes(f)), readerCallers.join(", "))
  check("lib/voice/a2p-registration.ts no longer queries brokerage_settings itself (the profile read moved to the one reader)", !/from\(\s*["']brokerage_settings["']\s*\)/.test(code("lib/voice/a2p-registration.ts")))
  const a2pAction = code("app/actions/a2p-registration.ts")
  check("saveA2pBusinessProfileAction is GONE and its tombstone names the survivor", !/export\s+async\s+function\s+saveA2pBusinessProfileAction/.test(a2pAction) && /saveA2pBusinessProfileAction[\s\S]{0,400}business-registration\.ts:saveBusinessRegistrationAction/.test(src("app/actions/a2p-registration.ts")))
  const phoneCard = code("app/dashboard/admin/phone-settings/a2p-card.tsx")
  check("the phone-settings A2P card has no typed EIN / profile form any more and links to the Branding card", !einInput.test(phoneCard) && !/saveA2pBusinessProfileAction/.test(phoneCard) && /settingsPath/.test(phoneCard))
  const idWriter = code("app/actions/settings/brokerage-identity.ts")
  check("the brokerages row keeps ONE writer: website / phone / email joined updateBrokerageIdentity's allow-list", /BROKERAGE_IDENTITY_FIELDS\s*=\s*\[[\s\S]*'website',\s*'phone',\s*'email',[\s\S]*?\]\s*as const/.test(idWriter))
  const regAction = code("app/actions/settings/business-registration.ts")
  check("…and the Branding card's door writes the row ONLY through it (no direct brokerages update)", /updateBrokerageIdentity\(/.test(regAction) && !/from\(\s*["']brokerages["']\s*\)/.test(regAction))

  // ── 5 · EIN never leaves unmasked, never logged ─────────────────────────────
  console.log("\n[5 · the EIN — masked to every browser, never logged]")
  const einFiles = ["lib/branding/business-registration.ts", "lib/voice/a2p-registration.ts", "lib/voice/carrier-registration-loop.ts", "lib/voice/number-port-in.ts", "app/actions/a2p-registration.ts", "app/actions/phone-port-in.ts", "app/actions/settings/business-registration.ts", "app/actions/settings/brokerage-identity.ts", "app/components/settings/BusinessRegistrationCard.tsx", "app/dashboard/admin/phone-settings/a2p-card.tsx", "app/dashboard/admin/phone-settings/pick-or-port-card.tsx"]
  const loggers = einFiles.filter((f) => einLog.test(code(f)))
  check(`no console call in the ${einFiles.length} registration files mentions an EIN`, loggers.length === 0, loggers.join(", "))
  const einUses = code("lib/voice/a2p-registration.ts").split("\n").filter((l) => /profile\.ein\b/.test(l))
  check("profile.ein appears ONLY in the two carrier filing payload fields (never in an error or status line)", einUses.length === 2 && einUses.every((l) => /business_registration_number:\s*profile\.ein|BusinessRegistrationNumber:\s*profile\.ein/.test(l)), einUses.join(" || "))
  check("the A2P status read hands the card a REDACTED draft", /prefill:\s*redactDraftForClient\(/.test(a2pAction))
  check("the Branding door strips the EIN from the record it returns and sends only einMasked", /const\s*\{\s*ein,\s*\.\.\.registration\s*\}\s*=\s*src\.registration/.test(regAction) && /einMasked:\s*maskEin\(ein\)/.test(regAction))
  check("the port-in prefill never carries the EIN", !("ein" in portInPrefillFromRegistration({ ein: "741234567", legalName: "X" })))

  // ── 6 · the door: session tenant, gate first, counted writes ─────────────────
  console.log("\n[6 · the Branding door — session tenant, gate first, counted writes]")
  check("\"use server\" file whose every export is async", /^\s*["']use server["']/.test(src("app/actions/settings/business-registration.ts")) && !/export\s+(?!async\s+function|interface|type)\w/.test(blankStrings(regAction)))
  for (const fn of ["getBusinessRegistrationAction", "saveBusinessRegistrationAction"]) {
    const body = regAction.slice(regAction.indexOf(`export async function ${fn}`))
    const gateAt = body.indexOf("await gate(")
    const svcAt = body.indexOf("createServiceClient(")
    check(`${fn}: gate() runs BEFORE the service client`, gateAt > 0 && svcAt > gateAt)
  }
  check("the gate resolves the tenant from the SESSION (acting-context) and the finance-admin predicate (role grants included), failing closed", /resolveWriteContext\(\)/.test(regAction) && /resolveActingContext\(\)/.test(regAction) && /resolveBrokerageFinanceAdmin\(/.test(regAction) && /if \(!admin\.ok\) return \{ ok: false/.test(regAction))
  check("no brokerageId is ever read from the payload", !/input\??\.\s*brokerage/i.test(regAction) && !/identity\??\.\s*brokerage/i.test(regAction))
  check("the settings write is counted (.select(\"id\")) and zero rows is a refusal", (regAction.match(/\.select\("id"\)/g) ?? []).length >= 2 && /write\.data\.length === 0/.test(regAction))
  check("the update pins the tenant as well as the row id", /\.eq\("id", src\.settingsRowId\)\.eq\("brokerage_id", g\.brokerageId\)/.test(regAction))
  const page = code("app/settings/branding/page.tsx")
  check("the Business registration card is mounted on the Branding settings page", /<BusinessRegistrationCard\s*\/>/.test(page))
  check("the card's anchor matches the path every 'needs input' message links to", code("app/components/settings/BusinessRegistrationCard.tsx").includes(`id="${BUSINESS_REGISTRATION_SETTINGS_PATH.split("#")[1]}"`) && BUSINESS_REGISTRATION_SETTINGS_PATH.startsWith("/settings/branding"))
  check("the card offers exactly the TrustHub business types (one vocabulary)", /options:\s*REGISTRATION_BUSINESS_TYPES/.test(code("app/components/settings/BusinessRegistrationCard.tsx")) && REGISTRATION_BUSINESS_TYPES.includes("Limited Liability Corporation" as any))

  // ── 7 · the port form pulls from the same record ─────────────────────────────
  console.log("\n[7 · the port form pulls its LOA details from the registration]")
  {
    const draft = deriveA2pProfile({ registration: REG, brokerage: BROKERAGE, owner: OWNER }).draft
    const pre = portInPrefillFromRegistration(draft)
    check("prefill = legal name, representative, e-mail and service address from the one record", pre.customerName === BROKERAGE.name && pre.authorizedRepresentative === "Pat Lee" && pre.authorizedRepresentativeEmail === "pat@kling.example" && pre.street2 === "Suite 400" && pre.zip === "78701")
    const merged = fillPortInFromRegistration({ customerName: "Kling Realty (Verizon acct)", city: "" }, pre)
    check("what the person TYPED wins (the LOA must match the losing carrier); every blank is pulled", merged.customerName === "Kling Realty (Verizon acct)" && merged.city === "Austin" && merged.authorizedRepresentative === "Pat Lee")
    const door = code("app/actions/phone-port-in.ts")
    check("the port door fills blanks server-side from the same derivation before validating", /fillPortInFromRegistration\(typed,\s*portInPrefillFromRegistration\(\(await resolveA2pProfile\(svc, auth\.brokerageId\)\)\.draft\)\)/.test(door) && /submitPortIn\(svc, auth\.brokerageId, input,/.test(door))
    check("the port card shows the pulled details as defaults", /defaultValue=\{prefill\.customerName/.test(code("app/dashboard/admin/phone-settings/pick-or-port-card.tsx")))
  }

  // ── 8 · registration of this proof ──────────────────────────────────────────
  console.log("\n[8 · wiring]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:business-registration-branding after test:scrapers (ordering)", typeof pkg.scripts["test:business-registration-branding"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:business-registration-branding"))
  const dom = (MAINTENANCE_DOMAINS as any).business_registration_branding
  check("MAINTENANCE_DOMAINS.business_registration_branding names this proof and its co-owners", dom?.proof === "test:business-registration-branding" && Array.isArray(dom?.coOwners) && dom.coOwners.length > 0)
  check("readBusinessRegistration ignores non-string / unknown keys", Object.keys(readBusinessRegistration({ [BUSINESS_REGISTRATION_SETTINGS_KEY]: { ein: 5, evil: "x", termsUrl: " https://a.example/t " } })).join() === "termsUrl")

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
void relative
