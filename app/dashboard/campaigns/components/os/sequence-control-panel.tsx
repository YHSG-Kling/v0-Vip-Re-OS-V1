"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Play,
  Pause,
  Settings,
  Users,
  Mail,
  Clock,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2
} from "lucide-react"
import { 
  launchCampaignSequence, 
  pauseCampaignSequence,
  updateCampaignSequence 
} from "@/app/actions/campaign-sequences"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

interface SequenceStep {
  id: string
  step_number: number
  step_name: string
  channel: string
  delay_days: number
  delay_hours: number
  is_active: boolean
  sent_count: number
  open_count: number
  click_count: number
}

interface SequenceControlPanelProps {
  sequenceId: string
  sequenceName: string
  isActive: boolean
  isAbTest: boolean
  complianceGated: boolean
  enrollmentsTotal: number
  completionsTotal: number
  conversionsTotal: number
  steps: SequenceStep[]
  onRefresh?: () => void
}

export function SequenceControlPanel({
  sequenceId,
  sequenceName,
  isActive,
  isAbTest,
  complianceGated,
  enrollmentsTotal,
  completionsTotal,
  conversionsTotal,
  steps,
  onRefresh,
}: SequenceControlPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [localIsActive, setLocalIsActive] = useState(isActive)
  const [localIsAbTest, setLocalIsAbTest] = useState(isAbTest)

  const handleToggleActive = async () => {
    startTransition(async () => {
      if (localIsActive) {
        const result = await pauseCampaignSequence(sequenceId)
        if (result.success) {
          setLocalIsActive(false)
          toast.success("Sequence paused")
          router.refresh()
        } else {
          toast.error(result.error || "Failed to pause sequence")
        }
      } else {
        const result = await launchCampaignSequence(sequenceId)
        if (result.success) {
          setLocalIsActive(true)
          toast.success("Sequence launched")
          router.refresh()
        } else {
          toast.error(result.error || "Failed to launch sequence")
        }
      }
    })
  }

  const handleToggleAbTest = async () => {
    startTransition(async () => {
      const result = await updateCampaignSequence(sequenceId, { is_ab_test: !localIsAbTest })
      if (result.success) {
        setLocalIsAbTest(!localIsAbTest)
        toast.success(localIsAbTest ? "A/B testing disabled" : "A/B testing enabled")
        router.refresh()
      } else {
        toast.error(result.error || "Failed to update sequence")
      }
    })
  }

  const completionRate = enrollmentsTotal > 0 
    ? Math.round((completionsTotal / enrollmentsTotal) * 100) 
    : 0
  
  const conversionRate = enrollmentsTotal > 0 
    ? Math.round((conversionsTotal / enrollmentsTotal) * 100) 
    : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Sequence Control
            </CardTitle>
            <CardDescription>{sequenceName}</CardDescription>
          </div>
          <Badge variant={localIsActive ? "default" : "secondary"} className="text-sm">
            {localIsActive ? "LIVE" : "PAUSED"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Primary Controls */}
        <div className="flex items-center justify-between p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center gap-3">
            {localIsActive ? (
              <div className="p-2 rounded-full bg-green-500/10">
                <Play className="h-5 w-5 text-green-500" />
              </div>
            ) : (
              <div className="p-2 rounded-full bg-amber-500/10">
                <Pause className="h-5 w-5 text-amber-500" />
              </div>
            )}
            <div>
              <p className="font-medium">Sequence Status</p>
              <p className="text-sm text-muted-foreground">
                {localIsActive ? "Actively enrolling and sending" : "Paused - no new enrollments"}
              </p>
            </div>
          </div>
          <Button 
            variant={localIsActive ? "outline" : "default"}
            onClick={handleToggleActive}
            disabled={isPending}
            className="gap-2"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : localIsActive ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {localIsActive ? "Pause" : "Launch"}
          </Button>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-3 border rounded-lg">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="h-4 w-4" />
              <span className="text-xs">Enrolled</span>
            </div>
            <p className="text-2xl font-bold">{enrollmentsTotal}</p>
          </div>
          <div className="p-3 border rounded-lg">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-xs">Completed</span>
            </div>
            <p className="text-2xl font-bold">{completionsTotal}</p>
            <p className="text-xs text-muted-foreground">{completionRate}% rate</p>
          </div>
          <div className="p-3 border rounded-lg">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs">Conversions</span>
            </div>
            <p className="text-2xl font-bold">{conversionsTotal}</p>
            <p className="text-xs text-muted-foreground">{conversionRate}% rate</p>
          </div>
          <div className="p-3 border rounded-lg">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Mail className="h-4 w-4" />
              <span className="text-xs">Steps</span>
            </div>
            <p className="text-2xl font-bold">{steps.length}</p>
            <p className="text-xs text-muted-foreground">{steps.filter(s => s.is_active).length} active</p>
          </div>
        </div>

        {/* Settings Toggles */}
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 border rounded-lg">
            <div className="flex items-center gap-3">
              <Label htmlFor="ab-test" className="cursor-pointer">
                <span className="font-medium">A/B Testing</span>
                <p className="text-xs text-muted-foreground">Split test subject lines and content</p>
              </Label>
            </div>
            <Switch
              id="ab-test"
              checked={localIsAbTest}
              onCheckedChange={handleToggleAbTest}
              disabled={isPending}
            />
          </div>
          <div className="flex items-center justify-between p-3 border rounded-lg bg-amber-500/5">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <div>
                <span className="font-medium">Compliance Gate</span>
                <p className="text-xs text-muted-foreground">Requires approval before sending</p>
              </div>
            </div>
            <Badge variant="outline" className="text-amber-600">
              {complianceGated ? "Required" : "Disabled"}
            </Badge>
          </div>
        </div>

        {/* Step Summary */}
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Step Performance</h4>
          {steps.slice(0, 5).map((step) => {
            const openRate = step.sent_count > 0 
              ? Math.round((step.open_count / step.sent_count) * 100) 
              : 0
            const clickRate = step.open_count > 0 
              ? Math.round((step.click_count / step.open_count) * 100) 
              : 0

            return (
              <div key={step.id} className="flex items-center justify-between p-2 border rounded text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                    {step.step_number}
                  </span>
                  <span className={!step.is_active ? "text-muted-foreground" : ""}>
                    {step.step_name}
                  </span>
                  {!step.is_active && (
                    <Badge variant="secondary" className="text-xs">Disabled</Badge>
                  )}
                </div>
                <div className="flex items-center gap-4 text-muted-foreground">
                  <span>{step.sent_count} sent</span>
                  <span>{openRate}% open</span>
                  <span>{clickRate}% click</span>
                </div>
              </div>
            )
          })}
          {steps.length > 5 && (
            <p className="text-xs text-muted-foreground text-center">
              +{steps.length - 5} more steps
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
