import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Phone, Mail, MessageSquare, Building2, CreditCard, FileCheck, ArrowLeft } from "lucide-react"

export default async function TeamPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get contact
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Get active transaction
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const activeTransaction = transactions?.[0] ?? null

  // Parallel fetches
  const [agentResult, dealTeamResult, lenderResult, titleResult] = await Promise.all([
    // Primary agent
    contact.agent_id
      ? supabase
          .from("agents")
          .select("id, profile_photo_url, bio, users(first_name, last_name, phone, email)")
          .eq("id", contact.agent_id)
          .single()
      : Promise.resolve({ data: null }),
    // Deal team members
    activeTransaction
      ? supabase
          .from("deal_team_members")
          .select("id, member_type, agent_id, external_name, external_company, external_phone, external_email, scheduled_date, agent:agents(id, profile_photo_url, users(first_name, last_name, phone, email))")
          .eq("transaction_id", activeTransaction.id)
      : Promise.resolve({ data: [] }),
    // Transaction lenders
    activeTransaction
      ? supabase
          .from("transaction_lenders")
          .select("id, lender_name, loan_officer_name, loan_officer_phone, loan_officer_email, loan_status, loan_amount, loan_type")
          .eq("transaction_id", activeTransaction.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Transaction title/escrow
    activeTransaction
      ? supabase
          .from("transaction_title_escrow")
          .select("id, company_name, officer_name, officer_phone, officer_email, closing_status")
          .eq("transaction_id", activeTransaction.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const primaryAgent = agentResult.data
    ? {
        id: (agentResult.data as any).id,
        profile_photo_url: (agentResult.data as any).profile_photo_url,
        bio: (agentResult.data as any).bio,
        first_name: ((agentResult.data as any).users as any)?.first_name ?? null,
        last_name: ((agentResult.data as any).users as any)?.last_name ?? null,
        phone: ((agentResult.data as any).users as any)?.phone ?? null,
        email: ((agentResult.data as any).users as any)?.email ?? null,
      }
    : null
  const dealTeamMembers = (dealTeamResult.data ?? []).map((m: any) => ({
    ...m,
    agent: m.agent
      ? {
          id: m.agent.id,
          profile_photo_url: m.agent.profile_photo_url,
          first_name: (m.agent.users as any)?.first_name ?? null,
          last_name: (m.agent.users as any)?.last_name ?? null,
          phone: (m.agent.users as any)?.phone ?? null,
          email: (m.agent.users as any)?.email ?? null,
        }
      : null,
  }))
  const lender = lenderResult.data
  const titleEscrow = titleResult.data

  const contactName = contact.first_name || "Guest"

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href={`/portal/${contactId}`}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-3xl font-bold">Your Team</h1>
          <p className="text-muted-foreground mt-1">
            The professionals helping you through your real estate journey
          </p>
        </div>
      </div>

      {/* Primary Agent Card - Expanded */}
      {primaryAgent && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-blue-100 text-blue-800">Your Agent</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-6">
              <Avatar className="h-24 w-24 shrink-0">
                {primaryAgent.profile_photo_url && (
                  <AvatarImage src={primaryAgent.profile_photo_url} alt={`${primaryAgent.first_name} ${primaryAgent.last_name}`} />
                )}
                <AvatarFallback className="text-2xl">
                  {primaryAgent.first_name?.charAt(0)}{primaryAgent.last_name?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 space-y-3">
                <div>
                  <h3 className="text-xl font-semibold">
                    {primaryAgent.first_name} {primaryAgent.last_name}
                  </h3>
                  {primaryAgent.bio && (
                    <p className="text-sm text-muted-foreground mt-2 line-clamp-3">
                      {primaryAgent.bio}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {primaryAgent.phone && (
                    <Button variant="outline" asChild>
                      <a href={`tel:${primaryAgent.phone}`}>
                        <Phone className="h-4 w-4 mr-2" />
                        {primaryAgent.phone}
                      </a>
                    </Button>
                  )}
                  {primaryAgent.email && (
                    <Button variant="outline" asChild>
                      <a href={`mailto:${primaryAgent.email}`}>
                        <Mail className="h-4 w-4 mr-2" />
                        Email
                      </a>
                    </Button>
                  )}
                  <Button asChild>
                    <Link href={`/portal/${contactId}/messages`}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      Send Message
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deal Team - Full View */}
      {dealTeamMembers.length > 0 && (
        <DealTeamCard
          primaryAgent={null} // Already shown above
          teamMembers={dealTeamMembers as any}
          variant="full"
        />
      )}

      {/* Lender Card */}
      {lender && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Lender
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{lender.lender_name}</h3>
                  {lender.loan_officer_name && (
                    <p className="text-sm text-muted-foreground">
                      Loan Officer: {lender.loan_officer_name}
                    </p>
                  )}
                </div>
                {lender.loan_status && (
                  <Badge variant="secondary">{lender.loan_status}</Badge>
                )}
              </div>
              {(lender.loan_amount || lender.loan_type) && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {lender.loan_type && (
                    <div>
                      <p className="text-muted-foreground">Loan Type</p>
                      <p className="font-medium">{lender.loan_type}</p>
                    </div>
                  )}
                  {lender.loan_amount && (
                    <div>
                      <p className="text-muted-foreground">Loan Amount</p>
                      <p className="font-medium">${lender.loan_amount.toLocaleString()}</p>
                    </div>
                  )}
                </div>
              )}
              <div className="flex gap-3">
                {lender.loan_officer_phone && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`tel:${lender.loan_officer_phone}`}>
                      <Phone className="h-4 w-4 mr-2" />
                      Call
                    </a>
                  </Button>
                )}
                {lender.loan_officer_email && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`mailto:${lender.loan_officer_email}`}>
                      <Mail className="h-4 w-4 mr-2" />
                      Email
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Title/Escrow Card */}
      {titleEscrow && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCheck className="h-5 w-5" />
              Title / Escrow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{titleEscrow.company_name}</h3>
                  {titleEscrow.officer_name && (
                    <p className="text-sm text-muted-foreground">
                      Closing Officer: {titleEscrow.officer_name}
                    </p>
                  )}
                </div>
                {titleEscrow.closing_status && (
                  <Badge variant="secondary">{titleEscrow.closing_status}</Badge>
                )}
              </div>
              <div className="flex gap-3">
                {titleEscrow.officer_phone && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`tel:${titleEscrow.officer_phone}`}>
                      <Phone className="h-4 w-4 mr-2" />
                      Call
                    </a>
                  </Button>
                )}
                {titleEscrow.officer_email && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`mailto:${titleEscrow.officer_email}`}>
                      <Mail className="h-4 w-4 mr-2" />
                      Email
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!primaryAgent && dealTeamMembers.length === 0 && !lender && !titleEscrow && (
        <Card>
          <CardContent className="py-12 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Your team will appear here</h3>
            <p className="text-muted-foreground">
              Once you are under contract, your deal team members will be listed here
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
