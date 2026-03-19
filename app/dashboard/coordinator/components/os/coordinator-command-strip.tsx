'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircle, Zap, CheckCircle2, Clock } from 'lucide-react'

interface CoordinatorCommandStripProps {
  brokerageId: string
}

export function CoordinatorCommandStrip({ brokerageId }: CoordinatorCommandStripProps) {
  return (
    <Card className="border-2 border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Coordinator Command Strip</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-3">
          <Button variant="outline" className="flex flex-col h-auto py-3" size="sm">
            <AlertCircle className="h-4 w-4 mb-1 text-destructive" />
            <span className="text-xs">Critical Actions</span>
          </Button>
          <Button variant="outline" className="flex flex-col h-auto py-3" size="sm">
            <Zap className="h-4 w-4 mb-1 text-yellow-600" />
            <span className="text-xs">Escalations</span>
          </Button>
          <Button variant="outline" className="flex flex-col h-auto py-3" size="sm">
            <CheckCircle2 className="h-4 w-4 mb-1 text-green-600" />
            <span className="text-xs">Completions</span>
          </Button>
          <Button variant="outline" className="flex flex-col h-auto py-3" size="sm">
            <Clock className="h-4 w-4 mb-1 text-blue-600" />
            <span className="text-xs">Pending</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
