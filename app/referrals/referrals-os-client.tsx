"use client"

import { useRouter } from "next/navigation"
import {
  ReferralCommandStrip,
  AdvocacyRadar,
  ReferralPipelinePanel,
  AdvocacyActionStack,
  ReviewRequestPanel,
  GratitudeGiftingPanel,
  ReferralAiDraftingPanel,
  RepeatBusinessPanel,
} from "@/app/dashboard/referrals/components/os"
import { updateReferralStatus, sendReferralThankYou } from "@/app/actions/referral-management"

interface Referral {
  id: string
  referral_name: string
  status: string
  source_contact_id?: string
  source_contact_name?: string
  created_at: string
  value_estimate?: number
}

interface RecentClosing {
  id: string
  contact_id: string
  contactName: string
  address: string
  closeDate: string
  transactionId: string
}

interface ExistingReview {
  id: string
  platform: string
  rating: number
  review_text: string
}

interface Anniversary {
  contactId: string
  contactName: string
  address: string
  yearsCount: number
  closeDate: string
}

interface ReferralsOsClientProps {
  agentId: string
  brokerageId: string
  referralCount: number
  pendingReferrals: number
  roiSummary: {
    totalReferrals: number
    converted: number
    conversionRate: number
    totalValue: number
  }
  referrals: Referral[]
  sphereScore?: any | null
  leaderboardWidget?: any | null
  recentClosings?: RecentClosing[]
  existingReviews?: ExistingReview[]
  upcomingAnniversaries?: Anniversary[]
  selectedContactId?: string | null
}

export function ReferralsOsClient({
  agentId,
  brokerageId,
  referralCount,
  pendingReferrals,
  roiSummary,
  referrals,
  sphereScore,
  leaderboardWidget,
  recentClosings,
  existingReviews,
  upcomingAnniversaries,
  selectedContactId,
}: ReferralsOsClientProps) {
  const router = useRouter()

  const handleCreateReferral = () => {
    router.push("/referrals?action=create")
  }

  const handleUpdateStatus = async (referralId: string, status: string) => {
    await updateReferralStatus(referralId, status)
    router.refresh()
  }

  const handleSendThankYou = async (referralId: string) => {
    await sendReferralThankYou(referralId)
    router.refresh()
  }

  const handleOpenPipeline = () => {
    router.push("/referrals/pipeline")
  }

  // Format sphere score for AdvocacyRadar
  const formattedSphereScore = sphereScore
    ? {
        overall: sphereScore.overall ?? 0,
        engagement: sphereScore.engagement ?? 0,
        loyalty: sphereScore.loyalty ?? 0,
        advocacy: sphereScore.advocacy ?? 0,
      }
    : null

  // Format leaderboard widget
  const formattedLeaderboard = leaderboardWidget
    ? {
        topReferrers: leaderboardWidget.topReferrers?.map((r: any, i: number) => ({
          name: r.name || "Unknown",
          count: r.count || 0,
          rank: i + 1,
        })) || [],
      }
    : null

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <ReferralCommandStrip
        agentId={agentId}
        referralCount={referralCount}
        pendingReferrals={pendingReferrals}
        roiSummary={roiSummary}
        onCreateReferral={handleCreateReferral}
      />

      {/* Advocacy Radar */}
      <AdvocacyRadar
        sphereScore={formattedSphereScore}
        topAdvocates={null}
        leaderboardWidget={formattedLeaderboard}
      />

      {/* Pipeline Panel */}
      <ReferralPipelinePanel
        referrals={referrals}
        onUpdateStatus={handleUpdateStatus}
        onSendThankYou={handleSendThankYou}
        onCreateReferral={handleCreateReferral}
        agentId={agentId}
        brokerageId={brokerageId}
      />

      {/* Action Stack */}
      <AdvocacyActionStack
        agentId={agentId}
        onOpenCreate={handleCreateReferral}
        onOpenPipeline={handleOpenPipeline}
      />

      {/* Review Requests + Reputation */}
      <ReviewRequestPanel
        agentId={agentId}
        recentClosings={recentClosings || []}
        existingReviews={existingReviews || []}
      />

      {/* Appreciation + Gifting */}
      {selectedContactId && (
        <GratitudeGiftingPanel
          agentId={agentId}
          contactId={selectedContactId}
          contactName="Selected Contact"
          occasion="closing"
          onComplete={() => router.refresh()}
        />
      )}

      {/* AI Referral Ask Drafter */}
      <ReferralAiDraftingPanel
        agentId={agentId}
        contactId={selectedContactId || agentId}
        contactName={selectedContactId ? "Selected Contact" : "Select a contact above"}
        onDraftComplete={(draft) => {
          navigator.clipboard.writeText(draft)
        }}
      />

      {/* Repeat Business + Anniversaries */}
      <RepeatBusinessPanel
        agentId={agentId}
        upcomingAnniversaries={upcomingAnniversaries || []}
        sphereSegments={null}
      />
    </div>
  )
}
