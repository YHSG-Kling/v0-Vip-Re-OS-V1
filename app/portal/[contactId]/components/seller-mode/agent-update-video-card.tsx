"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Video, MessageSquare, Play, ArrowRight, Clock } from "lucide-react"

interface AgentUpdateVideoCardProps {
  contactId: string
  latestUpdate?: {
    id: string
    title: string
    videoUrl?: string | null
    thumbnailUrl?: string | null
    // Nullable because seller_updates.created_at is: the badge below renders
    // NOTHING rather than `new Date(null)`, which prints "Invalid Date" to a
    // client on their own portal.
    createdAt: string | null
    summary?: string | null
  } | null
  agentName?: string | null
}

export function AgentUpdateVideoCard({ contactId, latestUpdate, agentName }: AgentUpdateVideoCardProps) {
  const hasVideo = latestUpdate?.videoUrl

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Video className="h-4 w-4" />
            Agent Updates
          </CardTitle>
          {latestUpdate?.createdAt && (
            <Badge variant="outline" className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {new Date(latestUpdate.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {latestUpdate ? (
          <>
            {/* Video Thumbnail or Placeholder */}
            {hasVideo ? (
              <div className="relative aspect-video rounded-lg overflow-hidden bg-slate-900">
                {latestUpdate.thumbnailUrl ? (
                  <img
                    src={latestUpdate.thumbnailUrl}
                    alt="Update video thumbnail"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center">
                    <Video className="h-12 w-12 text-white/50" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors cursor-pointer">
                  <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                    <Play className="h-6 w-6 text-blue-600 ml-1" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-muted/50 border">
                <p className="text-sm font-medium">{latestUpdate.title}</p>
                {latestUpdate.summary && (
                  <p className="text-sm text-muted-foreground mt-2 line-clamp-3">{latestUpdate.summary}</p>
                )}
              </div>
            )}

            {/* Update Info */}
            <div>
              <p className="text-sm font-medium">{latestUpdate.title}</p>
              {agentName && (
                <p className="text-xs text-muted-foreground">From {agentName}</p>
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-6">
            <Video className="h-10 w-10 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No updates yet. Your agent will share video updates and summaries here.
            </p>
          </div>
        )}

        {/* CTAs */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild className="flex-1">
            <Link href={`/portal/${contactId}/messages`}>
              <MessageSquare className="h-4 w-4 mr-2" />
              Message Agent
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild className="flex-1">
            <Link href={`/portal/${contactId}/team`}>
              <ArrowRight className="h-4 w-4 mr-2" />
              View Team
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
