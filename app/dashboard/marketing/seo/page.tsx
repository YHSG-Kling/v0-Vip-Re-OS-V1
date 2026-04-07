import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { SeoKeywordsDashboardClient } from "./seo-keywords-client"

export const metadata = {
  title: "SEO Keywords | Marketing",
  description: "Manage your SEO keyword library",
}

export default async function SeoKeywordsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }

  // Get user's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch SEO keywords
  const { data: keywords } = await supabase
    .from("seo_keywords")
    .select(
      "id, keyword, keyword_type, search_intent, target_location, search_volume, competition, difficulty_score, priority_score, is_active, created_at"
    )
    .eq("brokerage_id", userData.brokerage_id)
    .order("priority_score", { ascending: false, nullsFirst: false })

  return (
    <SeoKeywordsDashboardClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      initialKeywords={keywords || []}
    />
  )
}
