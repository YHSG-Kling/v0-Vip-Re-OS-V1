import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertTriangle } from 'lucide-react'

interface SetupBlocker {
  provider_type: string
  status: string
}

interface SetupBlockersPanelProps {
  blockers: SetupBlocker[]
}

export function SetupBlockersPanel({ blockers }: SetupBlockersPanelProps) {
  const unconfigured = blockers.filter(b => b.status !== "connected")

  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup Blockers</CardTitle>
        <CardDescription>Integrations preventing full adoption</CardDescription>
      </CardHeader>
      <CardContent>
        {unconfigured.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            All integrations are configured
          </div>
        ) : (
          <div className="space-y-3">
            {unconfigured.map(blocker => (
              <div key={blocker.provider_type} className="flex items-start gap-3 p-3 bg-red-50 rounded-lg">
                <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium text-sm">{blocker.provider_type}</p>
                  <p className="text-xs text-muted-foreground">Not configured</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
