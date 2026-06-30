// ─── YOUR NEXT MOVE (client-facing radar) ────────────────────────────────────
// Pure, import-free logic behind the lifetime portal's "Your Next Move" card.
//
// This is the CLIENT-FACING, self-directed mirror of the agent-side seller-
// likelihood radar (lib/predictive-listing). CRITICAL DIFFERENCE: this surface
// uses ONLY non-sensitive, financial inputs — equity and tenure — never any
// protected-class or life-event signal (fair housing). Every option is opt-in:
// the homeowner taps to start a conversation; nothing is targeted AT them based
// on who they are. Framing is equity-driven and contains no guarantee/forecast.

export type NextMoveIntent =
  | "move_up"
  | "right_size"
  | "invest"
  | "refinance"
  | "improve"
  | "explore"

export const NEXT_MOVE_INTENTS: NextMoveIntent[] = [
  "move_up",
  "right_size",
  "invest",
  "refinance",
  "improve",
  "explore",
]

export interface NextMoveOption {
  intent: NextMoveIntent
  title: string
  blurb: string
  cta: string
  /** Which manager the Sphere of Influence delegates this intent to (feed copy). */
  routeManager: "shopping_agent" | "listing_concierge" | "finance_manager" | "sphere_of_influence"
}

export interface NextMoveInput {
  /** Realized equity ($) from the wealth story; may be negative/zero. */
  estimatedEquity?: number | null
  /** Whole years owned. */
  yearsHeld?: number | null
}

export function isNextMoveIntent(v: unknown): v is NextMoveIntent {
  return typeof v === "string" && (NEXT_MOVE_INTENTS as string[]).includes(v)
}

// Equity over this threshold is enough to meaningfully fund a down payment on a
// second/investment property — used only to decide whether to SHOW the invest
// option, never to target the client.
const INVEST_EQUITY_FLOOR = 100_000

export interface NextMoveDeck {
  /** Equity-aware one-liner shown above the options (no forecast/guarantee). */
  headline: string
  options: NextMoveOption[]
}

const formatUsd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export function nextMoveDeck(input: NextMoveInput): NextMoveDeck {
  const equity = typeof input.estimatedEquity === "number" ? input.estimatedEquity : 0
  const hasEquity = equity > 0

  const headline = hasEquity
    ? `You've built an estimated ${formatUsd(equity)} in equity. Here's what it could open up — explore at your pace.`
    : `Curious what's possible with your home? Explore your options — your agent can run the numbers with you.`

  const options: NextMoveOption[] = [
    {
      intent: "move_up",
      title: "Buy your next home",
      blurb: "Use your equity toward the down payment on a larger or different home.",
      cta: "I'm thinking about moving up",
      routeManager: "shopping_agent",
    },
    {
      intent: "right_size",
      title: "Find a home that fits your life now",
      blurb: "A different size, layout, or location that better matches what you need today.",
      cta: "I'm thinking about right-sizing",
      routeManager: "shopping_agent",
    },
    {
      intent: "refinance",
      title: "Lower your payment or tap equity",
      blurb: "See whether a refinance or HELOC could lower your rate or free up cash.",
      cta: "Show me refinance options",
      routeManager: "finance_manager",
    },
    {
      intent: "improve",
      title: "Renovate & add value",
      blurb: "Plan improvements with trusted local pros — and see what adds resale value.",
      cta: "I want to improve my home",
      routeManager: "sphere_of_influence",
    },
    {
      intent: "explore",
      title: "Just talk it through",
      blurb: "No agenda — get an updated value and a no-pressure conversation with your agent.",
      cta: "Let's talk",
      routeManager: "sphere_of_influence",
    },
  ]

  // Investment property only surfaces when equity could realistically fund it —
  // a relevance filter, not targeting. Insert after "right_size".
  if (equity >= INVEST_EQUITY_FLOOR) {
    options.splice(2, 0, {
      intent: "invest",
      title: "Buy an investment property",
      blurb: "Put your equity to work on a rental or second home.",
      cta: "I'm curious about investing",
      routeManager: "shopping_agent",
    })
  }

  return { headline, options }
}

/** The next concrete step the Sphere Manager proposes to the agent per intent. */
export function nextStepForIntent(intent: NextMoveIntent): string {
  switch (intent) {
    case "move_up":
    case "right_size":
      return "buyer consult + a CMA on their current home (move-up needs both sides)"
    case "invest":
      return "investor buy-box conversation + financing pre-check"
    case "refinance":
      return "refinance/HELOC review with the finance desk"
    case "improve":
      return "renovation/vendor-marketplace intro + value-add guidance"
    case "explore":
      return "a no-pressure equity review call"
  }
}
