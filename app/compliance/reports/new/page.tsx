import { redirect } from 'next/navigation'
// Compliance report generation is handled on the reports page itself
export default function NewComplianceReportPage() {
  redirect('/compliance/reports')
}
