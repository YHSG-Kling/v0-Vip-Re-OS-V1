"use client"

import { ReputationPanel } from "@/app/components/reputation/ReputationPanel"

interface ReputationClientProps {
  agentId: string
  brokerageId?: string
  userId: string
  reviews: any[]
  recentClosings: any[]
}

export function ReputationClient({
  agentId,
  brokerageId,
  userId,
  reviews,
  recentClosings,
}: ReputationClientProps) {
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reputation & Advocacy</h1>
        <p className="text-muted-foreground">
          Turn trust into reviews, referrals, and lasting goodwill
        </p>
      </div>

      {/* Shared Reputation Panel */}
      <ReputationPanel
        agentId={agentId}
        brokerageId={brokerageId}
        userId={userId}
        reviews={reviews}
        recentClosings={recentClosings}
      />
    </div>
  )
}
