import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Film, Recycle, AlertTriangle, Mic } from 'lucide-react'
import { loadCacheBoard } from '@/lib/remotion/render-cache'

/**
 * RENDERED ONCE, USED MANY TIMES — the video economics board.
 *
 * Every composition in this OS is a pure function of its props, so identical
 * content should be rendered once and reused. This board reports whether that is
 * actually happening, and when it is not, WHY — naming the specific prop path
 * that makes a composition uncacheable.
 *
 * Two numbers, kept apart on purpose:
 *
 *   REUSED       renders served from an existing artifact. Zero is the honest
 *                answer on a fresh OS and on a tenant whose every video is
 *                genuinely personalized — a personalized cut SHOULD render once
 *                per person, and a board that implied otherwise would be
 *                pressuring the agent toward worse video.
 *   NARRATION    ElevenLabs clips reused instead of re-synthesized. This is the
 *                line with real dollars behind it.
 *
 * The leak list is the part that closes the loop for a human: it is the same
 * finding the Asset Manager receives on the bus, shown where a broker can see
 * that a fix is pending rather than wondering why the hit rate stays flat.
 */

interface RenderCachePanelProps {
  brokerageId: string
}

const REASON_LABEL: Record<string, string> = {
  epoch_millis: 'a millisecond timestamp',
  recent_timestamp: 'a full ISO timestamp',
  uuid: 'a fresh id',
  nonce_suffix: 'a per-call suffix in a URL',
}

export async function RenderCachePanel({ brokerageId }: RenderCachePanelProps) {
  const board = await loadCacheBoard(brokerageId, { sinceDays: 30 })
  const nothingYet = board.renders === 0 && board.narrationReuses === 0

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Film className="h-5 w-5 text-primary" />
          Rendered once, used many times
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {nothingYet ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            No video rendered in the last 30 days. When your team makes video, identical
            content is rendered <span className="font-medium text-foreground">once</span> and
            reused — this board shows how often that happened and what stopped it.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{board.hitRatePct}%</p>
                <p className="text-xs text-muted-foreground">Reused</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{board.renders}</p>
                <p className="text-xs text-muted-foreground">Videos delivered</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-emerald-600">
                  ${board.usdAvoided.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">Render cost avoided</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="flex items-center gap-1.5 min-w-0">
                  <Recycle className="h-4 w-4 shrink-0 text-emerald-500" />
                  <span className="font-medium">Served from an earlier render</span>
                  <span className="text-xs text-muted-foreground truncate">
                    — same content, no re-render
                  </span>
                </span>
                <span className="font-semibold shrink-0">{board.hits}</span>
              </div>
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="flex items-center gap-1.5 min-w-0">
                  <Mic className="h-4 w-4 shrink-0 text-sky-500" />
                  <span className="font-medium">Narration reused</span>
                  <span className="text-xs text-muted-foreground truncate">
                    — the same words in the same voice, not re-synthesized
                  </span>
                </span>
                <span className="font-semibold shrink-0">{board.narrationReuses}</span>
              </div>
              {board.secondsAvoided > 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  {Math.round(board.secondsAvoided)} seconds of finished video delivered
                  without rendering it again.
                </p>
              )}
            </div>

            {/* A 0% reuse rate is not a failure, and the board says so rather than
                letting a broker read it as one. */}
            {board.hits === 0 && board.leaks.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing has been reused yet, which is expected while every video your team
                makes is personalized to one person — a personal cut should be rendered for
                that person. Reuse shows up on the content that is the same for everyone:
                market updates, neighbourhood spotlights, explainers.
              </p>
            )}
          </>
        )}

        {board.leaks.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              These can never be reused
            </p>
            {board.leaks.slice(0, 4).map((leak) => (
              <div
                key={leak.compositionId}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
              >
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  {leak.compositionId}
                  <span className="font-normal text-muted-foreground">
                    — {leak.renders} {leak.renders === 1 ? 'render' : 'renders'}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Its inputs change on every call, so each one is a fresh render even when
                  the video is identical.
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {leak.findings.slice(0, 3).map((f, i) => (
                    <Badge key={`${f.path}-${i}`} variant="outline" className="text-xs font-normal">
                      {f.path || 'root'}
                      <span className="ml-1 text-muted-foreground">
                        {REASON_LABEL[f.reason] ?? f.reason}
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Your Asset Manager has been told about {board.leaks.length === 1 ? 'this' : 'these'}
              {' '}and it is on the Command Center feed — the fix is in the producer that
              builds these inputs, not something to change here.
            </p>
          </div>
        )}

        {board.topNarration.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Most-reused narration
            </p>
            {board.topNarration.map((n, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground truncate">&ldquo;{n.preview}&rdquo;</span>
                <span className="font-semibold shrink-0">
                  {n.hits}&times;
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
