'use client'

// Platform brand kit (the app's NAME is configurable — nothing hardcoded) + the
// watched-topic pool that feeds posts/reels (competitor buzz, trends, manual).
import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, Palette, Radar, Save, X } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { setProductBrandAction, addTopicAction, dismissTopicAction, listTopicsAction, harvestCompetitorTopicsAction } from '@/app/actions/superadmin/platform-brand'

interface Brand { name: string; tagline: string; primaryColor: string; accentColor: string; ctaUrl: string }
interface Topic { id: string; source: string; topic: string; url: string | null; status: string }

export function BrandTopicsCard({ initialBrand, initialTopics }: { initialBrand: Brand; initialTopics: Topic[] }) {
  const [brand, setBrand] = useState<Brand>(initialBrand)
  const [topics, setTopics] = useState<Topic[]>(initialTopics)
  const [newTopic, setNewTopic] = useState('')
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  const reloadTopics = () => listTopicsAction().then((r) => { if (r.ok) setTopics(r.topics as Topic[]) })

  const saveBrand = () => startTransition(async () => {
    const r = await setProductBrandAction(brand)
    if (r.ok) { setBrand(r.brand); toast({ title: `Brand saved — the platform now markets as "${r.brand.name}"` }) }
    else toast({ title: 'Error', description: r.error, variant: 'destructive' })
  })
  const addTopic = () => startTransition(async () => {
    const r = await addTopicAction({ topic: newTopic })
    if (r.ok) { setNewTopic(''); reloadTopics() } else toast({ title: 'Error', description: r.error, variant: 'destructive' })
  })
  const harvest = () => startTransition(async () => {
    const r = await harvestCompetitorTopicsAction()
    if (r.ok) { toast({ title: `Harvested ${r.added} topic(s) from the market` }); reloadTopics() }
    else toast({ title: 'Harvest', description: r.error, variant: 'destructive' })
  })
  const dismiss = (id: string) => startTransition(async () => { const r = await dismissTopicAction(id); if (r.ok) reloadTopics() })

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Palette className="h-4 w-4 text-primary" />Platform brand kit</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">Product name</Label><Input className="h-8 text-xs" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} /></div>
            <div><Label className="text-xs">CTA domain</Label><Input className="h-8 text-xs" value={brand.ctaUrl} onChange={(e) => setBrand({ ...brand, ctaUrl: e.target.value })} /></div>
          </div>
          <div><Label className="text-xs">Tagline</Label><Input className="h-8 text-xs" value={brand.tagline} onChange={(e) => setBrand({ ...brand, tagline: e.target.value })} /></div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5"><Label className="text-xs">Primary</Label><input type="color" value={brand.primaryColor} onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} /></div>
            <div className="flex items-center gap-1.5"><Label className="text-xs">Accent</Label><input type="color" value={brand.accentColor} onChange={(e) => setBrand({ ...brand, accentColor: e.target.value })} /></div>
            <Button size="sm" className="ml-auto" disabled={pending} onClick={saveBrand}>
              {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}Save brand
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Every post, reel, pitch and the /get-started page resolve this — rename the product with zero code changes.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2"><Radar className="h-4 w-4 text-primary" />Topic pool (competitor watch + trends)</CardTitle>
          <Button size="sm" variant="outline" disabled={pending} onClick={harvest}><Radar className="h-3.5 w-3.5 mr-1" />Harvest</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input className="h-8 text-xs" placeholder="add a topic the market is talking about…" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
            <Button size="sm" variant="outline" disabled={pending || newTopic.trim().length < 8} onClick={addTopic}>Add</Button>
          </div>
          {topics.length === 0 && <p className="text-xs text-muted-foreground">No topics yet — harvest or add one. New topics get woven into the next calendar/reel.</p>}
          {topics.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded border p-2 text-xs">
              <Badge variant="outline" className="text-[10px]">{t.source}</Badge>
              <span className="flex-1 truncate">{t.topic}</span>
              <Badge className={'text-[10px] ' + (t.status === 'used' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700')}>{t.status}</Badge>
              {t.status === 'new' && <button className="text-red-500" onClick={() => dismiss(t.id)}><X className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
