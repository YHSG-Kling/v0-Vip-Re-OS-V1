"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Settings2, AlertTriangle } from "lucide-react"
import { manualTierOverride } from "@/app/actions/billing"

interface TierOverrideModalProps {
  subscriptionId: string
  currentTierId?: string
  brokerageName: string
  tiers: any[]
}

export function TierOverrideModal({
  subscriptionId,
  currentTierId,
  brokerageName,
  tiers,
}: TierOverrideModalProps) {
  const [open, setOpen] = useState(false)
  const [selectedTierId, setSelectedTierId] = useState<string>(currentTierId || "")
  const [reason, setReason] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!selectedTierId || !reason.trim()) {
      setError("Please select a tier and provide a reason")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      await manualTierOverride(subscriptionId, selectedTierId, reason)
      setOpen(false)
      setReason("")
    } catch (err: any) {
      setError(err.message || "Failed to override tier")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Settings2 className="h-4 w-4 mr-1" />
          Override
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manual Tier Override</DialogTitle>
          <DialogDescription>
            Override the subscription tier for <strong>{brokerageName}</strong>.
            This action will be logged in the audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>
              This bypasses normal billing. The customer will not be charged for this change.
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tier-select">New Tier</Label>
            <Select value={selectedTierId} onValueChange={setSelectedTierId}>
              <SelectTrigger id="tier-select">
                <SelectValue placeholder="Select a tier" />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((tier) => (
                  <SelectItem key={tier.id} value={tier.id}>
                    {tier.display_name} 
                    {tier.id === currentTierId && " (current)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason for Override</Label>
            <Textarea
              id="reason"
              placeholder="Enter the reason for this manual override..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              This will be recorded in the audit log for compliance purposes.
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? "Applying..." : "Apply Override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
