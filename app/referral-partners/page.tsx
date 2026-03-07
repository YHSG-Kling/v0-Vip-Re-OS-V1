import { createClient } from "@/lib/supabase/server"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Building2, Phone, Mail, TrendingUp, UserPlus } from "lucide-react"
import { getAgentContext } from "@/lib/identity"

export const dynamic = "force-dynamic"

export default async function ReferralPartnersPage() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: partners } = await supabase
    .from("referral_partners")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("partner_name")

  const partnerTypeColors = {
    real_estate_agent: "bg-blue-100 text-blue-700",
    mortgage_broker: "bg-green-100 text-green-700",
    title_company: "bg-purple-100 text-purple-700",
    home_inspector: "bg-orange-100 text-orange-700",
    contractor: "bg-yellow-100 text-yellow-700",
    insurance_agent: "bg-pink-100 text-pink-700",
    attorney: "bg-indigo-100 text-indigo-700",
    property_manager: "bg-teal-100 text-teal-700",
    other: "bg-gray-100 text-gray-700",
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Referral Partners</h1>
          <p className="text-muted-foreground">Manage your professional referral network</p>
        </div>
        <Button>
          <UserPlus className="w-4 h-4 mr-2" />
          Add Partner
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Partners</p>
              <p className="text-2xl font-bold">{partners?.length || 0}</p>
            </div>
            <Building2 className="w-8 h-8 text-blue-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Active Partners</p>
              <p className="text-2xl font-bold">{partners?.filter((p) => p.active).length || 0}</p>
            </div>
            <TrendingUp className="w-8 h-8 text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Referrals Sent</p>
              <p className="text-2xl font-bold">
                {partners?.reduce((sum, p) => sum + (p.total_referrals_sent || 0), 0) || 0}
              </p>
            </div>
            <UserPlus className="w-8 h-8 text-purple-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Value</p>
              <p className="text-2xl font-bold">
                ${((partners?.reduce((sum, p) => sum + (p.total_value_generated || 0), 0) || 0) / 1000).toFixed(0)}K
              </p>
            </div>
            <TrendingUp className="w-8 h-8 text-green-600" />
          </div>
        </Card>
      </div>

      {/* Partners Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {partners?.map((partner) => (
          <Card key={partner.id} className="p-6 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <h3 className="font-semibold text-lg mb-1">{partner.partner_name}</h3>
                {partner.company_name && <p className="text-sm text-muted-foreground mb-2">{partner.company_name}</p>}
                <Badge className={partnerTypeColors[partner.partner_type as keyof typeof partnerTypeColors]}>
                  {partner.partner_type.replace(/_/g, " ")}
                </Badge>
              </div>
              {partner.active ? (
                <Badge className="bg-green-100 text-green-700">Active</Badge>
              ) : (
                <Badge variant="outline">Inactive</Badge>
              )}
            </div>

            <div className="space-y-2 text-sm mb-4">
              {partner.email && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="w-4 h-4" />
                  <span className="truncate">{partner.email}</span>
                </div>
              )}
              {partner.phone && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="w-4 h-4" />
                  <span>{partner.phone}</span>
                </div>
              )}
            </div>

            {/* Performance Stats */}
            <div className="grid grid-cols-2 gap-3 p-3 bg-muted/50 rounded text-sm">
              <div>
                <p className="text-muted-foreground">Referrals Sent</p>
                <p className="font-semibold">{partner.total_referrals_sent || 0}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Received</p>
                <p className="font-semibold">{partner.total_referrals_received || 0}</p>
              </div>
            </div>

            {partner.agreement_type && (
              <div className="mt-3 text-xs text-muted-foreground">
                Agreement: {partner.agreement_type.replace(/_/g, " ")}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <Button size="sm" variant="outline" className="flex-1 bg-transparent">
                View Details
              </Button>
              <Button size="sm" className="flex-1">
                Send Referral
              </Button>
            </div>
          </Card>
        ))}

        {(!partners || partners.length === 0) && (
          <Card className="p-12 col-span-full">
            <div className="text-center">
              <Building2 className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-4">No referral partners yet</p>
              <Button>Add Your First Partner</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
