"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Play,
  Pause,
  Archive,
  CheckCircle2,
  Calendar,
  Loader2,
  AlertTriangle
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { 
  batchPauseSequences, 
  batchLaunchSequences, 
  batchArchiveSequences 
} from "@/app/actions/campaign-sequences"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

interface Campaign {
  id: string
  name: string
  type: string
  isActive: boolean
}

interface CampaignBatchActionsPanelProps {
  campaigns: Campaign[]
}

export function CampaignBatchActionsPanel({ campaigns }: CampaignBatchActionsPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [showArchiveDialog, setShowArchiveDialog] = useState(false)

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(campaigns.map(c => c.id))
    } else {
      setSelectedIds([])
    }
  }

  const handleSelectOne = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id])
    } else {
      setSelectedIds(selectedIds.filter(i => i !== id))
    }
  }

  const handleBatchLaunch = async () => {
    startTransition(async () => {
      const result = await batchLaunchSequences(selectedIds)
      if (result.success) {
        toast.success(`${result.count} campaigns launched`)
        setSelectedIds([])
        router.refresh()
      } else {
        toast.error(result.error || "Failed to launch campaigns")
      }
    })
  }

  const handleBatchPause = async () => {
    startTransition(async () => {
      const result = await batchPauseSequences(selectedIds)
      if (result.success) {
        toast.success(`${result.count} campaigns paused`)
        setSelectedIds([])
        router.refresh()
      } else {
        toast.error(result.error || "Failed to pause campaigns")
      }
    })
  }

  const handleBatchArchive = async () => {
    startTransition(async () => {
      const result = await batchArchiveSequences(selectedIds)
      if (result.success) {
        toast.success(`${result.count} campaigns archived`)
        setSelectedIds([])
        setShowArchiveDialog(false)
        router.refresh()
      } else {
        toast.error(result.error || "Failed to archive campaigns")
      }
    })
  }

  const selectedCampaigns = campaigns.filter(c => selectedIds.includes(c.id))
  const activeSelected = selectedCampaigns.filter(c => c.isActive).length
  const pausedSelected = selectedCampaigns.filter(c => !c.isActive).length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5" />
              Batch Actions
            </CardTitle>
            <CardDescription>Select campaigns to perform bulk operations</CardDescription>
          </div>
          {selectedIds.length > 0 && (
            <Badge>{selectedIds.length} selected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Select All */}
        <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
          <div className="flex items-center gap-3">
            <Checkbox
              id="select-all"
              checked={selectedIds.length === campaigns.length && campaigns.length > 0}
              onCheckedChange={handleSelectAll}
            />
            <label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
              Select All ({campaigns.length})
            </label>
          </div>
          {selectedIds.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{activeSelected} active</span>
              <span>•</span>
              <span>{pausedSelected} paused</span>
            </div>
          )}
        </div>

        {/* Campaign List */}
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {campaigns.map((campaign) => (
            <div 
              key={campaign.id}
              className={`flex items-center justify-between p-3 border rounded-lg transition-colors ${
                selectedIds.includes(campaign.id) ? "border-primary bg-primary/5" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selectedIds.includes(campaign.id)}
                  onCheckedChange={(checked) => handleSelectOne(campaign.id, checked as boolean)}
                />
                <div>
                  <p className="font-medium text-sm">{campaign.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{campaign.type}</p>
                </div>
              </div>
              <Badge variant={campaign.isActive ? "default" : "secondary"}>
                {campaign.isActive ? "Active" : "Paused"}
              </Badge>
            </div>
          ))}
        </div>

        {/* Batch Action Buttons */}
        {selectedIds.length > 0 && (
          <div className="flex items-center gap-2 pt-4 border-t">
            <Button 
              onClick={handleBatchLaunch}
              disabled={isPending || pausedSelected === 0}
              className="gap-2"
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Launch ({pausedSelected})
            </Button>
            <Button 
              variant="outline"
              onClick={handleBatchPause}
              disabled={isPending || activeSelected === 0}
              className="gap-2"
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              Pause ({activeSelected})
            </Button>
            <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="outline"
                  className="gap-2 text-destructive"
                  disabled={isPending}
                >
                  <Archive className="h-4 w-4" />
                  Archive ({selectedIds.length})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                    Archive {selectedIds.length} Campaign{selectedIds.length > 1 ? "s" : ""}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This will pause all selected campaigns and cancel any active enrollments. 
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction 
                    onClick={handleBatchArchive}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : null}
                    Archive Campaigns
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {campaigns.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No campaigns available for batch actions</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
