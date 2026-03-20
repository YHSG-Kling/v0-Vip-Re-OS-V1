"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { 
  Mail, 
  MessageSquare, 
  Phone, 
  Plus, 
  Send, 
  Inbox, 
  Users,
  Zap,
  FileText,
  ChevronDown,
  Search,
  Filter,
  Bell,
  Settings
} from "lucide-react"

interface CommunicationsCommandStripProps {
  onComposeEmail?: () => void
  onComposeSms?: () => void
  onStartCall?: () => void
  onQuickReply?: () => void
  unreadCount?: number
  urgentCount?: number
}

export function CommunicationsCommandStrip({
  onComposeEmail,
  onComposeSms,
  onStartCall,
  onQuickReply,
  unreadCount = 0,
  urgentCount = 0,
}: CommunicationsCommandStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/30 border rounded-lg">
      {/* Primary Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="gap-2">
            <Plus className="h-4 w-4" />
            New Message
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onComposeEmail}>
            <Mail className="h-4 w-4 mr-2" />
            Compose Email
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onComposeSms}>
            <MessageSquare className="h-4 w-4 mr-2" />
            Send SMS
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onStartCall}>
            <Phone className="h-4 w-4 mr-2" />
            Start Call
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" className="gap-2" onClick={onQuickReply}>
        <Zap className="h-4 w-4" />
        Quick Reply
      </Button>

      {/* Navigation Links */}
      <div className="flex items-center gap-1 ml-auto">
        <Link href="/dashboard/communications/inbox">
          <Button variant="ghost" size="sm" className="gap-2">
            <Inbox className="h-4 w-4" />
            Inbox
            {unreadCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-full">
                {unreadCount}
              </span>
            )}
          </Button>
        </Link>
        
        <Link href="/dashboard/communications/outreach">
          <Button variant="ghost" size="sm" className="gap-2">
            <Send className="h-4 w-4" />
            Outreach
          </Button>
        </Link>

        <Link href="/dashboard/communications/sequences">
          <Button variant="ghost" size="sm" className="gap-2">
            <Users className="h-4 w-4" />
            Sequences
          </Button>
        </Link>

        <Link href="/dashboard/communications/intelligence">
          <Button variant="ghost" size="sm" className="gap-2">
            <Zap className="h-4 w-4" />
            Intelligence
          </Button>
        </Link>

        <Link href="/dashboard/communications/inbox">
          <Button variant="ghost" size="sm" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            AI Chat
          </Button>
        </Link>
      </div>

      {/* Urgent Indicator */}
      {urgentCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 bg-destructive/10 text-destructive rounded-md text-sm font-medium">
          <Bell className="h-4 w-4" />
          {urgentCount} urgent
        </div>
      )}
    </div>
  )
}
