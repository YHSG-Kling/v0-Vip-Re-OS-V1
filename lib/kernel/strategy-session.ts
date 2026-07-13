/**
 * lib/kernel/strategy-session.ts
 *
 * STRATEGY SESSIONS — the concierge list, item 24: "strategy sessions at key
 * moments (listing, price change, offer decision, relocation) with
 * auto-prepared agendas and briefs." A luxury advisor doesn't fire off
 * another text at a big moment — they sit the client down with an agenda
 * someone prepared. The OS is that someone: it detects the moment from the
 * REAL deal state, writes the agenda grounded in the real numbers, and
 * drafts the warm invite. The agent holds the meeting; the OS did the prep.
 *
 * PURE: inferStrategyMoment decides WHICH session this client needs right
 * now (offers on the table beat everything; a stale listing beats a fresh
 * one; a buyer gets the kickoff). composeStrategySession writes the agenda
 * from the facts with honest degradation — a missing number produces an
 * agenda line without a figure, never an invented one. The action layer
 * does the I/O. NOT server-only (simulator-driven).
 */

export type StrategyMoment = "offer_decision" | "price_change" | "listing_launch" | "buyer_kickoff"

export interface StrategyStateFacts {
  buyerStage: string | null
  hasActiveListing: boolean
  daysOnMarket: number | null
  offersAwaitingResponse: number
}

/** PURE: which strategy session does this client need right now?
 *  Offers on the table always win; a listing 21+ days out with none is the
 *  price talk; a fresh listing gets the launch; a buyer gets the kickoff. */
export function inferStrategyMoment(s: StrategyStateFacts): StrategyMoment | null {
  if (s.hasActiveListing && s.offersAwaitingResponse > 0) return "offer_decision"
  if (s.hasActiveListing && (s.daysOnMarket ?? 0) >= 21) return "price_change"
  if (s.hasActiveListing) return "listing_launch"
  if (s.buyerStage) return "buyer_kickoff"
  return null
}

export interface StrategySessionFacts {
  moment: StrategyMoment
  /** how the client prefers to be addressed (resolveAddressing.addressAs). */
  clientName: string
  listingAddress: string | null
  listPrice: number | null
  daysOnMarket: number | null
  showingCount: number | null
  offersAwaitingResponse: number
  topOfferPrice: number | null
  sellerNetEstimate: number | null
  responseDeadline: string | null
  budgetMin: number | null
  budgetMax: number | null
  buyerStage: string | null
}

export interface StrategySession {
  moment: StrategyMoment
  title: string
  durationMin: number
  /** the meeting agenda — grounded in the real numbers, 4–6 items. */
  agenda: string[]
  /** what the OS prepared / the agent should bring. */
  agentPrep: string[]
  /** the warm, no-pressure invite draft to send the client. */
  inviteLine: string
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`

/** PURE: the auto-prepared session — agenda, prep, and invite from real facts. */
export function composeStrategySession(f: StrategySessionFacts): StrategySession {
  const name = f.clientName || "your client"
  const addr = f.listingAddress

  if (f.moment === "offer_decision") {
    const top = f.topOfferPrice != null ? ` (strongest at ${usd(f.topOfferPrice)})` : ""
    return {
      moment: f.moment,
      title: `Offer decision session with ${name}`,
      durationMin: 30,
      agenda: [
        `Walk the ${f.offersAwaitingResponse} offer${f.offersAwaitingResponse === 1 ? "" : "s"} on the table${top} — price, terms, and contingencies side by side.`,
        f.sellerNetEstimate != null
          ? `What each path actually nets: the strongest offer pencils to roughly ${usd(f.sellerNetEstimate)} after costs.`
          : `What each path actually nets after costs (net sheet walked live).`,
        f.responseDeadline
          ? `The clock: a response is due ${new Date(f.responseDeadline).toLocaleDateString()} — decide today what happens if we do nothing.`
          : `Response timing — what the deadline pressure really is, and what it isn't.`,
        `Counter strategy: accept, counter on price, or counter on terms — the trade-offs of each.`,
        `Take a beat: the decision framework before anything is signed (no same-hour signatures on the biggest asset they own).`,
      ],
      agentPrep: [
        `The OS prepared the offer economics${f.sellerNetEstimate != null ? " and the net estimate" : ""}; bring the comparison on one screen.`,
        `Have the counter language ready for the two most likely responses.`,
      ],
      inviteLine: `${name}, the offer${f.offersAwaitingResponse === 1 ? "" : "s"} deserve${f.offersAwaitingResponse === 1 ? "s" : ""} a proper sit-down, not a text thread. I've prepared everything side by side — can we take 30 minutes together before we respond?`,
    }
  }

  if (f.moment === "price_change") {
    const dom = f.daysOnMarket != null ? `${f.daysOnMarket} days` : "several weeks"
    const showings = f.showingCount != null ? `${f.showingCount} showing${f.showingCount === 1 ? "" : "s"}` : "the showing traffic"
    const cuts = f.listPrice != null
      ? `If we adjust, the honest options are ~3% (${usd(f.listPrice * 0.97)}) or ~5% (${usd(f.listPrice * 0.95)}) — and what each signals to the market.`
      : `If we adjust, the honest options are a ~3% or ~5% move — and what each signals to the market.`
    return {
      moment: f.moment,
      title: `Pricing strategy session with ${name}`,
      durationMin: 30,
      agenda: [
        `Where we are honestly: ${dom} on market${addr ? ` at ${addr}` : ""}, ${showings}, and no offer yet — what that pattern usually means.`,
        `What the market said since launch: feedback themes and how buyers are reading the price.`,
        cuts,
        `The alternatives to a price move: presentation refresh, marketing re-push, or holding with a date to revisit.`,
        `Decide the plan and the message — the listing story stays confident either way.`,
      ],
      agentPrep: [
        `The OS prepared the DOM/showings read; pull the freshest comps before the session.`,
        `Bring the showing-feedback themes verbatim — sellers trust quotes over summaries.`,
      ],
      inviteLine: `${name}, we're ${dom} in and I'd rather bring you a real strategy conversation than another status update. I've prepared the numbers and the honest options — 30 minutes this week?`,
    }
  }

  if (f.moment === "listing_launch") {
    return {
      moment: f.moment,
      title: `Listing launch session with ${name}`,
      durationMin: 30,
      agenda: [
        f.listPrice != null
          ? `The pricing logic behind ${usd(f.listPrice)}${addr ? ` for ${addr}` : ""} — why this number, and what would change it.`
          : `The pricing logic${addr ? ` for ${addr}` : ""} — how the number gets set, and what would change it.`,
        `Week one, hour by hour: photos, go-live, syndication, and the showing plan (access, lockbox, notice).`,
        `What "good" looks like in the first 14 days — showings and inquiry pace we should expect, and the checkpoint we'll hold.`,
        `How you'll hear from me: the update rhythm, and the promise that every update ends with "here's what's next."`,
        `Your part: presentation punch-list and how showings-day works for the household.`,
      ],
      agentPrep: [
        `The OS prepared the launch checklist; confirm photo and go-live dates before the session.`,
        `Set the 14-day checkpoint on the calendar in the meeting, not after.`,
      ],
      inviteLine: `${name}, before we go live I'd like to walk you through the whole plan in one sitting — price logic, week one, and exactly how you'll hear from me. 30 minutes, and you'll never wonder what's happening.`,
    }
  }

  // buyer_kickoff
  const budget = f.budgetMin != null || f.budgetMax != null
    ? `${f.budgetMin != null ? usd(f.budgetMin) : "open"}–${f.budgetMax != null ? usd(f.budgetMax) : "open"}`
    : null
  return {
    moment: "buyer_kickoff",
    title: `Buying strategy session with ${name}`,
    durationMin: 45,
    agenda: [
      `The goals interview: what matters most — schools, commute, space, privacy — so every home we look at is chosen, not sprayed.`,
      budget
        ? `The money conversation, honestly: the ${budget} range, financing readiness, and what monthly actually feels like.`
        : `The money conversation, honestly: range, financing readiness, and what monthly actually feels like.`,
      `How the search will work: curated sets with my reasoning (including what I'm deliberately NOT sending), not a raw firehose.`,
      `Touring and deciding: how showings get booked, how offers work here, and the pace that wins without panic.`,
      `How you like to be reached — channel, tempo, and how much detail — so the process fits your life.`,
    ],
    agentPrep: [
      `The OS prepared the intake${f.buyerStage ? ` (stage: ${f.buyerStage.replace(/_/g, " ")})` : ""}; capture preferences INTO the file during the meeting — nothing said twice.`,
      `Have two example curated sets ready to show what "chosen, not sprayed" means.`,
    ],
    inviteLine: `${name}, before we look at a single home I'd like 45 minutes to build your strategy — what you actually want, what the money looks like, and how we'll run the search so it never feels like homework.`,
  }
}
