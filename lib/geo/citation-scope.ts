/**
 * lib/geo/citation-scope.ts
 *
 * WHOSE GEO AM I LOOKING AT — the owner's rule ("geo should be for agents, teams
 * and brokerages") as one pure function, so the page, the server read and the
 * guard all agree on the same answer.
 *
 * The rail was brokerage-scoped end to end: the GEO tab filtered on brokerage_id
 * alone, so an agent saw every reel in the company and none of them as theirs.
 * GEO is the one marketing surface where the unit of value is the PERSON — an AI
 * answer that names an agent is that agent's lead.
 *
 * PURE + total: no I/O, no imports. The server resolves the four facts (role,
 * agent, team, and whether the tenant HAS teams) and this decides what may be
 * shown. Kept out of the page so the guard can execute it rather than pattern-
 * match a JSX tree.
 */

export type CitationScope = "agent" | "team" | "brokerage"

/** Broker-tier roles: the whole brokerage is theirs to see. */
const BROKERAGE_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "platform_admin", "owner",
])
/** Team-tier roles: their team plus their own pages. */
const TEAM_ROLES = new Set(["team_lead", "team_leader"])

export interface ScopeInput {
  /** users.user_type / AgentContext.userType. */
  role: string
  /** agents.id for this viewer, or null (a broker with no agent row). */
  agentId: string | null
  /** agents.team_id for this viewer, or null. */
  teamId: string | null
}

export interface ScopeChoice {
  scope: CitationScope
  label: string
  /** The column the read filters on, and the value — the caller never invents a filter. */
  column: "agent_id" | "team_id" | "brokerage_id"
  value: string | null
}

/**
 * The scopes this viewer may select, most specific first, and which is default.
 *
 * The list is built from what the viewer ACTUALLY HAS, never from the role alone:
 * an agent with no team is not offered a team tab that would read NULL and show
 * the whole company's unassigned pages, and a viewer with no agent row is not
 * offered "Mine". An affordance that names a scope the data cannot express is
 * the same dead button this codebase keeps paying for.
 */
export function allowedScopes(input: ScopeInput, brokerageId: string): ScopeChoice[] {
  const out: ScopeChoice[] = []
  const role = (input.role ?? "").toLowerCase()

  if (input.agentId) {
    out.push({ scope: "agent", label: "Mine", column: "agent_id", value: input.agentId })
  }
  if (input.teamId && (TEAM_ROLES.has(role) || BROKERAGE_ROLES.has(role) || !!input.agentId)) {
    out.push({ scope: "team", label: "My Team", column: "team_id", value: input.teamId })
  }
  if (BROKERAGE_ROLES.has(role) || TEAM_ROLES.has(role)) {
    out.push({ scope: "brokerage", label: "Brokerage", column: "brokerage_id", value: brokerageId })
  }

  // A viewer who is neither staff nor an agent still gets a coherent surface
  // rather than an empty switcher — their own tenant, which is what every read
  // was already scoped to before this existed.
  if (out.length === 0) {
    out.push({ scope: "brokerage", label: "Brokerage", column: "brokerage_id", value: brokerageId })
  }
  return out
}

/**
 * The scope to open on. An agent lands on their own GEO — the number they can
 * actually move — rather than a company aggregate they cannot influence. Staff
 * land on the widest scope they hold, which is the one they are accountable for.
 */
export function defaultScope(choices: ScopeChoice[], role: string): CitationScope {
  const r = (role ?? "").toLowerCase()
  if (BROKERAGE_ROLES.has(r)) {
    const brokerage = choices.find((c) => c.scope === "brokerage")
    if (brokerage) return brokerage.scope
  }
  return choices[0]?.scope ?? "brokerage"
}

/** Resolve a requested scope against what is allowed — an unknown or unpermitted
 *  request degrades to the default rather than widening the read. */
export function resolveScope(
  choices: ScopeChoice[],
  requested: string | null | undefined,
  role: string,
): ScopeChoice {
  const match = choices.find((c) => c.scope === requested)
  if (match) return match
  const fallback = defaultScope(choices, role)
  return choices.find((c) => c.scope === fallback) ?? choices[0]
}

/** What the empty state should say — the reason differs by scope, and "no data"
 *  is not the same message as "you have published nothing citable yet". */
export function emptyScopeMessage(scope: CitationScope): string {
  if (scope === "agent") {
    return "No AI-search citations for your pages yet. Publish a reel page or a lead-magnet page and the citation monitor will start checking whether ChatGPT, Perplexity, Gemini and Google AI Overviews name you."
  }
  if (scope === "team") {
    return "No AI-search citations for your team's pages yet. Once teammates publish citable pages, their results roll up here."
  }
  return "No AI-search citation data yet. Once your brokerage publishes reel or lead-magnet pages and the citation monitor runs, you'll see which platforms are citing your content here."
}
