import { redirect } from "next/navigation"
import { getListingMedia, getSocialPosts, getVideoProjects, getVideoTemplates, getSocialAccounts } from "@/app/actions/listing-media"
import { MediaManagerClient } from "./media-manager-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { toCanonicalRoleOrDefault } from "@/lib/security"
import { createClient } from "@/lib/supabase/server"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingMediaPage({ params }: PageProps) {
  const { id: listingId } = await params

  // Kernel OS: getAgentContext — canonical identity resolution
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard")
  // Agents must have an agentId; brokers/admins can access without one
  if (!ctx.agentId && ctx.userType === "agent") redirect("/dashboard/onboarding")

  // toCanonicalRoleOrDefault handles legacy DB values (TC → tc etc.)
  const userRole = toCanonicalRoleOrDefault(ctx.userType, "agent")

  const supabase = await createClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, lifecycle_stage, status, seller_contact_id")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .single()
  if (!listing) redirect("/dashboard/listings")

  const [mediaResult, videosResult, socialResult, templatesResult, accountsResult] =
    await Promise.all([
      getListingMedia(listingId),
      getVideoProjects(listingId),
      getSocialPosts(listingId),
      getVideoTemplates(),
      getSocialAccounts(ctx.brokerageId),
    ])

  return (
    <MediaManagerClient
      listingId={listingId}
      listing={listing}
      brokerageId={ctx.brokerageId}
      agentId={ctx.agentId ?? ""}
      userRole={userRole}
      sellerContactId={(listing as any).seller_contact_id ?? null}
      initialMedia={mediaResult.data ?? []}
      initialVideos={videosResult.data ?? []}
      initialPosts={socialResult.data ?? []}
      videoTemplates={templatesResult.data ?? []}
      socialAccounts={accountsResult.data ?? []}
    />
  )
}
