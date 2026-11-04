/**
 * lib/portal/collaborative-share.ts — C28 COLLABORATIVE SEARCH (wave 149, lane 149B, owner ruling 6).
 *
 * Owner: "Family collaborative search = the buyer shares the homes they were searching and brings in a family
 * member to give their opinion on the selected properties."
 *
 * SURVIVOR, EXTENDED — NOT A SECOND FEATURE. The tables are the existing family-search set
 * (`collaborative_searches` → `collaborative_search_members` → `collaborative_search_properties` →
 * `property_family_ratings` → `property_consensus`, written by app/actions/collaborative-search.ts). Live, on
 * 2026-11-03, every one of them held ZERO rows: the feature had never completed end to end, because
 *   (1) an invitee had no view at all — /search/join accepted the token and sent them to the homepage;
 *   (2) `rateProperty` took the voter's email from the request body (any caller could vote as anyone);
 *   (3) the invite token was stored and matched in PLAINTEXT, never expired and could not be revoked;
 *   (4) `portal_member_searches()` admitted an invitee — by JWT email, pending or not — to READ the whole search
 *       row, the buyer's `search_criteria` included, and to INSERT members and properties;
 *   (5) the shared homes were whatever `propertyData` the client posted;
 *   (6) "consensus is updated automatically by trigger" — no trigger exists (pg_trigger, 2026-11-03);
 *   (7) nothing told the agent or the Shopping Agent, and nothing asked the buyer whether family opinions may
 *       shape their search.
 * This module is the one place those rules live; the server actions are thin doors over it.
 *
 * THE CONTRACT (C28):
 *   shareCollection({ buyer, listings[], collaborator (email | phone), scope: feedback_only })
 *     → ONLY homes the buyer saved (re-read from `saved_properties` under the tenant — never client-posted facts)
 *     → a per-collaborator credential: a random token, stored as a SHA-256 hash, with an expiry, revocable
 *   collaboratorView(token)  → ONLY those homes' public listing facts + the collaborator's OWN opinions.
 *                              Never the buyer's criteria, CRM fields, documents, messages, other members or other
 *                              portal data.
 *   recordCollaboratorOpinion(token, …) → property_family_ratings keyed by the MEMBER the token proves
 *   buyerFeedbackDigest(buyer) → the buyer sees every opinion, by name
 *   familyFeedbackForShoppingAgent(buyer) → [] unless the BUYER said yes (collaborative_searches.feedback_for_shopping_agent)
 *   the agent is told (manager bus → shopping_agent) when an opinion arrives; the opinion's WORDS ride the signal only
 *   when the buyer consented — otherwise the agent learns that family is weighing in, not what they said.
 *
 * INVITATION CHANNELS — a business decision, stated: an EMAIL invite is a one-off transactional message the buyer
 * asked us to send to a person they named (the survivor sender, `sendCollaborativeSearchInvite`), checked against
 * the tenant's suppression list first. A PHONE invite is NOT texted by the platform: the collaborator never gave
 * this tenant consent to be texted, and under the TCPA a text is a call. The buyer gets the private link to send
 * from their own phone. The collaborator is not made a CRM contact or a lead by being invited — they become one only
 * through the C8 consented intake if they ever ask for help themselves.
 *
 * NOT server-only: pure helpers + injected-client functions, so the proof drives them on memSupabase.
 */

import { createHash, randomBytes } from "node:crypto"

type Svc = { from: (table: string) => any }

/** The only scope a collaborator holds. The live CHECK (m937) admits exactly this value. */
export const COLLABORATOR_SCOPE = "feedback_only" as const
export type CollaboratorScope = typeof COLLABORATOR_SCOPE

/** The votes the live table already uses (app/actions/collaborative-search.ts rateProperty). One vocabulary. */
export const FAMILY_VOTES = ["love", "like", "neutral", "dislike", "pass"] as const
export type FamilyVote = (typeof FAMILY_VOTES)[number]
const VOTE_RATING: Record<FamilyVote, number> = { love: 5, like: 4, neutral: 3, dislike: 2, pass: 1 }

/** How long an invite link stays usable — the survivor invite email already promises "expires in 7 days". */
const SHARE_TOKEN_TTL_DAYS = 7
const MAX_SHARED_HOMES = 25
const MAX_COMMENT = 600

// ─── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/** A fresh, unguessable share token (256 bits, URL-safe). Returned ONCE, to send; never stored. */
function mintShareToken(): string {
  return randomBytes(32).toString("base64url")
}

/** What the database stores and matches: the token's SHA-256. A leaked table row is not a working link. */
function hashShareToken(token: string): string {
  return createHash("sha256").update(String(token ?? "")).digest("hex")
}

function normalizeEmail(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null
}

function normalizePhone(v: string | null | undefined): string | null {
  const d = String(v ?? "").replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  return ten.length === 10 ? `+1${ten}` : null
}

/** The listing facts a collaborator may see — public listing facts only, copied from the buyer's saved row. */
export interface SharedHomeFacts {
  address: string | null
  city: string | null
  state: string | null
  price: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  photo: string | null
  property_type: string | null
}

const SHARED_FACT_KEYS: readonly (keyof SharedHomeFacts)[] = ["address", "city", "state", "price", "beds", "baths", "sqft", "photo", "property_type"]

/** PURE. A saved_properties row → the public facts a collaborator sees. Notes, match reasons, scores and the
 *  buyer's dismissal reasons are the BUYER's — never copied. */
export function sharedFactsFromSaved(r: Record<string, any>): SharedHomeFacts {
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null)
  return {
    address: r.property_address ?? null, city: r.city ?? null, state: r.state ?? null,
    price: num(r.list_price), beds: num(r.bedrooms), baths: num(r.bathrooms), sqft: num(r.sqft),
    photo: r.primary_photo_url ?? null, property_type: r.property_type ?? null,
  }
}

/** PURE. Strip anything but the public keys (defence in depth on read — an old row cannot leak extra fields). */
function publicFactsOnly(data: unknown): SharedHomeFacts {
  const src = (data && typeof data === "object" ? data : {}) as Record<string, unknown>
  const out = {} as Record<string, unknown>
  for (const k of SHARED_FACT_KEYS) out[k] = src[k] ?? null
  return out as unknown as SharedHomeFacts
}

/** PURE. The ref a saved row is shared under — the listing id, else the external id (market rows). */
export function savedRef(r: Record<string, any>): string | null {
  const v = r.listing_id ?? r.external_property_id ?? null
  return v ? String(v) : null
}

/** PURE. The consensus row for one shared home, from its opinions (the trigger the old comment promised never existed). */
export function consensusOf(opinions: Array<{ rating: number | null }>): { avg_rating: number | null; vote_count: number } {
  const rated = opinions.map((o) => o.rating).filter((x): x is number => typeof x === "number")
  return { avg_rating: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 100) / 100 : null, vote_count: opinions.length }
}

/** PURE. Is this opinion worth the agent's attention right now? A strong feeling or words — not every tap. */
function opinionIsNotable(o: { vote: FamilyVote; comment: string | null; firstForHome: boolean }): boolean {
  return o.vote === "love" || o.vote === "pass" || !!(o.comment && o.comment.trim().length >= 3) || o.firstForHome
}

// ─── Share ───────────────────────────────────────────────────────────────────────────────────────

export interface ShareCollectionInput {
  brokerageId: string
  buyerContactId: string
  /** users.id of the buyer (the session) — recorded as who invited. */
  actorUserId: string
  /** saved_properties refs (listing_id or external_property_id) the buyer selected. */
  listingRefs: string[]
  collaborator: { name: string; email?: string | null; phone?: string | null }
  scope: CollaboratorScope
  now?: Date
}

export interface ShareCollectionDeps {
  /** The suppression gate (lib/kernel/compliance/check-suppression.ts checkSuppression), injected. */
  checkSuppression: (p: { brokerageId: string; email?: string | null; phone?: string | null; channel: "email" | "sms" }) => Promise<{ suppressed: boolean; reason?: string }>
  /** The survivor email sender; absent → no email sent, the link is returned for the buyer to share. */
  sendEmailInvite?: (p: { email: string; token: string; searchId: string }) => Promise<{ ok: boolean; error?: string | null }>
  tokenFactory?: () => string
}

export type ShareCollectionResult =
  | {
      ok: true
      searchId: string
      memberId: string
      /** The raw token — for the link only. Never persisted. */
      token: string
      sharedHomeIds: string[]
      /** email = we sent the invite; link = the buyer sends the link themselves (phone, suppressed or no sender). */
      delivery: "email" | "link"
      notes: string[]
    }
  | { ok: false; error: string }

/**
 * Share the buyer's selected saved homes with one collaborator. Tenant and buyer come from the CALLER's gate; the
 * homes are re-read from the buyer's own saved rows under that tenant — a ref the buyer never saved is refused.
 */
export async function shareCollection(svc: Svc, input: ShareCollectionInput, deps: ShareCollectionDeps): Promise<ShareCollectionResult> {
  if (input.scope !== COLLABORATOR_SCOPE) return { ok: false, error: "A family member can only be invited to give their opinion on the homes you share." }
  const name = String(input.collaborator?.name ?? "").trim().slice(0, 120)
  const email = normalizeEmail(input.collaborator?.email)
  const phone = normalizePhone(input.collaborator?.phone)
  if (!name) return { ok: false, error: "Who are you inviting? Add their name." }
  if (!email && !phone) return { ok: false, error: "Add an email address or a mobile number so they can open the homes." }
  const refs = [...new Set((input.listingRefs ?? []).map((r) => String(r ?? "").trim()).filter(Boolean))]
  if (refs.length === 0) return { ok: false, error: "Pick at least one home to share." }
  if (refs.length > MAX_SHARED_HOMES) return { ok: false, error: `You can share up to ${MAX_SHARED_HOMES} homes at a time.` }
  const now = input.now ?? new Date()
  const notes: string[] = []

  // 1. The homes — ONLY the buyer's own saved rows, in this tenant.
  const { data: saved, error: savedError } = await svc.from("saved_properties")
    .select("id, listing_id, external_property_id, property_address, city, state, list_price, bedrooms, bathrooms, sqft, primary_photo_url, property_type, dismissed")
    .eq("contact_id", input.buyerContactId).eq("brokerage_id", input.brokerageId)
  if (savedError) return { ok: false, error: `Your saved homes couldn't be read just now (${savedError.message}).` }
  const byRef = new Map<string, Record<string, any>>()
  for (const r of (saved ?? []) as Array<Record<string, any>>) { const k = savedRef(r); if (k && !r.dismissed) byRef.set(k, r) }
  const unknownRefs = refs.filter((r) => !byRef.has(r))
  if (unknownRefs.length === refs.length) return { ok: false, error: "Those homes aren't in your saved homes — save a home first, then share it." }
  if (unknownRefs.length) notes.push(`${unknownRefs.length} home${unknownRefs.length === 1 ? " wasn't" : "s weren't"} in your saved homes and ${unknownRefs.length === 1 ? "was" : "were"} left out.`)

  // 2. The buyer's ONE active family search (find, else create — the survivor table, tenant-stamped).
  const { data: existing, error: findError } = await svc.from("collaborative_searches")
    .select("id").eq("brokerage_id", input.brokerageId).eq("contact_id", input.buyerContactId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1)
  if (findError) return { ok: false, error: findError.message }
  let searchId = ((existing ?? []) as Array<{ id: string }>)[0]?.id ?? null
  if (!searchId) {
    const { data: created, error: createError } = await svc.from("collaborative_searches")
      .insert({ brokerage_id: input.brokerageId, contact_id: input.buyerContactId, created_by_contact_id: input.buyerContactId, name: "Homes I'm considering", search_criteria: {}, status: "active" })
      .select("id").single()
    if (createError || !created) return { ok: false, error: createError?.message ?? "The shared list couldn't be created." }
    searchId = (created as { id: string }).id
  }

  // 3. The shared homes — public facts copied from the saved row; an already-shared home is reused.
  const { data: already, error: alreadyError } = await svc.from("collaborative_search_properties")
    .select("id, property_mls_id, status").eq("collaborative_search_id", searchId)
  if (alreadyError) return { ok: false, error: alreadyError.message }
  const shared = new Map<string, Record<string, any>>(((already ?? []) as Array<Record<string, any>>).map((r) => [String(r.property_mls_id), r]))
  const sharedHomeIds: string[] = []
  for (const ref of refs) {
    const row = byRef.get(ref)
    if (!row) continue
    const prior = shared.get(ref)
    if (prior) {
      if (prior.status === "removed") {
        const { data: back, error: backError } = await svc.from("collaborative_search_properties").update({ status: "active" }).eq("id", prior.id).eq("collaborative_search_id", searchId).select("id")
        if (backError || !(back ?? []).length) { notes.push("One home couldn't be re-shared."); continue }
      }
      sharedHomeIds.push(String(prior.id))
      continue
    }
    const { data: ins, error: insError } = await svc.from("collaborative_search_properties")
      .insert({ collaborative_search_id: searchId, property_mls_id: ref, property_data: sharedFactsFromSaved(row), added_by_contact_id: input.buyerContactId, status: "active" })
      .select("id").single()
    if (insError || !ins) { notes.push(`A home couldn't be shared (${insError?.message ?? "no row"}).`); continue }
    sharedHomeIds.push(String((ins as { id: string }).id))
  }
  if (sharedHomeIds.length === 0) return { ok: false, error: "None of the homes could be shared just now — please try again." }

  // 4. The collaborator — one member per (search, email|phone); a fresh credential every share.
  const token = (deps.tokenFactory ?? mintShareToken)()
  const expires = new Date(now.getTime() + SHARE_TOKEN_TTL_DAYS * 86_400_000).toISOString()
  const { data: members, error: membersError } = await svc.from("collaborative_search_members")
    .select("id, email, phone, role").eq("collaborative_search_id", searchId)
  if (membersError) return { ok: false, error: membersError.message }
  const match = ((members ?? []) as Array<Record<string, any>>).find((m) => m.role !== "owner" && ((email && String(m.email ?? "").toLowerCase() === email) || (phone && m.phone === phone)))
  const credential = {
    brokerage_id: input.brokerageId, name, phone, scope: COLLABORATOR_SCOPE, role: "viewer",
    access_token_hash: hashShareToken(token), token_expires_at: expires, revoked_at: null,
    invite_channel: email ? "email" : "link", invited_by_user_id: input.actorUserId, invited_at: now.toISOString(),
  }
  let memberId: string
  if (match) {
    const { data: upd, error: updError } = await svc.from("collaborative_search_members").update(credential).eq("id", match.id).eq("collaborative_search_id", searchId).select("id")
    if (updError || !(upd ?? []).length) return { ok: false, error: updError?.message ?? "The invitation couldn't be refreshed." }
    memberId = String(match.id)
  } else {
    // `email` is NOT NULL on the live table; a phone-only collaborator carries a non-routable placeholder that the
    // suppression gate and the sender never see (delivery is "link").
    const { data: m, error: mError } = await svc.from("collaborative_search_members")
      .insert({ collaborative_search_id: searchId, email: email ?? `phone:${phone}`, invite_status: "pending", ...credential })
      .select("id").single()
    if (mError || !m) return { ok: false, error: mError?.message ?? "The invitation couldn't be recorded." }
    memberId = String((m as { id: string }).id)
  }

  // 5. Delivery — email (suppression first) or the link for the buyer to send.
  let delivery: "email" | "link" = "link"
  if (email) {
    const sup = await deps.checkSuppression({ brokerageId: input.brokerageId, email, channel: "email" })
    if (sup.suppressed) {
      notes.push("That address has asked not to receive email from us, so no email was sent — you can share the private link yourself.")
    } else if (deps.sendEmailInvite) {
      const sent = await deps.sendEmailInvite({ email, token, searchId })
      if (sent.ok) delivery = "email"
      else notes.push(`The email didn't go out (${sent.error ?? "the sender refused"}) — you can share the private link yourself.`)
    }
  } else {
    notes.push("We don't text people who haven't asked us to — send them the private link from your phone.")
  }
  return { ok: true, searchId, memberId, token, sharedHomeIds, delivery, notes }
}

// ─── The collaborator's side (the token is the credential) ───────────────────────────────────────

// Module-private (149Z: exported types nothing imported read as one-sided to test:opposite-missing).
interface CollaboratorContext {
  memberId: string
  memberName: string | null
  memberEmail: string
  searchId: string
  brokerageId: string
  buyerContactId: string
}

type CollaboratorResolution = { ok: true; c: CollaboratorContext } | { ok: false; error: string }

/** Resolve a token to its member — hash match, scope feedback_only, not revoked, not expired, search active. */
async function resolveCollaborator(svc: Svc, token: string, now: Date = new Date()): Promise<CollaboratorResolution> {
  const raw = String(token ?? "").trim()
  if (raw.length < 20 || raw.length > 200) return { ok: false, error: "This link isn't complete — open it straight from the message you were sent." }
  const { data: m, error } = await svc.from("collaborative_search_members")
    .select("id, name, email, scope, revoked_at, token_expires_at, collaborative_search_id, brokerage_id, invite_status")
    .eq("access_token_hash", hashShareToken(raw)).maybeSingle()
  if (error) return { ok: false, error: "We couldn't check this link just now — please try again in a moment." }
  if (!m) return { ok: false, error: "This link isn't valid. Ask the person who shared it to send a fresh one." }
  if (m.scope !== COLLABORATOR_SCOPE) return { ok: false, error: "This link isn't valid. Ask the person who shared it to send a fresh one." }
  if (m.revoked_at) return { ok: false, error: "The person who shared these homes has closed this link." }
  if (!m.token_expires_at || new Date(m.token_expires_at).getTime() <= now.getTime()) return { ok: false, error: "This link has expired. Ask the person who shared it to send a fresh one." }
  const { data: s, error: sError } = await svc.from("collaborative_searches")
    .select("id, contact_id, brokerage_id, status").eq("id", m.collaborative_search_id).maybeSingle()
  if (sError || !s) return { ok: false, error: "We couldn't open these homes just now — please try again in a moment." }
  if (s.status !== "active") return { ok: false, error: "This home search has wrapped up — thank you for helping." }
  if (m.brokerage_id && s.brokerage_id !== m.brokerage_id) return { ok: false, error: "This link isn't valid." }
  return { ok: true, c: { memberId: String(m.id), memberName: m.name ?? null, memberEmail: String(m.email), searchId: String(s.id), brokerageId: String(s.brokerage_id), buyerContactId: String(s.contact_id) } }
}

export interface CollaboratorHome { id: string; facts: SharedHomeFacts; myVote: FamilyVote | null; myComment: string | null }
export interface CollaboratorView { buyerFirstName: string | null; collaboratorName: string | null; homes: CollaboratorHome[] }

/** What the collaborator sees: the shared homes' public facts and their OWN opinions. Nothing else. */
export async function collaboratorView(svc: Svc, token: string, now: Date = new Date()): Promise<{ ok: true; view: CollaboratorView } | { ok: false; error: string }> {
  const r = await resolveCollaborator(svc, token, now)
  if (!r.ok) return r
  const c = r.c
  const { data: homes, error } = await svc.from("collaborative_search_properties")
    .select("id, property_data, status").eq("collaborative_search_id", c.searchId).eq("status", "active")
  if (error) return { ok: false, error: "We couldn't load the homes just now — please try again." }
  const { data: mine, error: mineError } = await svc.from("property_family_ratings")
    .select("property_id, vote, notes").eq("collaborative_search_id", c.searchId).eq("member_id", c.memberId)
  if (mineError) return { ok: false, error: "We couldn't load your opinions just now — please try again." }
  const myBy = new Map<string, Record<string, any>>(((mine ?? []) as Array<Record<string, any>>).map((o) => [String(o.property_id), o]))
  // The buyer's FIRST NAME only — how the collaborator knows whose homes these are. No other contact field.
  const { data: buyer } = await svc.from("contacts").select("first_name").eq("id", c.buyerContactId).eq("brokerage_id", c.brokerageId).maybeSingle()
  // First open accepts the invitation; the view is recorded (count-checked, best effort — the read is the product).
  await svc.from("collaborative_search_members").update({ invite_status: "accepted", accepted_at: now.toISOString(), last_viewed_at: now.toISOString() }).eq("id", c.memberId).select("id")
  return {
    ok: true,
    view: {
      buyerFirstName: (buyer as { first_name?: string | null } | null)?.first_name ?? null,
      collaboratorName: c.memberName,
      homes: ((homes ?? []) as Array<Record<string, any>>).map((h) => ({
        id: String(h.id), facts: publicFactsOnly(h.property_data),
        myVote: (myBy.get(String(h.id))?.vote ?? null) as FamilyVote | null, myComment: myBy.get(String(h.id))?.notes ?? null,
      })),
    },
  }
}

export interface OpinionInput { sharedHomeId: string; vote: FamilyVote; comment?: string | null }
export interface OpinionDeps {
  /** The manager bus (publishManagerSignal → shopping_agent), injected. */
  tellShoppingAgent: (p: { brokerageId: string; contactId: string; message: string; payload: Record<string, unknown> }) => Promise<boolean>
}

/** The collaborator's opinion on ONE shared home. The member is the one the token proves — never a posted email. */
export async function recordCollaboratorOpinion(svc: Svc, token: string, input: OpinionInput, deps: OpinionDeps, now: Date = new Date()):
  Promise<{ ok: true; agentNotified: boolean; consensus: { avg_rating: number | null; vote_count: number } } | { ok: false; error: string }> {
  if (!FAMILY_VOTES.includes(input.vote)) return { ok: false, error: "Pick how you feel about this home." }
  const r = await resolveCollaborator(svc, token, now)
  if (!r.ok) return r
  const c = r.c
  const comment = (input.comment ?? "").trim().slice(0, MAX_COMMENT) || null
  const { data: home, error: homeError } = await svc.from("collaborative_search_properties")
    .select("id, property_data, status").eq("id", input.sharedHomeId).eq("collaborative_search_id", c.searchId).maybeSingle()
  if (homeError) return { ok: false, error: "We couldn't save that just now — please try again." }
  if (!home || home.status !== "active") return { ok: false, error: "That home isn't one that was shared with you." }

  const { data: before, error: beforeError } = await svc.from("property_family_ratings")
    .select("id, member_id, rating").eq("collaborative_search_id", c.searchId).eq("property_id", input.sharedHomeId)
  if (beforeError) return { ok: false, error: "We couldn't save that just now — please try again." }
  const prior = ((before ?? []) as Array<Record<string, any>>)
  const firstForHome = !prior.some((o) => o.member_id && o.member_id !== c.memberId)
  const { error: upError } = await svc.from("property_family_ratings").upsert({
    collaborative_search_id: c.searchId, property_id: input.sharedHomeId, member_id: c.memberId, member_email: c.memberEmail,
    brokerage_id: c.brokerageId, vote: input.vote, rating: VOTE_RATING[input.vote], notes: comment, updated_at: now.toISOString(),
  }, { onConflict: "collaborative_search_id,property_id,member_email" })
  if (upError) return { ok: false, error: "We couldn't save that just now — please try again." }

  // Consensus, computed (no trigger exists). A refused write does not fail the opinion; it is reported.
  const { data: after } = await svc.from("property_family_ratings").select("rating").eq("collaborative_search_id", c.searchId).eq("property_id", input.sharedHomeId)
  const consensus = consensusOf(((after ?? []) as Array<{ rating: number | null }>))
  const { error: consError } = await svc.from("property_consensus").upsert({ collaborative_search_id: c.searchId, property_id: input.sharedHomeId, ...consensus, updated_at: now.toISOString() }, { onConflict: "collaborative_search_id,property_id" })
  if (consError) console.error("[collaborative-share] consensus not refreshed:", consError.message)

  // The agent / Shopping Agent — only when notable; the WORDS only when the buyer consented.
  let agentNotified = false
  if (opinionIsNotable({ vote: input.vote, comment, firstForHome })) {
    const consented = await buyerAllowsFamilyFeedback(svc, c.brokerageId, c.searchId)
    const facts = publicFactsOnly(home.property_data)
    agentNotified = await deps.tellShoppingAgent({
      brokerageId: c.brokerageId, contactId: c.buyerContactId,
      message: consented
        ? `${c.memberName ?? "A family member"} ${input.vote === "love" ? "loves" : input.vote === "pass" ? "would pass on" : "weighed in on"} ${facts.address ?? "a shared home"}${comment ? `: "${comment}"` : ""}`
        : `Family is weighing in on the homes your buyer shared (the buyer hasn't asked for their opinions to shape the search).`,
      payload: { source: "family_collaborative_search", search_id: c.searchId, shared_home_id: input.sharedHomeId, feedback_consented: consented, ...(consented ? { vote: input.vote, comment } : {}) },
    })
  }
  return { ok: true, agentNotified, consensus }
}

// ─── The buyer's side ────────────────────────────────────────────────────────────────────────────

async function buyerAllowsFamilyFeedback(svc: Svc, brokerageId: string, searchId: string): Promise<boolean> {
  const { data, error } = await svc.from("collaborative_searches").select("feedback_for_shopping_agent").eq("id", searchId).eq("brokerage_id", brokerageId).maybeSingle()
  // FAIL CLOSED: an unreadable consent is "the buyer has not said yes".
  if (error || !data) return false
  return (data as { feedback_for_shopping_agent?: boolean | null }).feedback_for_shopping_agent === true
}

export interface FamilyOpinion { sharedHomeId: string; listingRef: string; address: string | null; by: string | null; vote: FamilyVote | null; comment: string | null; at: string | null }
export interface BuyerFeedbackDigest {
  searchId: string | null
  feedbackForShoppingAgent: boolean
  collaborators: Array<{ id: string; name: string | null; status: "invited" | "viewed" | "closed" | "expired"; channel: string | null }>
  homes: Array<{ sharedHomeId: string; listingRef: string; address: string | null; opinions: FamilyOpinion[] }>
}

/** Everything family said, for the buyer (and their agent's staff view) — by name, per home. */
export async function buyerFeedbackDigest(svc: Svc, a: { brokerageId: string; contactId: string; now?: Date }): Promise<{ ok: true; digest: BuyerFeedbackDigest } | { ok: false; error: string }> {
  const now = a.now ?? new Date()
  const { data: s, error } = await svc.from("collaborative_searches").select("id, feedback_for_shopping_agent")
    .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("status", "active").order("created_at", { ascending: false }).limit(1)
  if (error) return { ok: false, error: error.message }
  const search = ((s ?? []) as Array<Record<string, any>>)[0]
  if (!search) return { ok: true, digest: { searchId: null, feedbackForShoppingAgent: false, collaborators: [], homes: [] } }
  const [mRes, hRes, oRes] = await Promise.all([
    svc.from("collaborative_search_members").select("id, name, role, revoked_at, token_expires_at, accepted_at, invite_channel").eq("collaborative_search_id", search.id),
    svc.from("collaborative_search_properties").select("id, property_mls_id, property_data, status").eq("collaborative_search_id", search.id).eq("status", "active"),
    svc.from("property_family_ratings").select("property_id, member_id, vote, notes, updated_at").eq("collaborative_search_id", search.id),
  ])
  if (mRes.error || hRes.error || oRes.error) return { ok: false, error: (mRes.error ?? hRes.error ?? oRes.error).message }
  const members = ((mRes.data ?? []) as Array<Record<string, any>>).filter((m) => m.role !== "owner")
  const nameOf = new Map(members.map((m) => [String(m.id), (m.name ?? null) as string | null]))
  const homes = ((hRes.data ?? []) as Array<Record<string, any>>).map((h) => {
    const facts = publicFactsOnly(h.property_data)
    return {
      sharedHomeId: String(h.id), listingRef: String(h.property_mls_id), address: facts.address,
      opinions: ((oRes.data ?? []) as Array<Record<string, any>>).filter((o) => String(o.property_id) === String(h.id) && o.member_id).map((o) => ({
        sharedHomeId: String(h.id), listingRef: String(h.property_mls_id), address: facts.address, by: nameOf.get(String(o.member_id)) ?? null,
        vote: (o.vote ?? null) as FamilyVote | null, comment: o.notes ?? null, at: o.updated_at ?? null,
      })),
    }
  })
  return {
    ok: true,
    digest: {
      searchId: String(search.id), feedbackForShoppingAgent: search.feedback_for_shopping_agent === true,
      collaborators: members.map((m) => ({
        id: String(m.id), name: m.name ?? null, channel: m.invite_channel ?? null,
        status: m.revoked_at ? "closed" : !m.token_expires_at || new Date(m.token_expires_at).getTime() <= now.getTime() ? "expired" : m.accepted_at ? "viewed" : "invited",
      })),
      homes,
    },
  }
}

/** The buyer's say: may family opinions shape what the Shopping Agent shows and suggests? Recorded with who + when. */
export async function setFamilyFeedbackForShoppingAgent(svc: Svc, a: { brokerageId: string; contactId: string; allow: boolean; actorUserId: string; now?: Date }): Promise<{ ok: true } | { ok: false; error: string }> {
  const at = (a.now ?? new Date()).toISOString()
  const { data, error } = await svc.from("collaborative_searches")
    .update({ feedback_for_shopping_agent: a.allow, feedback_consent_at: at, feedback_consent_by_user_id: a.actorUserId, updated_at: at })
    .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("status", "active").select("id")
  if (error) return { ok: false, error: error.message }
  if (!(data ?? []).length) return { ok: false, error: "Share a home with family first — then you can decide how their opinions are used." }
  return { ok: true }
}

/** Close one collaborator's link (the buyer's control). Count-checked: zero rows is reported, not dressed as done. */
export async function revokeCollaborator(svc: Svc, a: { brokerageId: string; contactId: string; memberId: string; now?: Date }): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: s, error } = await svc.from("collaborative_searches").select("id").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId)
  if (error) return { ok: false, error: error.message }
  const ids = ((s ?? []) as Array<{ id: string }>).map((x) => x.id)
  if (!ids.length) return { ok: false, error: "There's nobody to remove." }
  const { data, error: upError } = await svc.from("collaborative_search_members")
    .update({ revoked_at: (a.now ?? new Date()).toISOString() }).eq("id", a.memberId).in("collaborative_search_id", ids).neq("role", "owner").select("id")
  if (upError) return { ok: false, error: upError.message }
  if (!(data ?? []).length) return { ok: false, error: "That person isn't on your shared homes." }
  return { ok: true }
}

/**
 * The Shopping Agent's read: family opinions for this buyer — ONLY when the buyer said yes. Without consent this is
 * an empty list, never "nobody said anything". `listingRef` matches `listings.id` / the external ref the search uses.
 */
export async function familyFeedbackForShoppingAgent(svc: Svc, a: { brokerageId: string; contactId: string }): Promise<{ consented: boolean; opinions: FamilyOpinion[] }> {
  const d = await buyerFeedbackDigest(svc, a)
  if (!d.ok || !d.digest.feedbackForShoppingAgent) return { consented: false, opinions: [] }
  return { consented: true, opinions: d.digest.homes.flatMap((h) => h.opinions) }
}
