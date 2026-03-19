import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Settings, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default async function ComplianceSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/compliance">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Compliance Settings
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notification Preferences</CardTitle>
          <CardDescription>Configure when you receive compliance alerts</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {['New violation detected', 'Pending approval > 24hrs', 'Weekly compliance report', 'Agent certification expiry'].map((item) => (
            <div key={item} className="flex items-center justify-between py-2 border-b last:border-0">
              <span className="text-sm">{item}</span>
              <Button variant="outline" size="sm">Configure</Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Full Platform Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href="/settings/general">
            <Button variant="outline" size="sm">Open Platform Settings</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
