// app/portal/[contactId]/calculators/page.tsx — THE TENANT'S PUBLISHED CALCULATORS INSIDE THE CONSUMER PORTAL (wave 156,
// lane 156H, round 2). A buyer sees the buyer-side calculators (payment, affordability, buy-vs-rent, closing costs), a seller the
// seller-side ones (the net sheet ESTIMATE, equity), a dual client both — the same public component (CalculatorArtifact), the same
// engine and the same consent rule as the website: a view or a calculation never creates a person, and the brokerage's internal
// commission terms never reach this page (the public engine refuses them).
//
// TENANT: the contact row is read through the SESSION client (row security admits only the portal's own contact); its
// brokerage_id — never the URL — pins the service-client read of the published calculators (lib/calculators/artifact.ts).

import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePortalLayouts, portalShowsLayout } from "@/lib/kernel/portal"
import { listPublishedCalculators, portalCalculatorsFor } from "@/lib/calculators/artifact"
import { CalculatorArtifact } from "@/app/components/calculators/CalculatorArtifact"

export default async function PortalCalculatorsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()
  const layouts = await resolvePortalLayouts(supabase, { contactId })
  const buyer = portalShowsLayout(layouts, "buyer"), seller = portalShowsLayout(layouts, "seller")
  if (!buyer && !seller) redirect(`/portal/${contactId}`)
  const { data: contact, error } = await supabase.from("contacts").select("id, brokerage_id, first_name").eq("id", contactId).maybeSingle()
  if (error || !contact?.brokerage_id) redirect("/portal?error=contact_not_found")

  const all = await listPublishedCalculators(createServiceClient(), contact.brokerage_id as string)
  const calculators = portalCalculatorsFor(all, { buyer, seller })

  return (
    <div className="container mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
      <div>
        <Link href={`/portal/${contactId}`} className="text-sm underline">Back to your portal</Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Your calculators</h1>
        <p className="text-sm text-muted-foreground">Work through your own numbers. Nothing is saved or sent unless you choose to.</p>
      </div>
      {calculators.length === 0 && (
        <p className="text-sm text-muted-foreground">Your agent has not published a calculator for you yet — ask them in Messages.</p>
      )}
      {calculators.map((c) => (
        <CalculatorArtifact
          key={c.formId}
          formId={c.formId}
          kind={c.config.kind}
          jurisdiction={c.config.jurisdiction}
          hiddenFields={c.config.hiddenFields}
          brand={c.brand}
          explainer={c.config.explainer}
          cta={c.config.cta}
          consentBrandName={c.brand.displayName}
          attribution={{ utmSource: "portal" }}
        />
      ))}
    </div>
  )
}
