"use client"

// SaveHomeFromLinkCard — wave 150, lane 150W (owner ruling 2026-11-06): "a buyer may also save a home by pasting the
// property's URL". Found a home somewhere else? Paste its link and it joins your saved homes (origin buyer_url), so your
// agent, your family (when you share it) and your search assistant can all see it. The link's own words give the
// address; the facts come from the property records. We never copy that site's photos or page.
// Server action only (proxy-graph budget): no lib import here.

import { useState, useTransition } from "react"
import { Link2 } from "lucide-react"
import { saveHomeFromLinkAction } from "@/app/actions/buyer-search/conversational-search"

export function SaveHomeFromLinkCard({ contactId }: { contactId: string }) {
  const [url, setUrl] = useState("")
  const [lines, setLines] = useState<string[]>([])
  const [pending, startTransition] = useTransition()

  const save = () => {
    const link = url.trim()
    if (link.length < 8) return
    startTransition(async () => {
      const r = await saveHomeFromLinkAction({ contactId, url: link })
      if (!r.ok) { setLines([r.error]); return }
      setLines([r.message, ...r.notes])
      setUrl("")
    })
  }

  return (
    <section className="rounded-lg border p-4 space-y-2" aria-labelledby="save-from-link-title">
      <h2 id="save-from-link-title" className="flex items-center gap-2 text-base font-semibold">
        <Link2 className="h-4 w-4" aria-hidden="true" /> Found a home somewhere else?
      </h2>
      <p className="text-sm text-muted-foreground">
        Paste the link and I'll keep it with your saved homes. I read the address from the link and look up the home's facts
        from property records — I don't copy that site's photos or page, and your agent will double-check the details.
      </p>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          aria-label="Link to the home"
          inputMode="url"
          className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
        />
        <button type="button" disabled={pending || url.trim().length < 8} onClick={save} className="rounded-md border px-3 text-sm">
          {pending ? "Saving…" : "Save this home"}
        </button>
      </div>
      {lines.length > 0 && <p className="text-xs text-muted-foreground" role="status">{lines.join(" ")}</p>}
    </section>
  )
}
