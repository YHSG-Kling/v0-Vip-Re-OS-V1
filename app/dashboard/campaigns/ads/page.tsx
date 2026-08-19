// app/dashboard/campaigns/ads/page.tsx
// Layer 9.5 — Ads Management Page with Campaigns, Audiences, and Performance Tabs
//
// Campaigns, audiences and performance are read through the kernel command
// loadAdsWorkspace (lib/kernel/ads.ts) — one entitlement-gated, error-checked,
// brokerage-scoped read — instead of three inline queries. Everything this page
// still queries itself is SURFACE-ONLY state the kernel does not own: the
// agent's display name, the ad-account connect card, the audience-template
// catalog, and the streaming-TV lane.

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AdsDashboardClient } from "./ads-dashboard-client"
import { getAdConnections } from "@/lib/ads/connection-status"
import { listAudienceTemplates } from "@/app/actions/fb-audience-templates"
import { isVibeConfigured } from "@/lib/providers/vibe"
import type { CtvEligibleVideo } from "./ctv-lane"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-pipeline-reaper-policy"
import { loadAdsWorkspace } from "@/lib/kernel/ads"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Ad Campaigns | Dashboard",
  description: "Manage your ad campaigns, audiences, and creative variations",
}

/**
 * The workspace could not be read. There are exactly two reasons for that and
 * they are NOT the same claim, so they do not render the same:
 *
 *   entitlement — access was DECLINED (plan, rollout cohort, explicit disable,
 *                 platform pause). Nothing is broken and nothing is missing;
 *                 this account may not read the workspace. The exact reason
 *                 from the entitlement resolver is shown verbatim rather than
 *                 guessed at, because "your plan" is only one of the causes.
 *   read        — we TRIED and failed (workspace query, or the access check
 *                 itself erroring). Something IS broken. Say so, show the
 *                 reason, offer a retry.
 *
 * Neither is "you have no campaigns" — that is a SUCCESSFUL read of an empty
 * workspace and is rendered by the dashboard's own empty state. Showing an
 * empty dashboard for a refusal or a failure is the defect this page exists to
 * avoid: it tells the agent their campaigns are gone.
 */
function AdsWorkspaceUnavailable({
  kind,
  reason,
}: {
  kind: "input" | "entitlement" | "read" | undefined
  reason: string | undefined
}) {
  const isEntitlement = kind === "entitlement"

  return (
    <div className="container mx-auto max-w-3xl px-4 py-16">
      <div className="rounded-lg border bg-card p-8 text-card-foreground">
        <h1 className="text-2xl font-bold">
          {isEntitlement
            ? "Ad Campaigns isn't enabled for your account"
            : "We couldn't load your ad campaigns"}
        </h1>

        <p className="mt-3 text-muted-foreground">
          {isEntitlement
            ? "Access to the Ads workspace was declined for this account, so there's nothing to show here. Nothing has been deleted: your campaigns, audiences and spend history are intact and will appear as soon as access is granted."
            : "Something went wrong reading your campaigns, audiences or performance data. This is a problem on our side, not an empty account — this screen does not mean you have no campaigns."}
        </p>

        {reason && (
          <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {isEntitlement ? "Reason: " : "Error: "}
            </span>
            {reason}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {isEntitlement ? (
            <>
              <a
                href="/pricing"
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                See plans
              </a>
              <span className="text-sm text-muted-foreground">
                If you&apos;re on a brokerage plan, your broker can enable this for your seat.
              </span>
            </>
          ) : (
            <>
              <a
                href="/dashboard/campaigns/ads"
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Try again
              </a>
              <span className="text-sm text-muted-foreground">
                If this keeps happening, contact support with the error above.
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default async function AdsCampaignsPage() {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // ── Canonical workspace read (kernel) ────────────────────────────────────
  // Entitlement-gated, error-checked, brokerage-scoped. Returns campaigns (with
  // their marketing campaign + creative variations), audiences (with sync runs),
  // the ad_performance rows newest-first, and a spend/CTR/CPL summary.
  const workspaceResult = await loadAdsWorkspace({
    ctx: {
      brokerageId: profile.brokerage_id,
      agentId: user.id,
      userId: user.id,
    },
  })

  // A refusal is rendered as a refusal. It is not flattened into an empty
  // dashboard, and the two refusal kinds do not share a message.
  if (!workspaceResult.success || !workspaceResult.workspace) {
    return (
      <AdsWorkspaceUnavailable kind={workspaceResult.errorKind} reason={workspaceResult.error} />
    )
  }

  const workspace = workspaceResult.workspace

  // Get agent name for creative generation context
  const agentName = `${profile.first_name || ""} ${profile.last_name || ""}`.trim()

  // Ad-account connection status (drives the Connect card + the launch gate).
  // NOT the kernel's accountConnections: this is the {platform, connected,
  // accountId} shape over facebook+google that the Connect card and the launch
  // precheck both read, while the kernel reports {platform, is_active,
  // account_name} over the connectable-platform vocabulary. Two consumers, two
  // shapes — deliberately not collapsed.
  const adConnections = await getAdConnections(profile.brokerage_id)

  // Prebuilt one-click audience templates (static catalog) surfaced as a
  // gallery in the Audiences tab — agents pick a template to pre-fill the
  // Create Audience dialog.
  const audienceTemplates = await listAudienceTemplates()

  // ── Streaming-TV lane (Vibe.co) ──────────────────────────────────────────
  // TV-eligible creative: completed videos, 15-35s, with a rendered URL. The
  // stage action re-validates (incl. 16:9) — this is the picker's shortlist.
  const { data: ctvVideos } = await supabase
    .from("ai_video_projects")
    .select("id, title, video_url, duration_seconds, format, thumbnail_url, listing_id, created_at")
    .eq("brokerage_id", profile.brokerage_id)
    // Any finished asset can back a TV/streaming creative, not only `completed`.
    .in("status", VIDEO_FINISHED_STATUSES as unknown as string[])
    .not("video_url", "is", null)
    .gte("duration_seconds", 15)
    .lte("duration_seconds", 35)
    .order("created_at", { ascending: false })
    .limit(24)

  // Honest connection posture for the Vibe connector slot (never throws).
  const vibeConnected = await isVibeConfigured(profile.brokerage_id)

  return (
    <AdsDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      agentName={agentName}
      campaigns={workspace.campaigns}
      performanceData={workspace.performance}
      audiences={workspace.audiences}
      adConnections={adConnections}
      audienceTemplates={audienceTemplates}
      vibeConnected={vibeConnected}
      ctvEligibleVideos={(ctvVideos || []) as CtvEligibleVideo[]}
      organicLift={workspace.organicLift}
    />
  )
}
