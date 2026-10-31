import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileText, ArrowLeft, Shield } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// Wave 146 (lane 146H, owner ruling 16 — "no dead controls or misleading statuses"). Every row here
// used to wear a green "Active" badge. Nothing on this page reads a policy row, a setting or an
// enforcement record — the list is hard-coded — so "Active" was a status the page could not know.
// It is now what it is: a REFERENCE list, and where the platform has a real screen that manages or
// evidences the rule, the row links to it (each href resolves to a page at HEAD — the literal hrefs
// are held by test:dangling-links).
type PolicyRow = { name: string; category: string; description: string; managedAt?: { href: string; label: string } }
const BUILT_IN_POLICIES: PolicyRow[] = [
  { name: 'Fair Housing Act', category: 'Federal Law', description: 'Prohibits discrimination in housing sales, rental, and financing.', managedAt: { href: '/approvals', label: "Approvals — the content guardian's fair-housing findings on marketing copy" } },
  { name: 'TRID Compliance', category: 'CFPB', description: 'TILA-RESPA Integrated Disclosure rules for loan estimates and closing disclosures.' },
  { name: 'NAR Code of Ethics', category: 'Professional', description: 'Standards of practice for REALTOR members.' },
  { name: 'CAN-SPAM Act', category: 'Federal Law', description: 'Rules for commercial email communications.' },
  { name: 'TCPA Compliance', category: 'Federal Law', description: 'Telephone Consumer Protection Act — rules for calls and SMS.', managedAt: { href: '/dashboard/admin/compliance/tcpa', label: 'TCPA compliance' } },
  { name: 'State License Requirements', category: 'State Law', description: 'Agent licensing and renewal requirements.', managedAt: { href: '/dashboard/settings/license-ce', label: 'License & CE' } },
  { name: 'Data Privacy (CCPA/GDPR)', category: 'Privacy', description: 'Consumer data privacy protection requirements.', managedAt: { href: '/dashboard/admin/privacy/requests', label: 'Privacy requests (DSAR)' } },
  { name: 'Document Retention Policy', category: 'Internal', description: 'Required retention periods for transaction documents.' },
]

export default async function CompliancePoliciesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/compliance" aria-label="Back to compliance"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-blue-600" />
            Compliance Policies
          </h1>
          <p className="text-gray-600 text-sm">A reference list of the frameworks your brokerage works under — each links to the screen that manages it, where one exists</p>
        </div>
      </div>
      <div className="grid gap-4">
        {BUILT_IN_POLICIES.map((policy) => (
          <Card key={policy.name}>
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">{policy.name}</p>
                    <p className="text-sm text-gray-600 mt-0.5">{policy.description}</p>
                    {policy.managedAt ? (
                      <Link href={policy.managedAt.href} className="mt-1.5 inline-block rounded-sm text-sm font-medium text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        Managed in: {policy.managedAt.label}
                      </Link>
                    ) : (
                      <p className="mt-1.5 text-xs text-gray-600">No setting for this one on the platform — ask your broker or compliance officer.</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="text-xs">{policy.category}</Badge>
                  <Badge variant="outline" className="text-xs text-gray-700">Reference</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
