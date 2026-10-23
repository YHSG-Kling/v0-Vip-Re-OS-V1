import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { RecruitingLandingClient } from "./recruiting-client"

interface PageProps {
  params:       Promise<{ brokerageSlug: string }>
  searchParams: Promise<{ ref?: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { brokerageSlug } = await params
  const svc = createServiceClient()
  const { data: brokerage } = await svc
    .from("brokerages")
    .select("name, recruiting_pitch")
    .eq("slug", brokerageSlug)
    .maybeSingle()
  if (!brokerage) return { title: "Real Estate Careers" }
  return {
    title:       `Join ${brokerage.name} · Careers`,
    description: brokerage.recruiting_pitch ?? `See why agents are switching to ${brokerage.name}.`,
  }
}

/**
 * /recruiting/[brokerageSlug] — public, unauthenticated recruiting landing.
 *
 * Every QR code or share-link a broker hands to a prospective agent points
 * here. The page is rendered server-side so SEO + OpenGraph land properly.
 * Lead capture, ROI math, and "your AI saved $X" estimates run client-side
 * for instant interactivity.
 *
 * Referral attribution: an agent who shares /recruiting/[slug]?ref=<agentId>
 * gets stamped on every recruit who follows their link. When that recruit
 * later joins, the broker can see exactly which agent generated the new
 * hire — the foundation for referral bonuses.
 */
export default async function RecruitingLandingPage({ params, searchParams }: PageProps) {
  const { brokerageSlug } = await params
  const sp = await searchParams

  const svc = createServiceClient()
  const { data: brokerage } = await svc
    .from("brokerages")
    .select("id, name, slug, logo_url, primary_color, license_number, license_state, website, about_text, recruiting_pitch, recruiting_split_to_agent, recruiting_monthly_fee, recruiting_value_props, revenue_share_enabled, offers_medical_benefits, offers_retirement_benefits")
    .eq("slug", brokerageSlug)
    .maybeSingle()
  if (!brokerage) notFound()

  // Resolve the referring agent (optional). When ?ref=<agentId> is set,
  // look up their name so we can display "Referred by Jane Smith" on the
  // page — increases trust + makes the referral visible to the recruit.
  let referringAgent: { id: string; name: string | null } | null = null
  if (sp.ref) {
    const { data: agentRow } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id, users:user_id(first_name, last_name)")
      .eq("id", sp.ref)
      .maybeSingle()
    if (agentRow && agentRow.brokerage_id === brokerage.id) {
      const u = (agentRow as any).users
      const name = u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() : null
      referringAgent = { id: agentRow.id, name }
    }
  }

  return (
    <RecruitingLandingClient
      brokerage={{
        id:                      brokerage.id,
        name:                    brokerage.name,
        slug:                    brokerage.slug,
        logoUrl:                 brokerage.logo_url ?? null,
        primaryColor:            brokerage.primary_color ?? null,
        licenseNumber:           brokerage.license_number ?? null,
        licenseState:            brokerage.license_state ?? null,
        website:                 brokerage.website ?? null,
        aboutText:               brokerage.about_text ?? null,
        pitch:                   brokerage.recruiting_pitch ?? null,
        splitToAgent:            brokerage.recruiting_split_to_agent ?? null,
        monthlyFee:              brokerage.recruiting_monthly_fee ?? null,
        valueProps:              (brokerage.recruiting_value_props ?? []) as string[],
        // Benefit offerings (m574 + m264): FAIL-CLOSED `=== true` — an unset or
        // missing mark renders as not offered, and no benefits section appears.
        offersRevenueShare:      brokerage.revenue_share_enabled === true,
        offersMedical:           brokerage.offers_medical_benefits === true,
        offersRetirement:        brokerage.offers_retirement_benefits === true,
      }}
      referringAgent={referringAgent}
    />
  )
}
