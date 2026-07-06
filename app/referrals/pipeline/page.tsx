import { createClient } from "@/lib/supabase/server"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Phone, CheckCircle, XCircle, Clock } from "lucide-react"
import Link from "next/link"
import { getAgentContext } from "@/lib/identity"
import { PipelineOsClient } from "./pipeline-os-client"
import { ReferralAppreciationPanel } from "./appreciation-panel"

export const dynamic = "force-dynamic"

export default async function ReferralPipelinePage() {
  const { agentId, brokerageId, userType } = await getAgentContext()
  const supabase = await createClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select("*, referred_contact:contacts!referred_contact_id(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  const statusColors = {
    new: "bg-blue-100 text-blue-700",
    contacted: "bg-purple-100 text-purple-700",
    qualified: "bg-green-100 text-green-700",
    under_contract: "bg-orange-100 text-orange-700",
    closed: "bg-emerald-100 text-emerald-700",
    declined: "bg-gray-100 text-gray-700",
    lost: "bg-red-100 text-red-700",
  }

  const statusIcons = {
    new: Clock,
    contacted: Phone,
    qualified: CheckCircle,
    under_contract: CheckCircle,
    closed: CheckCircle,
    declined: XCircle,
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
          referral_name: r.referred_name,
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
      <ReferralAppreciationPanel canSetBrokerage={["broker", "broker_admin", "admin", "superadmin"].includes(userType ?? "")} />

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
                    <h3 className="text-lg font-semibold">{referral.referred_name}</h3>
                    <Badge className={statusColors[referral.status as keyof typeof statusColors]}>
                      <StatusIcon className="w-3 h-3 mr-1" />
                      {referral.status.replace("_", " ")}
                    </Badge>
                    {!referral.thank_you_sent && referral.status !== "new" && (
                      <Badge variant="outline" className="border-yellow-500 text-yellow-700">
                        Thank you pending
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Referred By</p>
                      <p className="font-medium">
                        {referral.referring_contact?.first_name} {referral.referring_contact?.last_name}
                      </p>
                    </div>
                    {referral.referred_phone && (
                      <div>
                        <p className="text-muted-foreground">Phone</p>
                        <p className="font-medium">{referral.referred_phone}</p>
                      </div>
                    )}
                    {referral.referred_email && (
                      <div>
                        <p className="text-muted-foreground">Email</p>
                        <p className="font-medium">{referral.referred_email}</p>
                      </div>
                    )}
                    {referral.potential_value && (
                      <div>
                        <p className="text-muted-foreground">Potential Value</p>
                        <p className="font-medium">${referral.potential_value.toLocaleString()}</p>
                      </div>
                    )}
                    {referral.actual_value && (
                      <div>
                        <p className="text-muted-foreground">Actual Value</p>
                        <p className="font-medium text-green-600">${referral.actual_value.toLocaleString()}</p>
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
                  {!referral.thank_you_sent && referral.status !== "new" && (
                    <Button size="sm" variant="default">
                      Send Thank You
                    </Button>
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
