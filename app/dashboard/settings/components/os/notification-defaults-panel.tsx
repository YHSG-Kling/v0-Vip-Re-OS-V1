"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Bell,
  Mail,
  MessageSquare,
  ExternalLink 
} from "lucide-react"

interface NotificationSettings {
  emailEnabled: boolean
  smsEnabled: boolean
  pushEnabled: boolean
  activeRulesCount: number
  totalRulesCount: number
}

interface NotificationDefaultsPanelProps {
  settings: NotificationSettings
}

export function NotificationDefaultsPanel({ settings }: NotificationDefaultsPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notification Defaults
          </CardTitle>
          <Link href="/settings/notifications">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              Configure <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Channel Status */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Email</span>
            </div>
            <Badge variant={settings.emailEnabled ? "default" : "secondary"} className="text-xs">
              {settings.emailEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">SMS</span>
            </div>
            <Badge variant={settings.smsEnabled ? "default" : "secondary"} className="text-xs">
              {settings.smsEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Push</span>
            </div>
            <Badge variant={settings.pushEnabled ? "default" : "secondary"} className="text-xs">
              {settings.pushEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </div>

        {/* Rules Summary */}
        <div className="pt-2 border-t">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Notification Rules</span>
            <span className="font-medium">
              {settings.activeRulesCount} / {settings.totalRulesCount} active
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
