"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Copy, Check, Globe, RefreshCw, Trash2, Plus } from "lucide-react"
import { getMyPublicSiteLinks, type PublicSiteLinks } from "@/app/actions/settings/public-site-links"
import {
  getCustomDomainsPanel,
  addCustomDomainAction,
  checkCustomDomainStatusAction,
  removeCustomDomainAction,
  type CustomDomainsPanel,
  type CustomDomainView,
} from "@/app/actions/custom-domains"

// "Your live website" — surfaces the zero-hosting public sites the OS already
// serves (brokerage /site, team /team, agent /p) right where the tenant edits
// the brand that feeds them. No hosting, no domains — the platform serves it.
// Round 24: + white-label CUSTOM DOMAINS (brokerage tier) — point
// www.theirbrokerage.com at the /site storefront, with live status, the exact
// DNS records to set, and a check-now poll. Lower tiers get an honest
// tier-gated state, never a broken form.

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  pending_dns: { label: "Pending DNS", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  verifying:   { label: "Verifying",   cls: "bg-blue-50 text-blue-700 border-blue-200" },
  active:      { label: "Live",        cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  error:       { label: "Error",       cls: "bg-red-50 text-red-700 border-red-200" },
}

function StatusChip({ status }: { status: string }) {
  const chip = STATUS_CHIP[status] ?? { label: status, cls: "bg-gray-50 text-gray-600 border-gray-200" }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
      {chip.label}
    </span>
  )
}

export function YourWebsiteCard() {
  const [links, setLinks] = useState<PublicSiteLinks | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [panel, setPanel] = useState<CustomDomainsPanel | null>(null)
  const [domainInput, setDomainInput] = useState("")
  const [busy, setBusy] = useState<string | null>(null) // "add" | domain id
  const [domainError, setDomainError] = useState<string | null>(null)

  useEffect(() => {
    getMyPublicSiteLinks().then((r) => { if (r.ok) setLinks(r.links) }).catch(() => {})
    getCustomDomainsPanel().then((r) => { if (r.ok) setPanel(r.panel) }).catch(() => {})
  }, [])

  const entries = [
    links?.brokerageSite && { label: "Brokerage website", ...links.brokerageSite },
    links?.teamSite && { label: "Team website", ...links.teamSite },
    links?.agentProfile && { label: "Agent profile", ...links.agentProfile },
  ].filter(Boolean) as Array<{ label: string; url: string; name: string }>

  if (entries.length === 0 && !panel) return null

  function copy(url: string) {
    navigator.clipboard.writeText(url)
    setCopied(url)
    setTimeout(() => setCopied(null), 2000)
  }

  function patchDomain(next: CustomDomainView) {
    setPanel((p) => p && {
      ...p,
      domains: p.domains.some((d) => d.id === next.id)
        ? p.domains.map((d) => (d.id === next.id ? next : d))
        : [...p.domains, next],
    })
  }

  async function onAdd() {
    if (!domainInput.trim() || busy) return
    setBusy("add"); setDomainError(null)
    try {
      const r = await addCustomDomainAction(domainInput)
      if (r.ok) { patchDomain(r.domain); setDomainInput("") }
      else setDomainError(r.error)
    } catch { setDomainError("Something went wrong — try again") }
    setBusy(null)
  }

  async function onCheck(id: string) {
    if (busy) return
    setBusy(id); setDomainError(null)
    try {
      const r = await checkCustomDomainStatusAction(id)
      if (r.ok) patchDomain(r.domain)
      else setDomainError(r.error)
    } catch { setDomainError("Something went wrong — try again") }
    setBusy(null)
  }

  async function onRemove(id: string) {
    if (busy) return
    setBusy(id); setDomainError(null)
    try {
      const r = await removeCustomDomainAction(id)
      if (r.ok) setPanel((p) => p && { ...p, domains: p.domains.filter((d) => d.id !== id) })
      else setDomainError(r.error)
    } catch { setDomainError("Something went wrong — try again") }
    setBusy(null)
  }

  const showCustomDomains = !!panel && !!links?.brokerageSite

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

      {/* ── Custom domain (white-label, brokerage tier) ─────────────────── */}
      {showCustomDomains && (
        <div className="border-t pt-3 space-y-3">
          <h3 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Custom domain</h3>

          {!panel.tierAllowed ? (
            <p className="text-xs text-gray-600">
              Connecting your own domain (www.yourbrokerage.com) is available on the Brokerage and
              Multi-Location plans. Your site stays live on the platform URL above on every plan.
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-600">
                Point your own domain at your brokerage website. Add both the apex (yourbrokerage.com)
                and www if you want both to work — up to {panel.cap} domains.
              </p>

              {!panel.vercelConfigured && panel.unconfiguredNote && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  {panel.unconfiguredNote}
                </p>
              )}

              {panel.domains.map((d) => (
                <div key={d.id} className="rounded border border-gray-200 p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">{d.domain}</span>
                    <StatusChip status={d.status} />
                    {panel.canManage && (
                      <span className="ml-auto flex items-center gap-2">
                        <button
                          onClick={() => onCheck(d.id)}
                          disabled={busy !== null}
                          className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3 w-3 ${busy === d.id ? "animate-spin" : ""}`} />
                          Check now
                        </button>
                        <button
                          onClick={() => onRemove(d.id)}
                          disabled={busy !== null}
                          className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                          aria-label={`Remove ${d.domain}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </div>

                  {d.status === "error" && d.errorDetail && (
                    <p className="text-[11px] text-red-700">{d.errorDetail}</p>
                  )}

                  {d.status !== "active" && (
                    <div className="space-y-1">
                      <p className="text-[11px] text-gray-600">Set these DNS records at your domain provider:</p>
                      <table className="w-full text-[11px] text-left">
                        <thead>
                          <tr className="text-gray-400">
                            <th className="font-medium pr-2">Type</th>
                            <th className="font-medium pr-2">Name</th>
                            <th className="font-medium">Value</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono text-gray-800">
                          {[...d.dnsRecords, ...d.challenges.map((c) => ({ type: c.type.toUpperCase(), name: c.domain, value: c.value }))].map((r, i) => (
                            <tr key={i}>
                              <td className="pr-2 py-0.5">{r.type}</td>
                              <td className="pr-2 py-0.5 break-all">{r.name}</td>
                              <td className="py-0.5 break-all">
                                {r.value}{" "}
                                <button onClick={() => copy(r.value)} className="text-gray-400 hover:text-gray-700 align-middle" aria-label={`Copy ${r.type} value`}>
                                  {copied === r.value ? <Check className="h-3 w-3 inline text-emerald-600" /> : <Copy className="h-3 w-3 inline" />}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {d.status === "active" && (
                    <p className="text-[11px] text-emerald-700">
                      Live — this domain serves your brokerage website{d.verifiedAt ? ` (verified ${new Date(d.verifiedAt).toLocaleDateString()})` : ""}.
                    </p>
                  )}
                </div>
              ))}

              {panel.canManage && panel.domains.length < panel.cap && (
                <div className="flex items-center gap-2">
                  <input
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") onAdd() }}
                    placeholder="www.yourbrokerage.com"
                    className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    onClick={onAdd}
                    disabled={busy !== null || !domainInput.trim()}
                    className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {busy === "add" ? "Adding…" : "Add domain"}
                  </button>
                </div>
              )}

              {!panel.canManage && (
                <p className="text-[11px] text-gray-500">Only brokerage admins can add or remove domains.</p>
              )}

              {domainError && <p className="text-[11px] text-red-700">{domainError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
