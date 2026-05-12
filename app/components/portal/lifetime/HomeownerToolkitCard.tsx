/**
 * <HomeownerToolkitCard> — Forever Mode preview of the vendor marketplace.
 *
 * Server component. Surfaces the top curated homeowner-services vendors
 * (handyman / cleaners / landscapers / refi / insurance / smart-home)
 * directly on the lifetime-home page so the homeowner sees them every
 * time they open the portal — that's the post-close retention loop.
 *
 * Filtered via lib/vendor-marketplace/resolve-contact-vendors using:
 *   audienceTags = ['past_client', 'lifetime_customer', contact_persona]
 *   stage        = 'forever'
 *
 * "See all" links to /portal/[contactId]/vendors for the full grouped view.
 */

import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Wrench, ArrowRight, Phone, Star } from "lucide-react"
import {
  resolveContactVendors,
  buildVendorAudienceTags,
} from "@/lib/vendor-marketplace/resolve-contact-vendors"

interface Props {
  contactId: string
}

const TOP_N = 6

export async function HomeownerToolkitCard({ contactId }: Props) {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, team_id, contact_type, contact_persona, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return null

  const { audienceTags, stage } = buildVendorAudienceTags({
    contactType:    contact.contact_type ?? null,
    contactPersona: contact.contact_persona ?? null,
    buyerStage:     contact.buyer_stage ?? null,
    portalView:     "lifetime",
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-600" />
              Homeowner Toolkit
            </CardTitle>
            <CardDescription className="text-xs">
              Vetted pros your agent personally recommends.
            </CardDescription>
          </div>
          {vendors.length > TOP_N && (
            <Button variant="ghost" size="sm" className="text-xs gap-1" asChild>
              <Link href={`/portal/${contactId}/vendors`}>
                See all {vendors.length} <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 md:grid-cols-2">
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
