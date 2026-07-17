"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Copy, Check, Globe } from "lucide-react"
import { getMyPublicSiteLinks, type PublicSiteLinks } from "@/app/actions/settings/public-site-links"

// "Your live website" — surfaces the zero-hosting public sites the OS already
// serves (brokerage /site, team /team, agent /p) right where the tenant edits
// the brand that feeds them. No hosting, no domains — the platform serves it.
export function YourWebsiteCard() {
  const [links, setLinks] = useState<PublicSiteLinks | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    getMyPublicSiteLinks().then((r) => { if (r.ok) setLinks(r.links) }).catch(() => {})
  }, [])

  const entries = [
    links?.brokerageSite && { label: "Brokerage website", ...links.brokerageSite },
    links?.teamSite && { label: "Team website", ...links.teamSite },
    links?.agentProfile && { label: "Agent profile", ...links.agentProfile },
  ].filter(Boolean) as Array<{ label: string; url: string; name: string }>

  if (entries.length === 0) return null

  function copy(url: string) {
    navigator.clipboard.writeText(url)
    setCopied(url)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-indigo-600" />
        <h2 className="text-sm font-semibold text-gray-900">Your live website</h2>
      </div>
      <p className="text-xs text-gray-600">
        Already live — served by the platform, no hosting or domain setup. The branding you save
        here updates it.
      </p>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.url} className="flex items-center gap-2 text-sm">
            <span className="text-gray-500 w-36 shrink-0 text-xs">{e.label}</span>
            <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline truncate flex items-center gap-1">
              {e.url.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <button onClick={() => copy(e.url)} className="text-gray-400 hover:text-gray-700" aria-label={`Copy ${e.label} link`}>
              {copied === e.url ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
