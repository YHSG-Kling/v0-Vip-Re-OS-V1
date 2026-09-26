import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileText, ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ISAScriptsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: scripts } = await supabase
    .from('video_scripts_library')
    .select('id, title, script_type, status:approval_status, created_at')
    .order('created_at', { ascending: false })
    .limit(30)

  // HONEST filter (production audit): only genuinely call-flavored scripts render
  // here. The old fallback padded the page with unrelated VIDEO scripts labeled
  // as call scripts — misleading, removed.
  const displayScripts = (scripts || []).filter((s: any) =>
    s.script_type?.toLowerCase().includes('call') ||
    s.script_type?.toLowerCase().includes('isa') ||
    s.script_type?.toLowerCase().includes('outreach')
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/isa"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileText className="w-6 h-6 text-blue-600" />
              Call Scripts
            </h1>
            <p className="text-gray-500 text-sm">{displayScripts.length} scripts available</p>
          </div>
        </div>
        {/* Objection drills are where call language is authored + practiced today */}
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" asChild>
          <Link href="/dashboard/coaching/practice">
            <Plus className="w-4 h-4 mr-2" />
            Practice call scripts
          </Link>
        </Button>
      </div>

      {displayScripts.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">No call scripts in your library yet.</p>
            <p className="text-sm text-gray-400 mt-1">
              Your AI ISA composes its call framing per lead automatically — nothing to configure here.
              For your own phrasings, drill real scripts in Coaching → Practice.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayScripts.map((script: any) => (
            <Card key={script.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{script.title || 'Untitled Script'}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">{script.script_type || 'General'}</Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={script.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}>
                    {script.status || 'draft'}
                  </Badge>
                  {/* Practice IS how a script gets used — drill it aloud with scoring */}
                  <Button size="sm" variant="outline" asChild>
                    <Link href="/dashboard/coaching/practice">Practice it</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
