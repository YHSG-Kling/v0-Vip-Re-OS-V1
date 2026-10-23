"use client"

/**
 * KdpPublishingPanel — the finished book's KDP package (wave 143, lane 143F; lib/lead-magnets/book-publishing*.ts).
 * Build the package (EPUB 3 + a 1,600×2,560 JPEG cover + KDP metadata + the rights / AI-disclosure record), read what KDP
 * will ask, download the files, and — once the human has read and attested every statement — approve it. KDP has no
 * publishing API: a person uploads the files in their own KDP account. Nothing here promises a sales rank, and a retail
 * page that says "bestseller" is refused before it is built.
 */

import { useEffect, useState } from "react"
import { approveKdpPackageAction, buildKdpPackageAction, getKdpDownloadsAction, getKdpPackageAction } from "@/app/actions/lead-magnets-actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, Package } from "lucide-react"

type Kdp = NonNullable<Extract<Awaited<ReturnType<typeof getKdpPackageAction>>, { success: true }>["kdp"]>

export function KdpPublishingPanel({ magnetId }: { magnetId: string }) {
  const [kdp, setKdp] = useState<Kdp | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<string[]>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [links, setLinks] = useState<{ epubUrl: string; coverUrl: string } | null>(null)

  useEffect(() => {
    let alive = true
    void getKdpPackageAction(magnetId).then((r) => { if (alive && r.success) setKdp(r.kdp) })
    return () => { alive = false }
  }, [magnetId])

  async function build() {
    setBusy(true); setError(null); setBlockers([]); setLinks(null)
    const r = await buildKdpPackageAction(magnetId)
    setBusy(false)
    if (!r.success) { setError(r.error); setBlockers(r.blockers ?? []); return }
    setKdp(r.kdp); setChecked({})
  }
  async function approve() {
    if (!kdp) return
    setBusy(true); setError(null)
    const r = await approveKdpPackageAction(magnetId, kdp.attestations.filter((a) => checked[a.id]).map((a) => a.id))
    setBusy(false)
    if (!r.success) { setError(r.error); return }
    setKdp(r.kdp)
  }
  async function link() {
    setBusy(true); setError(null)
    const r = await getKdpDownloadsAction(magnetId)
    setBusy(false)
    if (!r.success) { setError(r.error); return }
    setLinks({ epubUrl: r.epubUrl, coverUrl: r.coverUrl })
  }

  const allChecked = !!kdp && kdp.attestations.every((a) => checked[a.id])
  return (
    <div className="mt-4 rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium"><Package className="h-4 w-4" />Publish on Amazon KDP</div>
        {kdp?.approval && <Badge>Approved for upload</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        Builds the files KDP asks for. You upload them in your own KDP account — there is no publishing link from here, and nothing about a sales rank is promised or implied.
      </p>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {blockers.length > 0 && <ul className="list-disc pl-5 text-sm text-red-600">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      <Button onClick={build} disabled={busy} variant={kdp ? "outline" : "default"}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{kdp ? "Rebuild the package" : "Build the KDP package"}
      </Button>
      {kdp && (
        <div className="space-y-3 text-sm">
          <div><span className="font-medium">{kdp.title}</span>{kdp.subtitle ? ` — ${kdp.subtitle}` : ""} · {kdp.words.toLocaleString()} words · cover: {kdp.coverArt === "image_rail" ? "AI art + typography" : "typography only"}</div>
          <div><span className="font-medium">Keywords (up to 7):</span> {kdp.keywords.join(" · ")}</div>
          <div><span className="font-medium">Suggested categories</span> (confirm in KDP&rsquo;s picker): {kdp.categorySuggestions.join(" | ")}</div>
          <div className="rounded border p-2 text-xs" dangerouslySetInnerHTML={{ __html: kdp.descriptionHtml }} />
          <div><span className="font-medium">When KDP asks about AI content:</span> text — {kdp.aiDisclosure.text.replace("_", "-")}; images — {kdp.aiDisclosure.images.replace("_", "-")}. <span className="text-muted-foreground">{kdp.aiDisclosure.explanation}</span></div>
          {kdp.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700">{kdp.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="text-xs text-muted-foreground">Paperback: about {kdp.paperback.estimatedPages} pages at 6×9 in, inside margin {kdp.paperback.insideMarginIn ?? "—"} in. The paperback interior file is not produced yet (see the warning above).</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={link} disabled={busy}><Download className="mr-2 h-4 w-4" />Get the EPUB and cover links</Button>
            {links && <>
              <a className="text-primary underline text-sm" href={links.epubUrl} target="_blank" rel="noreferrer">Book (EPUB)</a>
              <a className="text-primary underline text-sm" href={links.coverUrl} target="_blank" rel="noreferrer">Cover (JPEG)</a>
            </>}
          </div>
          {!kdp.approval && (
            <div className="space-y-2 rounded border p-3">
              <div className="font-medium">Before you upload, confirm each statement:</div>
              {kdp.attestations.map((a) => (
                <label key={a.id} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={!!checked[a.id]} onChange={(e) => setChecked((c) => ({ ...c, [a.id]: e.target.checked }))} /><span>{a.text}</span></label>
              ))}
              <Button size="sm" onClick={approve} disabled={busy || !allChecked}>Approve for upload</Button>
            </div>
          )}
          {kdp.approval && <div className="text-xs text-muted-foreground">Approved {new Date(kdp.approval.at).toLocaleString()}.</div>}
        </div>
      )}
    </div>
  )
}
