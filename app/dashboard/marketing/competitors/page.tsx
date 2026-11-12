import { redirect } from "next/navigation"

// Competitors merged into the SEO / GEO section (Competitors tab). Storing and
// analyzing competitors lives alongside keywords and GEO visibility so the same
// signal feeds content that ranks higher and wins organic + AI-search traffic.
export default function CompetitorsPage() {
  redirect("/dashboard/marketing/seo?tab=competitors")
}
