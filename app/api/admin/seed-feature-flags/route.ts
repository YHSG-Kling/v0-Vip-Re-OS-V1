import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

const FEATURE_FLAGS = [
  {
    feature_key: "marketing_studio",
    display_name: "Marketing Studio",
    description: "Create and manage marketing campaigns, assets, and content calendar",
    category: "marketing",
  },
  {
    feature_key: "seo_blog_engine",
    display_name: "SEO Blog Engine",
    description: "Generate and publish SEO-optimized blog content to drive organic search traffic",
    category: "marketing",
  },
  {
    feature_key: "email_campaigns",
    display_name: "Email Campaigns",
    description: "Design and send targeted email campaigns to leads, clients, and prospects",
    category: "marketing",
  },
  {
    feature_key: "newsletter_engine",
    display_name: "Newsletter Engine",
    description: "Build and distribute branded newsletters to your contact list on a recurring schedule",
    category: "marketing",
  },
  {
    feature_key: "ad_creator",
    display_name: "Ad Creator",
    description: "Design and export digital ads for social media, display networks, and print",
    category: "marketing",
  },
  {
    feature_key: "ads_audiences",
    display_name: "Ads Audiences",
    description: "Build and manage targeted ad audiences based on CRM data and behavioral signals",
    category: "marketing",
  },
  {
    feature_key: "ads_campaigns",
    display_name: "Ads Campaigns",
    description: "Launch and monitor paid advertising campaigns across multiple channels",
    category: "marketing",
  },
  {
    feature_key: "ai_listing_generation",
    display_name: "AI Listing Generation",
    description: "Automatically generate compelling property listing descriptions using AI",
    category: "listings",
  },
  {
    feature_key: "ai_social_content",
    display_name: "AI Social Content",
    description: "Generate platform-optimized social media posts and captions using AI",
    category: "marketing",
  },
  {
    feature_key: "campaign_roi_dashboard",
    display_name: "Campaign ROI Dashboard",
    description: "Track return on investment across all marketing campaigns with unified attribution",
    category: "analytics",
  },
  {
    feature_key: "competitor_monitor",
    display_name: "Competitor Monitor",
    description: "Monitor competitor listings, pricing, and market activity",
    category: "analytics",
  },
  {
    feature_key: "content_performance_predictor",
    display_name: "Content Performance Predictor",
    description: "Forecast engagement and reach for content before publishing",
    category: "analytics",
  },
  {
    feature_key: "listing_marketing_tiers",
    display_name: "Listing Marketing Tiers",
    description: "Define and apply tiered marketing packages to listings",
    category: "listings",
  },
  {
    feature_key: "omnipresence_repurposer",
    display_name: "Omnipresence Repurposer",
    description: "Repurpose a single piece of content into multiple formats for every channel",
    category: "marketing",
  },
  {
    feature_key: "social_automation",
    display_name: "Social Automation",
    description: "Schedule, publish, and automate social media posting across all platforms",
    category: "marketing",
  },
  {
    feature_key: "training_library",
    display_name: "Training Library",
    description: "Access training videos, courses, and certification resources",
    category: "training",
  },
]

export async function POST() {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!["superadmin", "admin"].includes(ctx.role)) {
      return NextResponse.json({ error: "Forbidden — superadmin/admin only" }, { status: 403 })
    }

    const supabase = await createClient()

    const rows = FEATURE_FLAGS.map((f) => ({
      ...f,
      enabled: true,
      solo_agent_access: true,
      team_access: true,
      brokerage_access: true,
      multi_location_access: true,
      solo_agent_limit: null,
      team_limit: null,
      brokerage_limit: null,
      multi_location_limit: null,
      superadmin_only: false,
      beta: false,
      deprecated: false,
    }))

    const { error } = await supabase
      .from("feature_flags")
      .upsert(rows, { onConflict: "feature_key", ignoreDuplicates: true })

    if (error) {
      return NextResponse.json({ error: "Seed operation failed" }, { status: 500 })
    }

    const { data: seeded, error: selectError } = await supabase
      .from("feature_flags")
      .select("feature_key, enabled")
      .in("feature_key", FEATURE_FLAGS.map((f) => f.feature_key))
      .order("feature_key")

    if (selectError) {
      return NextResponse.json({ success: true, seeded: FEATURE_FLAGS.length, features: [] })
    }

    return NextResponse.json({
      success: true,
      seeded: seeded?.length ?? 0,
      features: seeded?.map((r: { feature_key: string }) => r.feature_key) ?? [],
    })
  } catch {
    return NextResponse.json({ error: "Seed operation failed" }, { status: 500 })
  }
}
