// lib/platform/disposition-route.ts
//
// PLATFORM-MEMBERSHIP DISPOSITION ROUTING — the single decision the whole team respects for broker-side
// steps (CDA signature, compliance approval, sending contracts back). A solo agent can be on the app
// while their managing brokerage/team is NOT a customer; in that case those steps can't happen in-app
// (there's no on-platform broker/compliance user) and must route OUT to the agent's configured external
// form platform. When the brokerage/team IS on the platform (or the account is a team/brokerage/multi
// tier — the org itself is the customer, with its own broker/admin users), everything runs in-app.
//
// Set explicitly at solo-agent account creation (brokerages.brokerage_on_platform / team_on_platform),
// never guessed. Pure → unit-tested.

export type DispositionRoute = "in_app" | "external_form_platform"

export interface DispositionDecision {
  route: DispositionRoute
  reason: string
  /** True when the account is a solo agent whose brokerage is NOT on the platform. */
  brokerageExternal: boolean
}

/**
 * PURE: where do broker-side steps for this account run? A team/brokerage/multi_location account is
 * itself the platform customer (its own broker/admin users handle these) → in_app. A solo_agent routes
 * by the explicit membership flag: brokerage on-platform → in_app; brokerage off-platform → out to the
 * external form platform. `planTier` null defaults to solo_agent (matches the plan-tier default).
 */
export function resolveDispositionRoute(input: {
  planTier: string | null | undefined
  brokerageOnPlatform: boolean | null | undefined
  teamOnPlatform?: boolean | null | undefined
}): DispositionDecision {
  const tier = input.planTier ?? "solo_agent"
  if (tier !== "solo_agent") {
    return { route: "in_app", reason: "org_is_the_customer", brokerageExternal: false }
  }
  // Solo agent — the explicit membership flag decides.
  const brokerageOnPlatform = input.brokerageOnPlatform === true
  if (brokerageOnPlatform) {
    return { route: "in_app", reason: "solo_agent_brokerage_on_platform", brokerageExternal: false }
  }
  return { route: "external_form_platform", reason: "solo_agent_brokerage_external", brokerageExternal: true }
}
