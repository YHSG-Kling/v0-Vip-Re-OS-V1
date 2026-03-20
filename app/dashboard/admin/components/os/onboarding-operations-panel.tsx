"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ActionConfirmSheet } from "@/app/components/action-framework/action-confirm-sheet"
import { sendOnboardingReminder } from "@/app/actions/onboarding/progress"
import {
  UserPlus,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Bell,
  ExternalLink,
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface OnboardingOperationsPanelProps {
  brokerageId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats?: any
}

interface OnboardingRecord {
  id: string
  agent_id: string
  status: string
  completion_percentage: number
  current_day: number
  updated_at: string
  agentName?: string
}

export function OnboardingOperationsPanel({ brokerageId }: OnboardingOperationsPanelProps) {
  const [records, setRecords] = useState<OnboardingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [reminderTarget, setReminderTarget] = useState<OnboardingRecord | null>(null)
  const [isPending, startTransition] = useTransition()
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  useEffect(() => {
    async function loadOnboarding() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()

      const { data: onboarding } = await supabase
        .from("agent_onboarding")
        .select(`
          id,
          agent_id,
          status,
          completion_percentage,
          current_day,
          updated_at
        `)
        .eq("brokerage_id", brokerageId)
        .in("status", ["pending", "in_progress"])
        .order("updated_at", { ascending: false })
        .limit(5)

      if (onboarding && onboarding.length > 0) {
        // Fetch agent names
        const agentIds = onboarding.map((o) => o.agent_id).filter(Boolean)
        const { data: agents } = await supabase
          .from("agents")
          .select("id, user_id")
          .in("id", agentIds)

        const userIds = (agents || []).map((a) => a.user_id).filter(Boolean)
        const { data: users } = await supabase
          .from("users")
          .select("id, first_name, last_name")
          .in("id", userIds)

        const userMap = new Map((users || []).map((u) => [u.id, `${u.first_name || ""} ${u.last_name || ""}`.trim()]))
        const agentUserMap = new Map((agents || []).map((a) => [a.id, a.user_id]))

        setRecords(
          onboarding.map((o) => ({
            ...o,
            agentName: userMap.get(agentUserMap.get(o.agent_id) || "") || "Unknown Agent",
          }))
        )
      } else {
        setRecords([])
      }

      setLoading(false)
    }

    loadOnboarding()
  }, [brokerageId])

  const stuckRecords = records.filter((r) => {
    const lastUpdate = new Date(r.updated_at)
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    return lastUpdate < weekAgo && (r.completion_percentage || 0) < 100
  })

  async function handleSendReminder(record: OnboardingRecord) {
    const result = await sendOnboardingReminder(record.agent_id)
    if (result.success) {
      setToastMsg(`Reminder sent to ${record.agentName}`)
    } else {
      setToastMsg(`Failed: ${result.error || "Unknown error"}`)
    }
    setTimeout(() => setToastMsg(null), 3000)
  }

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <UserPlus className="h-4 w-4 text-blue-600" />
              Onboarding Operations
            </CardTitle>
            <Badge variant="outline" className="text-xs">
              {records.length} Active
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {toastMsg && (
            <div className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded p-2">
              {toastMsg}
            </div>
          )}

          {records.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
              <p className="text-sm">No active onboarding</p>
            </div>
          ) : (
            <>
              {records.map((record) => {
                const isStuck = stuckRecords.includes(record)
                const progress = record.completion_percentage || 0

                return (
                  <div
                    key={record.id}
                    className={`p-3 rounded-lg border ${isStuck ? "border-amber-300 bg-amber-50/50" : "border-border bg-muted/30"}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{record.agentName}</span>
                        {isStuck && (
                          <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Stuck
                          </Badge>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs">
                        Day {record.current_day || 1}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <Progress value={progress} className="flex-1 h-2" />
                      <span className="text-xs text-muted-foreground w-10">{progress}%</span>
                    </div>
                    {/* Fast-action row — only for stuck or in-progress */}
                    <div className="flex items-center gap-1 flex-wrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setReminderTarget(record)}
                      >
                        <Bell className="h-3 w-3 mr-1" />
                        Send Reminder
                      </Button>
                      <Link href={`/dashboard/admin/onboarding/${record.agent_id}`}>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Mark Step Complete
                        </Button>
                      </Link>
                      <Link href={`/dashboard/admin/onboarding/${record.agent_id}`}>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          View Record
                        </Button>
                      </Link>
                    </div>
                  </div>
                )
              })}

              <Link href="/dashboard/admin/onboarding">
                <Button variant="outline" size="sm" className="w-full mt-2">
                  View All Onboarding
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </Link>
            </>
          )}
        </CardContent>
      </Card>

      {/* Reminder confirm sheet */}
      {reminderTarget && (
        <ActionConfirmSheet
          open={!!reminderTarget}
          onOpenChange={(open) => !open && setReminderTarget(null)}
          title={`Send reminder to ${reminderTarget.agentName}?`}
          description={`This will send an onboarding reminder to ${reminderTarget.agentName} (Day ${reminderTarget.current_day || 1}, ${reminderTarget.completion_percentage || 0}% complete).`}
          actionLabel="Send Reminder"
          confirmingLabel="Sending..."
          onConfirm={() => handleSendReminder(reminderTarget)}
        />
      )}
    </>
  )
}
