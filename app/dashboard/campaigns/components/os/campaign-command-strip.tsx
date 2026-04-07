"use client"

import { Button } from "@/components/ui/button"
import { 
  Plus, 
  Play, 
  Pause, 
  Copy, 
  Archive, 
  Send, 
  Calendar, 
  RefreshCw,
  Megaphone,
  Mail,
  Video,
  FileText,
  BarChart3,
  CheckCircle2
} from "lucide-react"
import Link from "next/link"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface CampaignCommandStripProps {
  onBatchPause?: () => void
  onBatchLaunch?: () => void
  onBatchArchive?: () => void
  selectedCount?: number
  isLoading?: boolean
}

export function CampaignCommandStrip({
  onBatchPause,
  onBatchLaunch,
  onBatchArchive,
  selectedCount = 0,
  isLoading = false,
}: CampaignCommandStripProps) {
  return (
    <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30 overflow-x-auto">
      {/* Primary Create Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            Create Campaign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem asChild>
            <Link href="/dashboard/campaigns/sequences?action=create" className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Drip Sequence
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/campaigns/ads?action=create" className="flex items-center gap-2">
              <Megaphone className="h-4 w-4" />
              Ad Campaign
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/social?action=create" className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Social Post
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard/videos/create" className="flex items-center gap-2">
              <Video className="h-4 w-4" />
              Video Content
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/campaigns/mail" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Direct Mail
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Quick Nav Links */}
      <Link href="/dashboard/campaigns/sequences">
        <Button variant="outline" size="sm" className="gap-2">
          <Mail className="h-4 w-4" />
          Sequences
        </Button>
      </Link>
      <Link href="/dashboard/campaigns/ads">
        <Button variant="outline" size="sm" className="gap-2">
          <Megaphone className="h-4 w-4" />
          Ads
        </Button>
      </Link>
      <Link href="/dashboard/social">
        <Button variant="outline" size="sm" className="gap-2">
          <Calendar className="h-4 w-4" />
          Social
        </Button>
      </Link>
      <Link href="/dashboard/campaigns/repurpose">
        <Button variant="outline" size="sm" className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Repurpose
        </Button>
      </Link>
      <Link href="/dashboard/campaigns/roi">
        <Button variant="outline" size="sm" className="gap-2">
          <BarChart3 className="h-4 w-4" />
          ROI
        </Button>
      </Link>

      <div className="flex-1" />

      {/* Batch Actions (when items selected) */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {selectedCount} selected
          </span>
          <Button 
            variant="outline" 
            size="sm" 
            className="gap-2"
            onClick={onBatchLaunch}
            disabled={isLoading}
          >
            <Play className="h-4 w-4" />
            Launch All
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            className="gap-2"
            onClick={onBatchPause}
            disabled={isLoading}
          >
            <Pause className="h-4 w-4" />
            Pause All
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            className="gap-2 text-destructive"
            onClick={onBatchArchive}
            disabled={isLoading}
          >
            <Archive className="h-4 w-4" />
            Archive
          </Button>
        </div>
      )}

      {/* Approvals Queue Link */}
      <Link href="/approvals">
        <Button variant="ghost" size="sm" className="gap-2 text-amber-600">
          <CheckCircle2 className="h-4 w-4" />
          Approvals
        </Button>
      </Link>
    </div>
  )
}
