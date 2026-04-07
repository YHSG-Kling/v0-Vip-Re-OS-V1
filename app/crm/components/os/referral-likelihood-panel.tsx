"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Heart, Star, Loader2, ArrowRight } from "lucide-react"
import Link from "next/link"

interface ReferralLikelihoodPanelProps {
  contactId: string
  agentId: string
  referralPotential?: "high" | "medium" | "low" | null
  onGenerateAsk: () => Promise<void>
  generating: boolean
}

export function ReferralLikelihoodPanel({
  contactId,
  agentId,
  referralPotential,
  onGenerateAsk,
  generating,
}: ReferralLikelihoodPanelProps) {
  const getPotentialBadge = () => {
    switch (referralPotential) {
      case "high":
        return {
          text: "High Referral Potential",
          className: "bg-amber-100 text-amber-700 border-amber-300",
          icon: <Star className="h-4 w-4 text-amber-500 fill-amber-500" />,
        }
      case "medium":
        return {
          text: "Moderate Potential",
          className: "bg-gray-200 text-gray-700 border-gray-300",
          icon: <Star className="h-4 w-4 text-gray-400" />,
        }
      case "low":
        return {
          text: "Building Relationship",
          className: "bg-gray-100 text-gray-500 border-gray-200",
          icon: <Heart className="h-4 w-4 text-gray-400" />,
        }
      default:
        return {
          text: "Not Yet Assessed",
          className: "bg-gray-100 text-gray-400 border-gray-200",
          icon: null,
        }
    }
  }

  const badge = getPotentialBadge()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-500" />
          Referral & Advocacy
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Potential badge */}
        <div className="flex items-center gap-2 mb-4">
          {badge.icon}
          <Badge className={badge.className}>{badge.text}</Badge>
        </div>

        {/* Generate referral ask button */}
        {(referralPotential === "high" || referralPotential === "medium") && (
          <Button
            onClick={onGenerateAsk}
            disabled={generating}
            className="w-full mb-4"
            variant="outline"
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Star className="h-4 w-4 mr-2" />
                Generate AI Referral Ask
              </>
            )}
          </Button>
        )}

        {/* Footer link */}
        <Link
          href="/referrals"
          className="flex items-center justify-center gap-1 text-sm text-primary hover:underline"
        >
          Open Referrals
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  )
}
