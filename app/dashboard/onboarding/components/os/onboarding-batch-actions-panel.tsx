"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
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
import { toast } from "sonner"
import { 
  Users, 
  Bell,
  Mail,
  RefreshCw,
  Loader2,
  CheckSquare
} from "lucide-react"

interface AgentForBatch {
  id: string
  name: string
  email: string
  completionPct: number
  daysSinceLastActivity: number
}

interface OnboardingBatchActionsPanelProps {
  agents: AgentForBatch[]
  onNudge?: (agentIds: string[]) => Promise<void>
  onResetProgress?: (agentIds: string[]) => Promise<void>
}

export function OnboardingBatchActionsPanel({ 
  agents, 
  onNudge,
  onResetProgress 
}: OnboardingBatchActionsPanelProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [processing, setProcessing] = useState<string | null>(null)

  const toggleSelection = (id: string) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  const selectAll = () => {
    if (selectedIds.size === agents.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(agents.map(a => a.id)))
    }
  }

  const handleNudge = async () => {
    if (selectedIds.size === 0) return
    setProcessing('nudge')
    try {
      await onNudge?.(Array.from(selectedIds))
      toast.success(`Sent nudge to ${selectedIds.size} agent(s)`)
      setSelectedIds(new Set())
    } catch (error) {
      toast.error("Failed to send nudges")
    } finally {
      setProcessing(null)
    }
  }

  const handleReset = async () => {
    if (selectedIds.size === 0) return
    setProcessing('reset')
    try {
      await onResetProgress?.(Array.from(selectedIds))
      toast.success(`Reset progress for ${selectedIds.size} agent(s)`)
      setSelectedIds(new Set())
    } catch (error) {
      toast.error("Failed to reset progress")
    } finally {
      setProcessing(null)
    }
  }

  if (agents.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Batch Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-sm">No agents require attention</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Users className="h-4 w-4" />
          Batch Actions
          {selectedIds.size > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {selectedIds.size} selected
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Select All */}
        <div className="flex items-center gap-2 pb-2 border-b">
          <Checkbox 
            checked={selectedIds.size === agents.length}
            onCheckedChange={selectAll}
          />
          <span className="text-sm text-muted-foreground">Select All</span>
        </div>

        {/* Agent List */}
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {agents.map((agent) => (
            <div 
              key={agent.id}
              className="flex items-center gap-3 p-2 rounded-lg border bg-card hover:bg-muted/50"
            >
              <Checkbox 
                checked={selectedIds.has(agent.id)}
                onCheckedChange={() => toggleSelection(agent.id)}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{agent.name}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{agent.completionPct}% complete</span>
                  <span>|</span>
                  <span>{agent.daysSinceLastActivity}d inactive</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2 border-t">
          <Button 
            size="sm" 
            variant="outline"
            className="flex-1 gap-2"
            disabled={selectedIds.size === 0 || processing !== null}
            onClick={handleNudge}
          >
            {processing === 'nudge' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            Nudge
          </Button>
          
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button 
                size="sm" 
                variant="outline"
                className="flex-1 gap-2"
                disabled={selectedIds.size === 0 || processing !== null}
              >
                {processing === 'reset' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Reset
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset Onboarding Progress?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will reset the onboarding progress for {selectedIds.size} selected agent(s). 
                  They will need to start their onboarding from the beginning.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleReset}>
                  Reset Progress
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
