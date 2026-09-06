/**
 * <HomeValueReportCard> — THE REPORT, IN THE PORTAL.
 *
 * The owner's ruling: "they will be presented with a contact portal to log in and
 * the report will show up in their portal ... [and] the portal will be given a way
 * to schedule a listing appotintment as well which needs to be atleast 7 days out."
 *
 * This is that card. Same shape as every other portal module (a self-fetching async
 * server component under app/components/portal, hidden when it has nothing to say —
 * see ContactVendorToolkitCard / MarketPositionCard), so the portal home keeps ONE
 * presentation language.
 *
 * WHERE THE NUMBERS COME FROM. It reads the contact's most recent
 * `home_value_estimates` row and renders what is stored — the same row the report
 * email was composed from, so the two surfaces cannot disagree. Nothing is
 * recomputed here and nothing is invented: no row, or a row with no range, and the
 * card does not render at all rather than showing a placeholder figure.
 *
 * SELLER-SAFETY, and the line that is easy to cross: this card SHOWS this seller
 * their own estimated value, because that is the thing they asked for and it is
 * about their own home. It is NOT the pre-listing presentation drip
 * (lib/listing-presentation/section-drip.ts), which is deliberately price-withheld
 * because it is pre-meeting marketing. Two different artefacts. The withholding
 * discipline of the one does not belong on the other, in either direction.
 *
 * The "View the full breakdown" link points at the seller's existing report page
 * rather than re-rendering comps here — the report presentation already exists and
 * a second copy of it is exactly the parallel surface to avoid.
 */

import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Home, ArrowRight, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { ListingAppointmentCard } from "@/app/components/home-value/ListingAppointmentCard"

interface Props {
  contactId: string
}

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/** What actually produced the number, in the seller's words. */
function methodLabel(methodology: string | null): string {
  switch (methodology) {
    case "ai_cma":
      return "Based on recent comparable sales near you, each adjusted for the differences between that home and yours."
    case "sqft_regional_average":
      // The honest state: no comparable sale could be sourced. Say so.
      return "We couldn't find enough recent comparable sales near your home for a full market analysis, so this range uses a regional average price per square foot. It doesn't account for your home's condition, upgrades, or lot."
    case "attom":
    case "housecanary":
    case "manual":
      return `Produced by our ${methodology.replace(/_/g, " ")} valuation method.`
    default:
      return "An estimate based on the property details on file."
  }
}

export async function HomeValueReportCard({ contactId }: Props) {
  const supabase = await createClient()

  // The contact's latest report. contact_id is the scope; the portal session's
  // own RLS is the backstop.
  const { data: estimate, error } = await supabase
    .from("home_value_estimates")
    .select(
      "id, valuation_request_id, brokerage_id, property_address, estimated_value_low, estimated_value_mid, estimated_value_high, confidence_score, methodology, market_trend, generated_at",
    )
    .eq("contact_id", contactId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    // A refused read resolves as "no report yet", which would silently hide a
    // report the seller does have. Log it and render nothing rather than lie.
    console.error("[portal] home value estimate read refused:", error.message)
    return null
  }
  if (!estimate) return null

  const low = estimate.estimated_value_low
  const mid = estimate.estimated_value_mid
  const high = estimate.estimated_value_high

  // No usable range = no card. Never a placeholder figure.
  if (typeof low !== "number" || typeof mid !== "number" || typeof high !== "number") return null

  // The homeowner's own name — stamped on the appointment and told to the agent.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("first_name, last_name")
    .eq("id", contactId)
    .maybeSingle()
  if (contactError) {
    console.error("[portal] contact read refused for home value card:", contactError.message)
  }
  const contactName =
    [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "Homeowner"

  const address = estimate.property_address ?? "your home"
  const trend = estimate.market_trend

  const trendIcon =
    trend === "appreciating" ? <TrendingUp className="h-3.5 w-3.5" />
    : trend === "depreciating" ? <TrendingDown className="h-3.5 w-3.5" />
    : <Minus className="h-3.5 w-3.5" />

  const trendClass =
    trend === "appreciating" ? "bg-green-100 text-green-800"
    : trend === "depreciating" ? "bg-red-100 text-red-800"
    : "bg-muted text-muted-foreground"

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Home className="h-4 w-4 text-emerald-600" />
                Your Home Value Report
              </CardTitle>
              <CardDescription>{address}</CardDescription>
            </div>
            {/* "unknown" is a real state — no market_data row covers this ZIP or
                city yet. Say that instead of labelling it Stable. */}
            <Badge variant="secondary" className={trendClass}>
              <span className="flex items-center gap-1">
                {trendIcon}
                {!trend || trend === "unknown"
                  ? "Trend not yet available"
                  : trend.charAt(0).toUpperCase() + trend.slice(1)}
              </span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-5 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Estimated value
            </p>
            <p className="text-3xl font-semibold text-foreground">{usd(mid)}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Range {usd(low)} &ndash; {usd(high)}
            </p>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed">
            {methodLabel(estimate.methodology)}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {typeof estimate.confidence_score === "number" && (
              <Badge variant="outline" className="text-xs">
                Confidence {Math.round(estimate.confidence_score)}%
              </Badge>
            )}
            {estimate.generated_at && (
              <span className="text-xs text-muted-foreground">
                Generated{" "}
                {new Date(estimate.generated_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            )}
          </div>

          {estimate.valuation_request_id && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/home-value/result/${estimate.valuation_request_id}`}>
                View the full breakdown
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          )}

          <p className="text-xs text-muted-foreground">
            An estimate for information, not an appraisal. Your agent can walk the property and
            give you a figure grounded in what it would actually list for.
          </p>
        </CardContent>
      </Card>

      {/* THE PORTAL'S WAY IN to the ≥7-day listing appointment — the same
          component the emailed report links to, so the two agree. */}
      {estimate.brokerage_id && (
        <ListingAppointmentCard
          brokerageId={estimate.brokerage_id}
          contactId={contactId}
          propertyAddress={address}
          contactName={contactName}
        />
      )}
    </div>
  )
}
