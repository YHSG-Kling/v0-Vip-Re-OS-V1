"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { UserRound } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ReferralCommandStrip,
  AdvocacyRadar,
  ReferralPipelinePanel,
  AdvocacyActionStack,
  ReviewRequestPanel,
  ReputationRecoveryPanel,
  ReferralProgramHealthPanel,
  GratitudeGiftingPanel,
  ReferralAiDraftingPanel,
  RepeatBusinessPanel,
} from "@/app/dashboard/referrals/components/os"
import { updateReferralStatus, sendReferralThankYou } from "@/app/actions/referrals/referral-actions"
import type { ReferralStatus } from "@/lib/referrals/referral-status"
import { awardPointsForAction } from "@/app/lib/gamification/award-on-action"

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
  /** Carried through so the panel's Send button has somewhere to send to. */
  contactEmail?: string
}

interface ExistingReview {
  id: string
  platform: string
  rating: number
  review_text: string
  /** From agent_reviews.contact_id — the client the recovery plan is built for. */
  contact_id?: string | null
}

interface Anniversary {
  contactId: string
  contactName: string
  address: string
  yearsCount: number
  closeDate: string
}

interface SphereContact {
  id: string
  name: string
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
  sphereScore?: {
    overall: number
    engagement: number
    loyalty: number
    advocacy: number
  } | null
  topAdvocates?: Array<{
    id: string
    name: string
    score: number
    potential: "high" | "medium" | "low"
  }> | null
  sphereSegments?: {
    champions: number
    engaged: number
    cooling: number
    atRisk: number
  } | null
  leaderboardWidget?: { topReferrers: Array<{ name: string; count: number }> } | null
  recentClosings?: RecentClosing[]
  existingReviews?: ExistingReview[]
  upcomingAnniversaries?: Anniversary[]
  /** The picker's options — past clients, resolved server-side. */
  sphereContacts?: SphereContact[]
  selectedContactId?: string | null
  /** ?action=create arrived on the URL and should open the create dialog. */
  initialAction?: "create" | null
}

export function ReferralsOsClient({
  agentId,
  brokerageId,
  referralCount,
  pendingReferrals,
  roiSummary,
  referrals,
  sphereScore,
  topAdvocates,
  sphereSegments,
  leaderboardWidget,
  recentClosings,
  existingReviews,
  upcomingAnniversaries,
  sphereContacts,
  selectedContactId,
  initialAction,
}: ReferralsOsClientProps) {
  const router = useRouter()

  const contacts = sphereContacts ?? []

  // WHY THERE IS A PICKER AT ALL. Three panels here act on ONE person, and this
  // composition had no way to name that person. It passed
  // `contactId={selectedContactId || agentId}` — an agents.id where a contacts.id
  // was required, two id spaces that must never be substituted — and then labelled
  // the result "Selected Contact", a literal string that rendered to the agent as
  // if it were their client's name ("Why would Selected Contact refer you?").
  // Both are fixed by resolving a real contact instead of faking one.
  const [contactId, setContactId] = useState<string>(selectedContactId ?? "")
  const selectedContact = contacts.find((c) => c.id === contactId) ?? null

  // The create dialog lives inside ReferralPipelinePanel. The other two Create
  // Referral buttons used to `router.push("/referrals?action=create")`, and
  // nothing read `action`, so they were silent. The composition owns the state
  // now and the URL parameter seeds it.
  const [createOpen, setCreateOpen] = useState(initialAction === "create")

  const handleCreateReferral = () => setCreateOpen(true)

  // No `as any` here any more. The cast is what let the board's non-storable
  // "new"/"converted" stages reach a CHECK-constrained column at runtime.
  const handleUpdateStatus = async (referralId: string, status: ReferralStatus) => {
    await updateReferralStatus(referralId, status)
    router.refresh()
  }

  const handleSendThankYou = async (referralId: string) => {
    await sendReferralThankYou(referralId)
    awardPointsForAction(agentId, "referral_received").catch(() => {})
    router.refresh()
  }

  const handleOpenPipeline = () => {
    router.push("/referrals/pipeline")
  }

  const handleRequestReview = () => {
    document.getElementById("review-section")?.scrollIntoView({ behavior: "smooth" })
  }

  // Ranks are positional and belong to the view, not the data.
  const formattedLeaderboard = leaderboardWidget
    ? {
        topReferrers: leaderboardWidget.topReferrers.map((r, i) => ({
          name: r.name,
          count: r.count,
          rank: i + 1,
        })),
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

      {/* Who the one-to-one panels below are about */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <UserRound className="h-5 w-5 text-muted-foreground" />
            Working with
          </CardTitle>
        </CardHeader>
        <CardContent>
          {contacts.length > 0 ? (
            <>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger className="max-w-sm">
                  <SelectValue placeholder="Select a past client" />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                The referral ask, appreciation and gifting tools all act on one person.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No past clients yet — the referral ask and appreciation tools unlock once a
              transaction closes.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Advocacy Radar */}
      <AdvocacyRadar
        sphereScore={sphereScore ?? null}
        topAdvocates={topAdvocates ?? null}
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
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
        onCreated={() => router.refresh()}
      />

      {/* Action Stack */}
      <AdvocacyActionStack
        agentId={agentId}
        defaultContactId={selectedContact?.id ?? ""}
        defaultContactName={selectedContact?.name ?? ""}
        onOpenCreate={handleCreateReferral}
        onOpenPipeline={handleOpenPipeline}
        onOpenReputationFull={() => router.push("/dashboard/reputation")}
        onRequestReview={handleRequestReview}
      />

      {/* Review Requests + Reputation.
          The id is not decoration: AdvocacyActionStack's "Request Review" button
          targeted #review-section and no such element existed anywhere. */}
      <div id="review-section">
        <ReviewRequestPanel
          agentId={agentId}
          recentClosings={recentClosings || []}
          existingReviews={existingReviews || []}
        />
      </div>

      {/* SERVICE RECOVERY. ReviewRequestPanel above answers a bad review with a
          PUBLIC REPLY; aiCreateRecoveryPlan is what to do for the CLIENT, and it
          had no caller anywhere. aiSetupReviewMonitoring sets which reviews
          qualify — it had no caller and no reader either. */}
      <ReputationRecoveryPanel
        agentId={agentId}
        existingReviews={existingReviews || []}
      />

      {/* PROGRAM HEALTH. Every other referral surface is about ONE relationship;
          analyzeReferralProgram is the only read of the book as a program, and it
          reached no screen. */}
      <ReferralProgramHealthPanel />

      {/* Appreciation + Gifting — one contact, so only with one selected. */}
      {selectedContact && (
        <GratitudeGiftingPanel
          agentId={agentId}
          contactId={selectedContact.id}
          contactName={selectedContact.name}
          occasion="closing"
          onComplete={() => router.refresh()}
        />
      )}

      {/* AI Referral Ask Drafter — same rule: a contacts.id or nothing. */}
      {selectedContact ? (
        <ReferralAiDraftingPanel
          agentId={agentId}
          contactId={selectedContact.id}
          contactName={selectedContact.name}
          onDraftComplete={(draft) => {
            navigator.clipboard.writeText(draft)
          }}
        />
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Select a client above to draft a referral ask or send appreciation.
          </CardContent>
        </Card>
      )}

      {/* Repeat Business + Anniversaries */}
      <RepeatBusinessPanel
        agentId={agentId}
        upcomingAnniversaries={upcomingAnniversaries || []}
        sphereSegments={sphereSegments ?? null}
      />
    </div>
  )
}
