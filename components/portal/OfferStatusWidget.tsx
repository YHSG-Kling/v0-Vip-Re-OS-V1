"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Clock, TrendingUp, AlertTriangle, CheckCircle2, DollarSign, Loader2 } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

interface OfferStatusWidgetProps {
  contactId: string
  isBuyer: boolean
}

export function OfferStatusWidget({ contactId, isBuyer }: OfferStatusWidgetProps) {
  const [offers, setOffers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()

    async function loadOffers() {
      try {
        if (isBuyer) {
          const { data, error } = await supabase
            .from("offers")
            .select("*")
            .eq("contact_id", contactId)
            .order("created_at", { ascending: false })
            .limit(3)

          if (error) {
            // Table may not exist or column mismatch - show empty state
            console.log("[v0] Offers query error:", error.message)
            setOffers([])
          } else {
            setOffers(data || [])
          }
        } else {
          // For sellers, get offers on their listings
          const { data: contactData } = await supabase
            .from("contacts")
            .select("listings(id)")
            .eq("id", contactId)
            .single()

          if (contactData?.listings && Array.isArray(contactData.listings) && contactData.listings.length > 0) {
            const listingIds = contactData.listings.map((l: any) => l.id)
            const { data, error } = await supabase
              .from("offers")
              .select("*")
              .in("listing_id", listingIds)
              .eq("status", "pending")
              .order("created_at", { ascending: false })
              .limit(5)

            if (error) {
              console.log("[v0] Seller offers query error:", error.message)
              setOffers([])
            } else {
              setOffers(data || [])
            }
          } else {
            setOffers([])
          }
        }
      } catch (err) {
        console.log("[v0] Offers load error:", err)
        setOffers([])
      }
      setLoading(false)
    }

    loadOffers()
  }, [contactId, isBuyer])

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  // Don't show widget if no offers
  if (offers.length === 0) {
    return null
  }

  const urgentOffers = offers.filter((o) => {
    if (!o.expires_at) return false
    const expiresAt = new Date(o.expires_at)
    const hoursUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)
    return hoursUntilExpiry < 24 && o.status === "pending"
  })

  return (
    <Card className="border-2">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              {isBuyer ? "Your Offer Status" : "Active Offers"}
              {urgentOffers.length > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {urgentOffers.length} Urgent
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {isBuyer
                ? "Track your submitted offers"
                : `${offers.length} offer${offers.length !== 1 ? "s" : ""} awaiting response`}
            </CardDescription>
          </div>
          <Link href={`/portal/${contactId}/${isBuyer ? "my-offer" : "offers"}`}>
            <Button variant="outline" size="sm">
              View All
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {offers.map((offer) => (
            <OfferCard key={offer.id} offer={offer} isBuyer={isBuyer} contactId={contactId} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function OfferCard({ offer, isBuyer, contactId }: { offer: any; isBuyer: boolean; contactId: string }) {
  const expiresAt = offer.expires_at ? new Date(offer.expires_at) : null
  const hoursUntilExpiry = expiresAt ? (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60) : 999
  const isUrgent = hoursUntilExpiry < 24 && offer.status === "pending"

  const statusConfig: Record<
    string,
    { variant: "secondary" | "default" | "destructive" | "outline"; label: string; icon: any }
  > = {
    pending: { variant: "secondary", label: "Pending Review", icon: Clock },
    countered: { variant: "default", label: "Counter Received", icon: TrendingUp },
    accepted: { variant: "default", label: "Accepted", icon: CheckCircle2 },
    rejected: { variant: "destructive", label: "Declined", icon: AlertTriangle },
    expired: { variant: "outline", label: "Expired", icon: Clock },
  }

  const config = statusConfig[offer.status] || statusConfig.pending
  const StatusIcon = config.icon

  return (
    <div
      className={`p-4 rounded-lg border ${isUrgent ? "border-orange-500 bg-orange-50 dark:bg-orange-950/20" : "bg-muted/30"}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-semibold text-sm">{offer.property_address || "Property"}</h4>
            <Badge variant={config.variant} className="text-xs">
              <StatusIcon className="h-3 w-3 mr-1" />
              {config.label}
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
        <div>
          <span className="text-muted-foreground">Offer Amount:</span>
          <p className="font-semibold">${(offer.offer_amount || 0).toLocaleString()}</p>
        </div>
        {offer.counter_amount && (
          <div>
            <span className="text-muted-foreground">Counter Amount:</span>
            <p className="font-semibold text-blue-600">${offer.counter_amount.toLocaleString()}</p>
          </div>
        )}
        {offer.financing_type && (
          <div>
            <span className="text-muted-foreground">Financing:</span>
            <p className="font-semibold capitalize">{offer.financing_type}</p>
          </div>
        )}
        {offer.close_date && (
          <div>
            <span className="text-muted-foreground">Close Date:</span>
            <p className="font-semibold">{new Date(offer.close_date).toLocaleDateString()}</p>
          </div>
        )}
      </div>

      {isUrgent && expiresAt && (
        <div className="mt-3 flex items-center gap-2 text-xs text-orange-700 dark:text-orange-400">
          <AlertTriangle className="h-4 w-4" />
          <span className="font-medium">Expires in {Math.round(hoursUntilExpiry)} hours</span>
        </div>
      )}

      <div className="mt-3">
        <Link href={`/portal/${contactId}/${isBuyer ? "my-offer" : "offers"}`}>
          <Button size="sm" className="w-full">
            View Details
          </Button>
        </Link>
      </div>
    </div>
  )
}
