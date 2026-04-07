'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Database, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

interface TableCheckResult {
  name: string
  present: boolean
  migrationScript: string
  description: string
}

interface SchemaReadinessPanelProps {
  brokerageId: string
}

async function probeSchemaReadiness(): Promise<TableCheckResult[]> {
  const res = await fetch('/api/system/schema-readiness', { cache: 'no-store' })
  if (!res.ok) return []
  return res.json()
}

export function SchemaReadinessPanel({ brokerageId }: SchemaReadinessPanelProps) {
  const [loading, setLoading] = useState(true)
  const [checks, setChecks] = useState<TableCheckResult[]>([])

  useEffect(() => {
    probeSchemaReadiness()
      .then(setChecks)
      .catch(() => setChecks([]))
      .finally(() => setLoading(false))
  }, [brokerageId])

  const allPresent = checks.length > 0 && checks.every((c) => c.present)
  const missingCount = checks.filter((c) => !c.present).length

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            Database Schema Readiness
          </CardTitle>
          {!loading && (
            <Badge
              variant={allPresent ? 'secondary' : 'destructive'}
              className="text-xs"
            >
              {allPresent ? 'All tables present' : `${missingCount} migration${missingCount !== 1 ? 's' : ''} pending`}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Probing schema...</span>
          </div>
        ) : checks.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Schema probe unavailable — service role key may be missing.
          </p>
        ) : (
          <div className="space-y-2">
            {checks.map((check) => (
              <div
                key={check.name}
                className={`flex items-start justify-between rounded-lg border p-3 gap-3 ${
                  check.present
                    ? 'border-border bg-background'
                    : 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700'
                }`}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {check.present ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{check.name}</p>
                    <p className="text-xs text-muted-foreground">{check.description}</p>
                    {!check.present && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 font-mono truncate">
                        Run: {check.migrationScript}
                      </p>
                    )}
                  </div>
                </div>
                <Badge
                  variant={check.present ? 'secondary' : 'outline'}
                  className={`text-xs shrink-0 ${
                    !check.present ? 'border-amber-400 text-amber-700 dark:text-amber-400' : ''
                  }`}
                >
                  {check.present ? 'Present' : 'Missing'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
