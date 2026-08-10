"use client"

// app/dashboard/vendors/vendor-portal-invite-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM INVITATIONS — the missing front door for the vendor portal.
//
// app/actions/vendor-invite.ts has always been able to mint a vendor_invitations
// row and send the Supabase auth invite, and /vendor-invite/[token] has always
// been able to ACCEPT one. Nothing on the platform could SEND one: no surface
// called inviteVendorToPlatformAction or revokeVendorInviteAction, so the only
// way a vendor ever reached their portal was for someone to construct the row by
// hand. The superadmin vendor board even renders "not invited" / "invite pending"
// badges for a lane no button fed.
//
// WHO CAN DO WHAT (enforced server-side in vendor-invite.ts, mirrored here):
//   invite — broker / broker_admin / admin / superadmin / team_lead / agent
//            (lib/vendors/vendor-scope.ts:canInviteVendors is the one list)
//   revoke — broker / broker_admin / admin / superadmin / team_lead
// Both are scoped to the caller's own brokerage and the server re-verifies that
// the vendor belongs to it before writing.
//
// HONESTY: the invitation ROW and the invitation EMAIL are two different things.
// The action now reports emailSent separately, and this panel says which one
// happened. A green "invited" toast over a failed send would be the exact defect
// this codebase is removing.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Mail, MailX, Ban, Copy } from "lucide-react"
import {
  inviteVendorToPlatformAction,
  revokeVendorInviteAction,
} from "@/app/actions/vendor-invite"

export interface VendorInviteRow {
  id:         string
  vendor_id:  string
  status:     string
  email:      string | null
  expires_at: string | null
  created_at: string | null
}

export interface InvitableVendor {
  id:           string
  name:         string
  email:        string | null
  /** Set when this vendor already has a portal login linked
   *  (user_role_assignments.vendor_id) — nothing left to invite. */
  linkedEmail:  string | null
}

export interface VendorPortalInvitePanelProps {
  vendors:     InvitableVendor[]
  invitations: VendorInviteRow[]
  /** Server-side load error, surfaced instead of an empty list that would read
   *  as "nobody has been invited". */
  loadError?:  string | null
  canInvite:   boolean
  canRevoke:   boolean
}

function statusTone(status: string) {
  switch (status) {
    case "pending":  return "bg-amber-100 text-amber-800"
    case "accepted": return "bg-emerald-100 text-emerald-800"
    case "revoked":  return "bg-red-100 text-red-800"
    default:         return "bg-slate-100 text-slate-600"
  }
}

export function VendorPortalInvitePanel({
  vendors, invitations, loadError, canInvite, canRevoke,
}: VendorPortalInvitePanelProps) {
  const router = useRouter()
  const [busyVendorId, setBusyVendorId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [customMessage, setCustomMessage] = useState("")

  // Latest invitation per vendor. `invitations` arrives newest-first.
  const latestByVendor = new Map<string, VendorInviteRow>()
  for (const inv of invitations) {
    if (!latestByVendor.has(inv.vendor_id)) latestByVendor.set(inv.vendor_id, inv)
  }

  async function handleInvite(vendorId: string) {
    setBusyVendorId(vendorId)
    try {
      const res = await inviteVendorToPlatformAction({
        vendorId,
        customMessage: customMessage.trim() || undefined,
      })
      if (!res.ok) {
        toast.error(res.error ?? "Could not create the invitation")
        return
      }
      if (res.emailSent) {
        toast.success(
          res.reused
            ? "Invitation re-sent — the existing link is still valid."
            : "Invitation email sent.",
        )
      } else {
        // Row exists, email did not go. Say so, and hand over the link.
        toast.warning(
          `Invitation created but the email did not send (${res.emailError ?? "unknown error"}). Copy the link and send it yourself.`,
          {
            duration: 12_000,
            action: res.inviteUrl
              ? { label: "Copy link", onClick: () => navigator.clipboard.writeText(res.inviteUrl!) }
              : undefined,
          },
        )
      }
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not create the invitation")
    } finally {
      setBusyVendorId(null)
    }
  }

  async function handleRevoke(invitationId: string) {
    setRevokingId(invitationId)
    try {
      const res = await revokeVendorInviteAction(invitationId)
      // The server proves the update with .select() and refuses when no PENDING
      // row of this brokerage matched, so a green toast here means the token is
      // genuinely dead — not merely that the call returned.
      if (!res.ok) {
        toast.error(res.error ?? "Could not revoke the invitation")
        return
      }
      toast.success("Invitation revoked — that link no longer works.")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not revoke the invitation")
    } finally {
      setRevokingId(null)
    }
  }

  const invitable = vendors.filter((v) => !v.linkedEmail)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Vendor portal invitations
        </CardTitle>
        <CardDescription className="text-xs">
          Invite a vendor on your bench to claim a portal login. They get a magic link, accept it, and land
          on their own jobs / invoices / earnings portal. A vendor with no invitation has no way in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canInvite && (
          <div className="space-y-1.5 max-w-xl">
            <Label className="text-xs">Note to include in the invitation (optional)</Label>
            <Input
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              placeholder="e.g. Rachel referred you — we'd like to send you work through the portal."
            />
          </div>
        )}

        {loadError ? (
          <p className="text-sm text-red-600">Could not load invitation status: {loadError}</p>
        ) : vendors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No vendors on the bench yet. Add a vendor in the Marketplace tab first — the invitation goes to
            the email on the vendor record.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10 text-xs text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">Vendor</th>
                  <th className="text-left px-3 py-2 font-medium">Email</th>
                  <th className="text-left px-3 py-2 font-medium">Portal status</th>
                  <th className="text-right px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => {
                  const inv = latestByVendor.get(v.id)
                  const expired =
                    inv?.status === "pending" &&
                    !!inv.expires_at &&
                    new Date(inv.expires_at).getTime() < Date.now()
                  return (
                    <tr key={v.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">{v.name}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {v.email ?? <span className="text-amber-700">no email on file</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {v.linkedEmail ? (
                          <Badge variant="outline" className="text-[11px] border-emerald-300 text-emerald-700">
                            portal account: {v.linkedEmail}
                          </Badge>
                        ) : inv ? (
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${statusTone(expired ? "expired" : inv.status)}`}>
                            invite {expired ? "expired" : inv.status}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">never invited</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {v.linkedEmail ? (
                          <span className="text-[11px] text-muted-foreground">already on the platform</span>
                        ) : !canInvite ? (
                          <span className="text-[11px] text-muted-foreground">ask a broker or team lead</span>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-xs"
                              disabled={busyVendorId === v.id || !v.email}
                              title={v.email ? undefined : "Add an email to the vendor record first"}
                              onClick={() => handleInvite(v.id)}
                            >
                              {busyVendorId === v.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : v.email ? <Mail className="h-3.5 w-3.5" /> : <MailX className="h-3.5 w-3.5" />}
                              {inv?.status === "pending" && !expired ? "Re-send" : "Invite"}
                            </Button>
                            {canRevoke && inv?.status === "pending" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1 text-xs text-red-600"
                                disabled={revokingId === inv.id}
                                onClick={() => handleRevoke(inv.id)}
                              >
                                {revokingId === inv.id
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Ban className="h-3.5 w-3.5" />}
                                Revoke
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {invitable.length > 0 && canInvite && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Copy className="h-3 w-3" />
            If the email cannot be delivered the invitation link is still created — the toast hands it to you
            to send another way.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
