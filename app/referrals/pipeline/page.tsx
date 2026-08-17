import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { sendReferralThankYou } from "@/app/actions/referrals/referral-actions"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Phone, CheckCircle, XCircle, Clock } from "lucide-react"
import Link from "next/link"
import { getAgentContext } from "@/lib/identity"
import { referralStatusBadgeClass, referralStatusLabel } from "@/lib/referrals/referral-status"
import { PipelineOsClient } from "./pipeline-os-client"
import { ReferralAppreciationPanel } from "./appreciation-panel"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export default async function ReferralPipelinePage() {
  const { agentId, brokerageId, userType } = await getAgentContext()
  const supabase = await createClient()

  // BOTH sides of the referral are embedded. The page rendered
  // `referral.referring_contact?.first_name` under a "Referred By" heading, but
  // nothing embedded a referring contact — the real FK is referrer_contact_id —
  // so that field was blank on every card.
  const { data: referrals } = await supabase
    .from("referrals")
    // ONE literal string, not a concatenation: supabase-js infers the row type
    // from the select text, and a `+`-joined string collapses it to
    // GenericStringError, which then hides every real field behind a type error.
    .select("*, referred_contact:contacts!referred_contact_id(first_name, last_name, phone, email), referrer_contact:contacts!referrer_contact_id(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  // The colours used to be a local map keyed on "new" and "declined", which the
  // CHECK does not admit, with no entry for "received" or "assigned" — the two
  // states a brand-new referral actually lands in. It was corrected here and then
  // this page was the ONLY one of four that had the list right. It now reads the
  // shared module, so there is one place to be right.
  const statusIcons = {
    received: Clock,
    assigned: Clock,
    contacted: Phone,
    qualified: CheckCircle,
    under_contract: CheckCircle,
    closed: CheckCircle,
    lost: XCircle,
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* OS Pipeline Panel */}
      <PipelineOsClient
        agentId={agentId ?? ""}
        brokerageId={brokerageId ?? ""}
        referrals={(referrals || []).map((r) => ({
          id: r.id,
          // referred_name is not a column — the OS panel's headings were blank
          // for the same reason the cards below were. The column is referral_name.
          referral_name: r.referral_name,
          status: r.status,
          source_contact_id: r.referred_contact_id,
          source_contact_name: r.referred_contact
            ? `${r.referred_contact.first_name} ${r.referred_contact.last_name}`
            : undefined,
          created_at: r.created_at,
          value_estimate: r.value_estimate,
        }))}
      />

      {/* Referrer love loop — configure appreciation, link referrers, record gifts */}
      <ReferralAppreciationPanel canSetBrokerage={isAdminOrBroker({ user_type: userType ?? "" })} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Referral Pipeline</h1>
          <p className="text-muted-foreground">Track all referrals from lead to close</p>
        </div>
        <Link href="/referrals?action=create">
          <Button>Add Referral</Button>
        </Link>
      </div>

      <div className="space-y-4">
        {referrals?.map((referral) => {
          const StatusIcon = statusIcons[referral.status as keyof typeof statusIcons] || Clock

          return (
            <Card key={referral.id} className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    {/*
                      referred_name / referred_phone / referred_email /
                      potential_value / actual_value are NOT columns on
                      `referrals` (live schema). Every one of them rendered
                      undefined: the card's own TITLE was blank, and the three
                      optional blocks below simply never appeared, so the page
                      looked sparse rather than broken. The real columns are
                      referral_name, value_estimate and commission_amount, with
                      the contact's phone/email on the embedded contact row.
                    */}
                    <h3 className="text-lg font-semibold">
                      {referral.referral_name ||
                        (referral.referred_contact
                          ? `${referral.referred_contact.first_name ?? ""} ${referral.referred_contact.last_name ?? ""}`.trim()
                          : "") ||
                        "Unnamed referral"}
                    </h3>
                    <Badge className={referralStatusBadgeClass(referral.status)}>
                      <StatusIcon className="w-3 h-3 mr-1" />
                      {referralStatusLabel(referral.status)}
                    </Badge>
                    {!referral.thank_you_sent && referral.status !== "received" && (
                      <Badge variant="outline" className="border-yellow-500 text-yellow-700">
                        Thank you pending
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    {(referral.referrer_contact || referral.referred_by || referral.source_contact_name) && (
                      <div>
                        <p className="text-muted-foreground">Referred By</p>
                        <p className="font-medium">
                          {referral.referrer_contact
                            ? `${referral.referrer_contact.first_name ?? ""} ${referral.referrer_contact.last_name ?? ""}`.trim()
                            : referral.source_contact_name || referral.referred_by}
                        </p>
                      </div>
                    )}
                    {referral.referred_contact?.phone && (
                      <div>
                        <p className="text-muted-foreground">Phone</p>
                        <p className="font-medium">{referral.referred_contact.phone}</p>
                      </div>
                    )}
                    {referral.referred_contact?.email && (
                      <div>
                        <p className="text-muted-foreground">Email</p>
                        <p className="font-medium">{referral.referred_contact.email}</p>
                      </div>
                    )}
                    {referral.value_estimate != null && (
                      <div>
                        <p className="text-muted-foreground">Estimated Value</p>
                        <p className="font-medium">${Number(referral.value_estimate).toLocaleString()}</p>
                      </div>
                    )}
                    {referral.commission_amount != null && (
                      <div>
                        <p className="text-muted-foreground">Commission</p>
                        <p className="font-medium text-green-600">
                          ${Number(referral.commission_amount).toLocaleString()}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-muted-foreground">Referral Date</p>
                      <p className="font-medium">{new Date(referral.created_at).toLocaleDateString()}</p>
                    </div>
                  </div>

                  {referral.notes && (
                    <div className="mt-3 p-3 bg-muted/50 rounded text-sm">
                      <p className="text-muted-foreground">Notes:</p>
                      <p>{referral.notes}</p>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Link href={`/referrals/${referral.id}`}>
                    <Button size="sm" variant="outline">
                      View Details
                    </Button>
                  </Link>
                  {/*
                    LABELLED FOR WHAT IT DOES. This button had no handler at
                    all, and sendReferralThankYou does not send anything — it
                    flips thank_you_sent / thank_you_sent_at. That matches how
                    this product actually works: the appreciation panel above
                    configures a physical thank-you (handwritten card + gift
                    card, "never a referral fee") that a human puts in the post,
                    and the OS records it. So wiring it under the old label
                    would have asserted a send that never happens; the fix is to
                    say "mark", not to fake a dispatch.
                  */}
                  {!referral.thank_you_sent && referral.status !== "received" && (
                    <form
                      action={async () => {
                        "use server"
                        await sendReferralThankYou(referral.id)
                        revalidatePath("/referrals/pipeline")
                      }}
                    >
                      <Button size="sm" variant="default" type="submit" className="w-full">
                        Mark Thank-You Sent
                      </Button>
                    </form>
                  )}
                </div>
              </div>
            </Card>
          )
        })}

        {(!referrals || referrals.length === 0) && (
          <Card className="p-12">
            <div className="text-center">
              <p className="text-muted-foreground mb-4">No referrals yet</p>
              <Link href="/referrals?action=create">
                <Button>Add Your First Referral</Button>
              </Link>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
