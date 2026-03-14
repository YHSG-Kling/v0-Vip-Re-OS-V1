import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileText, ArrowLeft, Shield } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const BUILT_IN_POLICIES = [
  { name: 'Fair Housing Act', status: 'active', category: 'Federal Law', description: 'Prohibits discrimination in housing sales, rental, and financing.' },
  { name: 'TRID Compliance', status: 'active', category: 'CFPB', description: 'TILA-RESPA Integrated Disclosure rules for loan estimates and closing disclosures.' },
  { name: 'NAR Code of Ethics', status: 'active', category: 'Professional', description: 'Standards of practice for REALTOR members.' },
  { name: 'CAN-SPAM Act', status: 'active', category: 'Federal Law', description: 'Rules for commercial email communications.' },
  { name: 'TCPA Compliance', status: 'active', category: 'Federal Law', description: 'Telephone Consumer Protection Act — rules for calls and SMS.' },
  { name: 'State License Requirements', status: 'active', category: 'State Law', description: 'Agent licensing and renewal requirements.' },
  { name: 'Data Privacy (CCPA/GDPR)', status: 'active', category: 'Privacy', description: 'Consumer data privacy protection requirements.' },
  { name: 'Document Retention Policy', status: 'active', category: 'Internal', description: 'Required retention periods for transaction documents.' },
]

export default async function CompliancePoliciesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/compliance/dashboard">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-blue-600" />
            Compliance Policies
          </h1>
          <p className="text-gray-500 text-sm">Active compliance frameworks and policies</p>
        </div>
      </div>
      <div className="grid gap-4">
        {BUILT_IN_POLICIES.map((policy) => (
          <Card key={policy.name}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">{policy.name}</p>
                    <p className="text-sm text-gray-600 mt-0.5">{policy.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="text-xs">{policy.category}</Badge>
                  <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Active</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
