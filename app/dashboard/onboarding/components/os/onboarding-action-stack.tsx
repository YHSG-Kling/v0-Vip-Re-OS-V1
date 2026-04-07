"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import Link from "next/link"
import { 
  Play, 
  CheckSquare, 
  UserPlus, 
  Video, 
  Settings, 
  AlertTriangle,
  FileText,
  Loader2,
  ArrowRight
} from "lucide-react"

interface PendingAction {
  id: string
  actionType: 'resume_setup' | 'complete_step' | 'assign_task' | 'open_training' | 'verify_provider' | 'review_blocker' | 'open_record'
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  targetId?: string
  targetType?: string
}

interface OnboardingActionStackProps {
  actions: PendingAction[]
  onActionComplete?: (actionId: string) => void
}

const actionConfig = {
  resume_setup: {
    icon: Play,
    color: "text-blue-500",
    href: (action: PendingAction) => "/dashboard/onboarding",
  },
  complete_step: {
    icon: CheckSquare,
    color: "text-green-500",
    href: (action: PendingAction) => `/dashboard/onboarding`,
  },
  assign_task: {
    icon: UserPlus,
    color: "text-purple-500",
    href: (action: PendingAction) => `/dashboard/onboarding/admin/agents/${action.targetId}`,
  },
  open_training: {
    icon: Video,
    color: "text-orange-500",
    href: (action: PendingAction) => `/dashboard/onboarding/training`,
  },
  verify_provider: {
    icon: Settings,
    color: "text-indigo-500",
    href: (action: PendingAction) => `/dashboard/onboarding/tech-stack`,
  },
  review_blocker: {
    icon: AlertTriangle,
    color: "text-red-500",
    href: (action: PendingAction) => `/dashboard/onboarding/admin/agents/${action.targetId}`,
  },
  open_record: {
    icon: FileText,
    color: "text-gray-500",
    href: (action: PendingAction) => `/dashboard/onboarding/admin/agents/${action.targetId}`,
  },
}

const priorityColors = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low: "bg-gray-100 text-gray-700 border-gray-200",
}

export function OnboardingActionStack({ actions, onActionComplete }: OnboardingActionStackProps) {
  const [processing, setProcessing] = useState<string | null>(null)

  const handleAction = async (action: PendingAction) => {
    setProcessing(action.id)
    try {
      // Simulate action processing
      await new Promise(resolve => setTimeout(resolve, 500))
      onActionComplete?.(action.id)
      toast.success(`Action completed: ${action.title}`)
    } catch (error) {
      toast.error("Failed to complete action")
    } finally {
      setProcessing(null)
    }
  }

  if (actions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckSquare className="h-4 w-4" />
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <CheckSquare className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p className="text-sm">All caught up! No pending actions.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CheckSquare className="h-4 w-4" />
          Quick Actions
          <Badge variant="secondary" className="ml-auto">{actions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {actions.slice(0, 5).map((action) => {
          const config = actionConfig[action.actionType]
          const Icon = config.icon
          const href = config.href(action)
          
          return (
            <div 
              key={action.id}
              className={`flex items-center gap-3 p-2 rounded-lg border ${priorityColors[action.priority]}`}
            >
              <Icon className={`h-4 w-4 ${config.color} shrink-0`} />
              
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{action.title}</p>
                <p className="text-xs text-muted-foreground truncate">{action.description}</p>
              </div>
              
              <Link href={href}>
                <Button 
                  size="sm" 
                  variant="outline"
                  disabled={processing === action.id}
                  className="shrink-0"
                >
                  {processing === action.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      Go <ArrowRight className="h-3 w-3 ml-1" />
                    </>
                  )}
                </Button>
              </Link>
            </div>
          )
        })}
        
        {actions.length > 5 && (
          <p className="text-xs text-center text-muted-foreground pt-2">
            +{actions.length - 5} more actions
          </p>
        )}
      </CardContent>
    </Card>
  )
}
