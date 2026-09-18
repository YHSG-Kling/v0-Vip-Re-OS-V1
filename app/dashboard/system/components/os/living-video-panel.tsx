import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, CircleCheck } from 'lucide-react'
import { loadLivingVideos } from '@/lib/video/living-video-sweep'
import { LIVING_KINDS } from '@/lib/video/living-video'

/**
 * VIDEOS THAT KEEP THEMSELVES CURRENT.
 *
 * A living video is one whose content is a claim about facts that move — "three
 * showings this week", "listed at $545,000". Everywhere else in this industry
 * those ship as static files that start rotting on delivery. This board shows
 * which videos are being watched, what each currently asserts, and which have
 * already remade themselves.
 *
 * It deliberately shows the FACTS, not a health score. A broker looking at this
 * should be able to read the numbers their client is being told and recognise
 * them — that is the whole trust proposition, and a green checkmark would hide
 * exactly the thing worth seeing.
 */

interface LivingVideoPanelProps {
  brokerageId: string
}

function factLine(kind: string, facts: Record<string, unknown> | null): string {
  const spec = LIVING_KINDS[kind]
  if (!spec || !facts) return ''
  // Only the material facts — the ones that would trigger a refresh — so the
  // line reads as "what this video promises", not as a debug dump.
  return Object.entries(spec.facts)
    .filter(([, f]) => f.materiality !== 'never')
    .map(([field, f]) => {
      const v = facts[field]
      if (v === null || v === undefined || v === '') return null
      const shown = typeof v === 'string' && v.length > 30 ? 'set' : String(v)
      return `${f.label} ${shown}`
    })
    .filter(Boolean)
    .slice(0, 4)
    .join(' · ')
}

export async function LivingVideoPanel({ brokerageId }: LivingVideoPanelProps) {
  const rows = await loadLivingVideos(brokerageId, 8)
  const refreshed = rows.filter((r) => r.isRefresh).length

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-primary" />
          Videos that keep themselves current
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              No living videos yet. When your team sends a video that makes a claim about
              numbers — a seller&rsquo;s weekly update, a market reel — the OS records what it
              said and rebuilds it if those numbers move.
            </div>
            <p className="text-xs text-muted-foreground">
              Watching for:{' '}
              {Object.values(LIVING_KINDS).map((k) => k.label).join(', ')}.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{rows.length}</p>
                <p className="text-xs text-muted-foreground">Kept current</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{refreshed}</p>
                <p className="text-xs text-muted-foreground">Rebuilt after a change</p>
              </div>
            </div>

            <div className="space-y-2">
              {rows.map((r) => {
                const line = factLine(r.kind, r.facts as Record<string, unknown> | null)
                return (
                  <div key={r.renderId} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {r.isRefresh
                        ? <RefreshCw className="h-4 w-4 shrink-0 text-sky-500" />
                        : <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />}
                      {r.label}
                      {r.isRefresh && (
                        <Badge variant="outline" className="text-xs font-normal">
                          rebuilt
                        </Badge>
                      )}
                    </p>
                    {line && (
                      <p className="text-xs text-muted-foreground">
                        Currently tells them: {line}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground border-t border-border pt-3">
          A rebuild never sends on its own — it stages the corrected video and your
          approval is still what reaches the client.
        </p>
      </CardContent>
    </Card>
  )
}
