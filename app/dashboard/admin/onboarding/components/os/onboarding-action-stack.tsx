import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Send, Zap } from 'lucide-react'

interface OnboardingActionStackProps {
  brokerageId: string
  userId: string
  stallCount: number
}

export function OnboardingActionStack({ brokerageId, userId, stallCount }: OnboardingActionStackProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
        <CardDescription>Common onboarding operations</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {stallCount > 0 && (
          <Button variant="outline" className="w-full justify-start gap-2 h-auto py-3">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <div className="text-left">
              <div className="font-medium">{stallCount} Stalled Agents</div>
              <div className="text-xs text-muted-foreground">Need intervention</div>
            </div>
          </Button>
        )}
        <Button className="w-full justify-start gap-2">
          <Send className="h-4 w-4" />
          Send Batch Reminders
        </Button>
        <Button variant="outline" className="w-full justify-start gap-2">
          <Zap className="h-4 w-4" />
          Create Training Campaign
        </Button>
      </CardContent>
    </Card>
  )
}
