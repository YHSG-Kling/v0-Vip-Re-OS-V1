'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle, Shield, TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface ComplianceMonitorPanelProps {
  brokerageId: string
}

export function ComplianceMonitorPanel({ brokerageId }: ComplianceMonitorPanelProps) {
  const [compliance, setCompliance] = useState<any[]>([])
  const [stats, setStats] = useState({ critical: 0, warnings: 0, resolved: 0 })
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchCompliance = async () => {
      try {
        const { data } = await supabase
          .from('transaction_compliance_log')
          .select(`
            id,
            transaction_id,
            issue_type,
            severity,
            description,
            status,
            created_at
          `)
          .eq('brokerage_id', brokerageId)
          .order('created_at', { ascending: false })
          .limit(12)

        setCompliance(data || [])

        // Calculate stats
        if (data) {
          setStats({
            critical: data.filter(c => c.severity === 'critical').length,
            warnings: data.filter(c => c.severity === 'warning').length,
            resolved: data.filter(c => c.status === 'resolved').length,
          })
        }
      } catch (error) {
        console.error('Error fetching compliance:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchCompliance()
  }, [brokerageId, supabase])

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-destructive/10 text-destructive'
      case 'warning':
        return 'bg-orange-100 text-orange-800'
      case 'info':
        return 'bg-blue-100 text-blue-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <Card className="border-l-4 border-l-amber-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Compliance Monitor</CardTitle>
            <CardDescription>Real-time compliance tracking</CardDescription>
          </div>
          <Shield className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.critical > 0 && (
          <Alert className="border-destructive/50 bg-destructive/5">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertDescription className="text-destructive">
              {stats.critical} critical compliance issue{stats.critical !== 1 ? 's' : ''}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 rounded-lg bg-red-50">
            <p className="text-xs text-muted-foreground">Critical</p>
            <p className="text-lg font-bold text-red-700">{stats.critical}</p>
          </div>
          <div className="p-2 rounded-lg bg-orange-50">
            <p className="text-xs text-muted-foreground">Warnings</p>
            <p className="text-lg font-bold text-orange-700">{stats.warnings}</p>
          </div>
          <div className="p-2 rounded-lg bg-green-50">
            <p className="text-xs text-muted-foreground">Resolved</p>
            <p className="text-lg font-bold text-green-700">{stats.resolved}</p>
          </div>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {loading ? (
            <div className="text-center py-6 text-muted-foreground">Loading compliance data...</div>
          ) : compliance.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">No compliance issues</div>
          ) : (
            compliance.map(item => (
              <div
                key={item.id}
                className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className={`p-1.5 rounded ${getSeverityColor(item.severity)} mt-0.5`}>
                  <AlertTriangle className="h-3 w-3" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{item.issue_type}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                </div>
                <Badge variant="outline" className="text-xs shrink-0">
                  {item.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
