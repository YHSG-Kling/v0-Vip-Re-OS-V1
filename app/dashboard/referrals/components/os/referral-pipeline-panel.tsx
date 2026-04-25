"use client"

import { useState, useTransition } from "react"
import { GitBranch, PlusCircle, Gift, ChevronDown, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createReferral, createPartner, deletePartner } from "@/app/actions/referrals/referral-actions"
import { format } from "date-fns"

interface Referral {
  id: string
  referral_name: string
  status: string
  source_contact_id?: string
  source_contact_name?: string
  created_at: string
  value_estimate?: number
}

interface ReferralPipelinePanelProps {
  referrals: Referral[]
  onUpdateStatus: (referralId: string, status: string) => Promise<void>
  onSendThankYou: (referralId: string) => Promise<void>
  onCreateReferral: () => void
  agentId: string
  brokerageId: string
}

const STATUSES = ["new", "contacted", "qualified", "converted", "closed"]
const statusColors: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  contacted: "bg-purple-100 text-purple-700",
  qualified: "bg-emerald-100 text-emerald-700",
  converted: "bg-amber-100 text-amber-700",
  closed: "bg-green-100 text-green-700",
}

export function ReferralPipelinePanel({
  referrals,
  onUpdateStatus,
  onSendThankYou,
  onCreateReferral,
  agentId,
  brokerageId,
}: ReferralPipelinePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [formData, setFormData] = useState({
    referred_name: "",
    referred_email: "",
    referred_phone: "",
    notes: "",
    potential_value: "",
  })

  const handleStatusChange = (referralId: string, newStatus: string) => {
    startTransition(() => {
      onUpdateStatus(referralId, newStatus)
    })
  }

  const handleThankYou = (referralId: string) => {
    startTransition(() => {
      onSendThankYou(referralId)
    })
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // createReferral requires a partnerId — create a partner record from the
    // referred person's name first, then attach the contact details.
    // If createReferral fails after createPartner succeeds, delete the orphan
    // partner as a compensating transaction to maintain atomicity.
    let partnerId: string | null = null
    try {
      const partner = await createPartner({
        partnerName: formData.referred_name,
        partnerType: "individual",
        agreementType: "referral",
      })
      partnerId = partner.id

      await createReferral({
        partnerId: partner.id,
        referredPerson: {
          email: formData.referred_email || undefined,
          phone: formData.referred_phone || undefined,
        },
        referralSource: formData.notes || undefined,
        commissionAmount: formData.potential_value ? Number(formData.potential_value) : undefined,
      })
      setCreateOpen(false)
      setFormData({ referred_name: "", referred_email: "", referred_phone: "", notes: "", potential_value: "" })
    } catch {
      // If partner was created but referral failed, delete the orphan partner
      if (partnerId) {
        try {
          await deletePartner(partnerId)
        } catch {
          console.error("Failed to clean up orphan partner after referral creation error", partnerId)
        }
      }
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Referral Pipeline
        </CardTitle>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1">
          <PlusCircle className="h-4 w-4" />
          Create Referral
        </Button>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full pb-4">
          <div className="flex gap-4 min-w-[900px]">
            {STATUSES.map((status) => {
              const columnReferrals = referrals.filter((r) => r.status === status)
              return (
                <div key={status} className="w-[180px] flex-shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className={statusColors[status]}>
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{columnReferrals.length}</span>
                  </div>
                  <div className="space-y-2 min-h-[200px] rounded-lg border border-dashed p-2 bg-muted/20">
                    {columnReferrals.map((referral) => (
                      <div key={referral.id} className="rounded-lg border bg-card p-3 shadow-sm">
                        <p className="font-medium text-sm truncate">{referral.referral_name}</p>
                        {referral.source_contact_name && (
                          <p className="text-xs text-muted-foreground truncate">
                            via {referral.source_contact_name}
                          </p>
                        )}
                        {referral.value_estimate && (
                          <p className="text-xs text-emerald-600 font-medium">
                            ${referral.value_estimate.toLocaleString()}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {format(new Date(referral.created_at), "MMM d")}
                        </p>
                        <div className="flex gap-1 mt-2">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm" className="h-7 text-xs flex-1" disabled={isPending}>
                                Status <ChevronDown className="h-3 w-3 ml-1" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              {STATUSES.map((s) => (
                                <DropdownMenuItem
                                  key={s}
                                  onClick={() => handleStatusChange(referral.id, s)}
                                  disabled={s === status}
                                >
                                  {s.charAt(0).toUpperCase() + s.slice(1)}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                          {(status === "converted" || status === "closed") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => handleThankYou(referral.id)}
                              disabled={isPending}
                            >
                              <Gift className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {columnReferrals.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">No referrals</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </CardContent>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Referral</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit} className="space-y-4">
            <div>
              <Label htmlFor="referred_name">Name *</Label>
              <Input
                id="referred_name"
                value={formData.referred_name}
                onChange={(e) => setFormData({ ...formData, referred_name: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="referred_email">Email</Label>
                <Input
                  id="referred_email"
                  type="email"
                  value={formData.referred_email}
                  onChange={(e) => setFormData({ ...formData, referred_email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="referred_phone">Phone</Label>
                <Input
                  id="referred_phone"
                  value={formData.referred_phone}
                  onChange={(e) => setFormData({ ...formData, referred_phone: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="potential_value">Potential Value ($)</Label>
              <Input
                id="potential_value"
                type="number"
                value={formData.potential_value}
                onChange={(e) => setFormData({ ...formData, potential_value: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              />
            </div>
            <Button type="submit" disabled={isPending} className="w-full">
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Referral
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
