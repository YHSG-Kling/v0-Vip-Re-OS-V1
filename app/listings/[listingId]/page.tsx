import { notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import type { Metadata } from "next"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Bed, Bath, Square, Calendar, MapPin, Phone, Mail } from "lucide-react"
import { PublicShowingForm } from "./public-showing-form"
import { PublicInfoForm } from "./public-info-form"

// ─── Types ───────────────────────────────────────────────────────────────────

interface ListingPageProps {
  params: Promise<{ listingId: string }>
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: ListingPageProps): Promise<Metadata> {
  const { listingId } = await params
  const service = await createClient()

  const { data: listing } = await service
    .from("listings")
    .select("address, city, state, zip, list_price, bedrooms, bathrooms, sqft, description")
    .eq("id", listingId)
    .in("status", ["active", "pending", "coming_soon", "sold", "under_contract"])
    .single()

  if (!listing) {
    return { title: "Listing Not Found" }
  }

  const price = listing.list_price
    ? `$${Number(listing.list_price).toLocaleString()}`
    : "Price on Request"

  const title = `${listing.address}, ${listing.city}, ${listing.state} ${listing.zip} — ${price}`
  const description =
    listing.description ||
    `${listing.bedrooms ?? "?"} bed, ${listing.bathrooms ?? "?"} bath home in ${listing.city}, ${listing.state}. ${price}.`

  return {
    title,
    description: description.slice(0, 160),
    openGraph: {
      title,
      description: description.slice(0, 160),
      type: "website",
    },
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PublicListingPage({ params }: ListingPageProps) {
  const { listingId } = await params
  const service = await createClient()

  // Fetch listing (no auth required — service client reads publicly relevant data)
  const { data: listing, error: listingError } = await service
    .from("listings")
    .select(
      "id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, description, property_type, year_built, mls_number, status, agent_id, brokerage_id, created_at"
    )
    .eq("id", listingId)
    .in("status", ["active", "pending", "coming_soon", "sold", "under_contract"])
    .single()

  if (listingError || !listing) {
    notFound()
  }

  // Fetch media, agent info, and brokerage in parallel
  const [mediaResult, agentInfo, brokerageResult] = await Promise.all([
    service
      .from("listing_media")
      .select("id, file_url, thumbnail_url, media_type, display_order")
      .eq("listing_id", listingId)
      .order("display_order", { ascending: true }),

    (async () => {
      if (!listing.agent_id) return null
      const { data: agentRow } = await service
        .from("agents")
        .select("user_id, phone, profile_photo_url")
        .eq("user_id", listing.agent_id)
        .maybeSingle()
      if (!agentRow) return null
      const { data: userRow } = await service
        .from("users")
        .select("name, email, avatar_url")
        .eq("id", agentRow.user_id ?? listing.agent_id)
        .maybeSingle()
      return { agentRow, userRow }
    })(),

    listing.brokerage_id
      ? service.from("brokerages").select("name").eq("id", listing.brokerage_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const photos = (mediaResult.data ?? []).filter(
    (m) => m.media_type === "photo" && (m.file_url || m.thumbnail_url)
  )
  const heroPhoto = photos[0]

  const agentName: string | null = agentInfo?.userRow?.name ?? null
  const agentPhone: string | null = agentInfo?.agentRow?.phone ?? null
  const agentEmail: string | null = agentInfo?.userRow?.email ?? null
  const agentPhoto: string | null =
    agentInfo?.agentRow?.profile_photo_url ?? agentInfo?.userRow?.avatar_url ?? null

  const brokerageName: string | null = (brokerageResult as any)?.data?.name ?? null

  const price = listing.list_price
    ? `$${Number(listing.list_price).toLocaleString()}`
    : "Price on Request"

  const statusLabel =
    listing.status === "active"
      ? "For Sale"
      : listing.status === "pending"
      ? "Under Contract"
      : listing.status === "sold"
      ? "Sold"
      : listing.status === "coming_soon"
      ? "Coming Soon"
      : listing.status === "under_contract"
      ? "Under Contract"
      : listing.status ?? "Active"

  const statusColor =
    listing.status === "active"
      ? "bg-green-100 text-green-800 border-green-200"
      : listing.status === "pending" || listing.status === "under_contract"
      ? "bg-yellow-100 text-yellow-800 border-yellow-200"
      : listing.status === "sold"
      ? "bg-gray-100 text-gray-800 border-gray-200"
      : "bg-blue-100 text-blue-800 border-blue-200"

  return (
    <div className="min-h-screen bg-white">
      {/* Minimal nav bar */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {brokerageName && (
              <span className="text-sm font-semibold text-gray-900 truncate">{brokerageName}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a href={`#schedule`}>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3">
                Schedule Showing
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* Hero — full-width photo */}
      <div className="relative w-full bg-gray-900" style={{ height: "min(60vh, 540px)" }}>
        {heroPhoto?.file_url || heroPhoto?.thumbnail_url ? (
          <Image
            src={heroPhoto.file_url || heroPhoto.thumbnail_url}
            alt={`${listing.address} — hero photo`}
            fill
            className="object-cover"
            priority
            sizes="100vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-blue-900 to-slate-800">
            <div className="text-center text-white opacity-60">
              <Square className="h-16 w-16 mx-auto mb-2" />
              <p className="text-sm">No photos available</p>
            </div>
          </div>
        )}

        {/* Gradient overlay + price badge */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 px-4 sm:px-8 pb-6 pt-12">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <span
                  className={`inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full border mb-2 ${statusColor}`}
                >
                  {statusLabel}
                </span>
                <h1 className="text-2xl sm:text-4xl font-bold text-white drop-shadow-md leading-tight">
                  {listing.address}
                </h1>
                <p className="text-white/90 text-sm sm:text-base mt-1 flex items-center gap-1">
                  <MapPin className="h-4 w-4 shrink-0" />
                  {listing.city}, {listing.state} {listing.zip}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-3xl sm:text-5xl font-extrabold text-white drop-shadow-md">
                  {price}
                </p>
                {listing.mls_number && (
                  <p className="text-white/70 text-xs mt-1">MLS# {listing.mls_number}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Photo strip (remaining photos) */}
      {photos.length > 1 && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-4">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {photos.slice(1, 8).map((photo) => (
              <div
                key={photo.id}
                className="relative flex-shrink-0 w-28 h-20 sm:w-36 sm:h-24 rounded-lg overflow-hidden bg-gray-100"
              >
                <Image
                  src={photo.file_url || photo.thumbnail_url || ""}
                  alt="Property photo"
                  fill
                  className="object-cover"
                  sizes="144px"
                />
              </div>
            ))}
            {photos.length > 8 && (
              <div className="flex-shrink-0 w-28 h-20 sm:w-36 sm:h-24 rounded-lg bg-gray-100 flex items-center justify-center text-xs text-gray-500 font-medium">
                +{photos.length - 8} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content grid */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* LEFT — Details */}
        <div className="lg:col-span-2 space-y-8">
          {/* Property stats */}
          <section>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {listing.bedrooms != null && (
                <div className="flex flex-col items-center gap-1 p-4 rounded-xl border border-gray-200 bg-gray-50">
                  <Bed className="h-6 w-6 text-blue-600" />
                  <span className="text-2xl font-bold text-gray-900">{listing.bedrooms}</span>
                  <span className="text-xs text-gray-500">Bedrooms</span>
                </div>
              )}
              {listing.bathrooms != null && (
                <div className="flex flex-col items-center gap-1 p-4 rounded-xl border border-gray-200 bg-gray-50">
                  <Bath className="h-6 w-6 text-blue-600" />
                  <span className="text-2xl font-bold text-gray-900">{listing.bathrooms}</span>
                  <span className="text-xs text-gray-500">Bathrooms</span>
                </div>
              )}
              {listing.sqft != null && (
                <div className="flex flex-col items-center gap-1 p-4 rounded-xl border border-gray-200 bg-gray-50">
                  <Square className="h-6 w-6 text-blue-600" />
                  <span className="text-2xl font-bold text-gray-900">
                    {Number(listing.sqft).toLocaleString()}
                  </span>
                  <span className="text-xs text-gray-500">Sq Ft</span>
                </div>
              )}
              {listing.year_built != null && (
                <div className="flex flex-col items-center gap-1 p-4 rounded-xl border border-gray-200 bg-gray-50">
                  <Calendar className="h-6 w-6 text-blue-600" />
                  <span className="text-2xl font-bold text-gray-900">{listing.year_built}</span>
                  <span className="text-xs text-gray-500">Year Built</span>
                </div>
              )}
            </div>
          </section>

          {/* Description */}
          {listing.description && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">About This Property</h2>
              <p className="text-gray-700 leading-relaxed whitespace-pre-line">
                {listing.description}
              </p>
            </section>
          )}

          {/* Property details table */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Property Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-8 text-sm">
              {listing.property_type && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">Property Type</span>
                  <span className="font-medium text-gray-900 capitalize">
                    {listing.property_type.replace(/_/g, " ")}
                  </span>
                </div>
              )}
              {listing.bedrooms != null && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">Bedrooms</span>
                  <span className="font-medium text-gray-900">{listing.bedrooms}</span>
                </div>
              )}
              {listing.bathrooms != null && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">Bathrooms</span>
                  <span className="font-medium text-gray-900">{listing.bathrooms}</span>
                </div>
              )}
              {listing.sqft != null && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">Square Feet</span>
                  <span className="font-medium text-gray-900">
                    {Number(listing.sqft).toLocaleString()}
                  </span>
                </div>
              )}
              {listing.year_built != null && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">Year Built</span>
                  <span className="font-medium text-gray-900">{listing.year_built}</span>
                </div>
              )}
              {listing.mls_number && (
                <div className="flex justify-between border-b border-gray-100 py-2">
                  <span className="text-gray-500">MLS#</span>
                  <span className="font-medium text-gray-900">{listing.mls_number}</span>
                </div>
              )}
            </div>
          </section>

          {/* Request More Info form */}
          <section id="info">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Request More Information</h2>
            <Card className="border border-gray-200">
              <CardContent className="pt-5">
                <PublicInfoForm listingId={listingId} />
              </CardContent>
            </Card>
          </section>
        </div>

        {/* RIGHT — Agent card + Schedule CTA */}
        <div className="space-y-6">
          {/* Agent card */}
          <Card className="border border-gray-200 overflow-hidden">
            <CardContent className="p-5">
              <div className="flex items-center gap-4 mb-4">
                {agentPhoto ? (
                  <div className="relative h-16 w-16 rounded-full overflow-hidden shrink-0 border-2 border-blue-100">
                    <Image
                      src={agentPhoto}
                      alt={agentName ?? "Agent"}
                      fill
                      className="object-cover"
                      sizes="64px"
                    />
                  </div>
                ) : (
                  <div className="h-16 w-16 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <span className="text-2xl font-bold text-blue-600">
                      {agentName ? agentName[0].toUpperCase() : "A"}
                    </span>
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 text-base leading-tight">
                    {agentName ?? "Listing Agent"}
                  </p>
                  {brokerageName && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{brokerageName}</p>
                  )}
                </div>
              </div>

              {agentPhone && (
                <a
                  href={`tel:${agentPhone}`}
                  className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 mb-2 group"
                >
                  <Phone className="h-4 w-4 text-gray-400 group-hover:text-blue-500" />
                  {agentPhone}
                </a>
              )}
              {agentEmail && (
                <a
                  href={`mailto:${agentEmail}`}
                  className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 mb-4 group truncate"
                >
                  <Mail className="h-4 w-4 text-gray-400 group-hover:text-blue-500 shrink-0" />
                  <span className="truncate">{agentEmail}</span>
                </a>
              )}
            </CardContent>
          </Card>

          {/* Schedule a Showing CTA */}
          <Card className="border border-blue-200 bg-blue-50 overflow-hidden" id="schedule">
            <CardContent className="p-5">
              <h3 className="font-semibold text-blue-900 mb-1">Schedule a Showing</h3>
              <p className="text-xs text-blue-700 mb-4">
                Request a private tour of this property.
              </p>
              <PublicShowingForm listingId={listingId} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 mt-12 py-8 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center text-xs text-gray-400">
          {brokerageName && <p className="font-medium text-gray-600 mb-1">{brokerageName}</p>}
          <p>
            All information is deemed reliable but not guaranteed. Equal housing opportunity.
          </p>
          {listing.mls_number && (
            <p className="mt-1">MLS Listing #{listing.mls_number}</p>
          )}
        </div>
      </footer>
    </div>
  )
}
