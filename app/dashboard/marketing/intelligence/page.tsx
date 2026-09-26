import { redirect } from "next/navigation"

// Market Intelligence (trending keywords + competitor high-performers) merged
// into the SEO / GEO section (Market Trends tab) — it's the "popular keyword +
// competitor signal" raw material for content that ranks higher.
export default function MarketIntelligencePage() {
  redirect("/dashboard/marketing/seo?tab=trends")
}
