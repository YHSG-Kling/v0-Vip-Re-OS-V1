import Link from "next/link"
import { MapPin, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  lookupZipAvailability,
  MARKETPLACE_MIN_LEADS,
  type MarketplaceSnapshot,
} from "@/lib/platform/territory-marketplace"

// TERRITORY MARKETPLACE section (owner round 40, rec 4) — server component on
// the public /pricing page. The zip search is a plain GET form back to /pricing
// (?zip=) — the page is already force-dynamic and reads searchParams, so no
// client JS and no server action are needed. Everything rendered here comes
// from the anonymized MarketplaceSnapshot: unclaimed zips + platform lead
// volume only — never a tenant name, never a claimed zip's numbers.
export function TerritoryAvailability({
  snapshot,
  error,
  searchedZip,
}: {
  snapshot: MarketplaceSnapshot | null
  error: string | null
  searchedZip: string | null
}) {
  // Honest degrade: a broken read renders nothing louder than a quiet note —
  // never fabricated availability.
  if (!snapshot) {
    return error ? (
      <section id="territory" className="mt-16 max-w-3xl mx-auto text-center">
        <h2 className="text-xl font-semibold tracking-tight">Territory availability</h2>
        <p className="text-sm text-muted-foreground mt-2">
          Territory data is temporarily unavailable — check back shortly.
        </p>
      </section>
    ) : null
  }

  const floors = snapshot.countsAreFloors
  const fmtCount = (n: number) => (floors ? `${n}+` : `${n}`)
  const result = searchedZip ? lookupZipAvailability(snapshot, searchedZip) : null

  return (
    <section id="territory" className="mt-16 max-w-3xl mx-auto">
      <div className="text-center mb-6">
        <h2 className="text-xl font-semibold tracking-tight">Territory availability</h2>
        <p className="text-sm text-muted-foreground mt-2">
          The platform surfaces real leads in territories no subscriber serves yet. Search your zip —
          if it&apos;s unclaimed, the leads shown are waiting for whoever claims it first. Counts are
          platform-surfaced leads from {snapshot.periodLabel}; zips with fewer than {MARKETPLACE_MIN_LEADS} are
          not listed{floors ? ", and a read cap was hit so every count is a floor, not a total" : ""}.
        </p>
      </div>

      {/* Zip search — GET form; the server re-renders this section with the result. */}
      <form action="/pricing" method="get" className="flex justify-center gap-2 mb-6">
        <Input
          type="text"
          name="zip"
          inputMode="numeric"
          maxLength={5}
          defaultValue={searchedZip ?? ""}
          placeholder="Enter a 5-digit zip (e.g. 78704)"
          aria-label="Zip code"
          className="max-w-[240px]"
        />
        <Button type="submit" variant="outline">
          <Search className="h-4 w-4 mr-1.5" /> Check zip
        </Button>
      </form>

      {/* The searched zip — one of the three honest states (+ input guard). */}
      {result && (
        <Card className="mb-8">
          <CardContent className="pt-6 text-center text-sm">
            {result.state === "invalid" && (
              <p className="text-muted-foreground">
                &quot;{result.input}&quot; isn&apos;t a 5-digit zip — try again.
              </p>
            )}
            {result.state === "served" && (
              <p>
                <span className="font-medium">{result.zip}</span> — this territory is served by an
                active subscriber.{" "}
                <span className="text-muted-foreground">
                  We don&apos;t publish volume for served territories.
                </span>
              </p>
            )}
            {result.state === "no_volume" && (
              <p>
                <span className="font-medium">{result.zip}</span> — unclaimed, but no recorded platform
                lead volume in {result.periodLabel} yet.{" "}
                <span className="text-muted-foreground">
                  Claiming it puts our scrapers to work there.
                </span>{" "}
                <Link href={`/signup?zip=${result.zip}`} className="underline underline-offset-2">
                  Start a trial with {result.zip}
                </Link>
              </p>
            )}
            {result.state === "available" && (
              <div className="space-y-2">
                <p>
                  <span className="font-semibold">{fmtCount(result.zip.leadCount)} leads</span> surfaced in{" "}
                  <span className="font-medium">{result.zip.zip}</span>
                  {result.zip.city ? ` (${result.zip.city}${result.zip.state ? `, ${result.zip.state}` : ""})` : result.zip.state ? ` (${result.zip.state})` : ""}{" "}
                  in {result.zip.periodLabel} — <Badge className="bg-emerald-100 text-emerald-800 align-middle">unclaimed</Badge>
                </p>
                <Button asChild size="sm">
                  <Link href={`/signup?zip=${result.zip.zip}`}>Claim this territory — start free trial</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Teaser — top unclaimed zips by platform volume. */}
      {snapshot.teaser.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" /> Top unclaimed territories
            </CardTitle>
            <CardDescription className="text-xs">
              Real platform lead volume from {snapshot.periodLabel} in zips no active subscriber serves.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {snapshot.teaser.map((z) => (
                <li key={z.zip} className="flex items-center justify-between py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{z.zip}</span>
                    {(z.city || z.state) && (
                      <span className="text-muted-foreground">
                        {" "}· {z.city ?? ""}{z.city && z.state ? ", " : ""}{z.state ?? ""}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {fmtCount(z.leadCount)} leads · unclaimed
                    </span>
                    <Link
                      href={`/signup?zip=${z.zip}`}
                      className="underline underline-offset-2 text-primary whitespace-nowrap"
                    >
                      Claim it
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          No unclaimed territory currently clears the {MARKETPLACE_MIN_LEADS}-lead bar for {snapshot.periodLabel} —
          search your zip above, or claim it first and let the platform start surfacing volume there.
        </p>
      )}
    </section>
  )
}
