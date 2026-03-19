"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Play,
  Pause,
  Copy,
  Archive,
  Send,
  Calendar,
  MoreVertical,
  Mail,
  Users,
  TrendingUp,
  Eye,
  Loader2,
  ExternalLink
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { 
  launchCampaignSequence, 
  pauseCampaignSequence, 
  duplicateCampaignSequence,
  archiveCampaignSequence 
} from "@/app/actions/campaign-sequences"
import { toast } from "sonner"
import Link from "next/link"
import { useRouter } from "next/navigation"

interface CampaignSequence {
  id: string
  name: string
  description: string | null
  sequence_type: string
  is_active: boolean
  enrollments_total: number
  completions_total: number
  conversions_total: number
}

interface CampaignActionStackProps {
  sequences: CampaignSequence[]
  brokerageId: string
  onSelect?: (id: string, selected: boolean) => void
  selectedIds?: string[]
}

export function CampaignActionStack({ 
  sequences, 
  brokerageId,
  onSelect,
  selectedIds = []
}: CampaignActionStackProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const handleLaunch = async (sequenceId: string) => {
    setLoadingId(sequenceId)
    startTransition(async () => {
      const result = await launchCampaignSequence(sequenceId)
      if (result.success) {
        toast.success("Campaign launched successfully")
        router.refresh()
      } else {
        toast.error(result.error || "Failed to launch campaign")
      }
      setLoadingId(null)
    })
  }

  const handlePause = async (sequenceId: string) => {
    setLoadingId(sequenceId)
    startTransition(async () => {
      const result = await pauseCampaignSequence(sequenceId)
      if (result.success) {
        toast.success("Campaign paused")
        router.refresh()
      } else {
        toast.error(result.error || "Failed to pause campaign")
      }
      setLoadingId(null)
    })
  }

  const handleDuplicate = async (sequenceId: string) => {
    setLoadingId(sequenceId)
    startTransition(async () => {
      const result = await duplicateCampaignSequence(sequenceId, brokerageId)
      if (result.sequence) {
        toast.success("Campaign duplicated")
        router.refresh()
      } else {
        toast.error(result.error || "Failed to duplicate campaign")
      }
      setLoadingId(null)
    })
  }

  const handleArchive = async (sequenceId: string) => {
    setLoadingId(sequenceId)
    startTransition(async () => {
      const result = await archiveCampaignSequence(sequenceId)
      if (result.success) {
        toast.success("Campaign archived")
        router.refresh()
      } else {
        toast.error(result.error || "Failed to archive campaign")
      }
      setLoadingId(null)
    })
  }

  if (sequences.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Mail className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-semibold text-lg mb-2">No Active Campaigns</h3>
          <p className="text-muted-foreground mb-4">Create your first drip campaign to start automating outreach</p>
          <Link href="/dashboard/campaigns/sequences?action=create">
            <Button>Create Campaign</Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign Action Stack</CardTitle>
        <CardDescription>Manage and control your active campaigns</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sequences.map((seq) => {
          const isLoading = loadingId === seq.id
          const isSelected = selectedIds.includes(seq.id)
          
          return (
            <div 
              key={seq.id} 
              className={`flex items-center justify-between p-4 border rounded-lg transition-colors ${
                isSelected ? "border-primary bg-primary/5" : "hover:border-primary/50"
              }`}
            >
              <div className="flex items-center gap-4">
                {onSelect && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => onSelect(seq.id, e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <Link 
                      href={`/dashboard/campaigns/sequences/${seq.id}`}
                      className="font-medium hover:underline"
                    >
                      {seq.name}
                    </Link>
                    <Badge variant={seq.is_active ? "default" : "secondary"}>
                      {seq.is_active ? "Active" : "Paused"}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {seq.sequence_type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {seq.enrollments_total} enrolled
                    </span>
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" />
                      {seq.conversions_total} conversions
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Primary Action */}
                {seq.is_active ? (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => handlePause(seq.id)}
                    disabled={isLoading}
                    className="gap-2"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                    Pause
                  </Button>
                ) : (
                  <Button 
                    size="sm" 
                    onClick={() => handleLaunch(seq.id)}
                    disabled={isLoading}
                    className="gap-2"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Launch
                  </Button>
                )}

                {/* More Actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/dashboard/campaigns/sequences/${seq.id}`} className="flex items-center gap-2">
                        <ExternalLink className="h-4 w-4" />
                        Open Sequence
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDuplicate(seq.id)} disabled={isLoading}>
                      <Copy className="h-4 w-4 mr-2" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem 
                      onClick={() => handleArchive(seq.id)} 
                      disabled={isLoading}
                      className="text-destructive"
                    >
                      <Archive className="h-4 w-4 mr-2" />
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
