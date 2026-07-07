"use client"

// Platform image library — search licensed stock (Pexels, creds-gated), curate the
// PLATFORM-scoped shared library every tenant's pickers see, and copy URLs into
// reel slideshows (ProductPromoReel imageUrls). AI images ride the existing
// generate-marketing-image rail onto the same marketing_assets table.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  searchStockImagesAction, saveLibraryImageAction, listImageLibraryAction, removeLibraryImageAction,
  type LibraryAssetRow,
} from "@/app/actions/marketing/image-library"
import type { LibraryImage } from "@/lib/marketing/image-library"

export function ImageLibraryCard() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<LibraryImage[]>([])
  const [assets, setAssets] = useState<LibraryAssetRow[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const refresh = () => listImageLibraryAction().then((r) => { if (r.ok) setAssets(r.assets) })
  useEffect(() => { refresh() }, [])

  function search() {
    setMsg(null)
    start(async () => {
      const r = await searchStockImagesAction(query)
      if (!r.ok) { setMsg(r.error); setResults([]); return }
      setResults(r.images)
      if (r.images.length === 0) setMsg("No results for that search.")
    })
  }

  function save(img: LibraryImage) {
    setMsg(null)
    start(async () => {
      const r = await saveLibraryImageAction({
        name: img.alt || query || "Stock photo",
        url: img.url, thumbnailUrl: img.thumbnailUrl, scope: "platform",
        alt: img.alt, source: img.source, photographer: img.photographer, licenseNote: img.licenseNote,
      })
      if (!r.ok) { setMsg(r.error); return }
      setMsg("Saved to the platform library — every tenant's pickers can now use it.")
      refresh()
    })
  }

  function remove(id: string) {
    start(async () => {
      const r = await removeLibraryImageAction(id)
      if (!r.ok) { setMsg(r.error ?? "Remove failed"); return }
      refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Shared image library</CardTitle>
        <CardDescription className="text-xs">
          Licensed stock (Pexels) + AI images, curated once at platform scope and reused by every tenant&apos;s
          video/social pickers — and by the reel slideshow (paste an image URL when attaching reel media).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stock photos — e.g. modern kitchen, handshake, skyline"
            onKeyDown={(e) => { if (e.key === "Enter") search() }} />
          <Button onClick={search} disabled={pending || query.trim().length < 2}>Search</Button>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

        {results.length > 0 && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {results.map((img) => (
              <div key={img.url} className="space-y-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.thumbnailUrl} alt={img.alt} className="aspect-square w-full rounded object-cover border" />
                <button onClick={() => save(img)} disabled={pending} className="w-full rounded border px-1 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50">
                  Save to library
                </button>
              </div>
            ))}
          </div>
        )}

        <div>
          <p className="text-xs font-medium mb-2">In the library ({assets.length})</p>
          {assets.length === 0 ? (
            <p className="text-xs text-muted-foreground">Empty — search above, or generate AI images from any tenant&apos;s marketing studio.</p>
          ) : (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {assets.map((a) => (
                <div key={a.id} className="space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.thumbnailUrl ?? a.url} alt={a.name} className="aspect-square w-full rounded object-cover border" />
                  <p className="truncate text-[10px] text-muted-foreground" title={a.name}>{a.name}{a.photographer ? ` · ${a.photographer}` : ""}</p>
                  <div className="flex gap-1">
                    <button onClick={() => navigator.clipboard.writeText(a.url)} className="flex-1 rounded border px-1 py-0.5 text-[10px]">Copy URL</button>
                    {a.scope === "platform" && (
                      <button onClick={() => remove(a.id)} disabled={pending} className="rounded border px-1 py-0.5 text-[10px] text-red-600">✕</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
