import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Building2, Wrench, AlertTriangle } from "lucide-react"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AcceptInviteForm } from "./accept-form"

export const dynamic = "force-dynamic"

export default async function VendorInviteAcceptPage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const svc = createServiceClient()
  const { data: invitation } = await svc
    .from("vendor_invitations")
    .select(`
      id, status, expires_at, email, custom_message,
      vendor:vendors!inner ( id, name, category ),
      brokerage:brokerages!inner ( id, name )
    `)
    .eq("token", token)
    .maybeSingle()

  if (!invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full border-red-200">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-10 w-10 text-red-600 mx-auto mb-3" />
            <p className="font-medium">Invitation not found</p>
            <p className="text-sm text-muted-foreground mt-1">
              This link may have been mistyped or revoked. Ask the brokerage that invited you to send a new one.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const isExpired = new Date(invitation.expires_at as string).getTime() < Date.now()
  const status    = invitation.status as string

  if (status !== "pending" || isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full border-amber-200">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-600 mx-auto mb-3" />
            <p className="font-medium">
              Invitation {isExpired ? "expired" : status}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Contact the brokerage to request a new invitation.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Check if user is authenticated. If not, send to login with redirect-back URL.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/vendor-invite/${token}`)}`)
  }

  // Treat invitation.vendor / .brokerage as object even though Supabase typing
  // sometimes returns arrays for embedded relations.
  const vendor    = Array.isArray(invitation.vendor)    ? invitation.vendor[0]    : invitation.vendor
  const brokerage = Array.isArray(invitation.brokerage) ? invitation.brokerage[0] : invitation.brokerage

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center p-6">
      <Card className="max-w-lg w-full">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Wrench className="h-5 w-5 text-primary" />
            <Badge variant="outline" className="text-xs">Vendor invitation</Badge>
          </div>
          <CardTitle>You&apos;ve been invited to join {brokerage?.name ?? "a brokerage"} on the platform</CardTitle>
          <CardDescription className="mt-2 space-y-1">
            <span className="flex items-center gap-1.5 text-sm">
              <Building2 className="h-3.5 w-3.5" />
              <span>{brokerage?.name}</span>
            </span>
            <span className="block text-sm">
              Vendor profile: <span className="font-medium">{vendor?.name}</span>
              {vendor?.category && <Badge variant="outline" className="ml-2 text-xs">{vendor.category}</Badge>}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {invitation.custom_message && (
            <div className="border rounded-md bg-muted/30 p-3 text-sm">
              <p className="text-xs text-muted-foreground mb-1">Message from your inviter:</p>
              <p className="italic">&ldquo;{invitation.custom_message}&rdquo;</p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Accepting this invitation will create a vendor account linked to <strong>{brokerage?.name}</strong>.
            You&apos;ll only see deals and jobs that this brokerage assigns to you — never another brokerage&apos;s data.
          </p>
          <AcceptInviteForm token={token} />
        </CardContent>
      </Card>
    </div>
  )
}
