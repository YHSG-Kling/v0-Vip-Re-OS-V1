import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Eye, AlertTriangle, CheckCircle2, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'

export const dynamic = 'force-dynamic'

export default async function AIAuditPage() {
  // Kernel OS: getAgentContext — canonical identity, never raw auth.getUser()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['admin', 'superadmin', 'compliance_officer'].includes(userRole)) redirect('/dashboard')

  const supabase = await createClient()

  // Fetch AI quality metrics — ai_generated_content is the canonical AI output
  // log (ai_content_outputs was a writer-less legacy twin; same columns).
  const { data: aiOutputs } = await supabase
    .from('ai_generated_content')
    .select('id, content_type, compliance_approved, created_at, agent_id')
    .order('created_at', { ascending: false })
    .limit(50)

  const outputs = aiOutputs || []
  const total = outputs.length
  const approved = outputs.filter((o: any) => o.compliance_approved).length
  const pending = outputs.filter((o: any) => !o.compliance_approved).length
  const approvalRate = total > 0 ? Math.round((approved / total) * 100) : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-600" />
            AI Quality Audit
          </h1>
          <p className="text-gray-500 text-sm">Monitor AI output quality and compliance across all agents</p>
        </div>
        <Link href="/dashboard/ai-quality">
          <Button variant="outline" size="sm">Full AI Quality Dashboard</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total AI Outputs', value: total, icon: Sparkles, color: 'text-purple-600' },
          { label: 'Compliance Approved', value: approved, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Pending Review', value: pending, icon: Eye, color: 'text-yellow-600' },
          { label: 'Approval Rate', value: `${approvalRate}%`, icon: TrendingUp, color: approvalRate >= 80 ? 'text-green-600' : 'text-red-600' },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <stat.icon className={`w-8 h-8 ${stat.color}`} />
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-gray-500">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent AI Outputs</CardTitle>
          <CardDescription>Last 50 AI-generated content items</CardDescription>
        </CardHeader>
        <CardContent>
          {outputs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No AI outputs recorded yet</p>
          ) : (
            <div className="space-y-2">
              {outputs.map((output: any) => (
                <div key={output.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{output.content_type || 'AI Content'}</p>
                    <p className="text-xs text-gray-500">{new Date(output.created_at).toLocaleString()}</p>
                  </div>
                  <Badge className={output.compliance_approved ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}>
                    {output.compliance_approved ? 'Approved' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
