import { getListingById } from "@/app/actions/listings"
import { ListingDetailTabs } from "@/components/listing/ListingDetailTabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Share2, MoreVertical } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

interface ListingDetailPageProps {
  params: Promise<{
    listingId: string
  }>
}

export default async function ListingDetailPage({ params }: ListingDetailPageProps) {
  const { listingId } = await params
  
  // Fetch listing data
  const result = await getListingById(listingId)
  
  if (!result.success || !result.listing) {
    notFound()
  }

  const listing = result.listing

  // Mock data for tabs - in production, these would be fetched from the database
  const mockPhotos = [
    { id: "1", url: "/placeholder-property.jpg" },
    { id: "2", url: "/placeholder-property.jpg" },
    { id: "3", url: "/placeholder-property.jpg" },
  ]

  const mockOffers = [
    {
      id: "1",
      buyer_name: "John Smith",
      offer_price: 425000,
      earnest_money: 5000,
      financing_type: "Conventional",
      close_date: "2026-03-15",
      status: "pending",
    },
  ]

  const mockShowings = [
    {
      id: "1",
      buyer_name: "Sarah Johnson",
      date: "2026-02-15",
      time: "2:00 PM",
      duration: 30,
      status: "confirmed",
    },
  ]

  const mockDocuments = [
    {
      id: "1",
      name: "Home Inspection Report.pdf",
      type: "Inspection",
      uploaded_at: "2026-01-20",
    },
    {
      id: "2",
      name: "Appraisal Report.pdf",
      type: "Appraisal",
      uploaded_at: "2026-01-25",
    },
  ]

  const mockAnalytics = {
    daysOnMarket: 12,
    totalViews: 342,
    inquiries: 28,
    interestLevel: "High",
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/agent/inventory">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to Listings
                </Button>
              </Link>
              <div className="h-8 w-px bg-border" />
              <div>
                <h1 className="text-2xl font-bold text-foreground">{listing.address}</h1>
                <p className="text-sm text-muted-foreground">
                  {listing.city}, {listing.state} {listing.zip}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
              <Button variant="ghost" size="sm">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <ListingDetailTabs
          listing={listing}
          offers={mockOffers}
          photos={mockPhotos}
          documents={mockDocuments}
          showings={mockShowings}
          analytics={mockAnalytics}
        />
      </div>
    </div>
  )
}
