"use client"

import { useState, useTransition } from "react"
import { RefreshCw, Home, MessageSquare, Loader2, ChevronRight, Users, Flame, Snowflake, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { aiGenerateTouchpoint } from "@/app/actions/ai-sphere-management"
import Link from "next/link"

interface Anniversary {
  contactId: string
  contactName: string
  address: string
  yearsCount: number
  closeDate: string
}

interface SphereSegment {
  champions: number
  engaged: number
  cooling: number
  atRisk: number
}

interface RepeatBusinessPanelProps {
  agentId: string
  upcomingAnniversaries: Anniversary[]
  sphereSegments?: SphereSegment | null
}

export function RepeatBusinessPanel({
  agentId,
  upcomingAnniversaries,
  sphereSegments,
}: RepeatBusinessPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [selectedAnniversary, setSelectedAnniversary] = useState<Anniversary | null>(null)
  const [draftMessage, setDraftMessage] = useState<string>("")
  const [dialogOpen, setDialogOpen] = useState(false)

  const handleGenerateMessage = (anniversary: Anniversary) => {
    setSelectedAnniversary(anniversary)
    setDraftMessage("")
    setDialogOpen(true)

    startTransition(async () => {
      const result = await aiGenerateTouchpoint({
        agentId,
        contactId: anniversary.contactId,
        touchpointType: "anniversary",
      })
      if (result.success && result.message) {
        setDraftMessage(result.message)
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <RefreshCw className="h-5 w-5" />
          Repeat Business Opportunities
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Anniversary Strip */}
        <div>
          <h4 className="text-sm font-medium mb-2">Upcoming Home Anniversaries</h4>
          <ScrollArea className="w-full">
            <div className="flex gap-3 pb-2">
              {upcomingAnniversaries.slice(0, 5).map((anniversary) => (
                <div
                  key={anniversary.contactId}
                  className="flex-shrink-0 w-[220px] p-3 rounded-lg border bg-muted/30"
                >
                  <div className="flex items-start gap-2">
                    <Home className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {anniversary.contactName}&apos;s {anniversary.yearsCount}-Year Anniversary
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{anniversary.address}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(anniversary.closeDate).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-2"
                    onClick={() => handleGenerateMessage(anniversary)}
                    disabled={isPending}
                  >
                    <MessageSquare className="h-3 w-3 mr-1" />
                    Generate Message
                  </Button>
                </div>
              ))}
              {upcomingAnniversaries.length === 0 && (
                <p className="text-sm text-muted-foreground py-4">No upcoming anniversaries</p>
              )}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>

        {/* Sphere Segments */}
        {sphereSegments && (
          <div>
            <h4 className="text-sm font-medium mb-2">Sphere Health</h4>
            <div className="grid grid-cols-4 gap-2">
              <div className="flex flex-col items-center p-2 rounded-lg border bg-emerald-50">
                <Users className="h-4 w-4 text-emerald-600 mb-1" />
                <span className="text-lg font-bold text-emerald-700">{sphereSegments.champions}</span>
                <span className="text-xs text-emerald-600">Champions</span>
              </div>
              <div className="flex flex-col items-center p-2 rounded-lg border bg-blue-50">
                <Flame className="h-4 w-4 text-blue-600 mb-1" />
                <span className="text-lg font-bold text-blue-700">{sphereSegments.engaged}</span>
                <span className="text-xs text-blue-600">Engaged</span>
              </div>
              <div className="flex flex-col items-center p-2 rounded-lg border bg-amber-50">
                <Snowflake className="h-4 w-4 text-amber-600 mb-1" />
                <span className="text-lg font-bold text-amber-700">{sphereSegments.cooling}</span>
                <span className="text-xs text-amber-600">Cooling</span>
              </div>
              <div className="flex flex-col items-center p-2 rounded-lg border bg-red-50">
                <AlertTriangle className="h-4 w-4 text-red-600 mb-1" />
                <span className="text-lg font-bold text-red-700">{sphereSegments.atRisk}</span>
                <span className="text-xs text-red-600">At Risk</span>
              </div>
            </div>
            <Link href="/past-clients" className="flex items-center justify-center gap-1 text-sm text-primary mt-3 hover:underline">
              View Full Sphere <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        )}
      </CardContent>

      {/* Draft Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Anniversary Message for {selectedAnniversary?.contactName}
            </DialogTitle>
          </DialogHeader>
          {isPending ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              <Textarea
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                rows={6}
                className="font-mono text-sm"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(draftMessage)}
                >
                  Copy
                </Button>
                <Button size="sm">Send</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
