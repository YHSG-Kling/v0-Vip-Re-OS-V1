"use client"

// CompareHomesCard — side-by-side comparison of a buyer's saved finalists, in OUR app (so they
// don't leak to Zillow to decide). Each home lined up by monthly payment + $/sqft + space + match,
// with the BEST in each row flagged as a strength (them-first — never a "worst"). "Get my agent's
// take" is the only thing that pings the agent — using the tool itself is quiet (signal, not noise).

import { useMemo, useState, useTransition } from "react"
import { Scale, CheckCircle2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { compareHomes, type ComparisonHomeInput } from "@/lib/buyer-offers/home-comparison"
import { requestComparisonReview } from "@/app/actions/buyer-offer-tools"

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

interface SavedHome {
  id: string
  property_address?: string | null
  list_price?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  ai_match_score?: number | null
}

export function CompareHomesCard({ contactId, savedHomes }: { contactId: string; savedHomes: SavedHome[] }) {
  const { toast } = useToast()
  const [pending, start] = useTransition()
  const candidates = useMemo(
    () => (savedHomes ?? []).filter((h) => h.id && typeof h.list_price === "number" && (h.list_price ?? 0) > 0),
    [savedHomes],
  )
  // Default to the first two finalists selected.
  const [selected, setSelected] = useState<string[]>(() => candidates.slice(0, 2).map((h) => h.id))

  if (candidates.length < 2) return null

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 4 ? prev : [...prev, id],
    )
  }

  const inputs: ComparisonHomeInput[] = candidates
    .filter((h) => selected.includes(h.id))
    .map((h) => ({
      id: h.id, address: h.property_address ?? "Saved home", price: h.list_price as number,
      bedrooms: h.bedrooms ?? null, bathrooms: h.bathrooms ?? null, sqft: h.sqft ?? null, matchScore: h.ai_match_score ?? null,
    }))
  const comparison = useMemo(() => compareHomes(inputs), [JSON.stringify(inputs)])

  function getAgentTake() {
    const addresses = comparison.homes.map((h) => h.address)
    start(async () => {
      const r = await requestComparisonReview({ contactId, addresses })
      toast(r.success
        ? { title: "Your agent will weigh in", description: "They'll help you choose between your finalists." }
        : { title: "Couldn't send", description: r.error ?? "Pick at least two homes", variant: "destructive" })
    })
  }

  return (
    <Card className="border-teal-200">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Scale className="h-4 w-4 text-teal-600" /> Compare your finalists
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pick 2–4 saved homes */}
        <div className="flex flex-wrap gap-2">
          {candidates.map((h) => {
            const on = selected.includes(h.id)
            return (
              <button
                key={h.id}
                onClick={() => toggle(h.id)}
                className={`text-xs rounded-full px-3 py-1 border transition ${on ? "bg-teal-600 text-white border-teal-600" : "bg-background text-muted-foreground border-input hover:border-teal-300"}`}
              >
                {h.property_address ?? "Saved home"}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">Pick 2–4 homes to line them up. Estimates only — your agent and lender confirm the real numbers.</p>

        {/* Side-by-side */}
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, comparison.homes.length)}, minmax(0, 1fr))` }}>
          {comparison.homes.map((h) => (
            <div key={h.id} className="rounded-lg border p-3 space-y-2">
              <p className="text-sm font-medium truncate" title={h.address}>{h.address}</p>
              <div className="space-y-1 text-xs">
                <Row label="Price" value={money(h.price)} />
                <Row label="Est. /mo" value={money(h.monthlyPayment)} />
                <Row label="$/sq ft" value={h.pricePerSqft != null ? money(h.pricePerSqft) : "—"} />
                <Row label="Beds / baths" value={`${h.bedrooms ?? "—"} / ${h.bathrooms ?? "—"}`} />
                <Row label="Sq ft" value={h.sqft ? h.sqft.toLocaleString() : "—"} />
                {h.matchScore != null && <Row label="Your fit" value={`${h.matchScore}/100`} />}
              </div>
              {h.highlights.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {h.highlights.map((hl) => (
                    <Badge key={hl} className="bg-green-100 text-green-800 text-[10px] flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />{hl}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <Button className="w-full bg-teal-600 hover:bg-teal-700 text-white" onClick={getAgentTake} disabled={pending || comparison.homes.length < 2}>
          <Users className="h-4 w-4 mr-1" />{pending ? "Sending…" : "Get my agent's take on these"}
        </Button>
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
