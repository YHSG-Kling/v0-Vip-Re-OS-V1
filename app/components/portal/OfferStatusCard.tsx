"use client"

import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { FileText, ArrowRight, PartyPopper, HelpCircle } from "lucide-react"
import { cn } from "@/lib/utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Offer {
  id: string
  listing_id?: string | null
  transaction_id?: string | null
  offer_amount: number | null
  status: string
  created_at: string
  expiration_date?: string | null
  property_address?: string | null
  // Joined data
  listing?: {
    address?: string | null
    property_address?: string | null
  } | null
}

export interface OfferStatusCardProps {
  offers: Offer[]
  contactId: string
  className?: string
}

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "bg-gray-100 text-gray-700" },
  submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  countered: { label: "Countered", color: "bg-purple-100 text-purple-800" },
  accepted: { label: "Accepted", color: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", color: "bg-red-100 text-red-800" },
  expired: { label: "Expired", color: "bg-slate-100 text-slate-600" },
  withdrawn: { label: "Withdrawn", color: "bg-slate-100 text-slate-600" },
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

function getOfferAddress(offer: Offer): string {
  return (
    offer.property_address ||
    offer.listing?.address ||
    offer.listing?.property_address ||
    "Property"
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function OfferStatusCard({ offers, contactId, className }: OfferStatusCardProps) {
  // Check for accepted offer
  const acceptedOffer = offers.find((o) => o.status === "accepted")

  // Get last 3 non-accepted offers for display
  const recentOffers = offers
    .filter((o) => o.status !== "accepted")
    .slice(0, 3)

  // Empty state
  if (offers.length === 0) {
    return (
      <Card className={className}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Your Offers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              No offers yet - your agent will help you prepare when you find the right home
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/portal/${contactId}/help`}>
                <HelpCircle className="h-4 w-4 mr-2" />
                Learn About Offers
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Your Offers
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/portal/${contactId}/offers`}>
              View All
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Accepted Offer Celebration Banner */}
        {acceptedOffer && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <PartyPopper className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium text-green-800">
                  Congratulations! Your offer was accepted!
                </p>
                <p className="text-sm text-green-700">
                  {getOfferAddress(acceptedOffer)} - {formatCurrency(acceptedOffer.offer_amount)}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 border-green-300 text-green-700 hover:bg-green-100"
                  asChild
                >
                  <Link href={`/portal/${contactId}/journey`}>
                    View Your Journey
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Recent Offers List */}
        {recentOffers.length > 0 && (
          <div className="space-y-2">
            {recentOffers.map((offer) => {
              const statusConfig = STATUS_CONFIG[offer.status] || STATUS_CONFIG.draft
              return (
                <div
                  key={offer.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">
                      {getOfferAddress(offer)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(offer.offer_amount)} - {formatDate(offer.created_at)}
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn("shrink-0 ml-2", statusConfig.color)}
                  >
                    {statusConfig.label}
                  </Badge>
                </div>
              )
            })}
          </div>
        )}

        {/* Show message if only accepted offer exists */}
        {acceptedOffer && recentOffers.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-2">
            Your accepted offer is now in progress
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default OfferStatusCard
