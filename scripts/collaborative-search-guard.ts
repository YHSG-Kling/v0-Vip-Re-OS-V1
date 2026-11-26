/**
 * scripts/collaborative-search-guard.ts — C28 COLLABORATIVE SEARCH (wave 149, lane 149B, owner ruling 6).
 * `test:collaborative-search`
 *
 * Owner: "the buyer shares the homes they were searching and brings in a family member to give their opinion on the
 * selected properties." Contract: shareCollection → authorized collaborator view of ONLY those listings → opinions →
 * the buyer sees them → the Shopping Agent uses them only when the buyer says so → the agent is told when appropriate.
 *
 *   A. SHARE — only the buyer's own saved homes (re-read under the tenant), public facts only, a hashed expiring token
 *   B. DELIVERY — email only after the suppression gate; a phone invite is a link the buyer sends (never a platform text)
 *   C. COLLABORATOR VIEW — ONLY the shared homes + their own opinions; no criteria, contact fields, other buyers' homes
 *   D. CREDENTIAL — wrong / expired / revoked / non-feedback_only tokens are refused
 *   E. OPINION — keyed by the member the token proves; a home that was not shared is refused; consensus computed
 *   F. BUYER — sees every opinion by name; can close a link (count-checked)
 *   G. SHOPPING AGENT — nothing without the buyer's yes; the agent signal carries the words only on consent
 *   H. WIRING (stripped source) — the doors are gated; no posted email is trusted; the join page renders the view
 *   I. MIGRATIONS — m937 / m938 carry the lane stamp or the APPLIED stamp on line 1, and the columns the code writes
 *
 * POSITIVE CONTROLS: each absence claim is paired with a check that the finder sees the thing when it IS there.
 *
 * BLIND SPOTS (published): memSupabase does not run RLS, so the narrowed `portal_member_searches()` (m938) is proven
 * only as SQL text; no email is sent (the sender is injected); the pages are not rendered in a browser (wiring is read
 * from stripped source); requireContactAccess itself is proven by its own guards, not re-driven here.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { createHash } from "node:crypto"
import * as share from "../lib/portal/collaborative-share"

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex")
const TTL_DAYS = 7 // the invite email's promise (lib/services/communication.service.tsx)
const opens = async (db: Parameters<typeof share.collaboratorView>[0], token: string, now: Date) => (await share.collaboratorView(db, token, now)).ok

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER_BRK = "22222222-2222-4222-8222-222222222222"
const BUYER = "33333333-3333-4333-8333-333333333333"
const OTHER_BUYER = "44444444-4444-4444-8444-444444444444"
const USER = "55555555-5555-4555-8555-555555555555"
const NOW = new Date("2026-11-03T15:00:00Z")
const SECRET_CRITERIA = "SECRET-CRITERIA-must-not-leak"

function seed() {
  return memSupabase({
    contacts: [
      { id: BUYER, brokerage_id: BRK, first_name: "Dana", last_name: "Reyes", email: "dana@example.com", phone: "+15125550100", notes: "PRIVATE-CRM-NOTE" },
      { id: OTHER_BUYER, brokerage_id: OTHER_BRK, first_name: "Other", email: "other@example.com" },
    ],
    saved_properties: [
      { id: "sp1", brokerage_id: BRK, contact_id: BUYER, listing_id: "L-1", property_address: "12 Elm St", city: "Frisco", state: "TX", list_price: 640000, bedrooms: 3, bathrooms: 2, sqft: 2100, primary_photo_url: "https://img/1.jpg", property_type: "single_family", notes: "BUYER-PRIVATE-NOTE", match_reasons: ["SCORE-REASON"], ai_match_score: 91, dismissed: false },
      { id: "sp2", brokerage_id: BRK, contact_id: BUYER, external_property_id: "ext_rentcast_9", property_address: "9 Oak Ct", city: "Plano", state: "TX", list_price: 590000, bedrooms: 4, bathrooms: 3, dismissed: false },
      { id: "sp3", brokerage_id: BRK, contact_id: BUYER, listing_id: "L-DISMISSED", property_address: "1 Gone Rd", dismissed: true },
      { id: "sp4", brokerage_id: OTHER_BRK, contact_id: OTHER_BUYER, listing_id: "L-OTHER", property_address: "77 Other Tenant Way", dismissed: false },
    ],
    collaborative_searches: [
      { id: "cs-other", brokerage_id: OTHER_BRK, contact_id: OTHER_BUYER, name: "Other", status: "active", search_criteria: { secret: SECRET_CRITERIA }, created_at: "2026-10-01T00:00:00Z" },
    ],
    collaborative_search_members: [],
    collaborative_search_properties: [
      { id: "csp-other", collaborative_search_id: "cs-other", property_mls_id: "L-OTHER", property_data: { address: "77 Other Tenant Way" }, status: "active" },
    ],
    property_family_ratings: [],
    property_consensus: [],
  }, { stampCreatedAt: true, uuidIds: true })
}

async function main() {
  console.log("\n A. SHARE — only the buyer's saved homes, public facts, hashed expiring credential")
  const db = seed()
  const emails: Array<{ email: string; token: string }> = []
  const supCalls: string[] = []
  let tokenN = 0
  const deps = (opts: { suppressed?: boolean } = {}) => ({
    checkSuppression: async (p: { email?: string | null; channel: string }) => { supCalls.push(`${p.channel}:${p.email}`); return { suppressed: !!opts.suppressed, reason: opts.suppressed ? "unsubscribed" : undefined } },
    sendEmailInvite: async (p: { email: string; token: string }) => { emails.push(p); return { ok: true } },
    tokenFactory: () => `tok-${++tokenN}-${"x".repeat(40)}`,
  })
  const r1 = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1", "ext_rentcast_9", "L-OTHER", "L-DISMISSED"], collaborator: { name: "Mom", email: "Mom@Example.com" }, scope: "feedback_only", now: NOW }, deps())
  check("the share succeeds with the two saved homes; another tenant's and a dismissed home are left out (with a note)", r1.ok && r1.sharedHomeIds.length === 2 && r1.notes.some((n) => /left out/.test(n)), JSON.stringify(r1))
  if (!r1.ok) throw new Error("share failed")
  const items = db.tables.collaborative_search_properties.filter((p) => p.collaborative_search_id === r1.searchId)
  check("shared facts are PUBLIC listing facts copied from the saved row — no buyer notes, match reasons or scores", items.length === 2 && items.every((i) => !JSON.stringify(i.property_data).includes("BUYER-PRIVATE-NOTE") && !JSON.stringify(i.property_data).includes("SCORE-REASON") && !("ai_match_score" in (i.property_data ?? {}))) && items.some((i) => i.property_data.address === "12 Elm St" && i.property_data.price === 640000))
  check("POSITIVE CONTROL: the private note IS in the seed (the absence above is meaningful)", JSON.stringify(db.tables.saved_properties).includes("BUYER-PRIVATE-NOTE"))
  const search = db.tables.collaborative_searches.find((s) => s.id === r1.searchId)!
  check("the family search is tenant-stamped and owned by the buyer", search.brokerage_id === BRK && search.contact_id === BUYER && search.status === "active")
  const member = db.tables.collaborative_search_members.find((m) => m.id === r1.memberId)!
  check("the collaborator holds scope feedback_only, role viewer, an E.164-free email member, the buyer as inviter", member.scope === "feedback_only" && member.role === "viewer" && member.email === "mom@example.com" && member.invited_by_user_id === USER && member.brokerage_id === BRK)
  check("the token is stored ONLY as its SHA-256 (64 hex), never raw, with a 7-day expiry", member.access_token_hash === sha256(r1.token) && /^[0-9a-f]{64}$/.test(member.access_token_hash) && !JSON.stringify(db.tables).includes(r1.token) && new Date(member.token_expires_at).getTime() - NOW.getTime() === TTL_DAYS * 86_400_000)
  check("POSITIVE CONTROL: the JSON scan finds a token when one IS stored", JSON.stringify({ x: r1.token }).includes(r1.token))
  const refused = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-OTHER"], collaborator: { name: "X", email: "x@example.com" }, scope: "feedback_only", now: NOW }, deps())
  check("sharing ONLY homes the buyer never saved is refused", !refused.ok && /saved homes/.test((refused as { error: string }).error))
  const badScope = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1"], collaborator: { name: "X", email: "x@example.com" }, scope: "editor" as never, now: NOW }, deps())
  check("any scope but feedback_only is refused", !badScope.ok)
  const noId = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1"], collaborator: { name: "X" }, scope: "feedback_only", now: NOW }, deps())
  check("a collaborator with neither email nor phone is refused", !noId.ok)

  console.log("\n B. DELIVERY — suppression first; phone is a link the buyer sends")
  check("the email invite went out after the suppression gate", r1.delivery === "email" && emails.length === 1 && emails[0].email === "mom@example.com" && supCalls[0] === "email:mom@example.com")
  const sup = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1"], collaborator: { name: "Uncle", email: "uncle@example.com" }, scope: "feedback_only", now: NOW }, deps({ suppressed: true }))
  check("a SUPPRESSED address gets no email — the buyer gets the link and is told why", sup.ok && sup.delivery === "link" && emails.length === 1 && sup.notes.some((n) => /asked not to receive email/.test(n)))
  const ph = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1"], collaborator: { name: "Sis", phone: "(512) 555-0199" }, scope: "feedback_only", now: NOW }, deps())
  const phMember = ph.ok ? db.tables.collaborative_search_members.find((m) => m.id === ph.memberId) : null
  check("a PHONE invite is never texted by the platform: delivery is a link, the number stored E.164", ph.ok && ph.delivery === "link" && phMember?.phone === "+15125550199" && phMember?.invite_channel === "link" && ph.notes.some((n) => /don't text/.test(n)))
  const again = await share.shareCollection(db, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: USER, listingRefs: ["L-1"], collaborator: { name: "Mom", email: "mom@example.com" }, scope: "feedback_only", now: NOW }, deps())
  check("re-sharing with the same person refreshes ONE member (no duplicate) and re-uses the shared home", again.ok && again.memberId === r1.memberId && db.tables.collaborative_search_properties.filter((p) => p.collaborative_search_id === r1.searchId).length === 2)
  const momToken = again.ok ? again.token : ""
  check("…and the earlier link stops working (a fresh credential replaces it)", !(await opens(db, r1.token, NOW)) && (await opens(db, momToken, NOW)))

  console.log("\n C. COLLABORATOR VIEW — ONLY the shared homes and their own opinions")
  // Plant the buyer's criteria on THEIR search row to prove the view never carries it.
  search.search_criteria = { secret: SECRET_CRITERIA }
  const v = await share.collaboratorView(db, momToken, NOW)
  const vj = JSON.stringify(v)
  check("the view opens with the two shared homes and the buyer's first name", v.ok && v.view.homes.length === 2 && v.view.buyerFirstName === "Dana")
  check("the view carries NO criteria, CRM note, buyer email/phone/last name, other member, or other tenant's home", !vj.includes(SECRET_CRITERIA) && !vj.includes("PRIVATE-CRM-NOTE") && !vj.includes("dana@example.com") && !vj.includes("+15125550100") && !vj.includes("Reyes") && !vj.includes("uncle@example.com") && !vj.includes("77 Other Tenant Way"))
  check("POSITIVE CONTROL: those secrets ARE in the database (the absence is meaningful)", JSON.stringify(db.tables).includes(SECRET_CRITERIA) && JSON.stringify(db.tables).includes("PRIVATE-CRM-NOTE"))
  check("opening the view accepts the invitation", db.tables.collaborative_search_members.find((m) => m.id === r1.memberId)?.invite_status === "accepted")

  console.log("\n D. CREDENTIAL — wrong, expired, revoked and out-of-scope tokens refused")
  check("a wrong token is refused", !(await opens(db, "nope-" + "y".repeat(40), NOW)))
  check("a too-short token is refused before any read", !(await opens(db, "short", NOW)))
  const later = new Date(NOW.getTime() + 8 * 86_400_000)
  check("an EXPIRED token is refused", !(await opens(db, momToken, later)))
  const m = db.tables.collaborative_search_members.find((x) => x.id === r1.memberId)!
  m.scope = "editor"
  check("a member outside feedback_only is refused", !(await opens(db, momToken, NOW)))
  m.scope = "feedback_only"
  search.status = "completed"
  check("a closed search is refused", !(await opens(db, momToken, NOW)))
  search.status = "active"

  console.log("\n E. OPINION — the member the token proves; only shared homes; consensus computed")
  const signals: Array<{ message: string; payload: Record<string, unknown> }> = []
  const opDeps = { tellShoppingAgent: async (p: { message: string; payload: Record<string, unknown> }) => { signals.push(p); return true } }
  const homeId = v.ok ? v.view.homes.find((h) => h.facts.address === "12 Elm St")!.id : ""
  const op = await share.recordCollaboratorOpinion(db, momToken, { sharedHomeId: homeId, vote: "love", comment: "The yard is perfect for the dog" }, opDeps, NOW)
  const row = db.tables.property_family_ratings.find((r) => r.property_id === homeId)
  check("the opinion is recorded under the member the TOKEN proved (member_id + their email), tenant-stamped", op.ok && row?.member_id === r1.memberId && row?.member_email === "mom@example.com" && row?.brokerage_id === BRK && row?.vote === "love" && row?.rating === 5)
  check("consensus is computed (no trigger exists) — avg 5, one vote", op.ok && op.consensus.avg_rating === 5 && op.consensus.vote_count === 1 && db.tables.property_consensus.some((c) => c.property_id === homeId && c.vote_count === 1))
  const foreign = await share.recordCollaboratorOpinion(db, momToken, { sharedHomeId: "csp-other", vote: "like" }, opDeps, NOW)
  check("an opinion on a home that was NOT shared with them is refused", !foreign.ok)
  const badVote = await share.recordCollaboratorOpinion(db, momToken, { sharedHomeId: homeId, vote: "maybe" as never }, opDeps, NOW)
  check("a vote outside the five is refused", !badVote.ok)
  const v2 = await share.collaboratorView(db, momToken, NOW)
  check("the collaborator sees their OWN opinion back", v2.ok && v2.view.homes.some((h) => h.id === homeId && h.myVote === "love" && /dog/.test(h.myComment ?? "")))

  console.log("\n G. SHOPPING AGENT — only on the buyer's yes")
  check("the agent was told (a notable opinion) WITHOUT the words — the buyer has not consented", op.ok && op.agentNotified && signals.length === 1 && !/dog/.test(signals[0].message) && signals[0].payload.feedback_consented === false && !("comment" in signals[0].payload))
  const before = await share.familyFeedbackForShoppingAgent(db, { brokerageId: BRK, contactId: BUYER })
  check("without consent the Shopping Agent reads NOTHING", !before.consented && before.opinions.length === 0)
  const yes = await share.setFamilyFeedbackForShoppingAgent(db, { brokerageId: BRK, contactId: BUYER, allow: true, actorUserId: USER, now: NOW })
  check("the buyer's yes is recorded with who and when", yes.ok && search.feedback_for_shopping_agent === true && search.feedback_consent_by_user_id === USER && !!search.feedback_consent_at)
  const after = await share.familyFeedbackForShoppingAgent(db, { brokerageId: BRK, contactId: BUYER })
  check("…and only then does the Shopping Agent read the opinion, keyed to the listing ref", after.consented && after.opinions.length === 1 && after.opinions[0].listingRef === "L-1" && after.opinions[0].by === "Mom")
  await share.recordCollaboratorOpinion(db, momToken, { sharedHomeId: homeId, vote: "pass", comment: "Changed my mind — road noise" }, opDeps, NOW)
  check("with consent the agent signal carries the words", signals.length === 2 && /road noise/.test(signals[1].message) && signals[1].payload.feedback_consented === true)
  const otherTenant = await share.familyFeedbackForShoppingAgent(db, { brokerageId: OTHER_BRK, contactId: BUYER })
  check("another tenant reading this buyer gets nothing", otherTenant.opinions.length === 0)
  const fresh = memSupabase({ collaborative_searches: [{ id: "s", brokerage_id: BRK, contact_id: BUYER, status: "active", feedback_for_shopping_agent: true }] }, { refuse: { collaborative_search_members: "permission denied" } })
  const closed = await share.familyFeedbackForShoppingAgent(fresh, { brokerageId: BRK, contactId: BUYER })
  check("FAIL CLOSED: an unreadable digest reads as no consent, no opinions", !closed.consented && closed.opinions.length === 0)

  console.log("\n F. BUYER — sees every opinion by name; can close a link")
  const d = await share.buyerFeedbackDigest(db, { brokerageId: BRK, contactId: BUYER, now: NOW })
  check("the buyer's digest lists the opinion by the collaborator's name, per home", d.ok && d.digest.homes.some((h) => h.address === "12 Elm St" && h.opinions.some((o) => o.by === "Mom" && o.vote === "pass")))
  check("the digest lists the collaborators with a status (no tokens)", d.ok && d.digest.collaborators.length === 3 && !JSON.stringify(d).includes("access_token_hash"))
  const rv = await share.revokeCollaborator(db, { brokerageId: BRK, contactId: BUYER, memberId: r1.memberId, now: NOW })
  check("the buyer closes Mom's link — and the link is refused after", rv.ok && !(await opens(db, momToken, NOW)))
  const rv2 = await share.revokeCollaborator(db, { brokerageId: OTHER_BRK, contactId: BUYER, memberId: r1.memberId, now: NOW })
  check("a revoke from the wrong tenant matches nothing and SAYS so", !rv2.ok)
  check("revoking keeps her opinions with the buyer", db.tables.property_family_ratings.some((r) => r.member_id === r1.memberId))

  console.log("\n H. WIRING (stripped source)")
  const act = code("app/actions/collaborative-search.ts")
  const fn = (name: string) => { const i = act.indexOf(`export async function ${name}(`); const j = act.indexOf("export async function", i + 10); return i < 0 ? "" : act.slice(i, j < 0 ? undefined : j) }
  check("rateProperty no longer writes the POSTED email", !/member_email:\s*memberEmail/.test(fn("rateProperty")) && /gateSearchOwner\(searchId\)/.test(fn("rateProperty")))
  check("POSITIVE CONTROL: the finder sees the old shape in a specimen", /member_email:\s*memberEmail/.test("upsert({ member_email: memberEmail })"))
  check("inviteFamilyMember is gated and writes no plaintext invite_token", /gateSearchOwner\(searchId\)/.test(fn("inviteFamilyMember")) && !/invite_token:/.test(act))
  check("addPropertyToSearch re-reads the saved row (posted propertyData is not stored)", /from\("saved_properties"\)/.test(fn("addPropertyToSearch")) && !/property_data:\s*propertyData/.test(fn("addPropertyToSearch")))
  check("removeMember revokes (gated) instead of an ungated delete", /revokeCollaborator/.test(fn("removeMember")) && !/\.delete\(\)/.test(fn("removeMember")))
  check("shareHomesWithFamilyAction: buyer-self gate, ledgered, suppression injected", /gateBuyerSelf\(input\.contactId\)/.test(fn("shareHomesWithFamilyAction")) && /withActionLedger/.test(fn("shareHomesWithFamilyAction")) && /checkSuppression/.test(fn("shareHomesWithFamilyAction")))
  check("setFamilyFeedbackUseAction: buyer-self only (staff cannot consent for the buyer), ledgered", /gateBuyerSelf\(input\.contactId\)\s*\n/.test(fn("setFamilyFeedbackUseAction") + "\n") && !/staffMay/.test(fn("setFamilyFeedbackUseAction")) && /withActionLedger/.test(fn("setFamilyFeedbackUseAction")))
  const join = code("app/search/join/page.tsx")
  check("the join page renders the collaborator view + the opinion form (no homepage dead end)", /acceptInvitation\(token\)/.test(join) && /FamilyOpinionForm/.test(join) && !/href="\/"/.test(join))
  const sp = code("app/portal/[contactId]/search/page.tsx")
  const shareAt = sp.indexOf("<ShareWithFamilyCard"), gateAt = sp.indexOf("{showCollaborativeSearch &&")
  check("the share card is on EVERY buyer's search page (not inside the persona-layout block)", shareAt > 0 && gateAt > 0 && shareAt < gateAt)
  check("the share card imports server actions only (no lib — proxy-graph budget)", !/from "@\/lib\//.test(code("app/portal/[contactId]/search/ShareWithFamilyCard.tsx")))
  check("the explain door hands the Shopping Agent family opinions only through the consent reader", /familyFeedbackForShoppingAgent/.test(code("app/actions/buyer-search/conversational-search.ts")))

  console.log("\n I. MIGRATIONS")
  const stampOk = (l: string) => /^-- WRITTEN, NOT APPLIED \(wave 149, lane 149B\)/.test(l) || /^-- ── APPLIED LIVE /.test(l)
  for (const f of ["m937-collaborative-search-collaborator-credential.sql", "m938-collaborative-search-consent-and-scope.sql"]) {
    const sql = raw(`supabase/migrations/${f}`)
    check(`${f}: line 1 carries the lane or APPLIED stamp`, stampOk(sql.split("\n")[0]))
  }
  const m937 = raw("supabase/migrations/m937-collaborative-search-collaborator-credential.sql")
  const lib = code("lib/portal/collaborative-share.ts")
  const written = ["access_token_hash", "token_expires_at", "revoked_at", "invite_channel", "invited_by_user_id", "last_viewed_at", "scope", "phone", "member_id"]
  check("every new column the module writes is added by m937", written.every((c) => lib.includes(c) && m937.includes(c)), written.filter((c) => !m937.includes(c)).join(","))
  const m938 = raw("supabase/migrations/m938-collaborative-search-consent-and-scope.sql")
  check("m938 adds the consent columns and narrows portal_member_searches to owners", ["feedback_for_shopping_agent", "feedback_consent_at", "feedback_consent_by_user_id"].every((c) => m938.includes(c)) && /m\.role = 'owner'/.test(m938) && !/brokerage_id IS NULL OR/.test(m938.split("CREATE POLICY").slice(1).join("")))
  check("POSITIVE CONTROL: the NULL-arm finder sees the old policy text", /brokerage_id IS NULL OR/.test("USING ((brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))"))

  console.log("\n J. THE INVITE IS THE TENANT'S (149Z — C32 brand rule)")
  {
    const svc =code("lib/services/communication.service.tsx"), act = code("app/actions/collaborative-search.ts")
    check("the share door resolves the SESSION tenant's brand through the one resolver and hands it to the invite sender",
      /resolveConsentBrand\(g\.svc as never, \{ brokerageId: g\.brokerageId \}\)/.test(act) && /sendCollaborativeSearchInvite\(\{[^}]*tenantBrand[^}]*\}\)/.test(act))
    check("the invite copy names the tenant (never a platform brand), escapes every name, and promises only the shared homes",
      /tenantBrand\?: string \| null/.test(svc) && /esc\(params\.inviterName\)/.test(svc) && /only the homes they chose to share/.test(svc) && !/VIP ?Agents|VIP Real Estate/i.test(svc.slice(svc.indexOf("sendCollaborativeSearchInvite"), svc.indexOf("sendAnniversaryMessage"))))
  }

  console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
  if (fail === 0) console.log(" COLLABORATIVE_SEARCH_PASS")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
