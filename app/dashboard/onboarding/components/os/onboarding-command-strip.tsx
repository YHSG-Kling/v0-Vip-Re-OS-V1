"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { 
  GraduationCap, 
  Users, 
  Settings, 
  Video,
  CheckSquare,
  FileText,
  Zap,
  Plus,
  ArrowRight,
  BarChart3
} from "lucide-react"

interface OnboardingCommandStripProps {
  brokerageId: string
  isAdmin?: boolean
}

export function OnboardingCommandStrip({ brokerageId, isAdmin = false }: OnboardingCommandStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/50 rounded-lg border">
      {isAdmin && (
        <Link href="/dashboard/onboarding/admin/agents">
          <Button variant="outline" size="sm" className="gap-2">
            <Users className="h-4 w-4" />
            All Agents
          </Button>
        </Link>
      )}
      
      <Link href="/dashboard/onboarding/progress">
        <Button variant="outline" size="sm" className="gap-2">
          <BarChart3 className="h-4 w-4" />
          My Progress
        </Button>
      </Link>
      
      <Link href="/dashboard/onboarding/training">
        <Button variant="outline" size="sm" className="gap-2">
          <Video className="h-4 w-4" />
          Training
        </Button>
      </Link>
      
      <Link href="/dashboard/onboarding/tech-stack">
        <Button variant="outline" size="sm" className="gap-2">
          <Settings className="h-4 w-4" />
          Tech Setup
        </Button>
      </Link>
      
      <Link href="/dashboard/onboarding/license">
        <Button variant="outline" size="sm" className="gap-2">
          <FileText className="h-4 w-4" />
          License
        </Button>
      </Link>
      
      <Link href="/dashboard/onboarding/brand">
        <Button variant="outline" size="sm" className="gap-2">
          <Zap className="h-4 w-4" />
          Brand
        </Button>
      </Link>
      
      <Link href="/academy">
        <Button variant="outline" size="sm" className="gap-2">
          <GraduationCap className="h-4 w-4" />
          Academy
        </Button>
      </Link>
      
      {isAdmin && (
        <>
          <div className="h-6 w-px bg-border mx-1" />
          <Link href="/dashboard/admin/onboarding">
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Manage Onboarding
              <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </>
      )}
    </div>
  )
}
