"use client"

import { useState, useTransition } from "react"
import { Star, MessageCircle, Share2, RefreshCw, Settings, Send, CheckCircle2, AlertCircle, TrendingUp } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ReputationPanel } from "@/app/components/reputation/ReputationPanel"
import { aiGenerateReviewRequest } from "@/app/actions/ai-review-automation"

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
  const [isPending, startTransition] = useTransition()
  const [selectedClosings, setSelectedClosings] = useState<Set<string>>(new Set())

  // Calculate reputation metrics
  const totalReviews = reviews?.length || 0
  const avgRating = reviews && reviews.length > 0
    ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1)
    : "0"
  const totalClosings = recentClosings?.length || 0

  const handleBatchRequestReviews = async () => {
    if (selectedClosings.size === 0) return
    startTransition(async () => {
      for (const closingId of selectedClosings) {
        await aiGenerateReviewRequest({
          transactionId: closingId,
          agentId,
          platform: "google",
          channel: "email",
        })
      }
      setSelectedClosings(new Set())
    })
  }

  const toggleClosingSelection = (id: string) => {
    setSelectedClosings((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  return (
    <div className="space-y-6">
      {/* OS Command Strip Header */}
      <div className="border-b bg-card">
        <div className="px-4 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                <Star className="h-5 w-5 text-amber-700" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Reputation & Advocacy</h1>
                <p className="text-sm text-muted-foreground">
                  Avg Rating: <span className="font-semibold">{avgRating} ⭐</span> from {totalReviews} reviews
                </p>
              </div>
            </div>
            {/* Command Strip Actions */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              {selectedClosings.size > 0 && (
                <>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleBatchRequestReviews}
                    disabled={isPending}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Request Reviews ({selectedClosings.size})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedClosings(new Set())}
                  >
                    Clear
                  </Button>
                </>
              )}
              <Link href="/dashboard/settings">
                <Button variant="ghost" size="sm">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Star className="h-4 w-4" />
              Average Rating
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgRating}</div>
            <p className="text-xs text-muted-foreground">{totalReviews} total reviews</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Recent Closings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalClosings}</div>
            <p className="text-xs text-muted-foreground">Last 90 days</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <MessageCircle className="h-4 w-4" />
              Review Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totalReviews > 0 && totalClosings > 0
                ? Math.round((totalReviews / totalClosings) * 100)
                : 0}%
            </div>
            <p className="text-xs text-muted-foreground">Reviews per closing</p>
          </CardContent>
        </Card>
      </div>

      {/* Batch Review Request Panel */}
      {recentClosings && recentClosings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Request Reviews from Recent Closings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-48 overflow-y-auto">
              {recentClosings.map((closing: any) => (
                <div
                  key={closing.id}
                  className="flex items-center gap-3 p-2 border rounded-lg hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedClosings.has(closing.id)}
                    onChange={() => toggleClosingSelection(closing.id)}
                    className="h-4 w-4 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{closing.property_address}</p>
                    <p className="text-xs text-muted-foreground">
                      {closing.contacts?.first_name} {closing.contacts?.last_name}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {new Date(closing.close_date).toLocaleDateString()}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Reputation Panel */}
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
