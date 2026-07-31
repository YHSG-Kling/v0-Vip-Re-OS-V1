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
import type { ShareObservationRow } from "@/lib/geo/citation-share"

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
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab } = await searchParams
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
      {activeTab === "geo" && <GeoTab brokerageId={brokerageId} />}
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
async function GeoTab({ brokerageId }: { brokerageId: string }) {
  const supabase = await createClient()
  const citationSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: citationRows, error } = await supabase
    .from("ai_search_citation_observations")
    .select("id, platform, outcome, cited_url, provider, public_slug, observed_at, project_id, observed_on, competitors_cited")
    .eq("brokerage_id", brokerageId)
    .gte("observed_at", citationSince)
    .order("observed_at", { ascending: false })
    .limit(60)
  const observations: CitationObservationRow[] = error
    ? []
    : ((citationRows ?? []) as CitationObservationRow[])

  if (observations.length === 0) {
    return (
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
          <p className="text-sm text-muted-foreground py-6 text-center">
            No AI-search citation data yet. Once you publish reel pages and the citation monitor runs,
            you'll see which platforms are citing your content here.
          </p>
        </CardContent>
      </Card>
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
      <CitationShareCard rows={shareRows} />
      <AiCitationVisibilityCard observations={observations} />
    </div>
  )
}
