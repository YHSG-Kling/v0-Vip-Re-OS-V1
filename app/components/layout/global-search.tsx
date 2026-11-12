'use client'

// Wave 149Z (lane 149E Outside-lane 1): this box used to be an inert <Input> — "Search contacts, listings, leads…" with no
// handler. Wave 149Z made it the trigger for the ⌘K command palette (pages and actions) and labelled it honestly.
//
// WAVE 150 (lane 150QTV — owner ruling R6, 2026-11-06: "Global search finds contacts, listings AND leads — scoped strictly to what
// the signed-in user may see"): the box now searches RECORDS — contacts, listings and leads — through
// app/actions/global-search.ts searchWorkspaceRecords (session tenant + resolveViewerHierarchy office/team scope + assignment +
// the lead-desk rule; an agent never sees the brokerage's raw lead pool). Pages and actions stay on the ⌘K palette
// (app/components/command-palette.tsx), reached from the last row of the results and by ⌘K itself — still one palette, and one
// record search. Every state says what it is: typing, searching, an error in words, "No … yet" per kind, and the reach.
//
// WAVE 151 (lane 151B — directive §151B: "global search must include scoped Transactions and Contacts without making the
// acquisition Lead queue visible to agents"): TRANSACTIONS join the four kinds, scoped by the same action (the books readers
// and the TC tenant-wide, a team lead their team's deals, an agent their own). Leads stay last and stay the lead desk's —
// an agent sees only a lead assigned to them, never the raw pool; the kinds are rendered from the action's result only.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { searchWorkspaceRecords } from '@/app/actions/global-search'
import type { ScopedRecordSearch } from '@/lib/search/scoped-record-search'

function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
}

const KINDS = [
  { key: 'contacts', title: 'Contacts', empty: 'No contacts match yet' },
  { key: 'listings', title: 'Listings', empty: 'No listings match yet' },
  { key: 'transactions', title: 'Transactions', empty: 'No transactions match yet' },
  { key: 'leads', title: 'Leads', empty: 'No leads match yet' },
] as const

export function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScopedRecordSearch | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) { setResult(null); setBusy(false); return }
    const mine = ++seq.current
    setBusy(true)
    const timer = setTimeout(() => {
      searchWorkspaceRecords(term)
        .then((r) => { if (mine === seq.current) setResult(r) })
        .catch(() => { if (mine === seq.current) setResult({ ok: false, error: 'Search is unavailable right now — please try again.' }) })
        .finally(() => { if (mine === seq.current) setBusy(false) })
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <div className="relative w-full" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
      <label htmlFor="global-record-search" className="sr-only">Search contacts, listings, transactions and leads you can see</label>
      <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-gray-500" aria-hidden />
      <input
        id="global-record-search"
        type="search"
        role="combobox"
        aria-expanded={open && query.trim().length >= 2}
        aria-controls="global-record-search-results"
        aria-autocomplete="list"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
        placeholder="Search contacts, listings, transactions, leads…"
        className="h-9 w-full rounded-md border border-gray-200 bg-gray-100 pl-8 pr-10 text-sm text-gray-900 placeholder:text-gray-600"
      />
      <span className="pointer-events-none absolute right-2 top-2.5 text-xs text-gray-600" aria-hidden>⌘K</span>
      {open && query.trim().length >= 2 && (
        <div id="global-record-search-results" role="listbox" aria-busy={busy}
          className="absolute z-50 mt-1 max-h-96 w-full overflow-y-auto rounded-md border border-gray-200 bg-white p-2 text-sm shadow-lg">
          {busy && !result && <p className="px-2 py-1 text-gray-700">Searching…</p>}
          {result && !result.ok && <p role="alert" className="px-2 py-1 text-red-700">{result.error}</p>}
          {result && result.ok && KINDS.map((k) => (
            <div key={k.key} className="mb-2">
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-gray-700">{k.title}</p>
              {result[k.key].length === 0
                ? <p className="px-2 py-1 text-gray-700">{k.empty} <span className="text-gray-600">({result.reach[k.key]})</span></p>
                : result[k.key].map((hit) => (
                  <Link key={hit.id} href={hit.href} role="option" aria-selected={false} onClick={() => setOpen(false)}
                    className="block rounded px-2 py-1 text-gray-900 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none">
                    <span className="font-medium">{hit.label}</span>
                    {hit.detail && <span className="ml-2 text-gray-700">{hit.detail}</span>}
                  </Link>
                ))}
            </div>
          ))}
          <button type="button" onClick={() => { setOpen(false); openCommandPalette() }}
            className="mt-1 w-full rounded px-2 py-1 text-left text-gray-800 hover:bg-gray-100">
            Looking for a page or an action? Open the command palette (⌘K)
          </button>
        </div>
      )}
    </div>
  )
}
