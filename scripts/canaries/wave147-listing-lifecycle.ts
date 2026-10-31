/**
 * scripts/canaries/wave147-listing-lifecycle.ts — LISTING LIFECYCLE · CHECK-IN · THE FIVE ACTIONS canary (wave 147, lane 147J;
 * owner rulings 7, 8, 10, 11, contract C12 — lane 147F):
 *   "coming soon start date is the day the listing agreement was executed and once the listing is live on mls, the listing becomes
 *    active not coming soon" · "archived listings: internal yes, public no" · "make sure that we didn't lose check-in writers for
 *    any event like open houses" · "verify the five actions that were silently never recorded".
 *   → the agreement is executed (last signature) → Coming Soon runs FROM THAT DAY with the planned MLS date preserved → the planned
 *     day passing flips nothing (the concierge told once) → the MLS feed confirms → through the activation gate → ACTIVE, ledgered
 *     once → archived: hidden from the ONE public predicate, still read by id internally;
 *   → an open-house sign-in → an attendee AND a Contact, consent anchored to that contact, person evidence, the capture event with
 *     the contact; the same email again is the same attendee; no consent files nothing; a foreign body tenant is refused;
 *   → the five ruling-11 actions — business_card.scan.confirm, tenant.custom_domain.attach | verify | detach,
 *     listing.agreement_amendment.record, life_change.signal.respond (+ the crosswalk on stripped source) — each lands ONE ledger
 *     row, replays on the second call without acting, and FAILS CLOSED when the ledger refuses the claim.
 *
 * Driven through the REAL modules / server actions: lib/listings/listing-agreement-terms.ts governingListingAgreementTerms,
 * compute-dom.ts resolveComingSoonWindow, mls-live-verification.ts verifyAndRecordMlsLive, listing-status-sync.ts,
 * lib/kernel/listing-archive.ts archiveListing, app/actions/seller-open-house.ts checkInAttendee, app/actions/open-house-kernel.ts
 * completeOpenHouseCheckInAction, app/actions/business-card/business-card-actions.ts, app/actions/custom-domains.ts,
 * app/actions/seller-listing/listing-agreement-amendment.ts, lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal. Seamed
 * exactly as lane 147F's proofs seam them: the session / caller gates, the routing transport, DNS, the activation gate + kernel
 * transition + the MLS feeds (their own proofs), the amendment's domain writer and the lifecycle-event writer.
 */
import { setSvc } from "./_harness"
import { strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { canary147, jsonOf, seams, tbl } from "./wave147-harness"

const B = "f1470000-0000-4000-8000-00000000f0b1", B2 = "f1470000-0000-4000-8000-00000000f0b2"
const L = "f1470000-0000-4000-8000-00000000f011", LA = "f1470000-0000-4000-8000-00000000f01a"
const AG = "f1470000-0000-4000-8000-00000000f0a1", AG2 = "f1470000-0000-4000-8000-00000000f0a2", U = "f1470000-0000-4000-8000-00000000f0e1", U2 = "f1470000-0000-4000-8000-00000000f0e2"
const EV = "f1470000-0000-4000-8000-00000000f0ee", OHL = "f1470000-0000-4000-8000-00000000f0ef"
const K = "f1470000-0000-4000-8000-00000000f0c1", SCAN = "f1470000-0000-4000-8000-00000000f05c", DOC = "f1470000-0000-4000-8000-00000000f0d0"
const NOW = new Date("2026-10-31T15:00:00Z")
const LEDGER_UNIQUE = { agent_action_ledger: [["idempotency_key"]] }

/** A frozen clock for one call (the custom-domain cycles are timestamps: "the same request twice" is the same instant twice). */
async function atInstant<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const Real = Date
  const fixed = new Real(iso).getTime()
  class Frozen extends Real {
    constructor(...args: any[]) { if (args.length) super(...(args as [any])); else super(fixed) }
    static now(): number { return fixed }
  }
  ;(globalThis as any).Date = Frozen
  try { return await fn() } finally { (globalThis as any).Date = Real }
}
const ledgerOf = (svc: unknown, action: string) => tbl(svc, "agent_action_ledger").filter((r) => r.action === action)

export async function run() {
  const c = canary147("Listing lifecycle (C12) · check-in writers · the five actions: Coming Soon from the executed day → Active only on the MLS-verified event (ledgered) → archived internal-only; a sign-in files a Contact with consent and evidence; each of the five actions lands, replays and fails closed")
  const w = seams()
  const lss = await quiet(async () => import("../../lib/listings/listing-status-sync")) as unknown as Record<string, any>

  // ═══ 1 · C12 — the listing lifecycle ═══
  w.recordLifecycle = true
  const lat = await quiet(async () => import("../../lib/listings/listing-agreement-terms")) as unknown as Record<string, any>
  const cdom = await quiet(async () => import("../../lib/listings/compute-dom")) as unknown as Record<string, any>
  const mlv = await quiet(async () => import("../../lib/listings/mls-live-verification")) as unknown as Record<string, any>
  const seedRows = (over: Record<string, unknown> = {}) => ({
    brokerages: [{ id: B, name: "Gulf Realty 147J", timezone: "America/New_York" }],
    listings: [{ id: L, brokerage_id: B, agent_id: null, address: "12 Coming Soon Ct", city: "Tampa", state: "FL", zip: "33602", status: "coming_soon", lifecycle_stage: "COMING_SOON_ACTIVE", mls_number: "TB-147J", go_live_date: "2026-10-20", go_live_confirmed_at: null, mls_live_date_actual: null, mls_live_timezone: "America/New_York", deleted_at: null, metadata: {}, listing_date: null, updated_at: "2026-10-02T00:00:00Z", ...over }],
    listing_agreements: [{ id: LA, listing_id: L, brokerage_id: B, esign_status: "fully_executed", seller_signed_at: "2026-10-01T17:00:00Z", agent_signed_at: "2026-10-02T16:00:00Z", fully_executed_at: "2026-10-05T12:00:00Z", created_at: "2026-09-20T00:00:00Z", seller_requested_mls_live_date: "2026-10-20" }],
    contract_term_versions: [], manager_signals: [], agent_action_ledger: [], notifications: [],
  })
  const svc = c.track(memSupabase(seedRows(), { unique: LEDGER_UNIQUE }), B)
  const tx: string[] = []
  const deps = {
    gate: async () => ({ allowed: true, reason: "ok" }),
    transition: async (p: { listingId: string; fromState: string }, s: any) => { tx.push(p.fromState); const { error } = await s.from("listings").update({ status: lss.statusForStage("MLS_ACTIVE"), lifecycle_stage: "MLS_ACTIVE" }).eq("id", p.listingId).eq("brokerage_id", B).select("id"); return { success: !error, error: error?.message } },
    now: NOW,
  }
  const notOnFeed = async () => ({ observations: [], consulted: ["rentcast"] })
  const onFeed = async (l: { address: string | null }) => ({ observations: [{ source: "rentcast", mlsNumber: "TB-147J", mlsName: "Stellar", address: String(l.address), status: "Active", listedDate: "2026-10-22" }], consulted: ["rentcast"] })
  const row = () => tbl(svc, "listings").find((x) => x.id === L) ?? {}
  const findings = (code: string) => tbl(svc, "manager_signals").filter((s) => s.signal_type === "listing_lifecycle_finding" && s.payload?.code === code)

  const terms = await quiet(async () => lat.governingListingAgreementTerms(svc, { brokerageId: B, listingId: L })) as Record<string, any>
  const win0 = cdom.resolveComingSoonWindow({ agreementExecutedAt: terms.agreementExecutedAt, listing: row() }, NOW) as Record<string, any>
  c.rule("147F", "COMING SOON STARTS ON THE DAY THE LISTING AGREEMENT WAS EXECUTED (ruling 10; C12 'coming_soon(start = executed_at, planned_mls_live_at)'): the ONE agreement reader dates execution at the LAST party's signature (Oct 2 — not fully_executed_at, which lands after compliance), the window starts that day, and the agreement's planned MLS day is preserved as PLANNED (not verified)",
    terms.ok === true && terms.agreementExecutedAt === "2026-10-02T16:00:00Z" && win0.start === "2026-10-02" && win0.startBasis === "agreement_executed" && win0.plannedLive === "2026-10-20" && win0.verifiedLive === null && win0.open === true,
    `executed ${terms.agreementExecutedAt}; window start ${win0.start} (${win0.startBasis}), planned ${win0.plannedLive}, verified ${win0.verifiedLive ?? "∅"}, open ${win0.open}`)
  const r0 = await quiet(async () => mlv.verifyAndRecordMlsLive(svc, { brokerageId: B, actorUserId: null }, L, { feeds: notOnFeed, now: NOW, lifecycle: deps })) as Record<string, any>
  const finding0 = findings("planned_live_date_passed_unverified").length
  await quiet(async () => mlv.verifyAndRecordMlsLive(svc, { brokerageId: B, actorUserId: null }, L, { feeds: notOnFeed, now: NOW, lifecycle: deps }))
  c.rule("147F", "A DATE NEVER MAKES IT ACTIVE (C12 'active(on MLS verification event, not on a date)'): the planned day (Oct 20) has passed and the feed does not show it — the listing STAYS coming_soon with no transition, and the responsible manager (listing concierge) is told ONCE (a second check re-publishes nothing)",
    r0.ok === true && row().status === "coming_soon" && tx.length === 0 && finding0 === 1 && findings("planned_live_date_passed_unverified").length === 1,
    `status ${row().status}; transitions ${tx.length}; planned_live_date_passed_unverified findings ${finding0} → ${findings("planned_live_date_passed_unverified").length}`)
  const r1 = await quiet(async () => mlv.verifyAndRecordMlsLive(svc, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps })) as Record<string, any>
  const act = ledgerOf(svc, "listing.mls_activation.record")
  const win1 = cdom.resolveComingSoonWindow({ agreementExecutedAt: terms.agreementExecutedAt, listing: row() }, NOW) as Record<string, any>
  c.rule("147F", "ONCE LIVE ON THE MLS IT IS ACTIVE, NOT COMING SOON — LEDGERED (ruling 10; C12): the feed confirms → the verified live day is recorded (Oct 22) → through the activation gate → MLS_ACTIVE / status active, ONE listing.mls_activation.record row (executed); the Coming Soon window closes on the VERIFIED day; the agreed-vs-verified discrepancy goes to the manager",
    r1.ok === true && row().status === "active" && row().lifecycle_stage === "MLS_ACTIVE" && row().mls_live_date_actual === "2026-10-22" && tx.length === 1 && act.length === 1 && act[0].status === "executed" && win1.verifiedLive === "2026-10-22" && win1.open === false && findings("verified_live_differs_from_agreed_date").length === 1,
    `status ${row().status}/${row().lifecycle_stage}; verified ${row().mls_live_date_actual}; transitions ${tx.length}; ledger ${act.length} (${act[0]?.status}); window ${win1.start} → ${win1.verifiedLive} open ${win1.open}`)
  await quiet(async () => mlv.verifyAndRecordMlsLive(svc, { brokerageId: B, actorUserId: null }, L, { feeds: onFeed, now: NOW, lifecycle: deps }))
  c.rule("147F", "…AND ONLY ONCE: re-checking an active listing makes no second transition and no second activation row",
    tx.length === 1 && ledgerOf(svc, "listing.mls_activation.record").length === 1, `transitions ${tx.length}; activation rows ${ledgerOf(svc, "listing.mls_activation.record").length}`)
  // archived — internal yes, public no
  const arc = await quiet(async () => import("../../lib/kernel/listing-archive")) as unknown as Record<string, any>
  const control = await (svc as any).from("listings").select("id").eq("id", L).in("status", lss.publiclyVisibleListingStatuses()).is("deleted_at", null).maybeSingle()
  row().status = "sold"; row().lifecycle_stage = "CLOSED"
  const arch = await quiet(async () => arc.archiveListing(svc, L, B)) as Record<string, any>
  const publicRead = await (svc as any).from("listings").select("id").eq("id", L).in("status", lss.publiclyVisibleListingStatuses()).is("deleted_at", null).maybeSingle()
  const internalRead = await (svc as any).from("listings").select("id, status, deleted_at").eq("id", L).eq("brokerage_id", B).maybeSingle()
  c.rule("147F", "ARCHIVED: INTERNAL YES, PUBLIC NO (ruling 8; C12 'archived (internal only)'; one shared predicate publiclyVisibleListingStatuses): archiving keeps the row and its outcome (sold) and stamps deleted_at; the public read shape returns NOTHING and isListingPubliclyVisible is false; the internal by-id read still returns the record — POSITIVE CONTROL: the same public read returned the listing while it was live",
    arch.ok === true && !!control.data && !publicRead.data && !lss.isListingPubliclyVisible(row()) && !!internalRead.data?.deleted_at && internalRead.data?.status === "sold",
    `public read before archive ${control.data ? "found" : "EMPTY"}; after → ${publicRead.data ? "FOUND (leak)" : "nothing"}; internal → ${internalRead.data ? `${internalRead.data.status}, deleted_at set` : "MISSING"}`)
  const page = strippedRepo("app/listings/[listingId]/page.tsx") ?? ""
  const SHARED = /PUBLIC_LISTING_STATUSES\s*=\s*publiclyVisibleListingStatuses\(\)/
  const filtered = (page.match(/\.in\("status",\s*PUBLIC_LISTING_STATUSES\)\s*\.is\("deleted_at",\s*null\)/g) ?? []).length
  const pageControl = SHARED.test(stripComments("const PUBLIC_LISTING_STATUSES = publiclyVisibleListingStatuses()")) && !SHARED.test(stripComments("// const PUBLIC_LISTING_STATUSES = publiclyVisibleListingStatuses()"))
  c.rule("147F", "THE PUBLIC LISTING PAGE READS THE ONE PREDICATE (C12 'Public readers filter on a single shared predicate'): app/listings/[listingId]/page.tsx derives its status set from publiclyVisibleListingStatuses() and every listing read filters deleted_at IS NULL (stripped source; POSITIVE CONTROL: a commented-out derivation is not one)",
    SHARED.test(page) && filtered >= 1 && pageControl, `shared predicate ${SHARED.test(page)}; filtered reads ${filtered}; finder control ${pageControl}`)
  w.recordLifecycle = false

  // ═══ 2 · ruling 7 — the open-house check-in writer ═══
  w.session = { isAuthenticated: true, brokerageId: B, agentId: AG, userId: U }
  const oh = c.track(memSupabase({
    open_house_events: [{ id: EV, brokerage_id: B, listing_id: OHL, agent_id: AG, status: "scheduled" }],
    listings: [{ id: OHL, brokerage_id: B, address: "5 Sign-In St" }],
    agents: [{ id: AG, user_id: U, brokerage_id: B }, { id: AG2, user_id: U2, brokerage_id: B2 }],
    contacts: [], open_house_attendees: [], contact_consent_events: [], lifecycle_events: [], person_identities: [], person_identity_evidence: [],
  }, { uuidIds: true }), B, B2)
  setSvc(oh)
  const soh = await quiet(async () => import("../../app/actions/seller-open-house")) as unknown as Record<string, any>
  const ev0 = w.events.length
  const ci = await quiet(async () => soh.checkInAttendee({ eventId: EV, name: "Pat Visitor", email: "pat.visitor.f147@example.test", phone: "8135550147", workingWithAgent: false, tcpaConsent: true })) as Record<string, any>
  const att = tbl(oh, "open_house_attendees")[0] ?? {}, contact = tbl(oh, "contacts")[0] ?? {}, consent = tbl(oh, "contact_consent_events")[0] ?? {}
  const captured = [...tbl(oh, "lifecycle_events"), ...w.events.slice(ev0)].some((e) => /attendee/i.test(String(e.event_type ?? e.event ?? "")) && jsonOf(e).includes(String(contact.id)))
  c.rule("147F", "AN OPEN-HOUSE SIGN-IN STILL HAS ITS WRITERS (ruling 7: attendance, identity matching, consent, follow-up and event evidence): a consented sign-in → an attendee AND a Contact (the attendee stamped with it) → the consent row anchored to THAT contact → the contact and the attendee as person-identity evidence → the capture event recorded WITH the contact (what the arbiter's follow-up reader keys on)",
    ci.success === true && !!contact.id && att.contact_id === contact.id && contact.brokerage_id === B && consent.contact_id === contact.id && consent.consented === true
      && tbl(oh, "person_identity_evidence").some((e) => e.entity_type === "contact" && e.entity_id === contact.id) && tbl(oh, "person_identity_evidence").some((e) => e.entity_type === "open_house_attendee" && e.entity_id === att.id) && captured,
    `check-in ${ci.success ? "ok" : ci.error}; attendee→contact ${att.contact_id === contact.id}; consent anchored ${consent.contact_id === contact.id}; identity evidence ${tbl(oh, "person_identity_evidence").length}; capture event with the contact ${captured}`)
  const again = await quiet(async () => soh.checkInAttendee({ eventId: EV, name: "Pat Visitor", email: "pat.visitor.f147@example.test", workingWithAgent: false, tcpaConsent: true })) as Record<string, any>
  const noConsent = await quiet(async () => soh.checkInAttendee({ eventId: EV, name: "No Consent", email: "nc.f147@example.test", workingWithAgent: false, tcpaConsent: false })) as Record<string, any>
  c.rule("147F", "…THE SAME PERSON AGAIN IS THE SAME ATTENDEE, AND NO CONSENT FILES NOTHING: a second sign-in of the same email is a duplicate (one attendee, one contact); a sign-in without the consent box is refused and files no contact — POSITIVE CONTROL for the 'one contact' count: the consented sign-in above filed exactly one",
    again.duplicate === true && tbl(oh, "open_house_attendees").length === 1 && tbl(oh, "contacts").length === 1 && noConsent.success === false,
    `again → duplicate ${again.duplicate}; attendees ${tbl(oh, "open_house_attendees").length}, contacts ${tbl(oh, "contacts").length}; no consent → ${noConsent.success === false ? "refused" : "FILED"}`)
  const ohk = await quiet(async () => import("../../app/actions/open-house-kernel")) as unknown as Record<string, any>
  const foreign = await quiet(async () => ohk.completeOpenHouseCheckInAction({ brokerage_id: B2, agent_id: AG2, open_house_id: EV, first_name: "Eve", last_name: "Other", email: "eve.f147@example.test", check_in_method: "manual" })) as Record<string, any>
  c.rule("147F", "THE WALK-IN DOOR TAKES ITS TENANT FROM THE SESSION (CLAUDE.md §4; the IDOR lane 147F closed): a body brokerage that is not the session's is REFUSED and nothing is filed into it",
    foreign.success === false && !tbl(oh, "contacts").some((x) => x.brokerage_id === B2) && !tbl(oh, "open_house_attendees").some((x) => x.brokerage_id === B2), jsonOf(foreign).slice(0, 160))
  w.session = null

  // ═══ 3 · ruling 11 — the five actions: lands · replays · fails closed ═══
  const actionSeed = () => ({
    brokerages: [{ id: B, plan_tier: "brokerage", slug: "f147j", name: "Gulf Realty 147J" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", first_name: "Fay", last_name: "Lane" }],
    agents: [{ id: AG, user_id: U, brokerage_id: B }],
    contacts: [{ id: K, brokerage_id: B, first_name: "Dana", last_name: "Card", email: "dana.f147@example.test", phone: null, address: null, enrichment_profile: {}, notes: null, contact_type: "buyer" }],
    business_card_scans: [{ id: SCAN, brokerage_id: B, agent_id: AG, contact_id: K, review_status: "approved", extracted_data: { first_name: "Dana", last_name: "Card", email: "dana.f147@example.test" }, subject_notes: null, card_subject_type: "contact", classified_by: "picker" }],
    listings: [{ id: L, brokerage_id: B, agent_id: AG, address: "1 Ledger Ln" }],
    tenant_custom_domains: [], agent_action_ledger: [], audit_log: [],
  })
  const REFUSE = { agent_action_ledger: "permission denied for table agent_action_ledger" }
  // (a) business_card.scan.confirm
  {
    w.caller = { brokerageId: B, agentId: AG, userId: U, userType: "broker_owner" }
    const s = c.track(memSupabase(actionSeed(), { unique: LEDGER_UNIQUE }), B); setSvc(s)
    const bc = await quiet(async () => import("../../app/actions/business-card/business-card-actions")) as unknown as Record<string, any>
    const fields = { first_name: "Dana", last_name: "Card-Lee", email: "dana.f147@example.test" }
    const first = await quiet(async () => bc.confirmBusinessCardScan({ scanId: SCAN, fields })) as Record<string, any>
    const n1 = ledgerOf(s, "business_card.scan.confirm").length
    const second = await quiet(async () => bc.confirmBusinessCardScan({ scanId: SCAN, fields })) as Record<string, any>
    const n2 = ledgerOf(s, "business_card.scan.confirm").length
    const ref = c.track(memSupabase(actionSeed(), { refuse: REFUSE }), B); setSvc(ref)
    const before = jsonOf(tbl(ref, "contacts")[0])
    const refused = await quiet(async () => bc.confirmBusinessCardScan({ scanId: SCAN, fields })) as Record<string, any>
    c.rule("147F", "business_card.scan.confirm — LANDS, REPLAYS, FAILS CLOSED (ruling 11): one executed ledger row; the SAME confirmation again does not act and says it was already recorded; a refused claim changes nothing and says it could not be recorded (never 'already recorded')",
      first.ok === true && n1 === 1 && ledgerOf(s, "business_card.scan.confirm")[0]?.status === "executed" && second.ok === false && /already recorded/.test(String(second.error)) && n2 === 1
        && refused.ok === false && /could not be recorded/.test(String(refused.error)) && !/already recorded/.test(String(refused.error)) && jsonOf(tbl(ref, "contacts")[0]) === before,
      `first ${first.ok} (rows ${n1}); second → ${String(second.error ?? second.ok).slice(0, 50)} (rows ${n2}); refused → ${String(refused.error ?? refused.ok).slice(0, 60)}`)
    const src = strippedRepo("app/actions/business-card/business-card-actions.ts") ?? ""
    const fn = src.slice(src.indexOf("async function crosswalkBusinessIdentity("), src.indexOf("async function stampCardProvenance("))
    const keyed = /idempotencyKey:\s*`business_card_crosswalk:\$\{scanId\}`/.test(fn)
    const inside = /withActionLedger<[^>]*>\([\s\S]*?async \(\) => \{[\s\S]*?runVersiumBusinessIdentityLeg\(/.test(fn)
    const aware = /replay:\s*\(claim\)\s*=>\s*claim\.kind === "refused"/.test(fn)
    const ctl = /idempotencyKey:\s*`business_card_crosswalk:\$\{scanId\}`/.test(stripComments("idempotencyKey: `business_card_crosswalk:${scanId}`")) && !/idempotencyKey:\s*`business_card_crosswalk:\$\{scanId\}`/.test(stripComments("// idempotencyKey: `business_card_crosswalk:${scanId}`"))
    c.rule("147F", "business_card.scan.identity_crosswalk (module-private — judged on STRIPPED source): keyed on the scan (one row per scan → the paid leg replays, never pays twice), the paid leg runs INSIDE the claim, and the replay hook tells a refusal apart (POSITIVE CONTROL: a commented-out key is not a key)",
      fn.length > 0 && keyed && inside && aware && ctl, `body found ${fn.length > 0}; keyed ${keyed}; inside the claim ${inside}; refusal-aware ${aware}; control ${ctl}`)
  }
  // (b) tenant.custom_domain.attach | verify | detach
  {
    const envBefore = { t: process.env.VERCEL_TOKEN, p: process.env.VERCEL_PROJECT_ID }
    process.env.VERCEL_TOKEN = "wave147-canary-fake"; process.env.VERCEL_PROJECT_ID = "prj_wave147_canary"
    try {
      w.caller = { brokerageId: B, userId: U, userType: "broker_owner" }
      w.connector = []
      const s = c.track(memSupabase(actionSeed(), { unique: LEDGER_UNIQUE, uuidIds: true }), B); setSvc(s)
      const cd = await quiet(async () => import("../../app/actions/custom-domains")) as unknown as Record<string, any>
      const T1 = "2026-10-31T12:00:00.000Z", T2 = "2026-10-31T12:05:00.000Z"
      const calls = (m: string) => (w.connector ?? []).filter((x) => x.method === m).length
      const add = await quiet(async () => atInstant(T1, () => cd.addCustomDomainAction("homes.gulf147j.test"))) as Record<string, any>
      const id = String(tbl(s, "tenant_custom_domains")[0]?.id)
      const v1 = await quiet(async () => atInstant(T1, () => cd.checkCustomDomainStatusAction(id))) as Record<string, any>
      const getsAfter1 = calls("GET")
      const v2 = await quiet(async () => atInstant(T1, () => cd.checkCustomDomainStatusAction(id))) as Record<string, any>
      const d1 = await quiet(async () => atInstant(T2, () => cd.removeCustomDomainAction(id))) as Record<string, any>
      const delsAfter1 = calls("DELETE")
      const d2 = await quiet(async () => atInstant(T2, () => cd.removeCustomDomainAction(id))) as Record<string, any>
      // attach replay: the SAME connect cycle again — under the frozen clock a revive reuses (row id, connect instant)
      const reAdd = await quiet(async () => atInstant(T1, () => cd.addCustomDomainAction("homes.gulf147j.test"))) as Record<string, any>
      c.rule("147F", "tenant.custom_domain.attach | verify | detach — LAND AND REPLAY (ruling 11; computed names through ledgeredRoutingCall): attach → one row + one routing POST, the same connect cycle again POSTs nothing; verify → one row, the same check at the same instant asks the routing layer nothing more; detach → one row + one routing DELETE, removing again detaches nothing",
        add.ok === true && ledgerOf(s, "tenant.custom_domain.attach").length === 1 && reAdd.ok === true && calls("POST") === 1
          && v1.ok === true && v2.ok === true && ledgerOf(s, "tenant.custom_domain.verify").length === 1 && calls("GET") === getsAfter1
          && d1.ok === true && d2.ok === true && ledgerOf(s, "tenant.custom_domain.detach").length === 1 && delsAfter1 === 1 && calls("DELETE") === 1,
        `attach ${add.ok}/${reAdd.ok} rows ${ledgerOf(s, "tenant.custom_domain.attach").length} POST ${calls("POST")}; verify rows ${ledgerOf(s, "tenant.custom_domain.verify").length} GET ${getsAfter1}→${calls("GET")}; detach rows ${ledgerOf(s, "tenant.custom_domain.detach").length} DELETE ${calls("DELETE")}`)
      w.connector = []
      const ref = c.track(memSupabase(actionSeed(), { refuse: REFUSE, uuidIds: true }), B); setSvc(ref)
      const rAdd = await quiet(async () => atInstant(T1, () => cd.addCustomDomainAction("refused.gulf147j.test"))) as Record<string, any>
      const rRow = tbl(ref, "tenant_custom_domains")[0] ?? {}
      const rAtAttach = { status: rRow.status, verification: { ...(rRow.verification ?? {}) } }
      const beforeCheck = jsonOf(rRow)
      const rCheck = await quiet(async () => atInstant(T2, () => cd.checkCustomDomainStatusAction(String(rRow.id)))) as Record<string, any>
      const afterCheck = jsonOf(tbl(ref, "tenant_custom_domains")[0])
      const rDel = await quiet(async () => atInstant(T2, () => cd.removeCustomDomainAction(String(rRow.id)))) as Record<string, any>
      const gone = tbl(ref, "tenant_custom_domains")[0] ?? {}
      c.rule("147F", "…AND FAIL CLOSED: with the ledger refusing, attach makes NO routing POST and answers ok:false with the row still pending_dns claiming no registration; verify makes no GET and patches nothing; detach makes no DELETE — the host stops being served (row removed, the safe direction) and the row SAYS the routing detach did not run",
        rAdd.ok === false && calls("POST") === 0 && rAtAttach.status === "pending_dns" && rAtAttach.verification?.registered_with_vercel !== true && rCheck.ok === false && calls("GET") === 0 && beforeCheck === afterCheck
          && calls("DELETE") === 0 && gone.status === "removed" && /routing detach failed: the action ledger refused/.test(String(gone.error_detail ?? "")),
        `attach → ${rAdd.ok ? "OK" : "refused"} (POST ${calls("POST")}, row ${rAtAttach.status}, registered ${rAtAttach.verification?.registered_with_vercel === true}); verify → ${rCheck.ok ? "OK" : "refused"} (GET ${calls("GET")}, patched ${beforeCheck !== afterCheck}); detach → row ${gone.status}, DELETE ${calls("DELETE")}, "${String(gone.error_detail ?? "").slice(0, 60)}"`)
    } finally {
      if (envBefore.t === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = envBefore.t
      if (envBefore.p === undefined) delete process.env.VERCEL_PROJECT_ID; else process.env.VERCEL_PROJECT_ID = envBefore.p
      w.connector = null
    }
  }
  // (c) listing.agreement_amendment.record
  {
    w.caller = { brokerageId: B, userId: U, userType: "broker_owner" }
    w.amendments = 0
    const s = c.track(memSupabase(actionSeed(), { unique: LEDGER_UNIQUE }), B); setSvc(s)
    const am = await quiet(async () => import("../../app/actions/seller-listing/listing-agreement-amendment")) as unknown as Record<string, any>
    const input = { listingId: L, documentId: DOC, executedOn: "2026-10-30", comingSoonStreetAddressAuthorized: true }
    const a1 = await quiet(async () => am.recordListingAgreementAmendmentAction(input)) as Record<string, any>
    const a2 = await quiet(async () => am.recordListingAgreementAmendmentAction(input)) as Record<string, any>
    const wrote = w.amendments
    const ref = c.track(memSupabase(actionSeed(), { refuse: REFUSE }), B); setSvc(ref)
    w.amendments = 0
    const a3 = await quiet(async () => am.recordListingAgreementAmendmentAction(input)) as Record<string, any>
    c.rule("147F", "listing.agreement_amendment.record — LANDS, REPLAYS, FAILS CLOSED (ruling 11): one ledger row and the domain writer ran once; the same amendment document again records no second version ('already recorded'); a refused claim records no amendment and names the refusal",
      a1.success === true && ledgerOf(s, "listing.agreement_amendment.record").length === 1 && a2.success === false && /already recorded/.test(String(a2.error)) && wrote === 1 && a3.success === false && /ledger refused/.test(String(a3.error)) && w.amendments === 0,
      `first ${a1.success}; second → ${String(a2.error ?? a2.success).slice(0, 50)}; domain writes ${wrote}; refused → ${String(a3.error ?? a3.success).slice(0, 60)} (writes ${w.amendments})`)
    w.amendments = null
  }
  w.caller = null
  // (d) life_change.signal.respond (lane 147G's file)
  {
    const s = c.track(memSupabase(actionSeed(), { unique: LEDGER_UNIQUE }), B); setSvc(s)
    const arb = await quiet(async () => import("../../lib/ai-isa/followup-arbiter")) as unknown as Record<string, any>
    let engaged = 0
    const deps2 = { recordSignal: async () => ({ id: "f147-sig-1" }), engage: async () => { engaged++; return { success: true, channel: "email" } } }
    const input = { brokerageId: B, subject: { type: "contact", id: K }, signalType: "relocation_detected", source: "wave147-canary", now: new Date("2026-10-31T09:00:00Z") }
    const r1b = await quiet(async () => arb.respondToLifeChangeSignal(s, input, deps2)) as Record<string, any>
    const r2b = await quiet(async () => arb.respondToLifeChangeSignal(s, input, deps2)) as Record<string, any>
    const engagedTwice = engaged
    const ref = c.track(memSupabase(actionSeed(), { refuse: { agent_action_ledger: "permission denied" } }), B)
    engaged = 0
    const r3b = await quiet(async () => arb.respondToLifeChangeSignal(ref, input, deps2)) as Record<string, any>
    c.rule("147F", "life_change.signal.respond — LANDS, REPLAYS, FAILS CLOSED (ruling 11): one ledger row and the ISA engaged once; the same signal the same day does not engage twice; a refused claim does NOT engage the person",
      ledgerOf(s, "life_change.signal.respond").length === 1 && r1b.action === "isa_engagement" && r2b.action === "replayed" && engagedTwice === 1 && engaged === 0,
      `first ${r1b.action} (rows ${ledgerOf(s, "life_change.signal.respond").length}); second ${r2b.action}; engagements ${engagedTwice}; refused → engaged ${engaged} (${r3b.action})`)
    // Lane 147F Outside-lane 1 (→ 147G / 147Z): a refused claim is labelled a refusal, not 'replayed' ("already answered today").
    const arbSrc = strippedRepo("lib/ai-isa/followup-arbiter.ts") ?? ""
    const AWARE = /replay:\s*\(claim\)\s*=>\s*claim\.kind\s*===\s*"refused"\s*\?\s*refused\(/
    const awareControl = AWARE.test(stripComments('replay: (claim) => claim.kind === "refused" ? refused(`the action ledger refused: ${claim.error}`, subjectClass) : out')) && !AWARE.test(stripComments("replay: () => out"))
    c.convergence("147F", "…A REFUSED CLAIM IS LABELLED A REFUSAL, NOT 'REPLAYED' (lane 147F Outside-lane 1 → 147G/147Z: respondToLifeChangeSignal's replay hook reads the claim's kind)",
      AWARE.test(arbSrc) && awareControl, r3b.action === "refused", `stripped hook refusal-aware ${AWARE.test(arbSrc)}; refused claim answered "${r3b.action}"; finder control ${awareControl}`)
  }

  c.blind("Every runtime step runs on memSupabase (no RLS, CHECK, FK or trigger). The activation gate, the kernel transition and the MLS feeds are injected (their own proofs: test:listing-activation-gate, test:listing-status-two-senses, test:mls-syndication); the lifecycle-event writer is a recorded edge. The check-in canary drives the event-day door and the walk-in door only (the kiosk, dashboard and mobile doors are lane 147F's stage matrix, test:event-checkin-writers). The five actions run behind the same seams lane 147F's census uses (session / caller gates, routing transport, DNS, the amendment's domain writer); the crosswalk is module-private and judged on stripped source; the §14 name visibility and the repository-wide evidence census are test:action-evidence-census / test:action-ledger.")
  return c.report()
}
