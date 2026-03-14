import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"

export default async function ListingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch listings for this agent
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, state, price, status, beds, baths, sqft, created_at")
    .eq("agent_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Listings</h1>
          <p className="text-muted-foreground">Manage your property listings</p>
        </div>
        <Link href="/listings/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Listing
          </Button>
        </Link>
      </div>

      <div className="grid gap-4">
        {listings && listings.length > 0 ? (
          listings.map((listing) => (
            <Link key={listing.id} href={`/listings/${listing.id}`}>
              <div className="border border-border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-foreground">{listing.address}</h3>
                    <p className="text-sm text-muted-foreground">
                      {listing.city}, {listing.state}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-foreground">
                      ${listing.price?.toLocaleString() || "N/A"}
                    </p>
                    <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs capitalize">
                      {listing.status || "active"}
                    </span>
                  </div>
                </div>
                {(listing.beds || listing.baths || listing.sqft) && (
                  <div className="mt-2 flex gap-4 text-sm text-muted-foreground">
                    {listing.beds && <span>{listing.beds} beds</span>}
                    {listing.baths && <span>{listing.baths} baths</span>}
                    {listing.sqft && <span>{listing.sqft.toLocaleString()} sqft</span>}
                  </div>
                )}
              </div>
            </Link>
          ))
        ) : (
          <div className="border border-dashed border-border rounded-lg p-8 text-center">
            <p className="text-muted-foreground mb-4">No listings found. Create your first listing to get started.</p>
            <Link href="/listings/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Create Listing
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
