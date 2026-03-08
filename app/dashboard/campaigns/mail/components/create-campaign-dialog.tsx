"use client"

import { useState } from "react"
import { Button } from "@/app/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { createMailCampaign } from "@/app/actions/direct-mail"

interface CreateCampaignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

export function CreateCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateCampaignDialogProps) {
  const [creating, setCreating] = useState(false)
  const [formData, setFormData] = useState({
    campaignName: "",
    targetAudience: "",
    designUrl: "",
    quantity: 500,
    mailingDate: "",
    perPieceCost: 0.79,
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)

    try {
      // In a real app, these IDs would come from the authenticated user session
      const result = await createMailCampaign({
        brokerageId: "00000000-0000-0000-0000-000000000000", // Would come from session
        agentId: undefined,
        campaignName: formData.campaignName,
        targetAudience: formData.targetAudience,
        designUrl: formData.designUrl || undefined,
        quantity: formData.quantity,
        mailingDate: formData.mailingDate || undefined,
        perPieceCost: formData.perPieceCost,
        createdBy: "00000000-0000-0000-0000-000000000000", // Would come from session
      })

      if (result.success) {
        setFormData({
          campaignName: "",
          targetAudience: "",
          designUrl: "",
          quantity: 500,
          mailingDate: "",
          perPieceCost: 0.79,
        })
        onCreated()
      } else {
        console.error("Create failed:", result.error)
      }
    } catch (error) {
      console.error("Create campaign error:", error)
    } finally {
      setCreating(false)
    }
  }

  const estimatedCost = formData.quantity * formData.perPieceCost

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Mail Campaign</DialogTitle>
            <DialogDescription>
              Set up a new direct mail campaign for your target audience.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="campaignName">Campaign Name</Label>
              <Input
                id="campaignName"
                placeholder="e.g., Spring 2026 Farm Postcards"
                value={formData.campaignName}
                onChange={(e) =>
                  setFormData({ ...formData, campaignName: e.target.value })
                }
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="targetAudience">Target Audience</Label>
              <Textarea
                id="targetAudience"
                placeholder="Describe your target audience (e.g., Homeowners in 90210 ZIP code with homes valued $1M+)"
                value={formData.targetAudience}
                onChange={(e) =>
                  setFormData({ ...formData, targetAudience: e.target.value })
                }
                required
                rows={3}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="designUrl">Design URL (Optional)</Label>
              <Input
                id="designUrl"
                type="url"
                placeholder="https://example.com/design.pdf"
                value={formData.designUrl}
                onChange={(e) =>
                  setFormData({ ...formData, designUrl: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                Link to your design file (PDF, PNG, or Canva share link)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="quantity">Quantity</Label>
                <Select
                  value={formData.quantity.toString()}
                  onValueChange={(value) =>
                    setFormData({ ...formData, quantity: parseInt(value) })
                  }
                >
                  <SelectTrigger id="quantity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="100">100 pieces</SelectItem>
                    <SelectItem value="250">250 pieces</SelectItem>
                    <SelectItem value="500">500 pieces</SelectItem>
                    <SelectItem value="1000">1,000 pieces</SelectItem>
                    <SelectItem value="2500">2,500 pieces</SelectItem>
                    <SelectItem value="5000">5,000 pieces</SelectItem>
                    <SelectItem value="10000">10,000 pieces</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="mailingDate">Mailing Date (Optional)</Label>
                <Input
                  id="mailingDate"
                  type="date"
                  value={formData.mailingDate}
                  onChange={(e) =>
                    setFormData({ ...formData, mailingDate: e.target.value })
                  }
                  min={new Date().toISOString().split("T")[0]}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="perPieceCost">Cost Per Piece ($)</Label>
              <Input
                id="perPieceCost"
                type="number"
                step="0.01"
                min="0.10"
                value={formData.perPieceCost}
                onChange={(e) =>
                  setFormData({ ...formData, perPieceCost: parseFloat(e.target.value) || 0 })
                }
              />
            </div>

            <div className="rounded-lg bg-muted p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Estimated Total Cost</span>
                <span className="text-lg font-bold">
                  ${estimatedCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formData.quantity.toLocaleString()} pieces x ${formData.perPieceCost.toFixed(2)}/piece
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={creating || !formData.campaignName || !formData.targetAudience}
            >
              {creating ? "Creating..." : "Create Campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
