'use client'

// The platform's own social calendar — generate a week of product-marketing drafts,
// approve, and record the permalink when a post actually goes out on the company
// channels. Gated to platform marketing staff; nothing auto-publishes.
import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { CalendarPlus, Loader2, Megaphone } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { generateProductCalendarAction, listProductDraftsAction, transitionProductDraftAction } from '@/app/actions/superadmin/platform-content'

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700', approved: 'bg-blue-100 text-blue-800', posted: 'bg-emerald-100 text-emerald-800',
}

interface Draft { id: string; channel: string; angle: string; content: string; hashtags: string | null; status: string; scheduled_for: string | null; permalink: string | null }

export function ProductContentBoard({ initialDrafts }: { initialDrafts: Draft[] }) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [permalinks, setPermalinks] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() { listProductDraftsAction().then((r) => { if (r.ok) setDrafts(r.drafts as Draft[]) }) }

  function generate() {
    startTransition(async () => {
      const r = await generateProductCalendarAction(startDate)
      if (r.ok) { toast({ title: `Calendar generated — ${r.created} draft(s)` }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function transition(id: string, to: string) {
    startTransition(async () => {
      const r = await transitionProductDraftAction({ id, to, permalink: permalinks[id] })
      if (r.ok) reload(); else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2"><Megaphone className="h-4 w-4 text-primary" />Product social calendar</CardTitle>
        <div className="flex items-center gap-2">
          <Input className="h-8 w-36 text-xs" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={generate}>
            {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5 mr-1" />}Generate week
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {drafts.length === 0 && <p className="text-sm text-muted-foreground">No drafts yet — generate a week of product content.</p>}
        {drafts.map((d) => (
          <div key={d.id} className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="text-[10px] uppercase">{d.channel}</Badge>
              <span className="text-muted-foreground">{d.scheduled_for}</span>
              <span className="text-muted-foreground">· {d.angle}</span>
              <Badge className={'ml-auto text-[10px] ' + (STATUS_BADGE[d.status] ?? '')}>{d.status}</Badge>
            </div>
            <pre className="text-xs whitespace-pre-wrap">{d.content}</pre>
            <p className="text-[11px] text-muted-foreground">{d.hashtags}</p>
            <div className="flex items-center gap-2">
              {d.status === 'draft' && <Button size="sm" variant="outline" disabled={pending} onClick={() => transition(d.id, 'approved')}>Approve</Button>}
              {d.status === 'approved' && (
                <>
                  <Input className="h-7 text-xs flex-1" placeholder="permalink after posting" value={permalinks[d.id] ?? ''} onChange={(e) => setPermalinks({ ...permalinks, [d.id]: e.target.value })} />
                  <Button size="sm" disabled={pending || !(permalinks[d.id] ?? '').trim()} onClick={() => transition(d.id, 'posted')}>Mark posted</Button>
                </>
              )}
              {d.status === 'posted' && d.permalink && <a className="text-xs text-indigo-600 underline" href={d.permalink} target="_blank" rel="noreferrer">view post</a>}
              {d.status !== 'posted' && <Button size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => transition(d.id, 'discarded')}>Discard</Button>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
