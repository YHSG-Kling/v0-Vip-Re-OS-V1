import { notFound } from "next/navigation"
import Link from "next/link"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Star, Award, Phone, Mail, MapPin, Home as HomeIcon, Sparkles,
} from "lucide-react"
import { ProfileLeadCaptureForm } from "./profile-lead-capture-form"
import { SiteChatLauncher } from "@/app/components/public-site/SiteChatLauncher"

export const dynamic = "force-dynamic"
export const revalidate = 60

interface AgentProfileData {
  agentId: string
  userId: string
  brokerageId: string
  fullName: string
  bio: string | null
  photoUrl: string | null
  licenseNumber: string | null
  licenseState: string | null
  yearsExperience: number | null
  specializations: string[] | null
  phoneMobile: string | null
  phoneOffice: string | null
  email: string | null
  brokerageName: string | null
  brokeragePhone: string | null
  primaryColor: string | null
  totalSalesLifetime: number | null
  listingsActive: number | null
}

interface ListingItem {
  id: string
  address: string
  city: string | null
  state: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  status: string | null
  primary_photo_url?: string | null
}

interface ReviewItem {
  id: string
  rating: number
  review_text: string | null
  reviewer_name: string | null
  platform: string | null
  created_at: string
}

async function loadProfile(slug: string): Promise<{
  profile: AgentProfileData
  listings: ListingItem[]
  reviews: ReviewItem[]
  averageRating: number
  chat: { brokerageSlug: string | null; widgetEnabled: boolean; assistantName: string | null }
} | null> {
  const svc = createServiceClient()

  const { data: agentRow } = await svc
    .from("agents")
    .select(
      "id, user_id, brokerage_id, license_number, license_state, photo_url, " +
      "bio, specializations, years_experience, phone_mobile, phone_office, " +
      "total_sales_lifetime, listings_active"
    )
    .eq("public_slug", slug)
    .maybeSingle()

  if (!agentRow) return null
  const agent = agentRow as any

  const [{ data: user }, { data: brokerage }, { data: listings }, { data: reviews }] =
    await Promise.all([
      svc.from("users").select("first_name, last_name, email, phone").eq("id", agent.user_id).maybeSingle(),
      svc.from("brokerages").select("name, phone, primary_color, slug, widget_enabled").eq("id", agent.brokerage_id).maybeSingle(),
      svc
        .from("listings")
        .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status")
        .eq("agent_id", agent.id)
        .eq("status", "active")
        .order("listing_date", { ascending: false })
        .limit(6),
      svc
        .from("agent_reviews")
        .select("id, rating, review_text, reviewer_name, platform, created_at")
        .eq("agent_id", agent.id)
        .eq("is_published", true)
        .order("created_at", { ascending: false })
        .limit(8),
    ])

  const { data: agentIdentity } = await svc.from("ai_identity_profiles")
    .select("assistant_name").eq("scope_type", "agent").eq("scope_id", agent.id).maybeSingle()

  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Your Agent"
  const reviewArr = reviews ?? []
  const averageRating =
    reviewArr.length > 0
      ? reviewArr.reduce((s, r) => s + r.rating, 0) / reviewArr.length
      : 0

  return {
    profile: {
      agentId: agent.id,
      userId: agent.user_id,
      brokerageId: agent.brokerage_id,
      fullName,
      bio: agent.bio ?? null,
      photoUrl: agent.photo_url ?? null,
      licenseNumber: agent.license_number ?? null,
      licenseState: agent.license_state ?? null,
      yearsExperience: agent.years_experience ?? null,
      specializations: agent.specializations ?? null,
      phoneMobile: agent.phone_mobile ?? null,
      phoneOffice: agent.phone_office ?? null,
      email: user?.email ?? null,
      brokerageName: brokerage?.name ?? null,
      brokeragePhone: brokerage?.phone ?? null,
      primaryColor: brokerage?.primary_color ?? "#0f172a",
      totalSalesLifetime: agent.total_sales_lifetime ?? null,
      listingsActive: agent.listings_active ?? null,
    },
    listings: (listings ?? []) as ListingItem[],
    reviews: reviewArr as ReviewItem[],
    averageRating,
    chat: {
      brokerageSlug: (brokerage as any)?.slug ?? null,
      widgetEnabled: (brokerage as any)?.widget_enabled !== false,
      assistantName: (agentIdentity as any)?.assistant_name ?? null,
    },
  }
}

function fmtPrice(n: number | null): string {
  if (n == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

export default async function AgentPublicProfilePage({
  params,
}: {
  params: Promise<{ agentSlug: string }>
}) {
  const { agentSlug } = await params
  const data = await loadProfile(agentSlug)
  if (!data) notFound()

  const { profile, listings, reviews, averageRating, chat } = data
  const brand = profile.primaryColor ?? "#0f172a"
  const phoneDisplay = profile.phoneMobile ?? profile.phoneOffice
  const initials = profile.fullName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      <header
        className="bg-white border-b"
        style={{ borderTopColor: brand, borderTopWidth: 4 }}
      >
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row gap-6 items-start">
          {profile.photoUrl ? (
            <img
              src={profile.photoUrl}
              alt={profile.fullName}
              className="h-28 w-28 rounded-full object-cover shrink-0"
            />
          ) : (
            <div
              className="h-28 w-28 rounded-full flex items-center justify-center text-white text-3xl font-semibold shrink-0"
              style={{ backgroundColor: brand }}
            >
              {initials}
            </div>
          )}

          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold">{profile.fullName}</h1>
            {profile.brokerageName && (
              <p className="text-sm text-gray-600 mt-0.5">{profile.brokerageName}</p>
            )}

            <div className="flex flex-wrap gap-3 mt-3 text-sm text-gray-600">
              {profile.yearsExperience != null && (
                <span className="flex items-center gap-1">
                  <Award className="h-3.5 w-3.5" />
                  {profile.yearsExperience} year{profile.yearsExperience === 1 ? "" : "s"} experience
                </span>
              )}
              {profile.licenseState && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {profile.licenseState}{profile.licenseNumber ? ` · #${profile.licenseNumber}` : ""}
                </span>
              )}
              {averageRating > 0 && (
                <span className="flex items-center gap-1">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  {averageRating.toFixed(1)} · {reviews.length} review{reviews.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {profile.specializations && profile.specializations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {profile.specializations.map((s) => (
                  <Badge key={s} variant="outline" className="text-xs">{s}</Badge>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 mt-4">
              {phoneDisplay && (
                <a href={`tel:${phoneDisplay}`}>
                  <Button size="sm" variant="outline" className="gap-1.5">
                    <Phone className="h-3.5 w-3.5" />
                    Call
                  </Button>
                </a>
              )}
              {profile.email && (
                <a href={`mailto:${profile.email}`}>
                  <Button size="sm" variant="outline" className="gap-1.5">
                    <Mail className="h-3.5 w-3.5" />
                    Email
                  </Button>
                </a>
              )}
              <Link href={`/home-value/${agentSlug}`}>
                <Button size="sm" style={{ backgroundColor: brand }} className="gap-1.5 text-white">
                  <Sparkles className="h-3.5 w-3.5" />
                  What's My Home Worth?
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          {/* About */}
          {profile.bio && (
            <Card>
              <CardContent className="p-6">
                <h2 className="text-base font-semibold mb-2">About</h2>
                <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">{profile.bio}</p>
              </CardContent>
            </Card>
          )}

          {/* Stats */}
          {(profile.totalSalesLifetime != null || profile.listingsActive != null) && (
            <Card>
              <CardContent className="p-6 grid grid-cols-3 gap-4 text-center">
                {profile.listingsActive != null && (
                  <div>
                    <p className="text-2xl font-bold" style={{ color: brand }}>
                      {profile.listingsActive}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">Active Listings</p>
                  </div>
                )}
                {profile.totalSalesLifetime != null && (
                  <div>
                    <p className="text-2xl font-bold" style={{ color: brand }}>
                      ${(profile.totalSalesLifetime / 1_000_000).toFixed(1)}M
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">Lifetime Sales</p>
                  </div>
                )}
                {averageRating > 0 && (
                  <div>
                    <p className="text-2xl font-bold flex items-center justify-center gap-1" style={{ color: brand }}>
                      {averageRating.toFixed(1)}
                      <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">Average Rating</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Active Listings */}
          {listings.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
                  <HomeIcon className="h-4 w-4" />
                  Active Listings
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {listings.map((l) => (
                    <Link
                      key={l.id}
                      href={`/listings/${l.id}`}
                      className="border rounded p-3 hover:bg-gray-50 transition-colors text-sm"
                    >
                      <p className="font-semibold" style={{ color: brand }}>
                        {fmtPrice(l.list_price)}
                      </p>
                      <p className="text-xs text-gray-700 mt-0.5">{l.address}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {[l.city, l.state].filter(Boolean).join(", ")}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-gray-500 mt-2">
                        {l.bedrooms != null && <span>{l.bedrooms} bd</span>}
                        {l.bathrooms != null && <span>· {l.bathrooms} ba</span>}
                        {l.sqft != null && <span>· {l.sqft.toLocaleString()} sqft</span>}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Reviews */}
          {reviews.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
                  <Star className="h-4 w-4 text-amber-400" />
                  Reviews
                </h2>
                <div className="space-y-4">
                  {reviews.map((r) => (
                    <div key={r.id} className="border-b last:border-0 pb-3 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              className={`h-3.5 w-3.5 ${i < r.rating ? "fill-amber-400 text-amber-400" : "text-gray-300"}`}
                            />
                          ))}
                          <span className="text-xs text-gray-600 ml-1">
                            {r.reviewer_name ?? "Anonymous"}
                          </span>
                        </div>
                        {r.platform && (
                          <Badge variant="outline" className="text-xs capitalize">{r.platform}</Badge>
                        )}
                      </div>
                      {r.review_text && (
                        <p className="text-sm text-gray-700 mt-1.5 leading-relaxed">{r.review_text}</p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Lead capture sidebar */}
        <aside className="space-y-4">
          <Card style={{ borderTopColor: brand, borderTopWidth: 3 }}>
            <CardContent className="p-5">
              <h3 className="text-base font-semibold mb-1">Get in touch with {profile.fullName.split(" ")[0]}</h3>
              <p className="text-xs text-gray-600 mb-4">
                Drop your details and {profile.fullName.split(" ")[0]} will reach out within 24 hours.
              </p>
              <ProfileLeadCaptureForm
                agentId={profile.agentId}
                agentUserId={profile.userId}
                brokerageId={profile.brokerageId}
                agentName={profile.fullName}
                brand={brand}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 text-xs text-gray-500 space-y-2">
              <p className="font-semibold uppercase tracking-wide text-gray-700">Brokerage</p>
              <p>{profile.brokerageName ?? "—"}</p>
              {profile.brokeragePhone && (
                <p className="flex items-center gap-1">
                  <Phone className="h-3 w-3" /> {profile.brokeragePhone}
                </p>
              )}
              {profile.licenseState && profile.licenseNumber && (
                <p className="text-[10px]">License: {profile.licenseNumber} · {profile.licenseState}</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </main>

      {/* LIVE AI — the agent's OWN assistant answers here (tier rule:
          agent site/call → agent identity; cascade falls back team →
          brokerage only when the agent hasn't configured one). */}
      {chat.brokerageSlug && chat.widgetEnabled && (
        <SiteChatLauncher
          brokerageSlug={chat.brokerageSlug}
          accentColor={profile.primaryColor ?? "#0f172a"}
          assistantLabel={chat.assistantName}
          widgetQuery={`agent=${agentSlug}`}
        />
      )}

      <footer className="border-t bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 text-[10px] text-gray-500 text-center">
          Equal Housing Opportunity. Real estate services provided by {profile.brokerageName ?? "the listed brokerage"}.
        </div>
      </footer>
    </div>
  )
}
