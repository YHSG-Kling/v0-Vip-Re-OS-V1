import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { ArrowLeft, Phone, Mail, Building2, Briefcase, MessageSquare, Star } from "lucide-react"
import { RequestBookingButton } from "./request-booking-button"
import {
  resolveContactVendors,
  buildVendorAudienceTags,
  type VendorDirectoryEntry,
} from "@/lib/vendor-marketplace/resolve-contact-vendors"
import {
  resolveVendorDisclosure,
  loadRespaDisclosureOverrides,
  loadAfbaConfig,
  type VendorRespaDisclosure,
} from "@/lib/compliance/vendor-respa"
import { RespaAckGate } from "./respa-ack-gate"

/**
 * Contact-facing vendor marketplace.
 *
 * Renders for ALL portal views (buyer / seller / lifetime) — sellers
 * need pre-listing prep vendors (staging / photography / cleaners),
 * lifetime customers need homeowner-services vendors (handyman /
 * landscaping / refi / insurance) for the forever-mode retention loop.
 *
 * Vendor list is persona + stage + team filtered via
 * lib/vendor-marketplace/resolve-contact-vendors so a first-time buyer
 * sees movers + home warranty, an investor sees property managers + tax
 * pros, a downsizer sees moving + storage, and a lifetime customer sees
 * handyman / cleaners / refi / insurance.
 */
export default async function ClientVendorsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Kernel decides the portal view (buyer / seller / lifetime). All three
  // get the marketplace — the resolver below filters per view.
  const portalViewOutput = await determinePortalView(supabase, { contactId })
  const portalView = portalViewOutput.view

  // Hard guard: if the kernel can't decide a view at all, bounce back.
  if (!portalView) {
    redirect(`/portal/${contactId}`)
  }

  // Load contact with everything the audience resolver needs.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, brokerage_id, team_id, contact_type, contact_persona, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Active transaction (used for both stage derivation + assignments list)
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, contact_id, status, close_date")
    .or(`buyer_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Build audience + stage tags for the resolver
  const { audienceTags, stage } = buildVendorAudienceTags({
    contactType:        contact.contact_type ?? null,
    contactPersona:     contact.contact_persona ?? null,
    buyerStage:         contact.buyer_stage ?? null,
    portalView,
    transactionStatus:  transaction?.status ?? null,
    closeDate:          transaction?.close_date ?? null,
  })

  // Three reads in parallel — assignments + curated list + agent info.
  const [assignedRes, curatedVendors, agentRes] = await Promise.all([
    transaction
      ? supabase
          .from("vendor_assignments")
          .select(`
            id,
            assignment_type,
            scheduled_date,
            status,
            vendors:vendor_id(id, name, category, phone, email),
            vendor_jobs:vendor_jobs(id, status, cost_estimate, cost_actual)
          `)
          .eq("transaction_id", transaction.id)
          .order("scheduled_date", { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: [] as never[] }),
    resolveContactVendors(supabase, {
      contactId,
      brokerageId:  contact.brokerage_id ?? null,
      teamId:       contact.team_id ?? null,
      stage,
      audienceTags,
    }),
    contact.agent_id
      ? supabase.from("agents").select("id, users(first_name, last_name)").eq("id", contact.agent_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const assignedVendors = (assignedRes.data ?? []) as Array<{
    id: string
    assignment_type: string | null
    scheduled_date: string | null
    status: string | null
    vendors: { name?: string; category?: string; phone?: string; email?: string } | null
    vendor_jobs: Array<{ id: string; status: string | null; cost_estimate: number | null; cost_actual: number | null }> | null
  }>
  const agent = (agentRes as { data?: { users?: { first_name?: string | null; last_name?: string | null } | null } | null }).data ?? null

  // RESPA disclosure resolution — a preferred / settlement-service vendor shown to a client must carry
  // the required disclosure (and AfBA vendors must be acknowledged before contact info is revealed).
  // Text is brokerage-customizable (required_disclosures) with a legally-complete pure fallback.
  const [brokerageRes, respaOverrides, afba] = await Promise.all([
    contact.brokerage_id
      ? supabase.from("brokerages").select("name").eq("id", contact.brokerage_id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadRespaDisclosureOverrides(supabase as never),
    loadAfbaConfig(supabase as never, contact.brokerage_id ?? ""),
  ])
  const brokerageName = (brokerageRes.data as { name?: string } | null)?.name ?? null
  const disclosureByVendor = new Map<string, VendorRespaDisclosure>()
  for (const v of curatedVendors) {
    const afbaCfg = afba.isConfigured({ id: v.id, name: v.name })
    const disclosure = resolveVendorDisclosure({
      category: v.category,
      preferred: !!v.preferred,
      afbaConfigured: afbaCfg.configured,
      brokerageName,
      vendorName: v.name,
      overrides: respaOverrides,
    })
    if (disclosure) disclosureByVendor.set(v.id, disclosure)
  }

  // Group curated vendors by category for clean rendering
  const byCategory = new Map<string, VendorDirectoryEntry[]>()
  for (const v of curatedVendors) {
    const key = v.category ?? "Other"
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key)!.push(v)
  }

  // Headline copy varies by portal view
  const HEADLINES: Record<string, { title: string; subtitle: string }> = {
    buyer:    { title: "Your Vendor Team",          subtitle: "Professionals assisting with your home purchase." },
    seller:   { title: "Pre-Listing Vendor Team",   subtitle: "Stagers, photographers, and prep pros recommended by your agent." },
    lifetime: { title: "Your Homeowner Toolkit",    subtitle: "Trusted pros your agent personally recommends — for everything that comes up after closing." },
  }
  const header = HEADLINES[portalView] ?? HEADLINES.buyer

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Link>
        </Button>
        <h1 className="text-3xl font-bold">{header.title}</h1>
        <p className="text-muted-foreground mt-1">{header.subtitle}</p>
        <p className="text-sm mt-2">
          <Link href={`/portal/${contactId}/invoices`} className="text-blue-600 hover:underline">
            View invoices from your service providers →
          </Link>
        </p>
      </div>

      {/* Section 1: assigned vendors (only when there's an active transaction) */}
      {transaction && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="h-5 w-5" />
              Your Transaction Team
            </CardTitle>
            <CardDescription>Vendors assigned to your active deal</CardDescription>
          </CardHeader>
          <CardContent>
            {assignedVendors.length === 0 ? (
              <div className="text-center py-8">
                <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">
                  Your vendor team will be assigned as your transaction progresses.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {assignedVendors.map((assignment) => (
                  <div key={assignment.id} className="p-4 border rounded-lg">
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <h3 className="font-semibold">{assignment.vendors?.name ?? "Vendor"}</h3>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {assignment.assignment_type && (
                            <Badge variant="secondary" className="text-xs">{assignment.assignment_type}</Badge>
                          )}
                          {assignment.status && (
                            <Badge
                              variant="outline"
                              className={`text-xs ${
                                assignment.status === "completed"
                                  ? "bg-green-50 text-green-700 border-green-200"
                                  : "bg-blue-50 text-blue-700 border-blue-200"
                              }`}
                            >
                              {assignment.status}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm mb-3">
                      {assignment.vendors?.phone && (
                        <a href={`tel:${assignment.vendors.phone}`} className="flex items-center gap-1 text-blue-600 hover:underline">
                          <Phone className="h-4 w-4" />
                          {assignment.vendors.phone}
                        </a>
                      )}
                      {assignment.vendors?.email && (
                        <a href={`mailto:${assignment.vendors.email}`} className="flex items-center gap-1 text-blue-600 hover:underline">
                          <Mail className="h-4 w-4" /> Email
                        </a>
                      )}
                    </div>
                    <Button variant="outline" size="sm" className="w-full" asChild>
                      <Link href={`/portal/${contactId}/messages`}>
                        <MessageSquare className="h-4 w-4 mr-2" />
                        Message Agent About This Vendor
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Section 2: curated marketplace (grouped by category, persona-filtered) */}
      {curatedVendors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              {portalView === "lifetime" ? "Homeowner Services" : "Recommended Professionals"}
            </CardTitle>
            <CardDescription>
              {agent ? `Recommended by ${(agent.users as any)?.first_name ?? "your agent"}` : "Vetted by your brokerage"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {Array.from(byCategory.entries()).map(([category, vendors]) => (
              // The category heading carries an anchor id so another surface can
              // link a client straight to a vendor's SPOT here — e.g. the deal's
              // Hazard Insurance panel deep-links to #vendor-category-insurance.
              // Linking here rather than reproducing vendor contact details
              // elsewhere is deliberate: this page is where the RESPA / AfBA
              // acknowledgment gate lives, and it must not be stepped around.
              <div key={category} id={`vendor-category-${category}`} className="scroll-mt-24">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  {category}
                </h3>
                <div className="grid gap-3 md:grid-cols-2">
                  {vendors.map((v) => {
                    const disclosure = disclosureByVendor.get(v.id)
                    const gated = disclosure?.acknowledgmentRequired === true
                    return (
                    <div key={v.id} className="p-4 border rounded-lg hover:bg-muted/30 transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-semibold truncate flex items-center gap-1.5">
                            {v.name ?? "Vendor"}
                            {v.preferred && (
                              <Badge className="bg-amber-100 text-amber-800 text-[10px] border-amber-200">Preferred</Badge>
                            )}
                          </h4>
                          {v.rating && (
                            <div className="flex items-center gap-1 text-xs mt-0.5">
                              <Star className="h-3 w-3 fill-yellow-400 text-yellow-500" />
                              <span className="font-medium">{Number(v.rating).toFixed(1)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* AfBA vendors: contact is gated behind acknowledgment. All others: contact shows. */}
                      {gated ? (
                        <RespaAckGate
                          contactId={contactId}
                          vendorId={v.id}
                          disclosureText={disclosure!.text}
                          disclosureType={disclosure!.type}
                          phone={v.phone}
                          website={v.website}
                        />
                      ) : (
                        <div className="space-y-1 text-sm mb-3">
                          {v.phone && (
                            <a href={`tel:${v.phone}`} className="flex items-center gap-2 text-blue-600 hover:underline">
                              <Phone className="h-4 w-4" />{v.phone}
                            </a>
                          )}
                          {v.website && (
                            <a href={v.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-600 hover:underline">
                              <Building2 className="h-4 w-4" /> Visit Website
                            </a>
                          )}
                        </div>
                      )}
                      {v.notes && (
                        <p className="text-xs text-muted-foreground italic mb-3">&ldquo;{v.notes}&rdquo;</p>
                      )}
                      {/* Standard RESPA preferred-vendor disclosure (settlement services / preferred), inline. */}
                      {disclosure && !gated && (
                        <p className="text-[10px] leading-relaxed text-muted-foreground border-l-2 border-amber-300 pl-2 mb-3">
                          {disclosure.text}
                        </p>
                      )}
                      <RequestBookingButton
                        contactId={contactId}
                        vendorId={v.id}
                        vendorName={v.name ?? "this vendor"}
                        defaultServiceType={v.category ?? "consultation"}
                      />
                    </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {curatedVendors.length === 0 && assignedVendors.length === 0 && (
        <Card className="bg-blue-50 border-blue-200">
          <CardContent className="pt-6">
            <p className="text-sm text-blue-900">
              No vendors recommended for you yet. Reach out to your agent — they&apos;ll add the right pros to your toolkit.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
