/**
 * scripts/canaries/wave145-listings.ts — LISTINGS canary (wave 145, lane 145J; owner rulings 1 + 2, contract C7):
 *   RULING 1 — public Coming Soon creative OMITS the street address by default; it is disclosed only when the seller's
 *   authorization AND an applicable approved brokerage/MLS policy both permit it; withholding the address never exempts the listing
 *   from its MLS obligations (no nationwide hardcoded rule — jurisdiction/MLS-scoped and cited); the full address stays internal.
 *   RULING 2 — the seller's requested MLS live date comes from the EXECUTED listing agreement (+ addenda); intake pulls it; it is
 *   corrected only through the agreement/amendment path (C7 — the same versioned mechanism as post-transaction addenda) and never
 *   overwritten; "MLS live" only when VERIFIED; a date change reaches alerts, the marketing schedule, the concierge, policy checks
 *   and customer communication.
 *
 * Through the survivors at b364eb4b: lib/compliance/coming-soon-policy.ts evaluateComingSoonReadiness (pure),
 * lib/listings/mls-live-date.ts recordPlannedMlsLiveDate / recordVerifiedMlsLive (driven on the in-memory client),
 * lib/offers/governing-terms.ts (the C7 versioned survivor). Lane 145B's creative door, agreement reader and amendment path bind at
 * the `WAVE145 BIND` lines once its notes publish them.
 *
 * MEASURED AT b364eb4b: recordPlannedMlsLiveDate accepts a date from ANY PlannedDateSource ("intake" | "timeline" | "launch" |
 * "agreement" | "agent_assistant") and overwrites whatever is stored — a seller-agreed date from the executed agreement can be
 * replaced by a typed one; no listing-creative door redacts the street address for a Coming Soon.
 */
import { CANARY_TAG, LIVE, canaryClient, cleanupCanary, uuid } from "./_harness"
import { findLanded, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { bindContract, canary145, quiet } from "./wave145-harness"

// ── WAVE145 BIND (lane 145B notes, "## Canary requirements", published 16:08Z) ─────────────────────────────────────────────────
// lib/marketing/listing-public-address.ts resolveComingSoonCreativeAddress · guardComingSoonCreativeText; lib/listings/listing-agreement-
// terms.ts governingListingAgreementTerms · recordOriginalListingAgreementTerms · recordListingAgreementAmendment (C7 — on
// contract_term_versions, anchored by listing_agreement_id); lib/listings/mls-live-date.ts followSellerAgreedMlsLiveDate; the agreement
// terms seller_requested_mls_live_date / coming_soon_street_address_authorized (m856). The fixtures are lane 145B's own
// (scripts/listing-coming-soon-live-date-guard.ts); the assertions are the rulings. The server-action doors (markAgreementSigned,
// activateComingSoon, recordListingAgreementAmendmentAction) need a session and are proved by lane 145B's guard; the canary drives the
// library doors they call.

export async function run() {
  const c = canary145("Listings: Coming Soon withholds the street address unless seller-authorized AND policy-permitted · never an MLS exemption · seller-agreed MLS live date from the executed agreement, amended only through the versioned path · 'live' only when verified")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const cs = await import("../../lib/compliance/coming-soon-policy")

  // ── 1 · NO NATIONWIDE CONSTANT: unknown = closed; one MLS's attested rule never covers another state (green — preserve) ──
  const flEntry = {
    mls_slug: "stellar_mls", mls_name: "Stellar MLS", state_codes: ["FL"], permitted: true, max_days: 21, showings_permitted: false, mls_submission_within_business_days: 1,
    source: { url: "https://www.stellarmls.com/rules", rule_ref: "Rule 4.1", title: "Coming Soon", verified_on: "2026-10-01" }, attestation: { user_id: "u1", user_type: "compliance_officer", at: "2026-10-01T00:00:00Z" }, updated_at: "2026-10-01T00:00:00Z",
  }
  const policy = { entries: { stellar_mls: flEntry }, rejected: [] } as never
  const none = cs.evaluateComingSoonReadiness(null, { stateCode: "FL" })
  const tx = cs.evaluateComingSoonReadiness(policy, { stateCode: "TX" })
  const fl = cs.evaluateComingSoonReadiness(policy, { stateCode: "FL", mlsSlug: "stellar_mls", daysInComingSoon: 3 })
  c.rule("145B", "NO NATIONWIDE HARDCODED RULE (ruling 1: 'No nationwide hardcoded rule … local MLS rules vary'): with no attested policy a Coming Soon is CLOSED (unknown, not ready); an MLS rule attested for Florida does not govern a Texas listing; the Florida listing is judged on its MLS's cited rule (source URL + rule reference carried) — green, preserve", !none.ready && none.status === "unknown" && !tx.ready && tx.status === "unknown" && fl.ready && fl.status === "attested" && !!fl.source?.url, `none ${none.status}/${none.ready}; TX ${tx.status}/${tx.ready}; FL ${fl.status}/${fl.ready} cited ${fl.source?.rule_ref ?? "—"}`)

  // ── 2 · WITHHOLDING THE ADDRESS IS NOT AN MLS EXEMPTION (green — preserve; an address flag must never clear a blocker) ──
  const late = { stateCode: "FL", mlsSlug: "stellar_mls", daysInComingSoon: 3, showingsScheduled: 2, businessDaysSincePublicMarketing: 4 }
  const shown = cs.evaluateComingSoonReadiness(policy, late)
  const withheld = cs.evaluateComingSoonReadiness(policy, { ...late, addressWithheld: true, streetAddressDisclosed: false, addressDisclosure: "withheld" } as never)
  c.rule("145B", "WITHHOLDING THE STREET ADDRESS DOES NOT EXEMPT PUBLIC ADVERTISING FROM MLS OBLIGATIONS (ruling 1: NAR Clear Cooperation / Multiple Listing Options; submission deadlines; showings): a publicly marketed Coming Soon past its MLS submission window with showings booked is blocked by name, and the SAME listing with the address withheld carries the SAME blockers", !shown.ready && shown.blockers.length >= 2 && JSON.stringify(withheld.blockers) === JSON.stringify(shown.blockers), `address shown: ${shown.blockers.length} blocker(s); withheld: ${withheld.blockers.length} — ${shown.blockers[0]?.slice(0, 90) ?? ""}`)

  // ── 3 · THE PUBLIC CREATIVE OMITS THE STREET ADDRESS BY DEFAULT; disclosure needs BOTH the seller's executed authorization AND an
  //        attested policy permitting it; a refused read keeps the street out; the creative door refuses copy that names it ──
  const B = uuid(), L = uuid(), AG = uuid(), U = uuid(), LA = uuid(), DOC = uuid(), DOC_SELLERLESS = uuid()
  const lpa = await bindContract({ id: "145B Coming Soon creative address door", lane: "145B", file: "lib/marketing/listing-public-address.ts", exports: ["resolveComingSoonCreativeAddress", "guardComingSoonCreativeText"] })
  const RULE = (o: Record<string, unknown> = {}) => ({
    mls_slug: "example_coast_mls", mls_name: "Example Coast MLS", state_codes: ["FL"], permitted: true, max_days: 21, showings_permitted: false, mls_submission_within_business_days: 1,
    source: { url: "https://rules.example-coast-mls.test/coming-soon", rule_ref: "Sec. 1.3", title: null, verified_on: "2026-10-27" }, attestation: { user_id: U, user_type: "compliance_officer", at: "2026-10-27T00:00:00Z" }, updated_at: "2026-10-27T00:00:00Z", ...o,
  })
  const lrow = { id: L, brokerage_id: B, address: "123 N Main St", city: "Tampa", state: "FL", zip: "33601" }
  const agreementRow = (o: Record<string, unknown> = {}) => ({ id: LA, listing_id: L, brokerage_id: B, esign_status: "fully_signed", seller_signed_at: "2026-10-20T10:00:00Z", agent_signed_at: "2026-10-20T10:00:00Z", fully_executed_at: null, created_at: "2026-10-20T10:00:00Z", seller_requested_mls_live_date: "2026-11-04", coming_soon_street_address_authorized: true, ...o })
  const world = (o: { rule?: Record<string, unknown> | null; agreement?: Record<string, unknown> | null; refuse?: Record<string, string> } = {}) => memSupabase({
    brokerage_settings: [{ id: "s", brokerage_id: B, settings: o.rule === null ? {} : { coming_soon_policy: { mls: { example_coast_mls: RULE(o.rule ?? { street_address_disclosure_permitted: true }) } } } }],
    listing_agreements: o.agreement === null ? [] : [agreementRow(o.agreement ?? {})], contract_term_versions: [],
  }, { refuse: o.refuse })
  await c.check("145B", "THE PUBLIC COMING SOON CREATIVE OMITS THE STREET ADDRESS BY DEFAULT (ruling 1: 'You can advertise a coming soon only if you don't disclose the street address, unless otherwise'): with no attested rule and no recorded authorization the public line is the city + state only; the seller's executed authorization ALONE, or an attested policy ALONE, still withholds it; BOTH disclose it (positive control); a refused policy read or a refused agreement read keeps the street out (fail closed); the creative door REFUSES copy that names the street on a withheld listing and passes the same copy without it", async () => {
    if (!lpa.mod) return { ok: false, evidence: `${lpa.evidence}; findLanded: ${findLanded(["lib/marketing", "lib/listings"], /\b(redact\w*Address|withhold\w*Address|addressDisclos\w*|omitStreet\w*|publicAddress\w*)\b/) ?? "nothing"}` }
    const resolve = async (policyClient: unknown, termsClient: unknown) => (await quiet(async () => lpa.mod!.resolveComingSoonCreativeAddress({ policyClient, termsClient, listing: lrow }))) as { decision: { disclose: boolean; withheldBecause: string[] }; addressLine: string; publicLocation: string }
    const empty = memSupabase({ brokerage_settings: [], listing_agreements: [] })
    const deflt = await resolve(empty, empty)
    const both = await resolve(world(), world())
    const sellerOnly = await resolve(world({ rule: {} }), world({ rule: {} }))
    const policyOnly = await resolve(world({ agreement: { coming_soon_street_address_authorized: false } }), world({ agreement: { coming_soon_street_address_authorized: false } }))
    const refPolicy = await resolve(world({ refuse: { brokerage_settings: "permission denied for table brokerage_settings" } }), world())
    const refTerms = await resolve(world(), world({ refuse: { listing_agreements: "permission denied for table listing_agreements" } }))
    const street = (s: string) => /123\s+N\s+Main/i.test(s)
    const guarded = lpa.mod.guardComingSoonCreativeText("Coming soon: 123 N Main St — 3 bed, 2 bath near the bay", lrow, deflt, "refuse") as { ok: boolean; findings: string[] }
    const clean = lpa.mod.guardComingSoonCreativeText("Coming soon in Tampa, FL — 3 bed, 2 bath near the bay", lrow, deflt, "refuse") as { ok: boolean }
    const ok = !deflt.decision.disclose && !street(deflt.addressLine) && /Tampa/.test(deflt.addressLine) && both.decision.disclose && street(both.addressLine) && !sellerOnly.decision.disclose && !policyOnly.decision.disclose && !refPolicy.decision.disclose && !refTerms.decision.disclose && !guarded.ok && clean.ok
    return { ok, evidence: `default → "${deflt.addressLine}" (disclose ${deflt.decision.disclose}); both → "${both.addressLine}"; seller-only ${sellerOnly.decision.disclose}; policy-only ${policyOnly.decision.disclose}; refused policy read ${refPolicy.decision.disclose}; refused agreement read ${refTerms.decision.disclose}; creative naming the street → ${guarded.ok ? "PASSED" : "refused"}; without it → ${clean.ok ? "passes" : "REFUSED"}` }
  })

  // ── 4–7 · RULING 2 + C7 on the in-memory client: the seller-agreed date, overwrite refusal, the amendment path, verified-only 'live' ──
  const signed = (roles: string[]) => ({ signatures: roles.map((r) => ({ signer_role: r, signed: true })) })
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Listings Brokerage` }],
    users: [{ id: U, email: `agent-${U.slice(0, 6)}@wave140-canary.test`, brokerage_id: B }],
    agents: [{ id: AG, brokerage_id: B, user_id: U }],
    listings: [{ id: L, brokerage_id: B, agent_id: AG, address: lrow.address, city: lrow.city, state: "FL", zip: lrow.zip, go_live_date: null, lifecycle_stage: "COMING_SOON_PREP", go_live_confirmed_at: null, mls_live_date_actual: null, mls_live_timezone: "America/New_York" }],
    listing_agreements: [agreementRow({ seller_requested_mls_live_date: null, coming_soon_street_address_authorized: null })],
    contract_term_versions: [], notifications: [], global_settings: [],
    documents: [{ id: DOC, brokerage_id: B, listing_id: L, signature_completeness: signed(["seller", "agent"]) }, { id: DOC_SELLERLESS, brokerage_id: B, listing_id: L, signature_completeness: signed(["agent"]) }],
  })
  const mld = await import("../../lib/listings/mls-live-date") as unknown as Record<string, any>
  const lat = await bindContract({ id: "145B listing-agreement governing terms (C7)", lane: "145B", file: "lib/listings/listing-agreement-terms.ts", exports: ["governingListingAgreementTerms", "recordOriginalListingAgreementTerms", "recordListingAgreementAmendment"] })
  const D1 = "2026-11-04", D2 = "2026-11-11"
  const goLive = () => String((svc.tables.listings ?? []).find((r) => r.id === L)?.go_live_date ?? "").slice(0, 10)
  let followed: Record<string, any> | null = null
  await c.check("145B", "INTAKE PULLS THE SELLER'S REQUESTED MLS LIVE DATE FROM THE EXECUTED LISTING AGREEMENT (ruling 2: 'check the listing agreement'): the agreement's term is recorded ONCE on the executed agreement (a second write is refused — the amendment is the path), the governing reader returns it, and the listing's planned date follows it — never a verified 'live' column", async () => {
    if (!lat.mod || typeof mld.followSellerAgreedMlsLiveDate !== "function") return { ok: false, evidence: `${lat.evidence}${typeof mld.followSellerAgreedMlsLiveDate === "function" ? "" : "; lib/listings/mls-live-date.ts has no followSellerAgreedMlsLiveDate (lane 145B)"}` }
    const o1 = await quiet(async () => lat.mod!.recordOriginalListingAgreementTerms(svc, { brokerageId: B, agreementId: LA, terms: { seller_requested_mls_live_date: D1, coming_soon_street_address_authorized: false } })) as { ok: boolean }
    const o2 = await quiet(async () => lat.mod!.recordOriginalListingAgreementTerms(svc, { brokerageId: B, agreementId: LA, terms: { seller_requested_mls_live_date: D2 } })) as { ok: boolean; reason?: string }
    const gov = await quiet(async () => lat.mod!.governingListingAgreementTerms(svc, { brokerageId: B, listingId: L })) as { ok: boolean; sellerRequestedMlsLiveDate?: string | null }
    const unsigned = await quiet(async () => lat.mod!.governingListingAgreementTerms(memSupabase({ listing_agreements: [agreementRow({ esign_status: "sent", seller_signed_at: null })] }), { brokerageId: B, listingId: L })) as { ok: boolean; sellerRequestedMlsLiveDate?: string | null }
    followed = await quiet(async () => mld.followSellerAgreedMlsLiveDate(svc, { brokerageId: B, listingId: L, actorUserId: U, via: "agreement" })) as Record<string, any>
    const row = (svc.tables.listings ?? []).find((r) => r.id === L) ?? {}
    return { ok: o1.ok && !o2.ok && /amendment/i.test(o2.reason ?? "") && gov.ok && gov.sellerRequestedMlsLiveDate === D1 && unsigned.ok && !unsigned.sellerRequestedMlsLiveDate && !!followed?.ok && goLive() === D1 && !row.mls_live_date_actual && !row.go_live_confirmed_at, evidence: `original terms → ${o1.ok}; second write → ${o2.ok ? "ACCEPTED" : (o2.reason ?? "").slice(0, 80)}; governs ${gov.sellerRequestedMlsLiveDate ?? "∅"}; unsigned agreement governs ${unsigned.sellerRequestedMlsLiveDate ?? "nothing"}; listing planned ${goLive() || "∅"}; verified cols ${row.mls_live_date_actual ?? "∅"}/${row.go_live_confirmed_at ?? "∅"}` }
  })
  const typed = await quiet(() => mld.recordPlannedMlsLiveDate(svc as never, { brokerageId: B, listingId: L, date: "2026-12-01", actorUserId: U, source: "timeline" })) as { ok: boolean; reason?: string }
  const cleared = await quiet(() => mld.recordPlannedMlsLiveDate(svc as never, { brokerageId: B, listingId: L, date: null, actorUserId: U, source: "intake" })) as { ok: boolean; reason?: string }
  const noAgreementDb = memSupabase({ listings: [{ id: L, brokerage_id: B, agent_id: AG, state: "FL", go_live_date: null, lifecycle_stage: "COMING_SOON_PREP" }], listing_agreements: [], global_settings: [] })
  const legacy = await quiet(() => mld.recordPlannedMlsLiveDate(noAgreementDb as never, { brokerageId: B, listingId: L, date: "2026-11-20", actorUserId: U, source: "timeline" })) as { ok: boolean }
  c.rule("145B", "THE SELLER-AGREED MLS LIVE DATE IS NEVER OVERWRITTEN OUTSIDE THE AMENDMENT PATH (ruling 2 + C7: 'correction only through the agreement/amendment path; never overwrite the seller-agreed date'): with an executed agreement carrying the seller's date, a different date typed on the timeline and a clear from intake are both REFUSED naming the amendment path and the date stays the agreement's; with NO executed agreement a person's plan is still recorded (control)", !typed.ok && /amendment/i.test(typed.reason ?? "") && !cleared.ok && goLive() === D1 && legacy.ok, `typed → ${typed.ok ? "ACCEPTED" : `refused (${(typed.reason ?? "").slice(0, 90)})`}; clear → ${cleared.ok ? "ACCEPTED" : "refused"}; stored ${goLive() || "∅"}; no agreement → ${legacy.ok ? "recorded" : "refused"}`)

  await c.check("145B", "THE AMENDMENT PATH IS THE VERSIONED GOVERNING-TERMS MECHANISM (contract C7 — the same contract_term_versions survivor as post-transaction addenda): an executed amendment (seller + agent signed) records ONE executed amendment version anchored to the listing agreement, the planned date follows it, the ORIGINAL agreement row still reads the original date (kept as the superseded term); a paper without the seller's signature is refused", async () => {
    if (!lat.mod || typeof mld.followSellerAgreedMlsLiveDate !== "function") return { ok: false, evidence: lat.evidence }
    const sellerless = await quiet(async () => lat.mod!.recordListingAgreementAmendment(svc, { brokerageId: B, listingId: L, documentId: DOC_SELLERLESS, executedOn: "2026-10-25", terms: { seller_requested_mls_live_date: D2 }, recordedBy: U, now: new Date("2026-10-27T12:00:00Z") })) as { ok: boolean }
    const amend = await quiet(async () => lat.mod!.recordListingAgreementAmendment(svc, { brokerageId: B, listingId: L, documentId: DOC, executedOn: "2026-10-25", terms: { seller_requested_mls_live_date: D2 }, recordedBy: U, now: new Date("2026-10-27T12:00:00Z") })) as { ok: boolean; versionNo?: number }
    followed = await quiet(async () => mld.followSellerAgreedMlsLiveDate(svc, { brokerageId: B, listingId: L, actorUserId: U, via: "amendment", amendmentVersion: amend.versionNo ?? 1 })) as Record<string, any>
    const versions = (svc.tables.contract_term_versions ?? []).filter((r) => r.brokerage_id === B)
    const v = versions[0] ?? {}
    const original = (svc.tables.listing_agreements ?? []).find((r) => r.id === LA)?.seller_requested_mls_live_date
    return { ok: !sellerless.ok && amend.ok && versions.length === 1 && v.source === "amendment" && v.status === "executed" && !!v.listing_agreement_id && goLive() === D2 && String(original).slice(0, 10) === D1, evidence: `seller-less paper → ${sellerless.ok ? "ACCEPTED" : "refused"}; amendment → ${amend.ok ? `v${amend.versionNo}` : "refused"}; versions ${versions.length} (${v.source ?? "—"}/${v.status ?? "—"}, anchored to the agreement ${!!v.listing_agreement_id}); planned ${goLive()}; original agreement row ${String(original).slice(0, 10)}` }
  })

  // "MLS LIVE" ONLY WHEN VERIFIED (green — preserve): no step above set a verified column; a person cannot verify; a feed can.
  const rowBefore = { ...((svc.tables.listings ?? []).find((r) => r.id === L) ?? {}) }
  const byAgent = await quiet(() => mld.recordVerifiedMlsLive(svc as never, { brokerageId: B, listingId: L, source: "agent" as never, feedListDate: null, actorUserId: U })) as { ok: boolean }
  const byFeed = await quiet(() => mld.recordVerifiedMlsLive(svc as never, { brokerageId: B, listingId: L, source: "idx", feedListDate: "2026-10-26", actorUserId: null, now: new Date("2026-10-27T12:00:00Z") })) as { ok: boolean }
  const rowV = (svc.tables.listings ?? []).find((r) => r.id === L) ?? {}
  c.rule("145B", "NEVER CLAIM 'MLS LIVE' UNTIL VERIFIED (ruling 2 — green, preserve): every planned / agreed / amended date above left the verified columns empty; a person or the agent cannot verify ('agent' is not a feed — refused); only a syndication feed's observation records the actual live date and its basis", !rowBefore.mls_live_date_actual && !rowBefore.go_live_confirmed_at && !byAgent.ok && byFeed.ok && !!rowV.go_live_confirmed_at && rowV.go_live_confirmed_source === "idx", `verified cols before the feed: ${rowBefore.mls_live_date_actual ?? "∅"}/${rowBefore.go_live_confirmed_at ?? "∅"}; agent → ${byAgent.ok ? "ACCEPTED" : "refused"}; idx → ${byFeed.ok ? `${rowV.mls_live_date_actual} (${rowV.mls_live_date_basis})` : "refused"}`)

  // ── 7 · A DATE CHANGE REACHES THE DEPENDENT WORKFLOWS (ruling 2) ──
  const reached = (((followed as Record<string, any> | null)?.reached ?? []) as string[])
  // The AMENDMENT's bell (the agreement's first follow bells too — null → D1); exactly ONE names the change to D2.
  const bells = (svc.tables.notifications ?? []).filter((n) => /mls_live_date_changed/.test(String(n.type ?? "")) && JSON.stringify(n).includes(D2))
  c.rule("145B", "A SELLER-AGREED DATE CHANGE REACHES THE ALERTS, THE MARKETING SCHEDULE AND THE POLICY CHECKS IN LANE 145B'S DOMAIN (ruling 2): the amendment bells the listing agent once (old → new), re-plans the open-house schedule while it has not started, and leaves the evidence event — the survivors it reached are named", reached.some((r) => /^alert:/.test(r)) && reached.some((r) => /^marketing_schedule:/.test(r)) && bells.length === 1, `reached ${reached.join(", ") || "none"}; agent bells ${bells.length}`)
  const kev = strippedRepo("lib/kernel/events.ts") ?? ""
  const followSrc = strippedRepo("lib/listings/mls-live-date.ts") ?? ""
  // OWNER: the INTEGRATOR — lane 145I's notes (Outside-lane 2, 16:51Z) route LISTING_MLS_LIVE_DATE_CHANGED (lib/kernel/events.ts +
  // event-fanout.ts PORTAL_UPDATE_TEMPLATES) to the integrator, landing in the SAME change as 145B's emit (145B Outside-lane 14).
  c.rule("integrator", "…AND THE LISTING CONCIERGE + THE SELLER HEAR OF IT (ruling 2: 'Date changes reach … listing concierge … customer communication'; lane 145B Outside-lane 14 + lane 145I Outside-lane 2 route it to the integrator — no lane's domain): a kernel event for the MLS live-date change exists in lib/kernel/events.ts and the agreed-date follower emits it (the concierge's signal + the seller's portal update consume it)", /MLS_LIVE_DATE_CHANGED/.test(kev) && /emitKernelEvent\s*\([\s\S]{0,200}MLS_LIVE_DATE_CHANGED/.test(followSrc), `kernel event declared ${/MLS_LIVE_DATE_CHANGED/.test(kev)}; emitted by the follower ${/emitKernelEvent\s*\([\s\S]{0,200}MLS_LIVE_DATE_CHANGED/.test(followSrc)}`)

  c.blind("In memory: no RLS, no trigger, no CHECK. The coming-soon policy is driven as a pure function with a fixture entry (an attested Stellar MLS rule) — no MLS rule is asserted as true of any real MLS. The creative door, the agreement field and the amendment writer are lane 145B's: until its notes name them the steps that need them stay red-awaiting-lane-145B (the binding lines above).")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, `${cl.cleanup.reduce((n, x) => n + Math.max(0, x.deleted), 0)} rows${cl.mismatches.length ? `; ${cl.mismatches.join("; ")}` : ""}`)
  return c.report(cl.cleanup, cl.residual)
}
