/**
 * scripts/lead-door-guard.ts  (npm run test:lead-door — no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150PU — directive lane 150P: "Lead eligibility/identity gate → existing AI ISA qualification → assigned
 * Contact/history; one consented Contact creator; never message known Contacts via Lead." Canary 4: "Licensed verified owner
 * with complete required identity may become a Lead; … consented tenant form becomes one Contact, portal invitation
 * immediate, welcome video asynchronous."
 *
 * The directive's chain, each link proven on its SURVIVOR (no second door is built — every name below already existed):
 *   §1 GATE     raw → Lead only with a real first AND last name AND a usable email (lib/lead-pipeline/canonical-lead-eligibility.ts);
 *               every `leads` INSERT site in app/ + lib/ is preceded by the predicate (re-derived; scripts/lead-identity-gate-guard.ts
 *               G2 is the full census with its own controls). An email is never fabricated on any contact/lead door.
 *   §2 ISA → ASSIGNMENT → CONTACT  promotion only for an AI-ISA-qualified, agent-assigned, active lead
 *               (lib/contact-promotion/promotion-eligibility.ts), then the lossless creator, the history carry, the welcome —
 *               in that order (promote-lead-to-contact.ts). The creator inherits consent and NEVER mints it from a source name.
 *   §3 THE ONE CONSENTED CREATOR (canary 4) run on memSupabase: a consented form → ONE contact, no lead row; the creator is
 *               recorded and owns it; the portal invite runs FIRST (before the model-drafted welcome), the welcome video is
 *               commissioned LAST; a returning person merges and gets none of the three again; a same-person open lead is
 *               CLOSED onto the contact (no duplicate lead record).
 *   §4 ASSIGNMENT NEVER ON A GUESS — a refused owner / rules read refuses the assignment (the creator's contact is never
 *               routed to someone else because a read failed).
 *   §5 THE C2 BOUNDARY — once contact_id exists the lead is provenance: lead-keyed evaluation refuses, the party is the
 *               contact; a STOP from an open lead's number is written to the lead, a converted lead's to its contact only.
 *   §6 AGENTS NEVER SEE RAW TENANT LEADS — the lead desk roster excludes `agent` (global search is lane 150QTV's; the rule
 *               is handed to it in the lane notes).
 *
 * BLIND SPOTS: memSupabase enforces no CHECK / FK / RLS / generated columns; the HTTP routes are read as stripped source;
 * the real portal invite core, welcome letter and avatar spine are stubbed EFFECTS (their own proofs: test:conversion-welcome,
 * test:welcome-avatar-video); the AI ISA's qualification itself is test:lead-pipeline's.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__150P = { svc: null as MemClient | null, events: [] as any[], minted: 0 }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { globalThis.__150P.minted++; return globalThis.__150P.svc }",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__150P.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__150P.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__150P.events.length, fanOutOk: true, error: null } }; export function asWriteResult(r){ return { data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null, error: null } }",
  "@/lib/kernel/notification-engine": "export async function processKernelEvent(e){ globalThis.__150P.events.push({ fanout: true, ...e }) }",
  "@/lib/enrichment/contact-enrichment-core": "export async function queueContactEnrichment(p){ const s = p.supabase ?? globalThis.__150P.svc; await s.from('lead_enrichment_queue').insert({ contact_id: p.contactId, brokerage_id: p.brokerageId, status: 'pending', trigger_type: p.triggerType }); return { queued: true } }",
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
function bodyOf(code: string, fn: string): string {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*[(<]`).exec(code)
  if (!m) return ""
  const rest = code.slice(m.index + m[0].length)
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[(<]/.exec(rest)
  return code.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length))
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — THE GATE
// ═════════════════════════════════════════════════════════════════════════════
async function section1() {
  console.log("\n§1 — raw → Lead: first AND last name AND a usable email (phone optional); every leads insert is gated; no fabricated email")
  const E = await import("../lib/lead-pipeline/canonical-lead-eligibility")
  check("a licensed verified owner with complete identity (first + last + email) may become a Lead", E.isLeadEligibleIdentity({ first_name: "Maria", last_name: "Gonzalez", email: "maria.g@example.com", phone: "3055550142" }))
  check("a PHONE alone is not a lead (owner wave 85: email required)", !E.isLeadEligibleIdentity({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }))
  check("a first name alone, a placeholder (Current Resident) or an entity (ABC Holdings LLC) is not a lead",
    !E.isLeadEligibleIdentity({ first_name: "Maria", email: "m@example.com" }) && !E.isLeadEligibleIdentity({ first_name: "Current", last_name: "Resident", email: "r@example.com" })
    && !E.isLeadEligibleIdentity({ first_name: "ABC Holdings", last_name: "LLC", email: "abc@example.com" }))
  check("an automated mailbox or a disposable domain is not the email anchor", E.leadEmailProblem("noreply@example.com") === "automated_mailbox" && E.leadEmailProblem("x@mailinator.com") === "disposable_domain")

  // Re-derived census (lead-identity-gate-guard G2 holds the full one): every `leads` insert sits after the predicate.
  const INSERT_RE = /\.from\(\s*(['"`])leads\1\s*\)\s*\.(insert|upsert)\s*\(/g
  const GATE_RE = /\b(evaluateCanonicalLeadEligibility|isLeadEligibleIdentity)\s*\(/
  const ungatedIn = (code: string): number => {
    let n = 0, m: RegExpExecArray | null
    const re = new RegExp(INSERT_RE.source, "g")
    while ((m = re.exec(code))) if (!GATE_RE.test(code.slice(0, m.index))) n++
    return n
  }
  const files = [...walk(join(ROOT, "app"), [".ts", ".tsx"]), ...walk(join(ROOT, "lib"), [".ts", ".tsx"])]
  const sites: string[] = [], ungated: string[] = []
  for (const f of files) {
    const code = blankComments(readFileSync(f, "utf8"))
    const n = (code.match(INSERT_RE) ?? []).length
    if (!n) continue
    sites.push(`${relative(ROOT, f)}×${n}`)
    if (ungatedIn(code) > 0) ungated.push(relative(ROOT, f))
  }
  console.log(`  · ${files.length} files scanned; leads insert sites: ${sites.join(", ") || "(none)"}`)
  check(`every leads INSERT/UPSERT is preceded by THE predicate (${sites.length} files, ${ungated.length} ungated)`, sites.length > 0 && ungated.length === 0, ungated.join(", "))
  check("POSITIVE CONTROL: an ungated insert is counted, a gated one is not, a tombstone naming one is not a site",
    ungatedIn(`await svc.from("leads").insert({ first_name: "x" })`) === 1 && ungatedIn(`if (!isLeadEligibleIdentity(c)) return\nawait svc.from("leads").insert(c)`) === 0
    && (blankComments(`// TOMBSTONE: svc.from("leads").insert(row) stood here\nconst x = 1`).match(INSERT_RE) ?? []).length === 0)

  // NEVER FABRICATE AN EMAIL on a door that creates a person.
  const FAKE_EMAIL = /@(pending\.local|walkin\.open|placeholder\.|noemail\.|example\.invalid)|`[^`]*\$\{[^}]+\}@[a-z0-9.-]+\.(local|open|invalid)`/
  const personFiles = [
    "lib/contact-pipeline/contact-capture.ts", "lib/contact-promotion/contact-creator.ts", "lib/contact-promotion/promote-lead-to-contact.ts",
    "lib/ads/ad-lead-intake.ts", "app/actions/home-value.ts", "app/actions/seller-open-house.ts", "lib/kernel/open-house.ts",
    "app/actions/agent-public-profile.ts", "lib/kernel/lead-magnets.ts", "app/api/widget/live-agent-request/route.ts",
  ].filter((f) => existsSync(join(ROOT, f)))
  const fakers = personFiles.filter((f) => FAKE_EMAIL.test(blankComments(raw(f))))
  check(`NO FABRICATED EMAIL on the ${personFiles.length} person-creating doors (no @pending.local / @walkin.open / templated placeholder addresses)`, fakers.length === 0, fakers.join(", "))
  check("POSITIVE CONTROL: the fabricated-email finder sees the retired shapes", FAKE_EMAIL.test("email: `seller-${id}@pending.local`") && FAKE_EMAIL.test("const e = `${digits}@walkin.open`") && !FAKE_EMAIL.test(`email: params.email ?? null`))
}

// ═════════════════════════════════════════════════════════════════════════════
// §2 — ISA → ASSIGNMENT → CONTACT
// ═════════════════════════════════════════════════════════════════════════════
async function section2() {
  console.log("\n§2 — promotion: qualified by the AI ISA + assigned + active → the lossless creator → history carry → the welcome")
  const P = await import("../lib/contact-promotion/promotion-eligibility")
  const base = { lead_stage: "qualified", agent_id: "agent-1", is_active: true, email: "m@example.com", first_name: "Maria", last_name: "Gonzalez" }
  check("a qualified, assigned, active lead with identity is eligible", (await P.validatePromotionEligibility(base)).isEligible)
  check("NOT YET QUALIFIED by the AI ISA → refused (the ISA is still working it)", !(await P.validatePromotionEligibility({ ...base, lead_stage: "new" })).isEligible)
  check("NO ASSIGNED AGENT → refused", !(await P.validatePromotionEligibility({ ...base, agent_id: null })).isEligible)
  check("POSITIVE CONTROL: an inactive (already converted) lead is refused", !(await P.validatePromotionEligibility({ ...base, is_active: false })).isEligible)

  const promote = src("lib/contact-promotion/promote-lead-to-contact.ts")
  const order = ["if (lead.contact_id)", "validatePromotionEligibility(lead)", "createContactFromLead(", "carryLeadHistoryToContact(", "deactivateLead(", "deliverConversionWelcome("].map((t) => promote.indexOf(t))
  check("promoteLeadToContactService: idempotent on contact_id → eligibility → create → history carry → deactivate → welcome, in that order",
    order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order.join(" < "))

  const creator = src("lib/contact-promotion/contact-creator.ts")
  const tcpa = /tcpa_consent:\s*([^,]+),/.exec(creator)?.[1] ?? ""
  check("CONSENT NEVER FABRICATED at promotion: the contact's tcpa_consent is the lead's own flag and nothing else (no source-name fallback)",
    /data\.lead\.tcpa_consent === true\s*$/.test(tcpa.trim()) && !/includes\(\s*data\.lead\.source/.test(creator), tcpa.trim())
  check("POSITIVE CONTROL: the finder sees the retired source-name fallback", /includes\(\s*data\.lead\.source/.test(`tcpa_consent: data.lead.tcpa_consent === true || ['web_form', 'qr_scan'].includes(data.lead.source ?? ''),`))
  check("the creator CARRIES every suppression flag (email / sms / phone / mail opt-outs, DNC, call stop, the channel list) onto the contact",
    ["email_opt_out", "sms_opt_out", "phone_opt_out", "direct_mail_opt_out", "dnc_status", "call_stop_flag", "opt_out_channels"].every((k) => new RegExp(`${k}:\\s*data\\.lead\\.${k}`).test(creator)))
}

// ═════════════════════════════════════════════════════════════════════════════
// §3 — THE ONE CONSENTED CREATOR (canary 4)
// ═════════════════════════════════════════════════════════════════════════════
const A = "00000000-0000-4000-8000-0000000150aa"
const AGENT_A = "00000000-0000-4000-8000-00000150a001", AGENT_B = "00000000-0000-4000-8000-00000150a002"
function seed(extra: Record<string, any[]> = {}, opts: Record<string, unknown> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: A, name: "Alpha Realty", plan_tier: "brokerage" }],
    agents: [
      { id: AGENT_A, brokerage_id: A, user_id: "u-a1", is_active: true, status: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: AGENT_B, brokerage_id: A, user_id: "u-a2", is_active: true, status: "active", created_at: "2026-01-02T00:00:00Z" },
    ],
    users: [{ id: "u-a1", first_name: "Ann", last_name: "Agent" }],
    qr_codes: [{ id: "qr-a", brokerage_id: A, agent_id: AGENT_A, slug: "spring" }],
    contacts: [], leads: [], contact_consent_events: [], lead_enrichment_queue: [], manager_signals: [], agent_action_ledger: [], lifecycle_events: [],
    manager_completions: [], person_identities: [], person_identity_evidence: [], lead_score_history: [], assignment_rules: [], transactions: [],
    activities: [], notifications: [], contact_suppression_list: [], platform_suppression_list: [], compliance_events: [], teams: [], contact_lead_history: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], contact_consent_events: [["brokerage_id", "idempotency_key"]] }, ...opts } as never)
}

async function section3() {
  console.log("\n§3 — canary 4 on memSupabase: a consented form → ONE contact (no lead), invite FIRST, welcome, video LAST; merge sends none")
  const cap = await import("../lib/contact-pipeline/contact-capture")
  const C = await import("../lib/kernel/compliance/consent-component")
  const OPEN_LEAD = "00000000-0000-4000-8000-0000150ead01"
  const svc = seed({ leads: [{ id: OPEN_LEAD, brokerage_id: A, first_name: "Pat", last_name: "Lee", email: "pat@example.test", is_active: true, contact_id: null, lead_stage: "new" }] })
  G.__150P.svc = null; G.__150P.minted = 0
  const order: string[] = []
  const effects = {
    notify: (async () => {}) as never,
    portalInvite: async (p: { contactId: string }) => { order.push(`invite:${p.contactId}`) },
    welcome: async (_s: unknown, c: { id: string }) => { order.push(`welcome:${c.id}`) },
    welcomeVideo: async (_s: unknown, p: { contactId: string; agentId: string }) => { order.push(`video:${p.contactId}:${p.agentId}`) },
    enrich: async () => { order.push("enrich") },
  }
  const sub = C.consentSubmissionFor({ serviceDelivery: true, marketing: { email: true, sms: false, voice: false, direct_mail: false } }, { door: "qr_landing", brandName: "Alpha Realty" })
  const g = cap.consentGrantsFromComponent(sub, { door: "qr_landing", brandName: "Alpha Realty", provided: { email: true, phone: false } })
  const params = {
    brokerageId: A, ownerAgentId: AGENT_A, creatorUserId: "u-a1", source: "qr_scan", first_name: "Pat", last_name: "Lee", email: "pat@example.test",
    consents: g.grants, intake: { capturedAt: "2026-11-06T10:00:00.000Z", channel: "qr", evidence: { ...g.evidence, qr_code_id: "qr-a" }, formOwner: { table: "qr_codes" as const, id: "qr-a" } },
  }
  const r = await cap.captureConsentedContact(params as never, { client: svc, effects })
  const contacts = rows(svc, "contacts")
  const c = contacts.find((x) => x.id === r.contactId)
  check("ONE contact, created on the injected client, owned by the creating agent, creator recorded (contacts.source_agent_id)",
    r.ok && contacts.length === 1 && c?.agent_id === AGENT_A && c?.source_agent_id === "u-a1" && G.__150P.minted === 0, JSON.stringify({ ok: r.ok, n: contacts.length, agent: c?.agent_id, creator: c?.source_agent_id, minted: G.__150P.minted }))
  check("NO DUPLICATE LEAD RECORD: no lead was written, and the same person's OPEN lead was closed onto the contact (contact_id stamped, deactivated)",
    rows(svc, "leads").length === 1 && rows(svc, "leads")[0].contact_id === r.contactId && rows(svc, "leads")[0].is_active === false && (r.leadsClosed ?? []).includes(OPEN_LEAD),
    JSON.stringify({ leads: rows(svc, "leads").map((l) => ({ c: l.contact_id, a: l.is_active })), closed: r.leadsClosed, w: r.warnings }))
  const iInvite = order.indexOf(`invite:${r.contactId}`), iWelcome = order.indexOf(`welcome:${r.contactId}`), iVideo = order.indexOf(`video:${r.contactId}:${AGENT_A}`)
  check("PORTAL INVITE IMMEDIATE: it ran BEFORE the (model-drafted) welcome and before the enrichment queue", iInvite >= 0 && iInvite < iWelcome && iInvite < order.indexOf("enrich"), order.join(" → "))
  check("WELCOME VIDEO ASYNCHRONOUS: commissioned LAST, for the owning agent, after the portal and the welcome", iVideo > iWelcome && iVideo === order.length - 1, order.join(" → "))
  const sends = () => order.filter((o) => /^(invite|welcome|video):/.test(o)).length
  const n = sends()
  const again = await cap.captureContact({ brokerageId: A, source: "web_form", first_name: "Pat", last_name: "Lee", email: "PAT@example.test", tcpa_consent: false }, { client: svc, effects })
  check("A RETURNING PERSON merges onto the same contact and gets NO second invite, welcome or video", again.action === "merged" && again.contactId === r.contactId && sends() === n && rows(svc, "contacts").length === 1, order.join(","))

  // NEGATIVE CONTROL — the order recorder can see the defect it exists for: a door whose invite effect never runs is seen.
  const order2: string[] = []
  const svc2 = seed()
  await cap.captureContact({ brokerageId: A, ownerAgentId: AGENT_A, source: "web_form", first_name: "Rae", last_name: "Ng", email: "rae@example.test", tcpa_consent: false },
    { client: svc2, effects: { ...effects, portalInvite: async () => { throw new Error("invite core down") }, welcome: async () => { order2.push("welcome") }, welcomeVideo: async () => { order2.push("video") }, enrich: async () => {} } })
  check("POSITIVE CONTROL: an invite that fails does not block the welcome or the video, and the capture stands (best-effort, said)", order2.join(",") === "welcome,video" && rows(svc2, "contacts").length === 1)

  const capSrc = src("lib/contact-pipeline/contact-capture.ts")
  const create = capSrc.slice(capSrc.indexOf("let createAgentId: string | null"))
  check("source shape: on the create path the invite precedes the welcome and the video follows the enrichment queue",
    create.indexOf("await portalInvite(") > 0 && create.indexOf("await portalInvite(") < create.indexOf("bestEffortEffect('client welcome'") && create.indexOf("bestEffortEffect('portal welcome video'") > create.indexOf("bestEffortEffect('enrichment queue'"))
  check("the default video effect is THE one commissioning path (ensureWelcomeAvatarVideo), never a second spine call", /import\('@\/lib\/contact-promotion\/welcome-avatar-video'\)/.test(capSrc) && !/dispatchAssignmentIntroVideo/.test(capSrc))
  check("the owning agent's read for the invite is READ (a refusal is said, never a silent skip)", /agentRead\.error/.test(capSrc) && !/const \{ data: agentRow \} = createAgentId/.test(capSrc))
}

// ═════════════════════════════════════════════════════════════════════════════
// §4 — ASSIGNMENT NEVER ON A GUESS
// ═════════════════════════════════════════════════════════════════════════════
async function section4() {
  console.log("\n§4 — assignment: a refused read refuses; the creator's contact is never routed elsewhere on a guess")
  const CA = await import("../lib/lead-assignment/contact-assignment")
  const ok = await CA.resolveAgentForContact({ brokerageId: A, ownerAgentId: AGENT_B, client: seed() as never })
  check("POSITIVE CONTROL: a readable owner keeps the contact (method owner)", ok.agentId === AGENT_B && ok.method === "owner", JSON.stringify(ok))
  let threw = ""
  try { await CA.resolveAgentForContact({ brokerageId: A, ownerAgentId: AGENT_B, client: seed({}, { refuse: { agents: "permission denied" } }) as never }) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  check("a REFUSED owner read throws with its reason — never a fall-through to load balance (someone else's contact)", /owner agent read refused/.test(threw), threw)
  let threw2 = ""
  try { await CA.resolveAgentForContact({ brokerageId: A, client: seed({}, { refuse: { assignment_rules: "permission denied" } }) as never }) } catch (e) { threw2 = e instanceof Error ? e.message : String(e) }
  check("a REFUSED assignment_rules read throws — 'no rules' is never assumed", /assignment_rules read refused/.test(threw2), threw2)
  const ca = src("lib/lead-assignment/contact-assignment.ts")
  const body = bodyOf(ca, "resolveAgentForContact")
  check("resolveAgentForContact keeps no unread `const { data: x } = await supabase` read", !/const \{ data: \w+ \} = await supabase/.test(body))
}

// ═════════════════════════════════════════════════════════════════════════════
// §5 — THE C2 BOUNDARY
// ═════════════════════════════════════════════════════════════════════════════
async function section5() {
  console.log("\n§5 — once contact_id exists, the lead is provenance: every action continues on the contact")
  const B = await import("../lib/contact-promotion/lead-domain-boundary")
  check("an OPEN lead is in the lead domain; a CONVERTED lead is not", B.isInLeadDomain({ id: "l1", contact_id: null }) && !B.isInLeadDomain({ id: "l1", contact_id: "c1" }))
  const party = B.canonicalPartyFor({ id: "l1", contact_id: "c1" })
  check("a converted lead's party is its CONTACT (lead kept as provenance only)", party.type === "contact" && party.id === "c1" && party.leadId === "l1")
  check("POSITIVE CONTROL: an unreadable row is UNRESOLVED, never 'the lead' (fail closed)", B.canonicalPartyFor(null).type === "unresolved" && !B.isInLeadDomain(null))
  const stop = src("app/api/sms/inbound-optout/route.ts")
  check("the SMS STOP door writes an OPEN lead's STOP through the one writer, and never a converted lead's (`.is('contact_id', null)`)",
    /from\('leads'\)[^\n]*\.is\('contact_id', null\)/.test(stop) && /entityType: 'lead'/.test(stop) && /processOptOutFromVerifiedInbound\(/.test(stop))
}

// ═════════════════════════════════════════════════════════════════════════════
// §6 — AGENTS NEVER SEE RAW TENANT LEADS
// ═════════════════════════════════════════════════════════════════════════════
async function section6() {
  console.log("\n§6 — the lead desk roster: tenant staff + ISA; never the agent seat")
  const lv = src("lib/auth/lead-visibility.ts")
  check("LEAD_DESK_USER_TYPES is DERIVED from the tenant admin roster (+ isa, − compliance_officer) — 'agent' is not in it", /LEAD_DESK_USER_TYPES: ReadonlySet<string> = new Set\(\[/.test(lv) && /TENANT_ADMIN_USER_TYPES/.test(lv) && !/LEAD_DESK_USER_TYPES[^;]*"agent"/.test(lv))
  const R = await import("../lib/auth/resolve-user-role")
  check("POSITIVE CONTROL: the roster it derives from has no agent seat", !(R.TENANT_ADMIN_USER_TYPES as ReadonlySet<string>).has("agent") && (R.TENANT_ADMIN_USER_TYPES as ReadonlySet<string>).has("broker"))
}

async function main() {
  console.log("━━ THE ONE LEAD DOOR → AI ISA → CONTACT (wave 150, lane 150PU / directive 150P) ━━")
  await section1()
  await section2()
  await section3()
  await section4()
  await section5()
  await section6()
  console.log(`\nBLIND SPOTS: memSupabase has no CHECK/FK/RLS/generated columns; routes read as stripped source; the invite core, welcome letter and avatar spine are stubbed effects (test:conversion-welcome, test:welcome-avatar-video); the ISA's qualification itself is test:lead-pipeline's; global-search scoping is lane 150QTV's.`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ LEAD_DOOR_PASS" : ""}`)
  if (fail) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
