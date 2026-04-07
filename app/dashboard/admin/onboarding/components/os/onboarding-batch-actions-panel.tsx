import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useState } from 'react'
import { Users } from 'lucide-react'

interface OnboardingBatchActionsPanelProps {
  brokerageId: string
  userId: string
  onBatchAction: (action: string, agentIds: string[]) => void
}

export function OnboardingBatchActionsPanel({
  brokerageId,
  userId,
  onBatchAction,
}: OnboardingBatchActionsPanelProps) {
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batch Actions</CardTitle>
        <CardDescription>Perform actions on multiple agents</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-center py-8 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>Select agents from the overview to perform batch actions</p>
          <p className="text-xs mt-2">{selectedAgents.length} agents selected</p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={selectedAgents.length === 0}
            onClick={() => onBatchAction('send-reminder', selectedAgents)}
          >
            Send Reminders
          </Button>
          <Button
            variant="outline"
            disabled={selectedAgents.length === 0}
            onClick={() => onBatchAction('enroll-training', selectedAgents)}
          >
            Enroll in Training
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
