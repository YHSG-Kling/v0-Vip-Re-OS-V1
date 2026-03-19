import { Button } from '@/components/ui/button'
import { Plus, FileText, Users, Zap } from 'lucide-react'
import Link from 'next/link'

interface OnboardingCommandStripProps {
  brokerageId: string
  userId: string
}

export function OnboardingCommandStrip({ brokerageId, userId }: OnboardingCommandStripProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/dashboard/onboarding/progress">
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          View All Agents
        </Button>
      </Link>
      <Link href="/dashboard/admin/onboarding/reports">
        <Button variant="outline" className="gap-2">
          <FileText className="h-4 w-4" />
          Onboarding Reports
        </Button>
      </Link>
      <Link href="/dashboard/admin/onboarding/assignments">
        <Button variant="outline" className="gap-2">
          <Users className="h-4 w-4" />
          Manage Assignments
        </Button>
      </Link>
      <Link href="/dashboard/admin/settings/training">
        <Button variant="outline" className="gap-2">
          <Zap className="h-4 w-4" />
          Training Settings
        </Button>
      </Link>
    </div>
  )
}
