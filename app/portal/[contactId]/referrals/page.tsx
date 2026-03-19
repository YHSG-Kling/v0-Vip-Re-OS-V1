import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView } from "@/lib/kernel/portal"
import { getReferralHistory } from "@/app/actions/portal-lifetime"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft,
  Users,
  Gift,
  Clock,
  CheckCircle2,
  UserPlus,
  Heart,
} from "lucide-react"
import { ReferralForm } from "./referral-form"

export default async function ReferralsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify lifetime portal access
  const portalView = await determinePortalView(supabase, contactId)
  if (portalView !== "lifetime") {
    redirect(`/portal/${contactId}`)
  }

  const referrals = await getReferralHistory(contactId)

  const getStatusBadge = (status: string) => {
    switch (status?.toLowerCase()) {
      case "converted":
        return (
          <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Converted
          </Badge>
        )
      case "contacted":
        return (
          <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
            <Users className="h-3 w-3 mr-1" />
            Contacted
          </Badge>
        )
      case "pending":
      default:
        return (
          <Badge variant="secondary">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        )
    }
  }

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Portal
          </Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">Referrals</h1>
        <p className="text-muted-foreground">
          Share the gift of great real estate service
        </p>
      </div>

      {/* Motivational Banner */}
      <Card className="bg-gradient-to-r from-purple-50 to-pink-50 border-purple-200">
        <CardContent className="py-6">
          <div className="flex items-center gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
              <Heart className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <p className="font-semibold text-purple-900">
                Your referrals are the biggest compliment you can give.
              </p>
              <p className="text-sm text-purple-700">
                Thank you for trusting us with the people you care about.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Submit New Referral */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-green-600" />
              <CardTitle>Submit a Referral</CardTitle>
            </div>
            <CardDescription>
              Know someone looking to buy or sell? Let us help them too.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReferralForm contactId={contactId} />
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Gift className="h-5 w-5 text-blue-600" />
              <CardTitle>Your Impact</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-3xl font-bold text-blue-600">{referrals.length}</p>
                <p className="text-sm text-muted-foreground">Total Referrals</p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-3xl font-bold text-green-600">
                  {referrals.filter((r: any) => r.referral_status === "converted").length}
                </p>
                <p className="text-sm text-muted-foreground">Converted</p>
              </div>
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-3xl font-bold text-amber-600">
                  {referrals.filter((r: any) => r.referral_status === "pending").length}
                </p>
                <p className="text-sm text-muted-foreground">Pending</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Referral History */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-purple-600" />
            <CardTitle>Referral History</CardTitle>
          </div>
          <CardDescription>
            People you've referred to your agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {referrals.length > 0 ? (
            <div className="space-y-3">
              {referrals.map((referral: any) => (
                <div
                  key={referral.id}
                  className="flex items-center justify-between p-4 rounded-lg border"
                >
                  <div className="space-y-1">
                    <p className="font-medium">{referral.referred_name}</p>
                    <p className="text-sm text-muted-foreground">
                      {referral.referred_contact}
                    </p>
                    {referral.relationship && (
                      <p className="text-xs text-muted-foreground">
                        Relationship: {referral.relationship}
                      </p>
                    )}
                  </div>
                  <div className="text-right space-y-1">
                    {getStatusBadge(referral.referral_status)}
                    <p className="text-xs text-muted-foreground">
                      {formatDate(referral.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">No referrals yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Submit your first referral above!
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
