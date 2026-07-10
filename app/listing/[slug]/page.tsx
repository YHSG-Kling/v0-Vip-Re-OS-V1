import { notFound } from "next/navigation"
import { Suspense } from "react"
import {
  getListingBySlug,
  getNeighborhoodData,
  getSimilarListings,
  logLandingSession,
} from "@/app/actions/listing-landing"
import { calculateDaysOnMarket, formatPrice } from "@/app/lib/listing-utils"
import { buildRealEstateListingJsonLd, buildBreadcrumbJsonLd, serializeJsonLd } from "@/lib/geo/video-landing"
import { ListingHero } from "@/app/components/listing-landing/ListingHero"
import { NeighborhoodWidget } from "@/app/components/listing-landing/NeighborhoodWidget"
import { ShowingRequestForm } from "@/app/components/listing-landing/ShowingRequestForm"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Phone, Mail, MapPin, Bed, Bath, Ruler, Calendar, Home } from "lucide-react"
import Link from "next/link"
import Image from "next/image"

// No auth required - public page
export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    qr_source?: string
  }>
}

/**
 * Social meta for rich previews when sellers share their listing on
 * Facebook, LinkedIn, Twitter, iMessage, etc. OpenGraph + Twitter Card +
 * canonical URL. Falls back gracefully when the listing isn't found.
 */
export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const listing = await getListingBySlug(slug)
  if (!listing) {
    return { title: "Listing", description: "Real estate listing" }
  }
  const l = listing as unknown as {
    address?: string
    city?: string
    state?: string
    zip?: string
    list_price?: number
    bedrooms?: number
    bathrooms?: number
    square_feet?: number
    photos?: Array<{ url?: string }>
    description?: string
    slug: string
  }
  const title = `${l.address ?? "Property"} — ${[l.city, l.state].filter(Boolean).join(", ")}`
  const priceLabel = l.list_price ? `$${l.list_price.toLocaleString()}` : null
  const features = [
    l.bedrooms ? `${l.bedrooms} bed` : null,
    l.bathrooms ? `${l.bathrooms} bath` : null,
    l.square_feet ? `${l.square_feet.toLocaleString()} sqft` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const description = [priceLabel, features, l.description?.slice(0, 140)]
    .filter(Boolean)
    .join(" · ")
  const heroImage = l.photos?.[0]?.url ?? null

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: heroImage ? [{ url: heroImage, width: 1200, height: 630, alt: title }] : [],
      siteName: "Listing",
    },
    twitter: {
      card: heroImage ? "summary_large_image" : "summary",
      title,
      description,
      images: heroImage ? [heroImage] : [],
    },
  }
}

export default async function ListingLandingPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const search = await searchParams

  const listing = await getListingBySlug(slug)

  if (!listing) {
    notFound()
  }

  // Generate session token for analytics
  const sessionToken = crypto.randomUUID()

  // Fire-and-forget analytics
  logLandingSession({
    listingId: listing.id,
    utmSource: search.utm_source,
    utmMedium: search.utm_medium,
    utmCampaign: search.utm_campaign,
    qrSource: search.qr_source,
    sessionToken,
  })

  const [neighborhoodData, similarListings] = await Promise.all([
    getNeighborhoodData(listing.id),
    getSimilarListings(listing.id, listing.zip),
  ])

  const daysOnMarket = calculateDaysOnMarket(listing.go_live_date ?? null)

  // AI Greeting based on source
  let aiGreeting: string | null = null
  if (search.qr_source) {
    aiGreeting = `Welcome! You're viewing ${listing.address} from ${search.qr_source}.`
  } else if (search.utm_source === "email") {
    aiGreeting = `Welcome back! You're viewing ${listing.address}.`
  }

  // GEO — schema.org RealEstateListing + BreadcrumbList so AI search engines
  // (ChatGPT browse, Perplexity, AI Overviews, Claude) can read and CITE the
  // page every QR and campaign points at. Same pure builders as /v/[slug].
  const siteBase = (process.env.NEXT_PUBLIC_APP_URL || "https://app.viprealestateos.com").replace(/\/$/, "")
  const pageUrl = `${siteBase}/listing/${slug}`
  const lAny = listing as unknown as {
    address?: string; city?: string; state?: string; list_price?: number
    bedrooms?: number; bathrooms?: number; public_remarks?: string
    photos?: Array<{ url?: string }>
    agent?: { first_name?: string; last_name?: string } | null
  }
  const listingJsonLd = buildRealEstateListingJsonLd({
    name: lAny.address ?? "Listing",
    description: (lAny.public_remarks ?? "").slice(0, 300) || `${lAny.address ?? "Home"} for sale`,
    url: pageUrl,
    imageUrl: lAny.photos?.[0]?.url ?? null,
    streetAddress: lAny.address ?? null,
    city: lAny.city ?? null,
    state: lAny.state ?? null,
    price: lAny.list_price ?? null,
    bedrooms: lAny.bedrooms ?? null,
    bathrooms: lAny.bathrooms ?? null,
  })
  const breadcrumbJsonLd = buildBreadcrumbJsonLd({
    siteName: "VIP Real Estate OS", siteUrl: siteBase,
    agentName: [lAny.agent?.first_name, lAny.agent?.last_name].filter(Boolean).join(" ") || null,
    pageName: lAny.address ?? "Listing", pageUrl,
  })

  return (
    <div className="min-h-screen bg-background">
      {listingJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(listingJsonLd) }} />
      )}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbJsonLd) }} />
      {/* AI Greeting Banner */}
      {aiGreeting && (
        <div className="bg-primary/10 border-b border-primary/20 px-4 py-3 text-center">
          <p className="text-sm text-primary font-medium">{aiGreeting}</p>
          <Badge variant="outline" className="ml-2 text-xs">
            AI Draft
          </Badge>
        </div>
      )}

      {/* Section 1: Hero */}
      <ListingHero
        photos={listing.photos}
        media={listing.media}
        address={listing.address}
        sessionToken={sessionToken}
        listingId={listing.id}
      />

      {/* Section 2: Key Details Bar */}
      <section className="sticky top-0 z-40 bg-background border-b shadow-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-6">
              <span className="text-2xl font-bold text-foreground">
                {formatPrice(listing.list_price)}
              </span>
              <div className="flex items-center gap-4 text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Bed className="h-4 w-4" />
                  {listing.beds} beds
                </span>
                <span className="flex items-center gap-1">
                  <Bath className="h-4 w-4" />
                  {listing.baths} baths
                </span>
                <span className="flex items-center gap-1">
                  <Ruler className="h-4 w-4" />
                  {listing.sqft?.toLocaleString()} sqft
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge
                variant={
                  listing.status === "active"
                    ? "default"
                    : listing.status === "pending"
                      ? "secondary"
                      : "outline"
                }
                className="capitalize"
              >
                {listing.status}
              </Badge>
              {listing.status === "active" && daysOnMarket !== null && (
                <span className="text-sm text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {daysOnMarket} days on market
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-8">
            {/* Address */}
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">{listing.address}</h1>
              <p className="text-lg text-muted-foreground flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                {listing.city}, {listing.state} {listing.zip}
              </p>
              {listing.mls_number && (
                <p className="text-sm text-muted-foreground mt-1">MLS# {listing.mls_number}</p>
              )}
            </div>

            {/* Section 3: Description */}
            <Card>
              <CardHeader>
                <CardTitle>About This Property</CardTitle>
              </CardHeader>
              <CardContent>
                {listing.description ? (
                  <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
                    {listing.description}
                  </p>
                ) : (
                  <p className="text-muted-foreground italic">
                    No description available for this listing.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Section 4: Neighborhood Widget */}
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <NeighborhoodWidget data={neighborhoodData} />
            </Suspense>

            {/* Section 5: Similar Listings */}
            {similarListings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Similar Listings Nearby</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {similarListings.map((similar) => (
                      <Link
                        key={similar.id}
                        href={`/listing/${similar.slug}`}
                        className="group block"
                      >
                        <div className="rounded-lg border overflow-hidden transition-shadow hover:shadow-md">
                          <div className="relative aspect-[4/3] bg-muted">
                            {similar.photo_url ? (
                              <Image
                                src={similar.photo_url}
                                alt={similar.address}
                                fill
                                className="object-cover group-hover:scale-105 transition-transform"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <Home className="h-12 w-12 text-muted-foreground/50" />
                              </div>
                            )}
                          </div>
                          <div className="p-3">
                            <p className="font-semibold text-foreground">
                              {formatPrice(similar.list_price)}
                            </p>
                            <p className="text-sm text-muted-foreground truncate">
                              {similar.address}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {similar.bedrooms} bed | {similar.bathrooms} bath
                            </p>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Section 6: Agent Contact Card */}
            {listing.agent && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Listing Agent</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-4">
                    {listing.agent.profile_photo_url ? (
                      <Image
                        src={listing.agent.profile_photo_url}
                        alt={`${listing.agent.first_name} ${listing.agent.last_name}`}
                        width={64}
                        height={64}
                        className="rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                        <span className="text-xl font-semibold text-primary">
                          {listing.agent.first_name?.[0]}
                          {listing.agent.last_name?.[0]}
                        </span>
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-foreground">
                        {listing.agent.first_name} {listing.agent.last_name}
                      </p>
                      {listing.brokerage_name && (
                        <p className="text-sm text-muted-foreground">{listing.brokerage_name}</p>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {listing.agent.phone && (
                      <Button variant="outline" className="w-full justify-start" asChild>
                        <a href={`tel:${listing.agent.phone}`}>
                          <Phone className="h-4 w-4 mr-2" />
                          {listing.agent.phone}
                        </a>
                      </Button>
                    )}
                    {listing.agent.email && (
                      <Button variant="outline" className="w-full justify-start" asChild>
                        <a href={`mailto:${listing.agent.email}`}>
                          <Mail className="h-4 w-4 mr-2" />
                          {listing.agent.email}
                        </a>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Section 7: Showing Request Form */}
            <ShowingRequestForm
              listingId={listing.id}
              sessionToken={sessionToken}
              agentName={
                listing.agent
                  ? `${listing.agent.first_name} ${listing.agent.last_name}`
                  : "The listing agent"
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}
