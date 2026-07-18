'use client'

// The platform's own social calendar — generate a week of product-marketing drafts,
// approve, then either DISPATCH through the connected company channel (when the
// channel is connected AND the publisher supports it — real send, real permalink)
// or copy & post manually with the honest per-channel reason. Gated to platform
// marketing staff; nothing fakes a send.
import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { CalendarPlus, Loader2, Megaphone, Send } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { generateProductCalendarAction, listProductDraftsAction, transitionProductDraftAction, generateProductVideoDraftAction, attachProductVideoAction } from '@/app/actions/superadmin/platform-content'
import { publishProductDraftAction } from '@/app/actions/superadmin/platform-social'

/** Honest per-channel dispatch state, computed server-side from the company
 *  channel connections (app/dashboard/superadmin/growth/page.tsx). */
export interface ChannelState { connected: boolean; dispatchSupported: boolean; note: string | null }

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700', approved: 'bg-blue-100 text-blue-800', posted: 'bg-emerald-100 text-emerald-800',
}

interface Draft { id: string; channel: string; angle: string; content: string; hashtags: string | null; status: string; scheduled_for: string | null; permalink: string | null; media_type?: string | null; format?: string | null; script?: string | null; video_url?: string | null }

export function ProductContentBoard({ initialDrafts, channelStates = {} }: { initialDrafts: Draft[]; channelStates?: Record<string, ChannelState> }) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [permalinks, setPermalinks] = useState<Record<string, string>>({})
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({})
  const [publishImages, setPublishImages] = useState<Record<string, string>>({}) // Instagram: image URL required at publish time
  const [videoAngle, setVideoAngle] = useState('ai_team')
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
  function generateVideo() {
    startTransition(async () => {
      const r = await generateProductVideoDraftAction({ angle: videoAngle })
      if (r.ok) { toast({ title: 'Video draft created — render with Remotion, then attach the file URL' }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function attachVideo(id: string) {
    startTransition(async () => {
      const r = await attachProductVideoAction({ id, videoUrl: videoUrls[id] ?? '' })
      if (r.ok) { toast({ title: 'Video attached' }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function transition(id: string, to: string) {
    startTransition(async () => {
      const r = await transitionProductDraftAction({ id, to, permalink: permalinks[id] })
      if (r.ok) reload(); else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function publish(id: string, channel: string, imageUrl?: string) {
    startTransition(async () => {
      const r = await publishProductDraftAction({ id, imageUrl })
      if (r.ok) { toast({ title: `Published to ${channel}`, description: r.permalink }); reload() }
      else toast({ title: 'Publish failed', description: r.error, variant: 'destructive' })
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
          <select className="rounded border p-1.5 text-xs" value={videoAngle} onChange={(e) => setVideoAngle(e.target.value)}>
            {['ai_team','command_center','voice_admin','lead_to_lifetime','compliance_wire','whole_business'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={pending} onClick={generateVideo}>+ Video</Button>
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
            {d.media_type === 'video' && (
              <div className="rounded bg-muted/40 p-2 space-y-1">
                <p className="text-[10px] uppercase text-muted-foreground">Video · {d.format} · ProductPromoReel script</p>
                <pre className="text-[11px] whitespace-pre-wrap">{d.script}</pre>
                {d.video_url ? (
                  <a className="text-xs text-indigo-600 underline" href={d.video_url} target="_blank" rel="noreferrer">rendered video</a>
                ) : (
                  <div className="flex gap-2">
                    <Input className="h-7 text-xs flex-1" placeholder="rendered video URL" value={videoUrls[d.id] ?? ''} onChange={(e) => setVideoUrls({ ...videoUrls, [d.id]: e.target.value })} />
                    <Button size="sm" variant="outline" disabled={pending || !(videoUrls[d.id] ?? '').trim()} onClick={() => attachVideo(d.id)}>Attach</Button>
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{d.hashtags}</p>
            <div className="flex items-center gap-2">
              {d.status === 'draft' && <Button size="sm" variant="outline" disabled={pending} onClick={() => transition(d.id, 'approved')}>Approve</Button>}
              {d.status === 'approved' && (() => {
                const cs = channelStates[d.channel]
                const canDispatch = !!cs && cs.connected && cs.dispatchSupported && d.media_type !== 'video'
                // IG Graph refuses text-only posts — publish needs an image URL
                // (the drafts are text; the Image library above supplies one).
                const needsImage = d.channel === 'instagram'
                const imageOk = /^https?:\/\/.+/.test((publishImages[d.id] ?? '').trim())
                return (
                  <>
                    {canDispatch && needsImage && (
                      <Input className="h-7 text-xs flex-1" placeholder="image URL (required — copy one from the Image library above)"
                        value={publishImages[d.id] ?? ''} onChange={(e) => setPublishImages({ ...publishImages, [d.id]: e.target.value })} />
                    )}
                    {canDispatch && (
                      <Button size="sm" disabled={pending || (needsImage && !imageOk)} onClick={() => publish(d.id, d.channel, needsImage ? publishImages[d.id]?.trim() : undefined)}>
                        <Send className="h-3.5 w-3.5 mr-1" />Publish to {d.channel}
                      </Button>
                    )}
                    <Input className="h-7 text-xs flex-1" placeholder="permalink after posting" value={permalinks[d.id] ?? ''} onChange={(e) => setPermalinks({ ...permalinks, [d.id]: e.target.value })} />
                    <Button size="sm" variant={canDispatch ? 'outline' : 'default'} disabled={pending || !(permalinks[d.id] ?? '').trim()} onClick={() => transition(d.id, 'posted')}>Mark posted</Button>
                  </>
                )
              })()}
              {d.status === 'posted' && d.permalink && <a className="text-xs text-indigo-600 underline" href={d.permalink} target="_blank" rel="noreferrer">view post</a>}
              {d.status !== 'posted' && <Button size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => transition(d.id, 'discarded')}>Discard</Button>}
            </div>
            {d.status === 'approved' && (() => {
              const cs = channelStates[d.channel]
              // Honest dispatch state: why this draft can (or can't) go out automatically.
              if (d.media_type === 'video') return <p className="text-[11px] text-muted-foreground">Video draft — upload the rendered video on {d.channel} and record the permalink manually.</p>
              if (!cs) return null
              if (!cs.connected) return <p className="text-[11px] text-amber-700">{d.channel} not connected — copy &amp; post manually (or connect it in Company channels above).</p>
              if (!cs.dispatchSupported) return <p className="text-[11px] text-muted-foreground">{cs.note ?? `${d.channel} auto-publish not supported — copy & post manually.`}</p>
              if (d.channel === 'instagram') return <p className="text-[11px] text-muted-foreground">Instagram needs an image — attach one from the Image library above (text-only Instagram posts are impossible via the API); or copy &amp; post manually.</p>
              return null
            })()}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
