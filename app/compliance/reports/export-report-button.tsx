'use client'

/**
 * Export control for the 30-day compliance summary.
 *
 * The page already awaits generateComplianceReport() server-side and renders the
 * result; this button downloads THAT object (passed down as a prop) rather than
 * re-running the report, so the file can never disagree with the numbers on
 * screen and no second "generate" path is introduced.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export interface ComplianceReportPayload {
  totalCommunications: number
  compliantCommunications: number
  totalViolations: number
  criticalViolations: number
  violationsByType: Record<string, number>
  communicationsByChannel: Record<string, number>
  coldLeadChannelCompliance: boolean | null
  unreadableSources?: string[]
}

interface Props {
  report: ComplianceReportPayload
  startDate: string
  endDate: string
}

function csvCell(value: string | number | boolean): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function ExportComplianceReportButton({ report, startDate, endDate }: Props) {
  const [exporting, setExporting] = useState(false)

  const handleExport = () => {
    setExporting(true)
    try {
      const rows: Array<[string, string, string | number | boolean]> = [
        ['section', 'key', 'value'],
        ['window', 'start', startDate],
        ['window', 'end', endDate],
        ['summary', 'total_communications', report.totalCommunications],
        ['summary', 'compliant_communications', report.compliantCommunications],
        ['summary', 'flagged_communications', report.totalCommunications - report.compliantCommunications],
        ['summary', 'total_violations', report.totalViolations],
        ['summary', 'critical_violations', report.criticalViolations],
        ['summary', 'cold_lead_channel_compliance', report.coldLeadChannelCompliance === null ? 'not_established' : report.coldLeadChannelCompliance],
        ...Object.entries(report.violationsByType ?? {}).map(
          ([k, v]) => ['violations_by_type', k, v] as [string, string, number],
        ),
        ...Object.entries(report.communicationsByChannel ?? {}).map(
          ([k, v]) => ['communications_by_channel', k, v] as [string, string, number],
        ),
      ]

      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `compliance-report-${endDate.slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Compliance report exported')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
      {exporting ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <Download className="w-4 h-4 mr-2" />
      )}
      Export Report
    </Button>
  )
}
