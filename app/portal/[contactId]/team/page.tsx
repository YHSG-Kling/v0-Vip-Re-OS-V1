import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Phone, Mail, MessageSquare, Building2, CreditCard, FileCheck, ArrowLeft, Star, User } from "lucide-react"
import { getAgentReviews } from "@/app/actions/multi-persona"

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
    // contact.agent_id is AGENTS-class (FK contacts_agent_id_fkey → agents.id), so
    // .eq("id", …) is the right comparison — this is NOT a users.id.
    //
    // TWO PHOTO COLUMNS, BOTH REAL. `agents` carries photo_url AND profile_image_url.
    // The agent's own profile editor (app/actions/user-profile.ts:155) reads and writes
    // photo_url, so an agent who sets their headshot from their profile lands it there
    // and this card — which used to read profile_image_url alone — showed nothing.
    // Resolve both, photo_url first, which is the convention the agent-facing surfaces
    // already use (lib/video/video-plays.ts:189, lib/video/director-content.ts:423).
    //
    // PHONE likewise: users.phone is the personal number and is frequently null, while
    // the client-facing numbers live on agents.phone_mobile / phone_office. The portal's
    // own messages page (app/portal/[contactId]/messages/page.tsx:137) already prefers
    // those two, so the Call button here now resolves the same way instead of going
    // missing whenever users.phone is unset.
    //
    // specializations / years_experience MERGED IN from the deleted
    // app/actions/ai-client-portal.ts:getContactAgent — see the tombstone in that
    // file. They are the two credibility fields this card was missing, and they
    // are what a client actually wants to know about the person representing
    // them. (Kept OUT of the query chain below deliberately: tenant-scope-guard
    // reads a 500-char window after `.from("agents")` looking for the scope
    // evidence, and a comment sitting between the .from() and the .eq("id", …)
    // pushes that evidence past the window and reports a scoped query as
    // unscoped. The chain stays compact so the guard can see it.)
    contact.agent_id
      ? supabase
          .from("agents")
          .select(
            "id, photo_url, profile_image_url, bio, specializations, years_experience, phone_mobile, phone_office, users(first_name, last_name, phone, email)"
          )
          .eq("id", contact.agent_id)
          .single()
      : Promise.resolve({ data: null, error: null }),
    // Deal team members
    activeTransaction
      ? supabase
          .from("deal_team_members")
          .select("id, member_type, external_name:name, external_company:company, external_phone:phone, external_email:email")
          .eq("transaction_id", activeTransaction.id)
      : Promise.resolve({ data: [] }),
    // Transaction lenders
    activeTransaction
      ? supabase
          .from("transaction_lenders")
          .select("id, lender_name, loan_officer_name, loan_officer_phone, loan_officer_email, loan_status:underwriting_status, loan_amount, loan_type")
          .eq("transaction_id", activeTransaction.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Transaction title/escrow
    activeTransaction
      ? supabase
          .from("transaction_title_escrow")
          .select("id, company_name:title_company_name, officer_name:title_officer_name, officer_phone:title_officer_phone, officer_email:title_officer_email, closing_status:title_status")
          .eq("transaction_id", activeTransaction.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  // `error` destructured deliberately: supabase-js RESOLVES a refused or failed read
  // with data:null, so treating a null row as "this client has no agent" would have
  // reported an RLS denial to the client as an absent agent. A failure now says so.
  const agentError = ((agentResult as any).error ?? null) as { message?: string } | null
  const agentRow = agentResult.data as any
  // `users` is a MANY-TO-ONE embed (agents.user_id → users.id, agents_user_id_fkey),
  // so PostgREST returns an object, not an array — the same shape the sibling readers
  // read at app/portal/[contactId]/listing/page.tsx:155 and vendors/page.tsx:263.
  const agentUser = (agentRow?.users as any) ?? null
  const primaryAgent = agentRow
    ? {
        id: agentRow.id,
        // photo_url is the column the agent's own profile editor writes; keep
        // profile_image_url as the fallback so older rows still resolve.
        profile_photo_url: (agentRow.photo_url ?? agentRow.profile_image_url ?? null) as string | null,
        bio: (agentRow.bio ?? null) as string | null,
        first_name: (agentUser?.first_name ?? null) as string | null,
        last_name: (agentUser?.last_name ?? null) as string | null,
        // Business numbers first — this card is what a CLIENT dials.
        phone: (agentRow.phone_mobile ?? agentRow.phone_office ?? agentUser?.phone ?? null) as string | null,
        email: (agentUser?.email ?? null) as string | null,
        // `agents.specializations` is `character varying`, NOT `text[]` (verified
        // against information_schema — the deleted getContactAgent passed it
        // through raw and would have handed a client component a bare string
        // where the shape implied a list). Split on commas so a single value and
        // a "Luxury, Relocation" value both render as chips, and so null and ""
        // both render as nothing.
        specializations: String(agentRow.specializations ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        years_experience: (agentRow.years_experience ?? null) as number | null,
      }
    : null

  // Degrade cleanly rather than printing "null null" or an empty element: a missing
  // name must not become a blank heading, and it must never reach the image alt text.
  const agentName = primaryAgent
    ? [primaryAgent.first_name, primaryAgent.last_name].filter(Boolean).join(" ")
    : ""
  const agentDisplayName = agentName || "Your agent"
  const agentInitials = primaryAgent
    ? [primaryAgent.first_name, primaryAgent.last_name]
        .filter(Boolean)
        .map((n) => (n as string).charAt(0).toUpperCase())
        .join("")
    : ""
  // deal_team_members has no agent_id/FK to agents — members render as external contacts.
  const dealTeamMembers = (dealTeamResult.data ?? []).map((m: any) => ({ ...m, agent: null }))
  const lender = lenderResult.data
  const titleEscrow = titleResult.data

  const contactName = contact.first_name || "Guest"

  // WHAT OTHER CLIENTS SAID. agent_reviews already collects these — the portal
  // testimonial capture (app/actions/portal-lifetime.ts) and the transaction
  // feedback widget both write them, and the agent publishes the ones they want
  // shown (is_published). Nothing on the CLIENT side had ever read them back, so a
  // published review reached the agent's own console and the public agent page and
  // stopped there. contact.agent_id is AGENTS-class, which is exactly what
  // agent_reviews.agent_id FKs — no identity hop.
  const agentReviews = contact.agent_id
    ? await getAgentReviews(contact.agent_id)
    : { reviews: [], metrics: { totalReviews: 0, averageRating: 0, recommendationRate: 0 }, error: null }

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

      {/* A FAILED agent read must say so rather than falling through to the "your team
          will appear here" empty state, which would tell a client with an assigned agent
          that they have none. Same honesty rule the reviews card below already follows. */}
      {contact.agent_id && !primaryAgent && agentError && (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-amber-700">
              Your agent details could not be loaded right now: {agentError.message ?? "unknown error"}
            </p>
          </CardContent>
        </Card>
      )}

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
                  <AvatarImage src={primaryAgent.profile_photo_url} alt={agentDisplayName} />
                )}
                <AvatarFallback className="text-2xl">
                  {agentInitials || <User className="h-10 w-10" />}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 space-y-3">
                <div>
                  <h3 className="text-xl font-semibold">{agentDisplayName}</h3>
                  {(primaryAgent.years_experience !== null ||
                    primaryAgent.specializations.length > 0) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {primaryAgent.years_experience !== null && (
                        <Badge variant="outline">
                          {primaryAgent.years_experience}{" "}
                          {primaryAgent.years_experience === 1 ? "year" : "years"} in real estate
                        </Badge>
                      )}
                      {primaryAgent.specializations.map((s) => (
                        <Badge key={s} variant="secondary">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  )}
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

      {/* What other clients said — PUBLISHED reviews only. A read failure says so
          rather than rendering as "no reviews", which would libel a good agent. */}
      {contact.agent_id && (agentReviews.reviews.length > 0 || agentReviews.error) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Star className="h-5 w-5 text-amber-500" />
              What other clients say
              {agentReviews.metrics.totalReviews > 0 && (
                <Badge variant="secondary">
                  {agentReviews.metrics.averageRating.toFixed(1)} average · {agentReviews.metrics.totalReviews} review
                  {agentReviews.metrics.totalReviews !== 1 ? "s" : ""}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {agentReviews.error ? (
              <p className="text-sm text-amber-700">
                Reviews could not be loaded right now: {agentReviews.error}
              </p>
            ) : (
              agentReviews.reviews.slice(0, 5).map((r: any) => (
                <div key={r.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={`h-4 w-4 ${n <= (r.rating ?? 0) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                      />
                    ))}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.reviewer_name || "A past client"}
                      {r.created_at ? ` · ${new Date(r.created_at).toLocaleDateString()}` : ""}
                    </span>
                  </div>
                  {r.review_text && <p className="mt-2 text-sm">{r.review_text}</p>}
                </div>
              ))
            )}
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
      {!primaryAgent && !agentError && dealTeamMembers.length === 0 && !lender && !titleEscrow && (
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
