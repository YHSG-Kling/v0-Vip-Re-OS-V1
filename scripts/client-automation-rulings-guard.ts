/**
 * scripts/client-automation-rulings-guard.ts — `npm run test:client-automation-rulings`
 *
 * Wave 94, lane 94A. Four owner rulings, each held as a RULE against the REAL functions
 * (in-memory database, module edges stubbed — no network, no live rows):
 *
 *   R1 "a portal invite is all part of the automation when a new contact or a converted
 *      contact is added." — ONE automatic invite on BOTH doors (the new-contact command
 *      lib/kernel/crm.ts createContactManually and the converters, through
 *      lib/contact-promotion/conversion-welcome.ts deliverConversionWelcome), email
 *      channel, ONE invite per contact, never for a lead, and a contact with NO email
 *      queues NOTHING and is reported.
 *   R2 NO duplicate notification to the same person on offer acceptance or on closing —
 *      a replay of the accept and close fan-outs counts alerts per recipient.
 *   R3 "on a dual, the seller should see both the seller and buyer layout and seller sees
 *      the seller's layout which the kernel determines the portal layout" — every portal
 *      surface asks the kernel's resolvePortalLayouts; the lifetime view finds the deal on
 *      ANY side the client was on.
 *   R4 an offer with no AI-read price never reads "$0" / "TBD" to a client — one helper,
 *      "price pending review".
 *
 * Every absence claim carries a POSITIVE CONTROL (the finder recognises the defect it was
 * written for). Scans read STRIPPED source (scripts/strip-comments.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ── MODULE EDGES ONLY ────────────────────────────────────────────────────────
const G = globalThis as any
G.__94A = { svc: null as MemClient | null, welcomes: [] as string[], emits: [] as string[] }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__94A.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__94A.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
}
const STUB_BY_PATH: Array<[RegExp, string]> = [
  [/\/lib\/kernel\/event-reactor\.ts$/, "export const dispatchKernelEvent = async () => {}"],
  [/\/lib\/kernel\/emit\.ts$/, "export const emitKernelEvent = async (p) => { globalThis.__94A.emits.push(p.event); return {} }"],
  [/\/lib\/enrichment\/contact-enrichment-core\.ts$/, "export const queueContactEnrichment = async () => ({ queued: false })"],
  [/\/lib\/video\/avatar-render-orchestrator\.ts$/, "export const COMPOSITE_WAIT_MS = 7200000"],
  // R8 (wave 98): the governed egress is the EDGE — the stub records each dispatch and emulates the
  // 97A ledger's cycle idempotency (tenant:contact:id:action:cycle → a second call REPLAYS, no send).
  // The real ledger replay is proven by its own proof (test:action-ledger); here we prove the delivery
  // hands it a STABLE cycle. Outside R8 (no recorder armed) it refuses, like an unconfigured provider.
  [/\/lib\/providers\/dispatch\.ts$/, [
    "export async function dispatchEmail(p) { const g = globalThis.__94A;",
    "  if (!g.emails) return { success: false, providerKey: 'stub', error: 'no provider in this proof' };",
    "  const key = p.ledger && p.ledger.cycle ? [p.brokerageId, 'contact', p.contactId, 'comms.email.send', p.ledger.cycle].join(':') : null;",
    "  const replay = !!key && g.ledgerKeys.has(key); if (key) g.ledgerKeys.add(key);",
    "  g.emails.push({ ...p, sent: !replay }); return { success: true, providerKey: replay ? 'action_ledger' : 'stub' } }",
    "export async function dispatchSms() { return { success: false, providerKey: 'stub', error: 'no provider in this proof' } }",
  ].join("\n")],
  [/\/lib\/ai-isa\/video-generator\.ts$/, "export async function embedVideoInEmail(h, u) { return h.replace('[Video will be embedded here]', String(u)) }"],
  [/\/lib\/contact-promotion\/welcome-avatar-video\.ts$/,
    "export const ensureWelcomeAvatarVideo = async () => ({ commissioned: false, reason: 'agent_not_video_ready', warnings: [] })"],
  // The welcome EMAIL is the edge: the invite under test is the grant that precedes it.
  // resolveWelcomeManagers keeps the real routing (seller/buyer/both → a manager; lifetime → none).
  [/\/lib\/kernel\/client-welcome\.ts$/, [
    "export function resolveWelcomeManagers(t) { t = String(t ?? '').toLowerCase();",
    "  if (!t || t === 'vendor' || t === 'referral_partner' || t === 'lifetime_customer' || t === 'past_client') return [];",
    "  if (t === 'both') return ['listing_concierge','shopping_agent'];",
    "  if (t.includes('seller')) return ['listing_concierge']; if (t.includes('buyer')) return ['shopping_agent']; return [] }",
    "export function welcomeJourneyFor(m) { const s = m.includes('listing_concierge'), b = m.includes('shopping_agent'); return s && b ? 'both' : s ? 'seller' : b ? 'buyer' : null }",
    "export const ensureClientWelcome = async (_svc, c) => { globalThis.__94A.welcomes.push(c.id); return { state: 'sent', situationWarnings: [] } }",
  ].join("\n")],
]
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const bySpec = STUB_BY_SPEC[spec]
    if (bySpec !== undefined) return { url: `data:text/javascript,${encodeURIComponent(bySpec)}`, shortCircuit: true }
    const r = next(spec, ctx)
    for (const [re, body] of STUB_BY_PATH) if (re.test(r.url ?? "")) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return r
  },
})

// ── THE WORLD ────────────────────────────────────────────────────────────────
const BRK = "b0000000-0000-4000-8000-000000000094"
const AGENT = "a0000000-0000-4000-8000-000000000094"
const AGENT_USER = "a1000000-0000-4000-8000-000000000094"
const TC_USER = "a2000000-0000-4000-8000-000000000094"
const BROKER_USER = "a3000000-0000-4000-8000-000000000094"
const C_MAIL = "c0000000-0000-4000-8000-000000000001"
const C_NOMAIL = "c0000000-0000-4000-8000-000000000002"
const C_LIFETIME = "c0000000-0000-4000-8000-000000000003"
const C_BUYER = "c0000000-0000-4000-8000-000000000004"
const C_SELLER = "c0000000-0000-4000-8000-000000000005"
const C_DUAL = "c0000000-0000-4000-8000-000000000006"
const LEAD = "e0000000-0000-4000-8000-000000000001"
const LISTING = "f0000000-0000-4000-8000-000000000001"
const TXN = "d0000000-0000-4000-8000-000000000001"

function world(extra: Record<string, Row[]> = {}): MemClient {
  const svc = memSupabase({
    users: [
      { id: AGENT_USER, brokerage_id: BRK, user_type: "agent", first_name: "Ava", last_name: "Agent", email: "ava@wave94.test" },
      { id: TC_USER, brokerage_id: BRK, user_type: "tc", first_name: "Tia", last_name: "Coord", email: "tia@wave94.test" },
      { id: BROKER_USER, brokerage_id: BRK, user_type: "broker", first_name: "Bo", last_name: "Broker", email: "bo@wave94.test" },
    ],
    agents: [{ id: AGENT, user_id: AGENT_USER, brokerage_id: BRK }],
    contacts: [
      { id: C_MAIL, brokerage_id: BRK, agent_id: AGENT, email: "pat@wave94.test", first_name: "Pat", contact_type: "buyer", status: "new" },
      { id: C_NOMAIL, brokerage_id: BRK, agent_id: AGENT, email: null, first_name: "Phone", contact_type: "buyer", status: "new" },
      { id: C_LIFETIME, brokerage_id: BRK, agent_id: AGENT, email: "life@wave94.test", first_name: "Lee", contact_type: "lifetime_customer", status: "new" },
      { id: C_BUYER, brokerage_id: BRK, agent_id: AGENT, email: "buyer@wave94.test", first_name: "Bea", last_name: "Buyer", contact_type: "buyer" },
      { id: C_SELLER, brokerage_id: BRK, agent_id: AGENT, email: "seller@wave94.test", first_name: "Sal", last_name: "Seller", contact_type: "seller" },
      { id: C_DUAL, brokerage_id: BRK, agent_id: AGENT, email: "dual@wave94.test", first_name: "Dee", contact_type: "both" },
    ],
    leads: [{ id: LEAD, brokerage_id: BRK, email: "lead@wave94.test", contact_id: null }],
    listings: [{ id: LISTING, brokerage_id: BRK, agent_id: AGENT, seller_contact_id: C_SELLER, status: "pending" }],
    transactions: [{
      id: TXN, brokerage_id: BRK, agent_id: AGENT, listing_id: LISTING, offer_id: null,
      contact_id: C_BUYER, buyer_contact_id: C_BUYER, seller_contact_id: C_SELLER,
      property_address: "94 Wave Lane", purchase_price: 0, status: "under_contract", stage: "UNDER_CONTRACT",
    }],
    portal_contact_invites: [], notifications: [], notification_rules: [], transparency_updates: [],
    client_portal_messages: [], activities: [], transaction_participants: [], transaction_milestones: [],
    transaction_assignments: [], journey_states: [], contact_portal_modules: [],
    ...extra,
  }, { stampCreatedAt: true })
  let otp = 0
  ;(svc as any).auth = { signInWithOtp: async () => { otp++; return { error: null } } }
  ;(svc as any).otpCount = () => otp
  G.__94A.svc = svc
  return svc
}
const rows = (svc: MemClient, t: string, pred: (r: Row) => boolean = () => true) => (svc.tables[t] ?? []).filter(pred)

async function main() {
  console.log("══ client-automation-rulings (wave 94, lane 94A) ══")

  // ════ R1 — ONE automatic portal invite on both doors ══════════════════════
  console.log("\n[R1 · the automatic portal invite — behaviour, real invite core]")
  const { grantPortalAccessForPromotedContact } = await import("../lib/contact-promotion/portal-access")
  {
    const svc = world()
    const first = await grantPortalAccessForPromotedContact(svc, { contactId: C_MAIL, agentId: AGENT, contactType: "buyer", sendMagicLink: false })
    check("a contact with an email gets ONE invite row on the automatic door", first.granted && rows(svc, "portal_contact_invites", (r) => r.contact_id === C_MAIL).length === 1, JSON.stringify(first))
    const again = await grantPortalAccessForPromotedContact(svc, { contactId: C_MAIL, agentId: AGENT, contactType: "buyer", sendMagicLink: false })
    check("IDEMPOTENT: the second automatic pass re-uses it — still exactly one invite for the contact",
      again.granted && rows(svc, "portal_contact_invites", (r) => r.contact_id === C_MAIL).length === 1)

    const none = await grantPortalAccessForPromotedContact(svc, { contactId: C_NOMAIL, agentId: AGENT, contactType: "buyer" })
    check("a contact with NO email queues NOTHING (no invite row, no mail)",
      !none.granted && rows(svc, "portal_contact_invites", (r) => r.contact_id === C_NOMAIL).length === 0 && (svc as any).otpCount() === 0)
    check("...and it is REPORTED with a machine reason and a human warning",
      none.reason === "no_email_on_file" && none.warnings.some((w) => /no email on file/.test(w)), JSON.stringify(none))

    const lead = await grantPortalAccessForPromotedContact(svc, { contactId: LEAD, agentId: AGENT, contactType: "buyer" })
    check("NEVER FOR A LEAD: a leads.id resolves to no contact and nothing is written",
      !lead.granted && rows(svc, "portal_contact_invites", (r) => r.contact_id === LEAD).length === 0)

    const life = await grantPortalAccessForPromotedContact(svc, { contactId: C_LIFETIME, agentId: AGENT, contactType: "lifetime_customer", sendMagicLink: true })
    check("EMAIL CHANNEL: with no agent welcome due, the invite's own emailed sign-in goes out once",
      life.granted && life.emailSent && (svc as any).otpCount() === 1)

    // POSITIVE CONTROL — the manual CRM button (a person's deliberate choice) is NOT the
    // automatic door: the core without requireEmail still writes the row, so the zero
    // above is the rule, not a finder that can never see a row.
    const { issuePortalInvite } = await import("../lib/portal/portal-invite-core")
    const manual = await issuePortalInvite({ contactId: C_NOMAIL, invitedByUserId: AGENT_USER })
    check("CONTROL: the same core WITHOUT the automatic rule does write a row for the no-email contact",
      manual.success && rows(svc, "portal_contact_invites", (r) => r.contact_id === C_NOMAIL).length === 1)
  }
  {
    // THE RACE: two automatic doors fire for one contact at once — both miss the read,
    // the database's UNIQUE(contact_id) refuses the second insert (23505).
    const svc = world()
    const real = svc.from.bind(svc)
    let hideOnce = true
    ;(svc as any).from = (t: string) => {
      const b: any = real(t)
      if (t !== "portal_contact_invites") return b
      const origInsert = b.insert.bind(b)
      const origMaybe = b.maybeSingle.bind(b)
      b.maybeSingle = async () => {
        if (hideOnce) { hideOnce = false; return { data: null, error: null } }
        return origMaybe()
      }
      b.insert = (row: Row) => {
        if (rows(svc, "portal_contact_invites", (r) => r.contact_id === row.contact_id).length > 0) {
          const refused: any = { select: () => refused, single: async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }) }
          return refused
        }
        return origInsert(row)
      }
      return b
    }
    svc.tables.portal_contact_invites.push({ id: "pci-winner", contact_id: C_MAIL, brokerage_id: BRK, status: "pending", expires_at: "2099-01-01T00:00:00Z" })
    const raced = await grantPortalAccessForPromotedContact(svc, { contactId: C_MAIL, agentId: AGENT, contactType: "buyer", sendMagicLink: false })
    check("RACE: a 23505 on the second automatic insert is the idempotency WORKING — the winner's row is used, still one invite",
      raced.granted && rows(svc, "portal_contact_invites", (r) => r.contact_id === C_MAIL).length === 1, JSON.stringify(raced))
  }

  console.log("\n[R1 · the NEW-contact door — createContactManually end to end]")
  {
    const { createContactManually } = await import("../lib/kernel/crm")
    const svc = world()
    G.__94A.welcomes = []
    const made = await createContactManually({
      first_name: "Nia", last_name: "New", email: "nia@wave94.test", contact_type: "buyer",
      agent_id: AGENT, brokerage_id: BRK,
    } as any)
    const id = made.contactId ?? ""
    check("a manually added contact is created", made.success && !!id, JSON.stringify(made).slice(0, 300))
    check("...and the automation invited it to the portal — one invite row, reported granted",
      rows(svc, "portal_contact_invites", (r) => r.contact_id === id).length === 1 && made.portalInvite?.granted === true, JSON.stringify(made.portalInvite))
    check("...through the ONE welcome path (the email carries the portal door — welcome asked once)",
      G.__94A.welcomes.filter((w: string) => w === id).length === 1)

    const noMail = await createContactManually({
      first_name: "Pho", last_name: "Only", phone: "5615550194", contact_type: "buyer", agent_id: AGENT, brokerage_id: BRK,
    } as any)
    check("a manually added contact with NO email queues nothing and the door REPORTS it",
      noMail.success && rows(svc, "portal_contact_invites", (r) => r.contact_id === noMail.contactId).length === 0
      && noMail.portalInvite?.granted === false && noMail.portalInvite?.reason === "no_email_on_file", JSON.stringify(noMail.portalInvite))
  }

  console.log("\n[R1 · wiring — stripped source]")
  {
    const crm = code("lib/kernel/crm.ts")
    const body = crm.slice(crm.indexOf("export async function createContactManually"), crm.indexOf("export async function createLeadOnlyRecordForAcquisitionSource"))
    check("createContactManually (the new-contact chokepoint) calls deliverConversionWelcome only for a NEW row",
      /result\.success && !result\.isDuplicate && result\.contactId/.test(body) && /deliverConversionWelcome\(/.test(body))
    const DOOR_COPY = /createPortalInviteForContact\(/
    check("CONTROL: the duplicate-door finder recognises the retired shape", DOOR_COPY.test("await createPortalInviteForContact({ contactId })"))
    check("app/actions/contacts.ts no longer writes its own invite (survivor: createContactManually)", !DOOR_COPY.test(code("app/actions/contacts.ts")))
    check("app/actions/lead-lifecycle.ts no longer writes a second invite after the conversion", !DOOR_COPY.test(code("app/actions/lead-lifecycle.ts")))
    const core = code("lib/portal/portal-invite-core.ts")
    const sys = core.slice(core.indexOf("export async function createSystemPortalInvite"))
    check("every automated caller's door (createSystemPortalInvite) applies the no-email rule", /requireEmail:\s*true/.test(sys))
    const converters = ["lib/kernel/crm.ts", "lib/contact-promotion/promote-lead-to-contact.ts", "lib/kernel/lead-acquisition-handlers.ts", "lib/ai-isa/convert-buyer-lead-on-intent.ts"]
    check(`all ${converters.length} converters reach the same deliverConversionWelcome (the converted door)`,
      converters.every((f) => /deliverConversionWelcome\(/.test(code(f))))
  }

  // ════ R2 — one alert per person per deal moment ═══════════════════════════
  console.log("\n[R2 · replay — accept and close, alerts counted per recipient]")
  const { processKernelEvent } = await import("../lib/kernel/notification-engine")
  const { writePortalUpdate } = await import("../lib/kernel/event-fanout")
  const { notifyTransactionParties } = await import("../lib/notifications/notify-helpers")
  const { KernelEvent } = await import("../lib/kernel/events")
  const { momentForType } = await import("../lib/notifications/notification-moments")
  const txnCtx = { brokerageId: BRK, transactionId: TXN, listingId: LISTING, buyerContactId: C_BUYER, sellerContactId: C_SELLER }

  type Step = { label: string; run: () => Promise<unknown> }
  const ACCEPT: Step[] = [
    { label: "OFFER_ACCEPTED (staff)", run: () => processKernelEvent({ ...txnCtx, event: KernelEvent.OFFER_ACCEPTED, entityType: "transaction", entityId: TXN }) },
    { label: "OFFER_ACCEPTED (client bells)", run: () => writePortalUpdate({ ...txnCtx, event: KernelEvent.OFFER_ACCEPTED, entityType: "transaction", entityId: TXN }, [C_BUYER, C_SELLER]) },
    { label: "BUYER_UNDER_CONTRACT", run: () => processKernelEvent({ ...txnCtx, event: KernelEvent.BUYER_UNDER_CONTRACT, entityType: "transaction", entityId: TXN }) },
    { label: "the parties packet", run: () => notifyTransactionParties(G.__94A.svc, { transactionId: TXN, brokerageId: BRK }) },
    { label: "CONTRACT_SIGNED (listing stage)", run: () => processKernelEvent({ brokerageId: BRK, event: KernelEvent.CONTRACT_SIGNED, entityType: "listing_stage_machine", entityId: LISTING }) },
    { label: "LISTING_UNDER_CONTRACT (seller bell)", run: () => writePortalUpdate({ brokerageId: BRK, event: KernelEvent.LISTING_UNDER_CONTRACT, entityType: "listing", entityId: LISTING, listingId: LISTING, sellerContactId: C_SELLER }, [C_SELLER]) },
  ]
  const CLOSE: Step[] = [
    { label: "TRANSACTION_CLOSED (staff)", run: () => processKernelEvent({ ...txnCtx, event: KernelEvent.TRANSACTION_CLOSED, entityType: "transaction", entityId: TXN }) },
    { label: "TRANSACTION_CLOSED (client bells)", run: () => writePortalUpdate({ ...txnCtx, event: KernelEvent.TRANSACTION_CLOSED, entityType: "transaction", entityId: TXN }, [C_BUYER, C_SELLER]) },
    { label: "DEAL_CLOSED (transaction)", run: () => processKernelEvent({ ...txnCtx, event: KernelEvent.DEAL_CLOSED, entityType: "transaction", entityId: TXN }) },
    { label: "DEAL_CLOSED (listing stage)", run: () => processKernelEvent({ brokerageId: BRK, event: KernelEvent.DEAL_CLOSED, entityType: "listing_stage_machine", entityId: LISTING }) },
  ]
  const perRecipient = (svc: MemClient, moment: string) => {
    const counts = new Map<string, number>()
    for (const n of rows(svc, "notifications", (r) => momentForType(r.type) === moment)) {
      const who = n.user_id ? `user:${n.user_id}` : `contact:${n.contact_id}`
      counts.set(who, (counts.get(who) ?? 0) + 1)
    }
    return counts
  }
  const show = (m: Map<string, number>) => [...m].map(([k, v]) => `${k.slice(0, 13)}…=${v}`).join(" ")

  // POSITIVE CONTROL FIRST: each event ALONE (a fresh world per event) alerts the agent —
  // so their SUM is the count a person got before the moment rule (93D2 measured 4 / 2).
  for (const [moment, steps] of [["under_contract", ACCEPT], ["closed", CLOSE]] as const) {
    let isolated = 0
    const alerting: string[] = []
    for (const s of steps) {
      const svc = world()
      await s.run()
      const n = rows(svc, "notifications", (r) => r.user_id === AGENT_USER && momentForType(r.type) === moment).length
      if (n > 0) alerting.push(s.label)
      isolated += n
    }
    check(`CONTROL: replayed one at a time, ${alerting.length} separate ${moment} events each alert the deal agent (pre-rule count ${isolated})`,
      isolated >= (moment === "under_contract" ? 4 : 3), alerting.join(" | "))
  }

  {
    const svc = world()
    for (const s of ACCEPT) await s.run()
    const counts = perRecipient(svc, "under_contract")
    console.log(`    accept → ${show(counts)}`)
    check("ACCEPT: the deal agent holds exactly ONE under-contract alert", counts.get(`user:${AGENT_USER}`) === 1)
    check("ACCEPT: the TC holds exactly one (the packet reached them, nothing else did)", (counts.get(`user:${TC_USER}`) ?? 0) === 1)
    check("ACCEPT: the buyer client holds exactly ONE under-contract bell", counts.get(`contact:${C_BUYER}`) === 1)
    check("ACCEPT: the seller client holds exactly ONE under-contract bell", counts.get(`contact:${C_SELLER}`) === 1)
    check("ACCEPT: NOBODY holds two", [...counts.values()].every((v) => v === 1), show(counts))
    const agentAlert = rows(svc, "notifications", (r) => r.user_id === AGENT_USER && momentForType(r.type) === "under_contract")[0]
    check("the ONE surviving alert is the richest — the parties packet's terms + dates, human-worded",
      /^Under contract: 94 Wave Lane$/.test(agentAlert?.title ?? "") && /Terms and dates/.test(agentAlert?.body ?? ""), `${agentAlert?.title} / ${String(agentAlert?.body).slice(0, 80)}`)
    check("R4 inside R2: that alert never says $0 for the unread price — it says price pending review",
      /Purchase price: price pending review/.test(agentAlert?.body ?? "") && !/\$0\b/.test(agentAlert?.body ?? ""))
    check("the broker (no default rule for these events) is untouched — channels the person is allowed are kept, none added",
      !counts.has(`user:${BROKER_USER}`))
    check("no raw kernel key reaches a person (no `entity: event` text)",
      rows(svc, "notifications").every((n) => !/\b\w+: \w+_\w+\b/.test(`${n.title} ${n.body ?? ""}`)))

    for (const s of CLOSE) await s.run()
    const closed = perRecipient(svc, "closed")
    console.log(`    close  → ${show(closed)}`)
    check("CLOSE: the deal agent holds exactly ONE closed alert", closed.get(`user:${AGENT_USER}`) === 1)
    check("CLOSE: each client holds exactly ONE closed bell", closed.get(`contact:${C_BUYER}`) === 1 && closed.get(`contact:${C_SELLER}`) === 1)
    check("CLOSE: NOBODY holds two", [...closed.values()].every((v) => v === 1), show(closed))
    check("the under-contract moment is not disturbed by the close (still one each)", [...perRecipient(svc, "under_contract").values()].every((v) => v === 1))

    // A LATER deal on the same listing is a new moment — the window bounds the rule.
    for (const n of rows(svc, "notifications")) n.created_at = new Date(Date.now() - 7 * 3600_000).toISOString()
    await ACCEPT[0].run()
    check("BOUNDED: an under-contract alert hours later (a new deal on the same listing) IS sent",
      perRecipient(svc, "under_contract").get(`user:${AGENT_USER}`) === 2)
  }
  {
    // A refused dedupe read lets the alert THROUGH (the moment rule is not a gate).
    const svc = world()
    const real = svc.from.bind(svc)
    ;(svc as any).from = (t: string) => {
      const b: any = real(t)
      if (t !== "notifications") return b
      const origSelect = b.select.bind(b)
      b.select = (c?: string) => (c === "id, type" ? { eq: () => b2, in: () => b2, gte: () => b2, limit: async () => ({ data: null, error: { message: "refused" } }) } as any : origSelect(c))
      const b2: any = { eq: () => b2, in: () => b2, gte: () => b2, limit: async () => ({ data: null, error: { message: "refused" } }) }
      return b
    }
    await ACCEPT[0].run()
    check("FAIL-OPEN BY DESIGN: a refused dedupe read still alerts the agent (never a lost deal alert)",
      rows(svc, "notifications", (r) => r.user_id === AGENT_USER).length === 1)
  }

  // ════ R3 — the kernel decides the portal layouts ══════════════════════════
  console.log("\n[R3 · the kernel's portal layouts]")
  const portal = await import("../lib/kernel/portal")
  check("PURE: dual → seller + buyer (seller first)", JSON.stringify(portal.portalLayoutsFor({ isDual: true, baseView: "seller" })) === '["seller","buyer"]'
    && JSON.stringify(portal.portalLayoutsFor({ isDual: true, baseView: "buyer" })) === '["seller","buyer"]')
  check("PURE: seller only → seller; buyer only → buyer; lifetime → lifetime",
    JSON.stringify(portal.portalLayoutsFor({ isDual: false, baseView: "seller" })) === '["seller"]'
    && JSON.stringify(portal.portalLayoutsFor({ isDual: false, baseView: "buyer" })) === '["buyer"]'
    && JSON.stringify(portal.portalLayoutsFor({ isDual: true, baseView: "lifetime" })) === '["lifetime"]')
  // Wave 95: a client who CLOSED a deal and is on a live one keeps the lifetime layout,
  // live journey first. The rule, not a waypoint: every live arm gains "lifetime" last.
  check("PURE (w95): sold here + buying elsewhere → buyer + lifetime; dual + closed → seller + buyer + lifetime",
    JSON.stringify(portal.portalLayoutsFor({ isDual: false, baseView: "buyer", hasClosedDeal: true })) === '["buyer","lifetime"]'
    && JSON.stringify(portal.portalLayoutsFor({ isDual: true, baseView: "seller", hasClosedDeal: true })) === '["seller","buyer","lifetime"]'
    && JSON.stringify(portal.portalLayoutsFor({ isDual: false, baseView: "lifetime", hasClosedDeal: true })) === '["lifetime"]')
  check("…POSITIVE CONTROL: no closed deal → the wave-94 answer, unchanged",
    JSON.stringify(portal.portalLayoutsFor({ isDual: false, baseView: "buyer", hasClosedDeal: false })) === '["buyer"]')
  {
    // public.transactions has NO contact-self SELECT policy, so the client's own session
    // reads its deals successfully EMPTY (live walk w95: a closed seller resolved ["buyer"]).
    // The kernel must gate (requireContactAccess) BEFORE it elevates to the service client.
    const k = code("lib/kernel/portal.ts")
    const body = k.slice(k.indexOf("async function portalLayoutClient("), k.indexOf("export async function resolvePortalLayouts("))
    const gatesThenElevates = (b: string) => {
      const gate = b.indexOf("requireContactAccess(")
      const refuse = b.search(/if \(!access\.ok\) return \{ client: supabase/)
      const svc = b.indexOf("createServiceClient(")
      return gate > 0 && refuse > gate && svc > refuse
    }
    check("the layout resolver gates the contact BEFORE it reads deals with the service client (refused gate = no elevation)", gatesThenElevates(body))
    check("…POSITIVE CONTROL: elevation without the gate is flagged",
      !gatesThenElevates("async function portalLayoutClient() { return { client: createServiceClient() } }"))
    const r = k.slice(k.indexOf("export async function resolvePortalLayouts("), k.indexOf("export function portalShowsLayout("))
    check("resolvePortalLayouts reads through the gated client and passes hasClosedDeal to the pure rule",
      /portalLayoutClient\(supabase, input\)/.test(r) && /resolveDualPortalView\(client, input\)/.test(r) && /hasClosedDeal/.test(r) && /\.eq\("brokerage_id", brokerageId\)/.test(r))
    const home = code("app/portal/[contactId]/page.tsx")
    check("the portal home renders the lifetime home beside a live journey when the kernel lists it",
      /portalShowsLayout\(dual, "lifetime"\)/.test(home) && (home.match(/\{lifetimeBelow\}/g) ?? []).length >= 3)
  }
  {
    const T2 = "d0000000-0000-4000-8000-000000000002"
    const svc = world({
      transactions: [
        // C_DUAL (type 'both') — and C_MAIL ('buyer') buys on one deal while selling on another.
        { id: TXN, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: C_MAIL, seller_contact_id: null, contact_id: C_MAIL, status: "under_contract" },
        { id: T2, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: null, seller_contact_id: C_MAIL, contact_id: null, status: "active" },
        // A dual-AGENCY row: C_NOMAIL is on both sides of ONE deal — that is not a dual client.
        { id: "d0000000-0000-4000-8000-000000000003", brokerage_id: BRK, buyer_contact_id: C_NOMAIL, seller_contact_id: C_NOMAIL, status: "active" },
      ],
    })
    const L = async (id: string) => (await portal.resolvePortalLayouts(svc as any, { contactId: id })).layouts.join("+")
    check("a 'both' contact → seller+buyer", (await L(C_DUAL)) === "seller+buyer", await L(C_DUAL))
    check("a seller-only contact → seller", (await L(C_SELLER)) === "seller", await L(C_SELLER))
    check("a buyer-only contact → buyer", (await L(C_BUYER)) === "buyer", await L(C_BUYER))
    const r = await portal.resolvePortalLayouts(svc as any, { contactId: C_MAIL })
    check("the DEALS say dual (buying on one, selling on another) → seller+buyer even with contact_type 'buyer'",
      r.layouts.join("+") === "seller+buyer" && r.reason === "ACTIVE_DEALS_BOTH_SIDES", `${r.layouts} ${r.reason}`)
    check("CONTROL: one contact on both sides of ONE deal (dual agency) is NOT a dual client", (await L(C_NOMAIL)) !== "seller+buyer", await L(C_NOMAIL))
    check("portalShowsLayout is the gate: a dual portal shows the buyer pages AND the seller pages",
      portal.portalShowsLayout(r, "buyer") && portal.portalShowsLayout(r, "seller") && !portal.portalShowsLayout(r, "lifetime"))
    const nav = portal.buildPortalNavForLayouts(["seller", "buyer"], {}, C_DUAL).map((n) => n.href)
    const sellerNav = portal.buildPortalNav("seller", {}, C_DUAL).map((n) => n.href)
    const buyerNav = portal.buildPortalNav("buyer", {}, C_DUAL).map((n) => n.href)
    check("the dual shell nav carries every seller AND every buyer destination, once each",
      [...sellerNav, ...buyerNav].every((h) => nav.includes(h)) && new Set(nav).size === nav.length)
    check("a single-layout shell nav is exactly the one layout's nav (unchanged for everyone else)",
      JSON.stringify(portal.buildPortalNavForLayouts(["buyer"], {}, C_BUYER)) === JSON.stringify(portal.buildPortalNav("buyer", {}, C_BUYER)))
  }
  {
    // Every portal SURFACE asks the kernel's layouts — never the single-view resolver.
    const dir = join(ROOT, "app/portal/[contactId]")
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p) } }
    walk(dir)
    const SINGLE = /\bdeterminePortalView\(/
    check("CONTROL: the single-view finder recognises the retired call", SINGLE.test("const v = await determinePortalView(supabase, { contactId })"))
    const offenders = files.filter((f) => SINGLE.test(stripComments(readFileSync(f, "utf8")))).map((f) => relative(ROOT, f))
    const askers = files.filter((f) => /\bresolvePortalLayouts\(/.test(stripComments(readFileSync(f, "utf8"))))
    check(`no portal surface asks the single-view resolver (${files.length} files under app/portal/[contactId] scanned)`, offenders.length === 0, offenders.join(", "))
    const gating = files.filter((f) => /\bportalShowsLayout\(|\bportalLayouts\b/.test(stripComments(readFileSync(f, "utf8"))))
    const shell = ["app/portal/[contactId]/layout.tsx", "app/portal/[contactId]/page.tsx"]
    check(`the shell and the home ask resolvePortalLayouts, and every page that gates on a layout asks it (${askers.length} askers, ${gating.length} gating)`,
      shell.every((s) => askers.some((a) => relative(ROOT, a) === s)) && gating.every((g) => askers.includes(g)),
      gating.filter((g) => !askers.includes(g)).map((g) => relative(ROOT, g)).join(", "))
    check("lib/portal/resolve-education-context.ts asks it too", /\bresolvePortalLayouts\(/.test(code("lib/portal/resolve-education-context.ts")))
  }
  {
    console.log("\n[R3 · the lifetime home finds the deal on ANY side]")
    const T_SOLD = "d0000000-0000-4000-8000-000000000010"
    const T_BOUGHT = "d0000000-0000-4000-8000-000000000011"
    const svc = world({
      transactions: [
        { id: T_SOLD, brokerage_id: BRK, contact_id: C_BUYER, buyer_contact_id: C_BUYER, seller_contact_id: C_DUAL, status: "closed", close_date: "2026-09-01" },
        { id: T_BOUGHT, brokerage_id: BRK, contact_id: C_SELLER, buyer_contact_id: C_DUAL, seller_contact_id: C_SELLER, status: "closed", close_date: "2026-08-15" },
      ],
    })
    const oldShape = rows(svc, "transactions", (r) => r.contact_id === C_DUAL && r.status === "closed")
    check("CONTROL: the old main-contact-only read finds NO home for the dual client", oldShape.length === 0)
    const { data: found } = await (svc.from("transactions").select("id, buyer_contact_id").or(portal.clientTransactionFilter(C_DUAL))
      .eq("brokerage_id", BRK).eq("status", "closed").order("close_date", { ascending: false }).limit(10) as any)
    const home = portal.pickLifetimeHomeTransaction((found ?? []) as Array<{ id: string; buyer_contact_id: string | null }>, C_DUAL)
    check("clientTransactionFilter finds BOTH deals the dual client was on", (found ?? []).length === 2)
    check("...and the HOME is the one they BOUGHT (the house they own now), not the newer sale", home?.id === T_BOUGHT, String(home?.id))
    const sellerOnly = portal.pickLifetimeHomeTransaction([{ id: T_SOLD, buyer_contact_id: C_BUYER }], C_DUAL)
    check("a seller-only client still sees the deal they closed with us", sellerOnly?.id === T_SOLD)
    check("a non-uuid id is never interpolated into the filter", portal.clientTransactionFilter("x,id.neq.0") === "id.is.null")
    const lifetime = code("app/actions/portal-lifetime.ts")
    const MAIN_ONLY = /from\("transactions"\)(?:(?!\.from\()[\s\S]){0,700}?\.eq\("contact_id",\s*(params\.)?contactId\)/
    check("CONTROL: the main-contact-only finder recognises the retired read", MAIN_ONLY.test('from("transactions").select("id").eq("contact_id", contactId)'))
    check("portal-lifetime.ts reads no transaction by the main contact only", !MAIN_ONLY.test(lifetime))
    check("...its three closed-deal reads use the one client filter", (lifetime.match(/clientTransactionFilter\(/g) ?? []).length === 3)
  }

  // ════ R4 — never "$0" for a price nobody read ═════════════════════════════
  console.log("\n[R4 · one wording for a price we do not have]")
  const money = await import("../lib/format/money")
  const { renderTemplateText } = await import("../lib/kernel/portal-template-render")
  const { composeStaffMessage, composeClientMessage } = await import("../lib/notifications/transaction-parties-packet")
  check("0 / null / undefined / NaN / negative / '' / '$0' all render 'price pending review'",
    [0, null, undefined, NaN, -5, "", "$0"].every((v) => money.priceOrPendingReview(v as any) === money.PRICE_PENDING_REVIEW))
  check("a real price renders as dollars", money.priceOrPendingReview(450000) === "$450,000" && money.priceOrPendingReview("$450,000") === "$450,000")
  check("a template price token never renders $0 or TBD",
    renderTemplateText("at {contract_price_fmt}", { contract_price_fmt: "$0" }) === "at price pending review"
    && renderTemplateText("for {purchase_price}", {}) === "for price pending review"
    && renderTemplateText("for {offer_price}", { offer_price: 0 }) === "for price pending review")
  check("CONTROL: non-price tokens are unchanged (a missing date is still TBD, a 0 amount is still 0)",
    renderTemplateText("close {closing_date}", {}) === "close TBD" && renderTemplateText("paid {amount}", { amount: 0 }) === "paid 0")
  const packet = { terms: { dealName: null, propertyAddress: "94 Wave Lane", purchasePrice: 0, earnestMoney: null, earnestMoneyDue: null, contractDate: null, closingDate: null, inspectionDeadline: null, appraisalDeadline: null, financingDeadline: null, contingencies: [], titleCompany: null }, parties: [] }
  check("the parties packet (staff AND client) says 'price pending review', never $0",
    /Purchase price: price pending review/.test(composeStaffMessage(packet)) && /Purchase price: price pending review/.test(composeClientMessage(packet, "seller"))
    && !/\$0\b/.test(composeClientMessage(packet, "seller")))
  {
    const ZERO = /\(\s*[\w.?]+\.(offer_price|purchase_price|sale_price|offer_amount)\s*\|\|\s*0\s*\)\.toLocaleString/
    check("CONTROL: the $0 finder recognises the retired render", ZERO.test("${(offer.offer_price || 0).toLocaleString()}"))
    const surfaces = ["app/portal/[contactId]/my-offer/page.tsx", "app/components/portal/OfferStatusCard.tsx", "app/components/portal/lifetime/MyHomeCard.tsx", "app/components/portal/lifetime/CongratsCard.tsx"]
    const hits = surfaces.filter((f) => ZERO.test(blankStrings(code(f)).replace(/`[^`]*`/g, "``")) || ZERO.test(code(f)))
    check(`the client offer/price surfaces render no "|| 0" price (${surfaces.length} files)`, hits.length === 0, hits.join(", "))
    const offers = code("app/portal/[contactId]/offers/page.tsx")
    check("the seller-portal offers page renders offer prices through the one helper",
      (offers.match(/priceOrPendingReview\(/g) ?? []).length >= 5 && !/\(offer\.offer_price \|\| 0\)\.toLocaleString/.test(offers))
  }

  // ════ R5 — wave 96: portal sub-pages read the client's deals through the ONE gate ═══
  console.log("\n[R5 · a portal client's deals are read through the kernel gate, never its own session]")
  {
    const portalSrc = code("lib/kernel/portal.ts")
    const dealFn = portalSrc.slice(portalSrc.indexOf("export async function portalDealClient("), portalSrc.indexOf("export function scopeToDealTenant("))
    check("portalDealClient IS the layout gate (returns portalLayoutClient), not a second gate",
      /return portalLayoutClient\(supabase, \{ contactId \}\)/.test(dealFn) && !/requireContactAccess\(/.test(dealFn))
    check("...and the kernel still calls requireContactAccess exactly once", (portalSrc.match(/requireContactAccess\(/g) ?? []).length === 1)
    // Every transactions read under app/portal/[contactId] goes through the deal client.
    const dir = join(ROOT, "app/portal/[contactId]")
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p) } }
    walk(dir)
    // The session-client shape: `supabase` (the cookie client every page builds) chained
    // straight into a transactions read.
    const SESSION_DEAL_READ = /\bsupabase\s*\.from\(\s*"transactions"\s*\)/
    check("CONTROL: the finder recognises a session-client deal read",
      SESSION_DEAL_READ.test('const { data } = await supabase\n    .from("transactions")\n    .select("id")'))
    const readers = files.filter((f) => /\.from\(\s*"transactions"\s*\)/.test(code(relative(ROOT, f))))
    const offenders = readers.filter((f) => SESSION_DEAL_READ.test(code(relative(ROOT, f)))).map((f) => relative(ROOT, f))
    check(`no portal page reads transactions with the client's own session (${readers.length} deal-reading files scanned)`,
      offenders.length === 0, offenders.join(", "))
    const ungated = readers
      .filter((f) => !/\bportalDealClient\(/.test(code(relative(ROOT, f))) && !/\bcreateServiceClient\(/.test(code(relative(ROOT, f))))
      .map((f) => relative(ROOT, f))
    check("...and every deal-reading page asks portalDealClient (or already holds its own gate + service client)", ungated.length === 0, ungated.join(", "))
    check("...the files that read deals are found at all (positive count)", readers.length >= 8, String(readers.length))
    // The tenant pin: elevated → .eq("brokerage_id", tenant); not elevated → untouched.
    const seen: Array<[string, string]> = []
    const q = { eq(c: string, v: string) { seen.push([c, v]); return q } }
    check("scopeToDealTenant pins an elevated read to the gate's tenant", portal.scopeToDealTenant(q, BRK) === q && seen.length === 1 && seen[0][0] === "brokerage_id" && seen[0][1] === BRK)
    check("...and leaves a session read untouched (never .eq(brokerage_id, null))", portal.scopeToDealTenant(q, null) === q && seen.length === 1)
  }
  {
    console.log("\n[R6 · the lifetime client's OWN home is not neighbourhood activity]")
    const home = { listing_id: "L-own", property_address: "12 Harbor View Dr, Austin, TX 78701" }
    const nearby = [
      { id: "L-own", address: "12 Harbor View Dr, Austin, TX" },
      { id: "L-twin", address: "12 Harbor View Dr., Austin" },
      { id: "L-1", address: "14 Harbor View Dr, Austin, TX" },
      { id: "L-2", address: "9 Oak St, Austin, TX" },
    ]
    const kept = portal.excludeOwnHome(nearby, home).map((l) => l.id)
    check("the client's own listing (by id) is excluded", !kept.includes("L-own"), kept.join(","))
    check("...and the same street line on another listing row is excluded", !kept.includes("L-twin"), kept.join(","))
    check("...the neighbours stay", kept.includes("L-1") && kept.includes("L-2"), kept.join(","))
    check("a home with no listing id is still excluded by address", !portal.excludeOwnHome(nearby, { listing_id: null, property_address: home.property_address }).some((l) => l.id === "L-twin"))
    // POSITIVE CONTROL: the pre-wave-96 read never selected listing_id, so its exclusion
    // compared against the nil uuid and kept the client's own home.
    const oldKept = nearby.filter((l) => l.id !== ((({} as { listing_id?: string }).listing_id) ?? "00000000-0000-0000-0000-000000000000"))
    check("CONTROL: the old nil-uuid exclusion kept the client's own home", oldKept.some((l) => l.id === "L-own"))
    const lifetime = code("app/actions/portal-lifetime.ts")
    const homeRead = lifetime.slice(lifetime.indexOf("export async function getLifetimeContext("))
    check("getLifetimeContext's home read now selects listing_id", /buyer_contact_id,\s*listing_id\s*`/.test(homeRead))
    check("...and the neighbourhood list goes through excludeOwnHome", /excludeOwnHome\(nearby \?\? \[\], transaction\)/.test(homeRead))
  }

  // ════ R7 — wave 98: a client sees marked deal documents + their own uploads, never the CDA ═══
  console.log("\n[R7 · client-visible deal documents: marked or self-uploaded — never the commission form or internal paperwork]")
  {
    const vis = await import("../lib/kernel/deal-document-visibility")
    const ME = "a9000000-0000-4000-8000-000000000098", STAFF = "a8000000-0000-4000-8000-000000000098"
    check("PURE: a staff-marked document is shown", vis.isClientVisibleDealDocument({ client_visible: true, uploaded_by: STAFF, doc_type: "inspection_report" }, ME))
    check("PURE: an UNMARKED staff document is hidden (deny by default)", !vis.isClientVisibleDealDocument({ client_visible: false, uploaded_by: STAFF, doc_type: "inspection_report" }, ME))
    check("PURE: the client's OWN upload is shown unmarked", vis.isClientVisibleDealDocument({ client_visible: false, uploaded_by: ME, doc_type: "upload" }, ME))
    check("PURE: the commission disbursement form is NEVER shown — even marked visible", !vis.isClientVisibleDealDocument({ client_visible: true, doc_type: "commission_disbursement_authorization" }, ME))
    check("PURE: ...nor a CDA copy, nor internal paperwork, by any spelling carrying the segment",
      ["cda", "cda_check_copy", "cda_signed", "internal_notes", "broker_internal_memo", "disbursement_ledger"].every((t) => vis.isClientHiddenDealDocType(t)))
    check("PURE: the Buyer Broker Agreement (classification commission_agreement) is the CLIENT's document and stays showable",
      vis.isClientVisibleDealDocument({ client_visible: true, doc_type: "commission_agreement" }, ME))
    check("PURE: no viewer → only marked documents (an unknown viewer never matches 'own')",
      !vis.isClientVisibleDealDocument({ client_visible: false, uploaded_by: null, doc_type: "upload" }, null)
      && vis.clientDealDocumentFilter(null) === "client_visible.eq.true" && vis.clientDealDocumentFilter(ME) === `client_visible.eq.true,uploaded_by.eq.${ME}`)

    // The elevated seller-portal reader (getSellerDocuments) against an in-memory deal.
    const CLIENT_USER = "c9000000-0000-4000-8000-000000000098"
    const DOCS = [
      { id: "doc-marked", transaction_id: TXN, brokerage_id: BRK, doc_type: "inspection_report", doc_label: "Inspection", client_visible: true, uploaded_by: STAFF, created_at: "2026-10-01" },
      { id: "doc-unmarked", transaction_id: TXN, brokerage_id: BRK, doc_type: "addendum", doc_label: "Draft addendum", client_visible: false, uploaded_by: STAFF, created_at: "2026-10-01" },
      { id: "doc-own", transaction_id: TXN, brokerage_id: BRK, doc_type: "upload", doc_label: "My pay stub", client_visible: false, uploaded_by: CLIENT_USER, created_at: "2026-10-01" },
      { id: "doc-cda", transaction_id: TXN, brokerage_id: BRK, doc_type: "commission_disbursement_authorization", doc_label: "CDA", client_visible: true, uploaded_by: STAFF, created_at: "2026-10-01" },
      { id: "doc-other-tenant", transaction_id: TXN, brokerage_id: "b0000000-0000-4000-8000-0000000000ff", doc_type: "inspection_report", doc_label: "x", client_visible: true, uploaded_by: STAFF, created_at: "2026-10-01" },
    ]
    const svc = world({ transaction_documents: DOCS.map((d) => ({ ...d })), client_documents: [] })
    ;(svc.tables.contacts.find((c) => c.id === C_SELLER) as Row).contact_user_id = CLIENT_USER
    ;(svc as any).auth.getUser = async () => ({ data: { user: { id: CLIENT_USER, email: "seller@wave94.test" } } })
    const { getSellerDocuments } = await import("../app/actions/portal-seller")
    const got = await getSellerDocuments(C_SELLER, TXN)
    const ids = (got.transactionDocuments as Array<{ id: string }>).map((d) => d.id).sort()
    check("the seller portal returns the marked doc + the client's own upload — and nothing else", JSON.stringify(ids) === JSON.stringify(["doc-marked", "doc-own"]), ids.join(","))
    check("...the commission disbursement form (marked visible by mistake) is NOT among them", !ids.includes("doc-cda"))
    check("CONTROL: the CDA row IS in the deal's documents, so its absence above is the rule, not an empty table",
      rows(svc, "transaction_documents", (r) => r.transaction_id === TXN && r.brokerage_id === BRK).some((r) => r.id === "doc-cda"))

    // Every portal reader of transaction_documents goes through the gate + the rule (stripped source).
    const page = code("app/portal/[contactId]/documents/page.tsx")
    const SESSION_DOC_READ = /\bsupabase\s*\.from\(\s*"transaction_documents"\s*\)/
    check("CONTROL: the finder recognises a session-client deal-document read", SESSION_DOC_READ.test('await supabase\n  .from("transaction_documents")'))
    check("the documents page reads deal documents through the deal client, never the session", !SESSION_DOC_READ.test(page) && /dealDb\s*\.from\("transaction_documents"\)/.test(page))
    check("...narrows with clientDealDocumentFilter and re-checks every row with isClientVisibleDealDocument",
      /\.or\(clientDealDocumentFilter\(viewerUserId\)\)/.test(page) && /isClientVisibleDealDocument\(d, viewerUserId\)/.test(page))
    const docSelect = /from\("transaction_documents"\)\s*\.select\(`([^`]*)`/.exec(page)?.[1] ?? ""
    check("...and never selects the internal `notes` column", docSelect.length > 0 && !/\bnotes\b/.test(docSelect))
    const viewer = code("app/actions/documents.ts")
    check("the document viewer's portal fallback gates (portalDealClient) and applies the same rule",
      /portalDealClient\(supabase as any, contactId\)/.test(viewer) && /isClientVisibleDealDocument\(portalDoc as any/.test(viewer))
    check("the staff toggle is wired on the deal documents tab and writes through the gated action",
      /setDocumentClientVisibility\(d\.id, visible\)/.test(code("app/dashboard/transactions/[id]/transaction-detail-client.tsx"))
      && /\.update\(\{ client_visible: visible \}\)[\s\S]{0,120}\.select\(/.test(code("lib/application/transactions.ts")))
  }

  // ════ R8 — wave 98: an APPROVED client-facing video is delivered once (portal + email) ═══
  console.log("\n[R8 · an approved client-facing video reaches its contact's portal + inbox exactly once]")
  {
    const del = await import("../lib/video/client-video-delivery")
    check("the list is ONE constant and excludes the kinds with their own rail (welcome, home_anniversary)",
      !(del.CLIENT_FACING_VIDEO_TYPES as readonly string[]).includes("welcome") && !(del.CLIENT_FACING_VIDEO_TYPES as readonly string[]).includes("home_anniversary"))

    const V_CONTACT = "f9000000-0000-4000-8000-000000000001", V_NONE = "f9000000-0000-4000-8000-000000000002"
    const V_MKT = "f9000000-0000-4000-8000-000000000003"
    const vid = (id: string, extra: Row) => ({ id, brokerage_id: BRK, agent_id: AGENT, listing_id: null, title: "Teammate explainer — How buying works",
      video_type: "avatar_explainer", audience_type: "customer_facing", approval_status: "pending_review", video_url: "https://cdn/v.mp4", thumbnail_url: null, ...extra })
    const svc = world({ ai_video_projects: [vid(V_CONTACT, { contact_id: C_BUYER }), vid(V_NONE, { contact_id: null }), vid(V_MKT, { contact_id: C_BUYER, video_type: "just_listed" })] })
    G.__94A.emails = [] as Array<Record<string, any>>
    G.__94A.ledgerKeys = new Set<string>()
    const { applyMarketingAssetApproval } = await import("../lib/kernel/approval-queue-aggregator")
    await applyMarketingAssetApproval("video", V_CONTACT)
    await applyMarketingAssetApproval("video", V_CONTACT) // re-approval
    await applyMarketingAssetApproval("video", V_NONE)
    await applyMarketingAssetApproval("video", V_MKT)
    // The rule's other refusals, through the real delivery function (file-local verdict).
    svc.tables.ai_video_projects.push(
      vid("f9000000-0000-4000-8000-000000000004", { contact_id: C_BUYER, approval_status: "pending_review" }),
      vid("f9000000-0000-4000-8000-000000000005", { contact_id: C_BUYER, approval_status: "approved", video_url: null }),
      vid("f9000000-0000-4000-8000-000000000006", { contact_id: C_BUYER, approval_status: "approved", video_type: "market_update", audience_type: "in_house" }),
    )
    const reasons = await Promise.all(["4", "5", "6"].map((n) => del.deliverApprovedClientVideo(svc as any, `f9000000-0000-4000-8000-00000000000${n}`)))
    check("not approved → nothing; approved but not rendered → nothing yet; in-house → library only",
      JSON.stringify(reasons.map((r) => r.reason)) === '["not_approved","not_rendered","not_client_facing"]', JSON.stringify(reasons.map((r) => r.reason)))
    const cards = rows(svc, "transparency_updates", (r) => r.update_type === del.CLIENT_VIDEO_UPDATE_TYPE)
    const sends = G.__94A.emails as Array<Record<string, any>>
    check("approved contact video → exactly ONE portal card for that contact, playable (url + project id)",
      cards.length === 1 && cards[0].contact_id === C_BUYER && cards[0].is_visible_to_client === true
      && (cards[0].metadata as any)?.video_project_id === V_CONTACT && (cards[0].metadata as any)?.video_url === "https://cdn/v.mp4", String(cards.length))
    check("...and exactly ONE email actually sent (re-approval replayed the ledger cycle, no second send)",
      sends.filter((e) => e.sent).length === 1 && sends.filter((e) => e.sent)[0].to === "buyer@wave94.test", JSON.stringify(sends.map((e) => [e.to, e.sent])))
    check("...through dispatchEmail with a stable cycle + an m687 reason (HUMAN_REQUESTED) + human-approved",
      sends.length === 2 && sends.every((e) => e.ledger?.cycle === `video:${V_CONTACT}` && e.ledger?.reasonCode === "HUMAN_REQUESTED" && e.humanApproved === true && e.contactId === C_BUYER))
    {
      const { dispatchEmail } = await import("../lib/providers/dispatch")
      const n = (G.__94A.emails as unknown[]).length
      await dispatchEmail({ brokerageId: BRK, contactId: C_BUYER, to: "x@wave98.test", subject: "s", html: "h" } as any)
      await dispatchEmail({ brokerageId: BRK, contactId: C_BUYER, to: "x@wave98.test", subject: "s", html: "h" } as any)
      check("CONTROL: without a cycle the same send goes out TWICE — the single send above is the cycle's doing",
        (G.__94A.emails as Array<{ sent: boolean }>).slice(n).filter((e) => e.sent).length === 2)
      ;(G.__94A.emails as unknown[]).splice(n) // in place: `sends` above is this same array
    }
    check("no-contact video and marketing video: no card, no email", !cards.some((c) => (c.metadata as any)?.video_project_id !== V_CONTACT) && !sends.some((e) => e.metadata?.video_project_id !== V_CONTACT))
    check("CONTROL: the approval itself landed on all three (delivery is the only thing skipped)",
      rows(svc, "ai_video_projects", (r) => [V_CONTACT, V_NONE, V_MKT].includes(r.id as string) && r.approval_status === "approved").length === 3)

    check("the explainer tool ADDRESSES the video: capability passes the conversation's contact; the commission writes the tenant-checked id",
      /contactId: ctx\.contactId \?\? null/.test(code("lib/ai-isa/capability-catalogue.ts")) && /contact_id: contactIdInTenant/.test(code("lib/video/avatar-explainer.ts")))
    check("CONTROL: the finder recognises the pre-wave-98 unaddressed row", !/contact_id: contactIdInTenant/.test("    contact_id: null,"))
    check("the render-ready moment (handleVideoGenerated, the in-force video.generated handler) delivers too",
      /deliverApprovedClientVideo\(svc as any, video_id\)/.test(code("lib/orchestrator/internal.ts")))
    check("the portal feed plays the delivered card (CARD_VIDEO_KEYS has the client_video spec)",
      /client_video:\s*\{\s*url:\s*"video_url"/.test(code("app/portal/[contactId]/components/RecentUpdatesFeed.tsx")))
  }

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  console.log("  blind spots (R5/R6): R5 scans app/portal/[contactId] only and recognises the `supabase.from(\"transactions\")` chain — a deal read through a differently named session variable, or a portal read inside an app/actions module, is not seen; the deal-derived tables are pinned by review, not by this scan; transaction_documents is read through the deal gate and filtered by the wave-98 client-visibility rule (R7). R6 matches the street line only (unit numbers after a comma are ignored)")
  console.log("  blind spots: R1's welcome EMAIL and video are module edges here (the grant under test precedes them; the email itself is held by test:conversion-welcome); R2 replays the four writers this lane owns (engine, fan-out bell, parties packet) — a fifth direct notifications writer on the accept/close path would not be counted; portal CARDS (transparency_updates, the feed) are not alerts and keep one per event; R3's surface scan is app/portal/[contactId] + the education resolver — a portal surface outside that tree is not scanned; R4's '|| 0' finder sees the inline shape only — the net-sheet table (lane 94B) is not in scope")
  console.log("  blind spots (R7/R8): R7's deny-list is by doc_type (named list + cda/disbursement/internal segments) — a CDA stored under a neutral doc_type such as 'upload' is not recognised; client_documents (the client's own folder) is filtered by the same deny-list but has no staff flag; R8 stubs dispatchEmail at the module edge (cycle replay emulated — the real replay is test:action-ledger's) and drives the approval door, not the render-ready door (that one is a wiring scan)")
  if (fail > 0) { console.log(" ❌ CLIENT_AUTOMATION_RULINGS_FAIL"); process.exit(1) }
  console.log(" ✅ CLIENT_AUTOMATION_RULINGS_PASS — one automatic portal invite per contact on both doors (no email → nothing queued, reported); one alert per person per accept/close moment; every portal surface asks the kernel's layouts (dual → seller + buyer); a price nobody read says 'price pending review'")
}

main().catch((e) => { console.error(e); process.exit(1) })
