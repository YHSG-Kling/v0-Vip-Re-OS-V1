import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { getTrendingKeywords, getCompetitorHighPerformers } from "@/app/actions/marketing-intelligence"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Search } from "lucide-react"
import { SeoKeywordsDashboardClient } from "./seo-keywords-client"
import { CompetitorsClient } from "../competitors/competitors-client"
import { MarketTrendsPanel } from "./components/market-trends-panel"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import {
  AiCitationVisibilityCard,
  type CitationObservationRow,
} from "@/app/dashboard/intelligence/components/ai-citation-visibility-card"
import { CitationShareCard } from "./citation-share-card"
import { LandingCitationCard, type LandingCitationRow } from "./landing-citation-card"
import type { ShareObservationRow } from "@/lib/geo/citation-share"
import {
  allowedScopes, resolveScope, emptyScopeMessage, type CitationScope,
} from "@/lib/geo/citation-scope"

export const metadata = {
  title: "SEO / GEO | Marketing",
  description: "Keywords, competitors, market trends, and AI-search (GEO) visibility",
}

const TABS = [
  { key: "keywords", label: "Keywords" },
  { key: "competitors", label: "Competitors" },
  { key: "trends", label: "Market Trends" },
  { key: "geo", label: "GEO / AI Visibility" },
] as const

type TabKey = (typeof TABS)[number]["key"]

export default async function SeoGeoPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; scope?: string }>
}) {
  const { tab, scope } = await searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userData?.brokerage_id) redirect("/dashboard/onboarding")
  const brokerageId = userData.brokerage_id

  const activeTab: TabKey = (TABS.some((t) => t.key === tab) ? tab : "keywords") as TabKey

  // Brokerage territory — the default market for keyword + competitor tools.
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("city, state")
    .eq("id", brokerageId)
    .maybeSingle()
  const defaultTerritory =
    brokerage?.city && brokerage?.state ? `${brokerage.city}, ${brokerage.state}` : undefined

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">SEO / GEO</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Rank higher and win AI-search visibility — manage keywords, track competitors, mine market
          trends, and monitor how AI engines cite you.
        </p>
      </div>

      {/* Tab bar */}
      <div className="border-b flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/marketing/seo?tab=${t.key}`}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {activeTab === "keywords" && (
        <KeywordsTab userId={user.id} brokerageId={brokerageId} defaultTerritory={defaultTerritory} />
      )}
      {activeTab === "competitors" && (
        <CompetitorsTab brokerageId={brokerageId} defaultTerritory={defaultTerritory ?? ""} />
      )}
      {activeTab === "trends" && <TrendsTab />}
      {activeTab === "geo" && <GeoTab brokerageId={brokerageId} requestedScope={scope ?? null} />}
    </div>
  )
}

// ─── Keywords ────────────────────────────────────────────────────────────────
async function KeywordsTab({
  userId,
  brokerageId,
  defaultTerritory,
}: {
  userId: string
  brokerageId: string
  defaultTerritory?: string
}) {
  const supabase = await createClient()
  const { data: keywords } = await supabase
    .from("seo_keywords")
    .select(
      "id, keyword, keyword_type, search_intent, target_location, search_volume, competition, difficulty_score, priority_score, is_active, created_at",
    )
    .eq("brokerage_id", brokerageId)
    .order("priority_score", { ascending: false, nullsFirst: false })

  return (
    <SeoKeywordsDashboardClient
      userId={userId}
      brokerageId={brokerageId}
      initialKeywords={keywords || []}
      defaultTerritory={defaultTerritory}
    />
  )
}

// ─── Competitors ─────────────────────────────────────────────────────────────
async function CompetitorsTab({
  brokerageId,
  defaultTerritory,
}: {
  brokerageId: string
  defaultTerritory: string
}) {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()
  const { data: competitors } = await supabase
    .from("competitors")
    .select("id, competitor_name, competitor_url, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  return (
    <CompetitorsClient
      initialCompetitors={competitors ?? []}
      agentId={agentId ?? ""}
      defaultMarketArea={defaultTerritory}
    />
  )
}

// ─── Market Trends ───────────────────────────────────────────────────────────
async function TrendsTab() {
  const [keywords, competitors] = await Promise.all([
    getTrendingKeywords({ limit: 24 }),
    getCompetitorHighPerformers({ limit: 12 }),
  ])
  return <MarketTrendsPanel keywords={keywords} competitors={competitors} />
}

// ─── GEO / AI Visibility ─────────────────────────────────────────────────────
// SCOPED, per the owner's rule that GEO is for agents, teams AND brokerages.
// This read used to filter on brokerage_id alone, so an agent opened GEO to a
// company aggregate: every reel in the brokerage, none of them identifiable as
// theirs, and no way to see the one number they can actually move. The scope
// choices come from lib/geo/citation-scope — built from what the viewer ACTUALLY
// has (no team → no team tab), never from the role alone.
async function GeoTab({
  brokerageId, requestedScope,
}: { brokerageId: string; requestedScope: string | null }) {
  const supabase = await createClient()
  const { agentId, userType } = await getAgentContext()

  // The viewer's team, read from their own agents row — the same column the
  // monitor stamps onto each observation.
  let teamId: string | null = null
  if (agentId) {
    const { data: a } = await supabase.from("agents").select("team_id").eq("id", agentId).maybeSingle()
    teamId = (a as { team_id: string | null } | null)?.team_id ?? null
  }

  const choices = allowedScopes({ role: userType, agentId, teamId }, brokerageId)
  const active = resolveScope(choices, requestedScope, userType)

  const citationSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
  let query = supabase
    .from("ai_search_citation_observations")
    // `query` is the prompt the monitor asked — the card shows it under each outcome.
    .select("id, platform, outcome, cited_url, provider, public_slug, observed_at, project_id, observed_on, competitors_cited, query")
    // The tenant filter ALWAYS applies. The scope filter narrows within it — it
    // never replaces it, so a narrower scope can never widen the read.
    .eq("brokerage_id", brokerageId)
  // agent_id / team_id ARE READ HERE — as the dynamic filter column
  // `active.column` (one of brokerage_id | team_id | agent_id, from
  // allowedScopes), not as selected fields. A column-level census that looks
  // for the literal name inside `.select()` / `.eq("agent_id", …)` cannot see
  // this `.eq(active.column, …)`, so ai_search_citation_observations.agent_id
  // and .team_id read as "written, never read" in scripts/opposite-missing-
  // baseline.json while being the axis this whole page pivots on. They are
  // deliberately NOT added to the select: nothing renders a per-row
  // attribution, and selecting a column no one shows is the other half of the
  // same orphan. (The landing rail below spells its branches literally for the
  // same reason — see the comment there.)
  if (active.column !== "brokerage_id" && active.value) {
    query = query.eq(active.column, active.value)
  }
  const { data: citationRows, error } = await query
    .gte("observed_at", citationSince)
    .order("observed_at", { ascending: false })
    .limit(60)
  const observations: CitationObservationRow[] = error
    ? []
    : ((citationRows ?? []) as CitationObservationRow[])

  // THE LANDING RAIL'S OBSERVATIONS (lane M2). runLandingPageCitationMonitor
  // records the same daily pass for lead-magnet / FAQ landing pages into its
  // OWN table (ai_search_landing_citation_observations — FK'd to
  // lead_capture_forms, deliberately not merged with the reels table above:
  // same-sounding, different capability), and until this read the only
  // consumer was the geo-gap runner's outcome counts. The query the AI was
  // asked, the provider, the cited URL, the agent/team attribution (m335) and
  // the competitor share (m328) had no reader at all. Same scope discipline as
  // the reels read: the tenant filter ALWAYS applies; the scope filter narrows
  // within it, spelled as literal branches so the columns stay visible to
  // every static scanner in this repo.
  let landingQuery = supabase
    .from("ai_search_landing_citation_observations")
    .select(
      "id, platform, outcome, query, cited_url, provider, public_slug, observed_at, competitors_cited, agent_id, team_id",
    )
    .eq("brokerage_id", brokerageId)
  if (active.column === "agent_id" && active.value) {
    landingQuery = landingQuery.eq("agent_id", active.value)
  } else if (active.column === "team_id" && active.value) {
    landingQuery = landingQuery.eq("team_id", active.value)
  }
  const { data: landingRows, error: landingErr } = await landingQuery
    .gte("observed_at", citationSince)
    .order("observed_at", { ascending: false })
    .limit(60)
  // §3: the error is read; a refused read renders as no card, never as a crash
  // or a fabricated zero-visibility claim.
  if (landingErr) {
    console.error("[seo/geo] landing citation observations read refused:", landingErr.message)
  }
  const landingObservations: LandingCitationRow[] = landingErr
    ? []
    : ((landingRows ?? []) as LandingCitationRow[])

  const scopeBar =
    choices.length > 1 ? (
      <div className="flex gap-1">
        {choices.map((c) => (
          <Link
            key={c.scope}
            href={`/dashboard/marketing/seo?tab=geo&scope=${c.scope}`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active.scope === c.scope
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {c.label}
          </Link>
        ))}
      </div>
    ) : null

  // The empty state only claims "nothing citable" when BOTH rails are empty —
  // a brokerage whose reels were never checked may still have landing-page
  // observations, and hiding them behind the reels empty state re-orphans them.
  if (observations.length === 0 && landingObservations.length === 0) {
    return (
      <div className="space-y-4">
        {scopeBar}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="h-4 w-4" />
              GEO / AI-Search Visibility
            </CardTitle>
            <CardDescription>
              Whether AI search engines (ChatGPT, Perplexity, Gemini, Google AI Overviews) cite your
              published pages. Generative Engine Optimization is the new organic traffic.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* The reason for an empty state differs by scope — "you have published
                nothing citable yet" is a different fact from "your brokerage has no
                data", and only one of them is the viewer's to act on. */}
            <p className="text-sm text-muted-foreground py-6 text-center">
              {emptyScopeMessage(active.scope as CitationScope)}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // The share KPI collapses the per-platform rows onto the ANSWER they came
  // from, so its sample size is answers-read rather than rows-written.
  const shareRows: ShareObservationRow[] = (citationRows ?? []).map((r: any) => ({
    pageId: String(r.project_id ?? ""),
    observedOn: String(r.observed_on ?? String(r.observed_at ?? "").slice(0, 10)),
    outcome: r.outcome,
    competitorsCited: r.competitors_cited ?? null,
  }))

  return (
    <div className="space-y-4">
      {scopeBar}
      <CitationShareCard rows={shareRows} />
      <AiCitationVisibilityCard observations={observations} />
      <LandingCitationCard observations={landingObservations} />
    </div>
  )
}
