"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCw, RotateCcw, Activity } from "lucide-react"
import { toast } from "sonner"
import { orchestrateEventById } from "@/app/actions/orchestrator"
import { createClient } from "@/lib/supabase/client"

interface LifecycleEvent {
  id: string
  event_type: string
  entity_type?: string
  entity_id?: string
  status: string
  created_at: string
  processed_at?: string
}

const STATUS_COLORS: Record<string, string> = {
  processed: "bg-green-100 text-green-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
}

export default function OrchestratorEventsPage() {
  const [events, setEvents] = useState<LifecycleEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  const loadEvents = async () => {
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("lifecycle_events")
        .select("id, event_type, entity_type, entity_id, status, created_at, processed_at")
        .order("created_at", { ascending: false })
        .limit(100)
      setEvents(data ?? [])
    } catch (error) {
      console.error("Failed to load events:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadEvents() }, [])

  const handleReplay = (eventId: string) => {
    startTransition(async () => {
      const result = await orchestrateEventById(eventId)
      if ((result as any)?.success !== false) {
        toast.success("Event replayed")
        await loadEvents()
      } else {
        toast.error("Replay failed")
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Automation Event Log</h1>
          <p className="text-muted-foreground text-sm mt-1">Lifecycle events processed by the orchestrator</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); loadEvents() }} disabled={isPending}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Recent Events ({events.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No events found</p>
          ) : (
            <div className="divide-y max-h-[600px] overflow-y-auto">
              {events.map(event => (
                <div key={event.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-medium">{event.event_type}</p>
                      <Badge className={`text-xs ${STATUS_COLORS[event.status] ?? "bg-gray-100 text-gray-700"}`}>
                        {event.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {event.entity_type && `${event.entity_type}: `}
                      {event.entity_id ?? event.id}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(event.created_at).toLocaleString()}
                      {event.processed_at && ` → processed ${new Date(event.processed_at).toLocaleString()}`}
                    </p>
                  </div>
                  {event.status === "failed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleReplay(event.id)}
                      disabled={isPending}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      Replay
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
