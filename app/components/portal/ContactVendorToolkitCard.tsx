/**
 * <ContactVendorToolkitCard> — persona + stage-filtered vendor marketplace
 * preview that renders on every contact's portal home (buyer, seller,
 * lifetime). One server component, three contexts.
 *
 * Each context gets its own headline + icon + empty-state guidance so the
 * customer immediately understands WHY these vendors and not those:
 *
 *   buyer    → "Vendors for your home search"  (pre-contract + deal stages)
 *   seller   → "Pre-Listing Vendor Team"       (staging / photo / prep)
 *   lifetime → "Homeowner Toolkit"             (handyman / refi / etc.)
 *
 * Composition with the resolver:
 *   - audienceTags from buildVendorAudienceTags using the right portalView
 *   - stage derived from the contact's transaction + portalView
 *   - team_id picked up automatically when contact's agent is on a team
 *
 * Behavior:
 *   - Renders the top N vendors (default 6) as a compact grid
 *   - "See all" link to /portal/[contactId]/vendors when there are more
 *   - Hidden entirely when nothing matches (avoids empty-state clutter)
 */

import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Wrench, Hammer, Sparkles, ArrowRight, Phone, Star } from "lucide-react"
import {
  resolveContactVendors,
  buildVendorAudienceTags,
} from "@/lib/vendor-marketplace/resolve-contact-vendors"

interface Props {
  contactId:  string
  portalView: "buyer" | "seller" | "lifetime"
  /** Compact mode used when other context owns the page header. */
  compact?:   boolean
  /** Override the default 6 cap. */
  limit?:     number
}

type Headline = {
  title:       string
  description: string
  icon:        typeof Wrench
  color:       string
}

const HEADLINES: Record<Props["portalView"], Headline> = {
  buyer:    {
    title:       "Recommended Pros",
    description: "Vetted vendors for your home search, inspection, lending, and more.",
    icon:        Hammer,
    color:       "text-blue-600",
  },
  seller:   {
    title:       "Pre-Listing Vendor Team",
    description: "Stagers, photographers, cleaners, and prep pros recommended by your agent.",
    icon:        Sparkles,
    color:       "text-purple-600",
  },
  lifetime: {
    title:       "Homeowner Toolkit",
    description: "Vetted pros your agent personally recommends — handyman, refi, insurance, more.",
    icon:        Wrench,
    color:       "text-amber-600",
  },
}

export async function ContactVendorToolkitCard({ contactId, portalView, compact, limit }: Props) {
  const supabase = await createClient()
  const TOP_N = limit ?? 6

  // Load contact with full audience signal + active transaction stage
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, team_id, contact_type, contact_persona, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return null

  // Resolve current transaction (used for buyer-stage tagging only;
  // sellers + lifetime don't need it for stage derivation)
  let txnStatus: string | null = null
  if (portalView === "buyer") {
    const { data: txn } = await supabase
      .from("transactions")
      .select("status")
      .or(`buyer_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
      .not("status", "in", "(cancelled)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    txnStatus = (txn?.status as string | null) ?? null
  }

  const { audienceTags, stage } = buildVendorAudienceTags({
    contactType:        contact.contact_type ?? null,
    contactPersona:     contact.contact_persona ?? null,
    buyerStage:         contact.buyer_stage ?? null,
    portalView,
    transactionStatus:  txnStatus,
  })

  const vendors = await resolveContactVendors(supabase, {
    contactId,
    brokerageId:  contact.brokerage_id ?? null,
    teamId:       contact.team_id ?? null,
    stage,
    audienceTags,
  })

  if (vendors.length === 0) return null

  const top = vendors.slice(0, TOP_N)
  const headline = HEADLINES[portalView]
  const Icon = headline.icon

  return (
    <Card>
      <CardHeader className={compact ? "pb-2" : "pb-3"}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className={`flex items-center gap-2 ${compact ? "text-sm" : "text-base"}`}>
              <Icon className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} ${headline.color}`} />
              {headline.title}
            </CardTitle>
            {!compact && (
              <CardDescription className="text-xs">{headline.description}</CardDescription>
            )}
          </div>
          {vendors.length > TOP_N && (
            <Button variant="ghost" size="sm" className="text-xs gap-1 shrink-0" asChild>
              <Link href={`/portal/${contactId}/vendors`}>
                See all {vendors.length} <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className={`grid gap-2 ${compact ? "" : "md:grid-cols-2"}`}>
          {top.map((v) => (
            <Link
              key={v.id}
              href={`/portal/${contactId}/vendors`}
              className="block p-3 border rounded-lg hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                    {v.name ?? "Vendor"}
                    {v.preferred && (
                      <Badge className="bg-amber-100 text-amber-800 text-[9px] border-amber-200 h-4 px-1">★</Badge>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">{v.category ?? "Service"}</p>
                  {v.rating && (
                    <p className="text-[10px] flex items-center gap-0.5 mt-0.5">
                      <Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-500" />
                      {Number(v.rating).toFixed(1)}
                    </p>
                  )}
                </div>
                {v.phone && (
                  <Phone className="h-3.5 w-3.5 text-blue-600 shrink-0 mt-0.5" />
                )}
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
