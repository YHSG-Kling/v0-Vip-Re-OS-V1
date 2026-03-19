"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Rocket,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Play,
  Calendar,
  Mail,
  Video,
  Megaphone
} from "lucide-react"
import Link from "next/link"

interface QueuedItem {
  id: string
  type: "sequence" | "email" | "social" | "video" | "ad"
  name: string
  status: "ready" | "pending_approval" | "scheduled" | "draft"
  scheduledAt?: string
  createdAt: string
}

interface LaunchQueuePanelProps {
  items: QueuedItem[]
  onLaunch?: (id: string) => void
}

const typeIcons = {
  sequence: Mail,
  email: Mail,
  social: Calendar,
  video: Video,
  ad: Megaphone,
}

const statusConfig = {
  ready: { label: "Ready to Launch", color: "green", icon: CheckCircle2 },
  pending_approval: { label: "Pending Approval", color: "amber", icon: Clock },
  scheduled: { label: "Scheduled", color: "blue", icon: Calendar },
  draft: { label: "Draft", color: "muted", icon: AlertTriangle },
}

export function LaunchQueuePanel({ items, onLaunch }: LaunchQueuePanelProps) {
  const readyItems = items.filter(i => i.status === "ready")
  const pendingItems = items.filter(i => i.status === "pending_approval")
  const scheduledItems = items.filter(i => i.status === "scheduled")

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              Launch Queue
            </CardTitle>
            <CardDescription>Campaigns ready to go live</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {readyItems.length > 0 && (
              <Badge className="bg-green-500">{readyItems.length} ready</Badge>
            )}
            {pendingItems.length > 0 && (
              <Badge variant="outline" className="text-amber-600 border-amber-600">
                {pendingItems.length} pending
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.length === 0 ? (
          <div className="text-center py-8">
            <Rocket className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No campaigns in queue</p>
            <Link href="/dashboard/campaigns/sequences?action=create">
              <Button variant="outline" className="mt-4">Create Campaign</Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const TypeIcon = typeIcons[item.type]
              const status = statusConfig[item.status]
              const StatusIcon = status.icon

              return (
                <div 
                  key={item.id} 
                  className="flex items-center justify-between p-3 border rounded-lg hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-${status.color}-500/10`}>
                      <TypeIcon className={`h-4 w-4 text-${status.color}-500`} />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{item.name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <StatusIcon className="h-3 w-3" />
                        <span>{status.label}</span>
                        {item.scheduledAt && (
                          <span>• {new Date(item.scheduledAt).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.status === "ready" && onLaunch && (
                      <Button size="sm" onClick={() => onLaunch(item.id)} className="gap-2">
                        <Play className="h-3 w-3" />
                        Launch
                      </Button>
                    )}
                    {item.status === "pending_approval" && (
                      <Link href="/approvals">
                        <Button size="sm" variant="outline">
                          Review
                        </Button>
                      </Link>
                    )}
                    {item.status === "scheduled" && (
                      <Badge variant="outline">
                        {new Date(item.scheduledAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Badge>
                    )}
                    {item.status === "draft" && (
                      <Button size="sm" variant="ghost">
                        Edit
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-2 pt-4 border-t">
          <div className="text-center p-2">
            <p className="text-lg font-bold text-green-600">{readyItems.length}</p>
            <p className="text-xs text-muted-foreground">Ready</p>
          </div>
          <div className="text-center p-2">
            <p className="text-lg font-bold text-amber-600">{pendingItems.length}</p>
            <p className="text-xs text-muted-foreground">Pending</p>
          </div>
          <div className="text-center p-2">
            <p className="text-lg font-bold text-blue-600">{scheduledItems.length}</p>
            <p className="text-xs text-muted-foreground">Scheduled</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
