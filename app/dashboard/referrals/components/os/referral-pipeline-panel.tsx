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
import { createReferral } from "@/app/actions/referrals/referral-actions"
import { format } from "date-fns"
import {
  REFERRAL_STATUSES,
  referralStatusBadgeClass,
  type ReferralStatus,
} from "@/lib/referrals/referral-status"

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
  onUpdateStatus: (referralId: string, status: ReferralStatus) => Promise<void>
  onSendThankYou: (referralId: string) => Promise<void>
  onCreateReferral: () => void
  agentId: string
  brokerageId: string
}

// This board used to define its own five stages: "new", "contacted",
// "qualified", "converted", "closed". `new` and `converted` are in NO check
// constraint on referrals.status — picking either sent an UPDATE the database
// refused, and neither caller caught it, so those two stage changes silently
// did nothing. "assigned", "under_contract" and "lost" had no column at all, so
// referrals in those states rendered nowhere. See lib/referrals/referral-status.ts.

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
  // The create flow used to swallow every failure in a bare `catch {}` — the
  // dialog just sat there and the agent had no idea the referral was not saved.
  const [error, setError] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    referred_name: "",
    referred_email: "",
    referred_phone: "",
    notes: "",
    potential_value: "",
  })

  const handleStatusChange = (referralId: string, newStatus: ReferralStatus) => {
    setError(null)
    startTransition(() => {
      onUpdateStatus(referralId, newStatus).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to update status"),
      )
    })
  }

  const handleThankYou = (referralId: string) => {
    setError(null)
    startTransition(() => {
      onSendThankYou(referralId).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to send thank you"),
      )
    })
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // This used to CREATE A REFERRAL PARTNER named after the REFERRED person
    // purely because createReferral demanded a partnerId — then delete it again
    // as a compensating transaction when the referral insert failed. That put a
    // row in the agent's partner directory for every person who was referred TO
    // them, which is backwards: a partner is who SENT the referral.
    //
    // referrals.partner_id is nullable and partnerId is now optional, so a
    // referral that arrives without a partner is simply recorded without one.
    //
    // The name itself was also being dropped on the floor — the field is
    // required in this dialog and went nowhere. It now feeds referredPerson,
    // which is what captureContact() and referrals.referral_name are fed from.
    const trimmedName = formData.referred_name.trim()
    const [firstName, ...restName] = trimmedName.split(/\s+/)

    try {
      await createReferral({
        referredPerson: {
          firstName: firstName || undefined,
          lastName: restName.length ? restName.join(" ") : undefined,
          email: formData.referred_email || undefined,
          phone: formData.referred_phone || undefined,
        },
        notes: formData.notes || undefined,
        valueEstimate: formData.potential_value ? Number(formData.potential_value) : undefined,
      })
      setCreateOpen(false)
      setFormData({ referred_name: "", referred_email: "", referred_phone: "", notes: "", potential_value: "" })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create referral")
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
        {error && (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <ScrollArea className="w-full pb-4">
          <div className="flex gap-4 min-w-[1260px]">
            {REFERRAL_STATUSES.map(({ value: status, label }) => {
              const columnReferrals = referrals.filter((r) => r.status === status)
              return (
                <div key={status} className="w-[180px] flex-shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className={referralStatusBadgeClass(status)}>
                      {label}
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
                              {REFERRAL_STATUSES.map((s) => (
                                <DropdownMenuItem
                                  key={s.value}
                                  onClick={() => handleStatusChange(referral.id, s.value)}
                                  disabled={s.value === status}
                                >
                                  {s.label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                          {/* "converted" is not a storable status, so this gift button
                              was gated on a state no referral could ever be in — it
                              only ever appeared on Closed. under_contract is the point
                              at which the referral has actually produced business. */}
                          {(status === "under_contract" || status === "closed") && (
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
