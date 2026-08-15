import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MapPin } from "lucide-react"

interface Listing {
  id: string
  address: string | null
  list_price: number | null
  status: string | null
  created_at: string | null
}

interface NeighborhoodActivityCardProps {
  listings: Listing[]
  propertyAddress?: string | null
}

export function NeighborhoodActivityCard({ listings, propertyAddress }: NeighborhoodActivityCardProps) {
  if (listings.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-blue-600" />
            <CardTitle className="text-lg">Neighborhood Activity</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No recent listings found nearby.</p>
        </CardContent>
      </Card>
    )
  }

  const fmt = (n: number | null) =>
    n ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : "—"

  const statusColor = (status: string | null) => {
    if (status === "active") return "bg-green-100 text-green-800"
    if (status === "sold") return "bg-blue-100 text-blue-800"
    if (status === "pending") return "bg-amber-100 text-amber-800"
    return "bg-gray-100 text-gray-800"
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-blue-600" />
          <CardTitle className="text-lg">Neighborhood Activity</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {listings.map((l) => (
          <div key={l.id} className="flex items-start justify-between gap-2 py-1 border-b last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{l.address ?? "Address unavailable"}</p>
              <p className="text-xs text-muted-foreground">{fmt(l.list_price)}</p>
            </div>
            <Badge variant="secondary" className={`text-xs shrink-0 ${statusColor(l.status)}`}>
              {l.status ?? "—"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
