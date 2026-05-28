"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { GraduationCap, Footprints, Train, Shield, MapPin } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface SchoolRating {
  name: string
  rating: number
  type?: string
}

interface NeighborhoodData {
  neighborhood_name: string | null
  school_ratings: Record<string, unknown> | null
  walk_score: number | null
  transit_score: number | null
  crime_index: number | null
  ai_summary: string | null
  generated_at: string | null
}

interface NeighborhoodWidgetProps {
  data?: NeighborhoodData | null
  listingId?: string
}

function ScoreBadge({
  score,
  label,
  icon: Icon,
}: {
  score: number | null
  label: string
  icon: React.ComponentType<{ className?: string }>
}) {
  if (score === null) return null

  const getScoreColor = (s: number) => {
    if (s >= 70) return "bg-green-100 text-green-800 border-green-200"
    if (s >= 50) return "bg-yellow-100 text-yellow-800 border-yellow-200"
    return "bg-red-100 text-red-800 border-red-200"
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
      <div className={`p-2 rounded-full ${getScoreColor(score)}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-foreground">{score}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function CrimeIndexBadge({ index }: { index: number | null }) {
  if (index === null) return null

  const getLabel = (i: number) => {
    if (i <= 30) return { text: "Low", color: "bg-green-100 text-green-800" }
    if (i <= 60) return { text: "Medium", color: "bg-yellow-100 text-yellow-800" }
    return { text: "High", color: "bg-red-100 text-red-800" }
  }

  const { text, color } = getLabel(index)

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
      <div className={`p-2 rounded-full ${color}`}>
        <Shield className="h-5 w-5" />
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground">{text}</p>
        <p className="text-xs text-muted-foreground">Crime Index</p>
      </div>
    </div>
  )
}

export function NeighborhoodWidget({ data: initialData, listingId }: NeighborhoodWidgetProps) {
  const [data, setData] = useState<NeighborhoodData | null>(initialData ?? null)
  const [loading, setLoading] = useState(!initialData && !!listingId)

  useEffect(() => {
    if (initialData || !listingId) return
    const supabase = createClient()
    supabase
      .from("neighborhood_reports")
      .select("neighborhood_name, school_ratings, walk_score, transit_score, crime_index, ai_summary, generated_at")
      .eq("listing_id", listingId)
      .maybeSingle()
      .then(({ data: report }: { data: any }) => {
        setData(report ?? null)
        setLoading(false)
      })
  }, [listingId, initialData])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Neighborhood
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">Loading neighborhood data...</p>
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Neighborhood
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">
            Neighborhood data is being compiled for this listing.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Parse school ratings if available
  let schools: SchoolRating[] = []
  if (data.school_ratings) {
    if (Array.isArray(data.school_ratings)) {
      schools = data.school_ratings.slice(0, 3) as SchoolRating[]
    } else if (typeof data.school_ratings === "object") {
      const entries = Object.entries(data.school_ratings)
      schools = entries.slice(0, 3).map(([name, rating]) => ({
        name,
        rating: typeof rating === "number" ? rating : 0,
      }))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-5 w-5" />
          {data.neighborhood_name || "Neighborhood"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Score Badges */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ScoreBadge score={data.walk_score} label="Walk Score" icon={Footprints} />
          <ScoreBadge score={data.transit_score} label="Transit Score" icon={Train} />
          <CrimeIndexBadge index={data.crime_index} />
        </div>

        {/* Schools */}
        {schools.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <GraduationCap className="h-4 w-4" />
              Nearby Schools
            </h4>
            <div className="space-y-2">
              {schools.map((school, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2 rounded-md bg-muted/50"
                >
                  <span className="text-sm text-foreground">{school.name}</span>
                  <Badge variant={school.rating >= 7 ? "default" : "secondary"}>
                    {school.rating}/10
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Summary */}
        {data.ai_summary && (
          <div className="p-4 rounded-lg bg-primary/5 border border-primary/10">
            <p className="text-sm text-muted-foreground leading-relaxed">{data.ai_summary}</p>
            <Badge variant="outline" className="mt-2 text-xs">
              AI Generated
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
