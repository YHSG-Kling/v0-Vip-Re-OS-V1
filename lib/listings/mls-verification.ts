// lib/listings/mls-verification.ts
// ─────────────────────────────────────────────────────────────────────────────
// DID THE LISTING ACTUALLY GO LIVE ON THE MLS?
//
// OWNER RULING: "the admin needs to add the actual listing that is in house
// manually to the mls or state mls but verification that it is actually live on
// the mls can be checked in rentcast or the tenants(subscriber) idxbroker."
//
// This corrects the shape of an earlier pass, which framed RentCast/IDX as a way
// to PULL an MLS number the agent could paste in. That is not the job. The agent
// already has the number — they typed it into the MLS themselves. The number is
// an INPUT, not an output.
//
// The job is RECONCILIATION, and it is the same truthfulness problem
// lib/outcomes/reconciliation.ts exists to solve, one level up:
//
//   THE CLAIM   listings.status='active' / lifecycle_stage='MLS_ACTIVE'.
//               The OS asserts this listing is live on the MLS.
//   THE TRUTH   a syndication feed the brokerage already pays for — RentCast's
//               for-sale index, or the tenant's own IDX Broker connection.
//
// Nothing in the OS ever asked. `launchListing` flips the row to active because a
// human pressed a button, and from that instant every downstream surface — the
// seller report, the buyer-match blast, the marketing engine, the syndication
// claim on the public listing page — treats "live on the MLS" as an established
// fact. If the MLS entry was never actually completed, was rejected, or was
// entered under a different number, NOTHING would ever notice.
//
// ── WHY THIS IS A SEPARATE MODULE FROM lib/outcomes/reconciliation.ts ────────
// That module's OutcomeChannel is a DELIVERY lane: did a message reach a person.
// This is a SYNDICATION claim: did a record reach a marketplace. Forcing this in
// as a seventh "channel" would repeat the exact error that module's own header
// calls out for `video` — conflating "did it get MADE" with "did it REACH
// anybody". Different question, different truth sources, different actor.
// It deliberately reuses the VOCABULARY, so the two read as one system.
//
// ── THE FOUR HONEST STATES ───────────────────────────────────────────────────
//
//   confirmed     a feed reports this address as an active for-sale listing AND
//                 the MLS number it reports matches ours. The claim is proven.
//
//   contradicted  a feed reports this address with a DIFFERENT MLS number. This
//                 is the dangerous one and the reason this module exists: an MLS
//                 number is the industry identity of a specific property, so a
//                 mismatch means we are publishing someone else's identifier on
//                 our listing. A consumer, a portal and a compliance officer all
//                 treat that field as authoritative. Somebody must look.
//
//   pending       no feed has this address yet. Syndication lags MLS entry by
//                 hours to days, so absence early is NORMAL and is NOT evidence
//                 of failure. It becomes evidence with time — see staleness.
//
//   unverifiable  this brokerage has NO feed connected. "Not found" from a
//                 source that was never consulted is not a finding, and letting
//                 it render as one would be worse than saying nothing. Said out
//                 loud, per tenant, exactly as the delivery lanes do.
//
// The distinction between `pending` and `unverifiable` is the whole discipline.
// Collapsing them would let a brokerage with no RentCast key and no IDX
// connection see a permanent "not on the MLS" warning on every correct listing —
// which trains people to ignore the warning, which is how the one real mismatch
// gets missed.
//
// PURE — no I/O. Every verdict is unit-tested without a database or a vendor.

/** Where a syndication truth can come from. Both are already-paid-for feeds. */
export type MlsFeedSource = "rentcast" | "idx"

/** One feed row that matched the listing's address. */
export interface MlsFeedObservation {
  source: MlsFeedSource
  /** The MLS number the feed reports, when it reports one. */
  mlsNumber: string | null
  /** The feed's name for the originating MLS, when it has one (RentCast only). */
  mlsName: string | null
  /** The address the feed has — carried so a human can judge the match. */
  address: string
  /** The feed's listing status verbatim, never normalised before mapping. */
  status: string | null
}

export type MlsVerdict = "confirmed" | "contradicted" | "pending" | "unverifiable"

export interface MlsVerification {
  verdict: MlsVerdict
  /** True when a human must look: we are asserting something the feed disputes. */
  needsAttention: boolean
  /** One line someone can act on. */
  explanation: string
  /** The feeds that were actually consulted. Empty ⇒ verdict is unverifiable. */
  consulted: MlsFeedSource[]
  /** The observation the verdict rests on, when there is one. */
  evidence: MlsFeedObservation | null
}

/**
 * Statuses a feed uses for a listing that is LIVE. Anything else (pending,
 * withdrawn, expired, sold) is not an active syndication and must not confirm.
 * RentCast uses 'Active'; IDX Broker's propStatus vocabulary is looser, so the
 * comparison is case-insensitive and a null status is treated as unknown rather
 * than as active — an unknown status confirming would be a guess.
 */
const ACTIVE_FEED_STATUSES = ["active", "for sale", "forsale", "a", "new"] as const

/** PURE — is this feed row a live for-sale listing? */
export function isActiveOnFeed(o: MlsFeedObservation): boolean {
  if (!o.status) return false
  return (ACTIVE_FEED_STATUSES as readonly string[]).includes(o.status.trim().toLowerCase())
}

/**
 * PURE — compare two MLS numbers the way a human would, without being clever.
 *
 * Feeds format the same number differently: "24-118372" vs "24118372" vs
 * "MLS24118372". Case and the separators are noise. Everything else is signal —
 * this deliberately does NOT do fuzzy or prefix matching, because the failure it
 * would cause (declaring two DIFFERENT listings the same, and so confirming a
 * wrong number as correct) is the exact harm the module exists to catch.
 */
export function sameMlsNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) =>
    (v ?? "").toLowerCase().replace(/[\s\-_.#]/g, "").replace(/^mls/, "")
  const na = norm(a), nb = norm(b)
  return na.length > 0 && na === nb
}

/**
 * How long after going live before `pending` stops being innocent.
 *
 * Syndication is not instant: an MLS pushes to aggregators on its own schedule
 * and RentCast/IDX re-index behind that. Two full business days is generous
 * enough that a correct listing will essentially always have appeared, and short
 * enough that a listing that never actually made it to the MLS is caught while
 * the seller still has a market. This is a THRESHOLD FOR RAISING A HUMAN, never
 * a threshold for changing the verdict — time does not turn absence into proof.
 */
export const SYNDICATION_GRACE_HOURS = 48

/** PURE — has a listing been live long enough that still-not-found is worth a look? */
export function isSyndicationOverdue(
  liveSince: string | Date | null | undefined,
  now: Date = new Date(),
  graceHours: number = SYNDICATION_GRACE_HOURS,
): boolean {
  if (!liveSince) return false
  const t = liveSince instanceof Date ? liveSince : new Date(liveSince)
  if (Number.isNaN(t.getTime())) return false
  return now.getTime() - t.getTime() > graceHours * 3_600_000
}

export interface MlsClaim {
  /** What the OS has stored and is publishing. */
  storedMlsNumber: string | null
  /** When the listing was flipped live, for the overdue judgement. */
  liveSince: string | null
}

/**
 * PURE: reconcile the OS's "this is live on the MLS" claim against the feeds.
 *
 * ORDER MATTERS, and this is the order:
 *   1. No feed consulted        → unverifiable. Never anything else.
 *   2. A feed contradicts       → contradicted. A mismatch OUTRANKS a match from
 *                                 another feed: if RentCast and IDX disagree
 *                                 about which number belongs to this address,
 *                                 that is precisely when a human is needed, and
 *                                 letting the agreeing feed win would bury it.
 *   3. A feed confirms          → confirmed.
 *   4. Otherwise                → pending.
 *
 * `contradicted` requires BOTH sides to have a number. A feed row with a null
 * mlsNumber cannot contradict anything — it is evidence the address is listed,
 * not evidence about which number is right.
 */
export function verifyMlsSyndication(
  claim: MlsClaim,
  observations: MlsFeedObservation[],
  consulted: MlsFeedSource[],
  now: Date = new Date(),
): MlsVerification {
  if (consulted.length === 0) {
    return {
      verdict: "unverifiable",
      needsAttention: false,
      explanation:
        "No syndication feed is connected for this brokerage, so nothing can confirm " +
        "or dispute that this listing is live. Connect RentCast or IDX Broker to verify.",
      consulted: [],
      evidence: null,
    }
  }

  const active = observations.filter(isActiveOnFeed)

  // 2. A number we can compare, that disagrees. Checked before confirmation.
  const mismatch = active.find(
    (o) => !!o.mlsNumber && !!claim.storedMlsNumber && !sameMlsNumber(o.mlsNumber, claim.storedMlsNumber),
  )
  if (mismatch) {
    return {
      verdict: "contradicted",
      needsAttention: true,
      explanation:
        `${sourceLabel(mismatch.source)} lists ${mismatch.address} under MLS# ${mismatch.mlsNumber}, ` +
        `but this listing publishes MLS# ${claim.storedMlsNumber}. One of them is wrong, and the ` +
        `number we publish is the one buyers and portals will use to find the property.`,
      consulted,
      evidence: mismatch,
    }
  }

  // 3. Same address, same number, live on the feed.
  const match = active.find((o) => sameMlsNumber(o.mlsNumber, claim.storedMlsNumber))
  if (match) {
    return {
      verdict: "confirmed",
      needsAttention: false,
      explanation:
        `Live on the MLS — ${sourceLabel(match.source)} shows ${match.address} active under ` +
        `MLS# ${match.mlsNumber}${match.mlsName ? ` (${match.mlsName})` : ""}.`,
      consulted,
      evidence: match,
    }
  }

  // 4. Not seen yet. Whether that is innocent depends only on TIME, never on
  //    how much we would like it to be true.
  const overdue = isSyndicationOverdue(claim.liveSince, now)
  return {
    verdict: "pending",
    needsAttention: overdue,
    explanation: overdue
      ? `This listing has been marked live for more than ${SYNDICATION_GRACE_HOURS} hours and still has ` +
        `not appeared on ${consulted.map(sourceLabel).join(" or ")}. Confirm the MLS entry was actually ` +
        `completed and accepted — syndication should have caught up by now.`
      : `Not on ${consulted.map(sourceLabel).join(" or ")} yet. Syndication normally lags MLS entry by ` +
        `several hours, so this is expected for a listing that just went live.`,
    consulted,
    evidence: null,
  }
}

function sourceLabel(s: MlsFeedSource): string {
  return s === "rentcast" ? "RentCast" : "your IDX feed"
}
