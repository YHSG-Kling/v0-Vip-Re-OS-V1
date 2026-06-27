"use client"

// NeighborhoodLifestyleCard — surfaces the neighborhood intelligence our AI already generates but
// never showed the buyer: schools, walk/bike/transit, nearby amenities, and PERSONAL commute times
// to the places they actually go. This is the RealScout-grade "is this the right area for me?" layer.
//
// Deliberate omissions (Fair Housing + warm doctrine): we do NOT surface crime/safety scores or
// demographic make-up — those are steering risks and they scare buyers. We show lifestyle fit only.
// Commute is honest: real AI estimates, clearly labeled, never presented as live traffic.

import { useState, useTransition } from "react"
import { GraduationCap, Footprints, Bike, Bus, Store, Car, Plus, X, MapPin, Clock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { saveCommuteDestination, removeCommuteDestination } from "@/app/actions/smart-insights"

interface CommuteDestination { name: string; address: string; type: "work" | "school" | "family" | "other" }

interface Props {
  contactId: string
  propertyId: string
  propertyData: Record<string, any>
  schoolInsights: Record<string, any> | null
  neighborhoodInsights: Record<string, any> | null
  commuteInsights: Record<string, any> | null
  initialDestinations: CommuteDestination[]
}

function ScoreDot({ label, score, icon: Icon }: { label: string; score: number | null; icon: any }) {
  if (score === null || score === undefined) return null
  const tone = score >= 70 ? "text-emerald-700" : score >= 50 ? "text-blue-700" : "text-slate-600"
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <Icon className={`h-4 w-4 mx-auto mb-1 ${tone}`} />
      <p className={`text-lg font-bold ${tone}`}>{Math.round(score)}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

export function NeighborhoodLifestyleCard({
  contactId, propertyId, propertyData,
  schoolInsights, neighborhoodInsights, commuteInsights, initialDestinations,
}: Props) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [destinations, setDestinations] = useState<CommuteDestination[]>(initialDestinations)
  const [commute, setCommute] = useState<Record<string, any> | null>(commuteInsights)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [address, setAddress] = useState("")
  const [type, setType] = useState<CommuteDestination["type"]>("work")

  const walk = neighborhoodInsights?.walkability
  const amenities = neighborhoodInsights?.amenities
  const schools: any[] = Array.isArray(schoolInsights?.nearbySchools) ? schoolInsights!.nearbySchools : []
  const district = schoolInsights?.districtInfo
  const commuteRows: any[] = commute?.status === "calculated" && Array.isArray(commute.destinations) ? commute.destinations : []

  const hasWalk = walk && (walk.walkScore != null || walk.bikeScore != null || walk.transitScore != null)
  const hasAmenities = amenities && (amenities.restaurants || amenities.groceryStores || amenities.parks || amenities.gyms)
  const hasAnything = hasWalk || hasAmenities || schools.length > 0 || destinations.length > 0

  function handleAdd() {
    if (!name.trim() || !address.trim()) { toast({ title: "Add a name and address", variant: "destructive" }); return }
    startTransition(async () => {
      const r = await saveCommuteDestination(contactId, { name, address, type }, { propertyId, propertyData })
      if (r.success) {
        setDestinations(r.destinations ?? [])
        setCommute(r.commute ?? commute)
        setName(""); setAddress(""); setType("work"); setAdding(false)
        toast({ title: "Added — estimating your commute" })
      } else {
        toast({ title: r.error ?? "Could not add", variant: "destructive" })
      }
    })
  }

  function handleRemove(n: string) {
    startTransition(async () => {
      const r = await removeCommuteDestination(contactId, n, { propertyId, propertyData })
      if (r.success) { setDestinations(r.destinations ?? []); setCommute(r.commute ?? commute) }
    })
  }

  if (!hasAnything && !adding) {
    // Still offer the commute capture even if neighborhood data hasn't generated yet.
    return (
      <Card>
        <CardHeader><CardTitle className="text-sm font-semibold">Neighborhood &amp; Lifestyle</CardTitle></CardHeader>
        <CardContent>
          <button onClick={() => setAdding(true)} className="flex items-center gap-2 text-sm text-teal-700 font-medium">
            <Plus className="h-4 w-4" /> Add a place you go often to see your commute
          </button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm font-semibold">Neighborhood &amp; Lifestyle</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {/* Walk / Bike / Transit */}
        {hasWalk && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Getting around</p>
            <div className="grid grid-cols-3 gap-2">
              <ScoreDot label="Walk" score={walk.walkScore} icon={Footprints} />
              <ScoreDot label="Bike" score={walk.bikeScore} icon={Bike} />
              <ScoreDot label="Transit" score={walk.transitScore} icon={Bus} />
            </div>
            {walk.description && <p className="text-xs text-muted-foreground mt-2">{walk.description}</p>}
          </div>
        )}

        {/* Schools */}
        {schools.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
              <GraduationCap className="h-3.5 w-3.5" /> Schools nearby
              {district?.name && <span className="font-normal">· {district.name}</span>}
            </p>
            <div className="space-y-1.5">
              {schools.slice(0, 4).map((s, i) => (
                <div key={i} className="flex items-center justify-between text-sm rounded-lg border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{s.type} · {s.grades}{s.distance ? ` · ${s.distance} mi` : ""}</p>
                  </div>
                  {s.rating != null && (
                    <Badge variant="outline" className={s.rating >= 8 ? "text-emerald-700 border-emerald-200" : s.rating >= 5 ? "text-blue-700 border-blue-200" : "text-slate-600"}>
                      {s.rating}/10
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Amenities */}
        {hasAmenities && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Store className="h-3.5 w-3.5" /> What's close</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {amenities.restaurants ? <Badge variant="outline">{amenities.restaurants} restaurants</Badge> : null}
              {amenities.groceryStores ? <Badge variant="outline">{amenities.groceryStores} grocery</Badge> : null}
              {amenities.parks ? <Badge variant="outline">{amenities.parks} parks</Badge> : null}
              {amenities.gyms ? <Badge variant="outline">{amenities.gyms} gyms</Badge> : null}
              {amenities.hospitals ? <Badge variant="outline">{amenities.hospitals} hospitals</Badge> : null}
            </div>
          </div>
        )}

        {/* Commute — personal */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Car className="h-3.5 w-3.5" /> Your commute</p>
          {commuteRows.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {commuteRows.map((c, i) => {
                const dest = destinations.find((d) => d.name === c.destination)
                return (
                  <div key={i} className="flex items-center justify-between text-sm rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate flex items-center gap-1"><MapPin className="h-3 w-3 text-muted-foreground" />{c.destination}</p>
                      {dest && <p className="text-xs text-muted-foreground truncate">{dest.address}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {c.drivingPeakMin != null && (
                        <span className="flex items-center gap-1 text-sm"><Clock className="h-3 w-3 text-muted-foreground" />{c.drivingPeakMin} min</span>
                      )}
                      <button onClick={() => handleRemove(c.destination)} disabled={isPending} className="text-muted-foreground hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                )
              })}
              <p className="text-[11px] text-muted-foreground">Estimated drive times at peak hours. Your agent can confirm exact times.</p>
            </div>
          )}

          {adding ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="space-y-1">
                <Label htmlFor="dest-name" className="text-xs">Place name</Label>
                <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, the gym, Mom's…" className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dest-addr" className="text-xs">Address</Label>
                <Input id="dest-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, City" className="h-9 text-sm" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(["work", "school", "family", "other"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setType(t)}
                    className={`rounded-full border px-2.5 py-1 text-xs capitalize ${type === t ? "border-teal-600 bg-teal-50 text-teal-700" : "border-border text-muted-foreground"}`}>{t}</button>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleAdd} disabled={isPending}>{isPending ? "Saving…" : "Add"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={isPending}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-2 text-sm text-teal-700 font-medium">
              <Plus className="h-4 w-4" /> {destinations.length > 0 ? "Add another place" : "Add a place you go often"}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
