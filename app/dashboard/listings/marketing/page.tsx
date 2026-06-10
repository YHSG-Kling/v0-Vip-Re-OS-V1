import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Share2, Mail, Video, FileText, Megaphone, Instagram, ArrowRight } from "lucide-react"
import Link from "next/link"

export const dynamic = "force-dynamic"

export default async function ListingsMarketingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Get active listings for marketing
  const { data: listings } = await service
    .from("listings")
    .select("id, property_address:address, list_price, status, photos")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10)

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/listings">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Listings
          </Button>
        </Link>
        <div className="flex-1" />
        <Link href="/dashboard/campaigns">
          <Button variant="outline" size="sm" className="gap-2">
            <Megaphone className="h-4 w-4" />
            Campaigns Hub
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Listing Marketing Hub</h1>
          <p className="text-muted-foreground">Create and distribute marketing for your listings</p>
        </div>

        {/* Marketing Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Link href="/dashboard/social?action=create">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-pink-500/10">
                    <Instagram className="w-6 h-6 text-pink-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Social Media Post</h3>
                    <p className="text-sm text-muted-foreground">Create & schedule social posts</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/sequences?action=create">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-blue-500/10">
                    <Mail className="w-6 h-6 text-blue-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Email Campaign</h3>
                    <p className="text-sm text-muted-foreground">Launch drip sequences</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/videos/create">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-purple-500/10">
                    <Video className="w-6 h-6 text-purple-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Property Video</h3>
                    <p className="text-sm text-muted-foreground">Generate AI listing video</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/repurpose">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-green-500/10">
                    <Share2 className="w-6 h-6 text-green-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Repurpose Content</h3>
                    <p className="text-sm text-muted-foreground">Turn one asset into many</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/mail">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-amber-500/10">
                    <FileText className="w-6 h-6 text-amber-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Direct Mail</h3>
                    <p className="text-sm text-muted-foreground">Print postcards & flyers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/ads">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-red-500/10">
                    <Megaphone className="w-6 h-6 text-red-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Paid Ads</h3>
                    <p className="text-sm text-muted-foreground">Launch Facebook/Google ads</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>

        {/* Active Listings Ready for Marketing */}
        <Card>
          <CardHeader>
            <CardTitle>Active Listings</CardTitle>
            <CardDescription>Select a listing to market</CardDescription>
          </CardHeader>
          <CardContent>
            {listings && listings.length > 0 ? (
              <div className="space-y-3">
                {listings.map((listing) => (
                  <div key={listing.id} className="flex items-center justify-between p-3 border rounded-lg hover:border-primary/50 transition-colors">
                    <div>
                      <p className="font-medium">{listing.property_address || `Listing #${listing.id.slice(0, 8)}`}</p>
                      <p className="text-sm text-muted-foreground">${(listing.list_price || 0).toLocaleString()}</p>
                    </div>
                    <Link href={`/dashboard/social?action=create&listing=${listing.id}`}>
                      <Button size="sm" variant="outline" className="gap-2">
                        Market This <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No active listings to market</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
