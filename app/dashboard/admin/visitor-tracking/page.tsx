'use client'

import { useEffect, useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'

type VisitorRow = {
  id: string
  session_id: string
  page_url: string | null
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  identified_at: string | null
  lead_id: string | null
  contact_id: string | null
}

type Profile = {
  brokerage_id: string
  /** auth user id — used as the agent identifier in the tracking pixel snippet */
  agent_id: string
  user_type: string
}

export default function VisitorTrackingPage() {
  const [profile, setProfile]     = useState<Profile | null>(null)
  const [visitors, setVisitors]   = useState<VisitorRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [copied, setCopied]       = useState(false)
  const [, startTransition]       = useTransition()

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setError('Unauthorized'); setLoading(false); return }

      const { data: prof } = await supabase
        .from('users')
        .select('brokerage_id, user_type')
        .eq('id', user.id)
        .single()

      if (!prof || !['admin', 'broker', 'superadmin'].includes(prof.user_type)) {
        setError('Forbidden')
        setLoading(false)
        return
      }

      // agent_id uses the auth user's id — the pixel snippet scopes tracking to this brokerage+agent
      setProfile({ brokerage_id: prof.brokerage_id ?? '', agent_id: user.id, user_type: prof.user_type })

      const { data: rows, error: fetchErr } = await supabase
        .from('website_visitors')
        .select(
          'id, session_id, page_url, referrer, utm_source, utm_medium, utm_campaign, ' +
          'first_seen_at, last_seen_at, identified_at, lead_id, contact_id'
        )
        .eq('brokerage_id', prof.brokerage_id)
        .order('last_seen_at', { ascending: false })
        .limit(200)

      if (fetchErr) throw new Error(fetchErr.message)
      setVisitors((rows ?? []) as VisitorRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load visitor data')
    } finally {
      setLoading(false)
    }
  }

  // The pixel must be ABSOLUTE. This snippet is pasted into someone else's website, so a
  // relative '/api/track/pixel' resolved against THEIR origin — the request went to
  // https://their-site.com/api/track/pixel, 404'd there, and nothing was ever recorded.
  // The snippet looked right, copied cleanly, and could not work. NEXT_PUBLIC_APP_URL is
  // the canonical origin used elsewhere in the codebase for exactly this.
  const trackingOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")

  const snippet = profile && trackingOrigin
    ? `<script>
(function(b,a){
  var s=localStorage.getItem('_vip')||Math.random().toString(36).slice(2);
  localStorage.setItem('_vip',s);
  new Image().src='${trackingOrigin}/api/track/pixel?b='+b+'&a='+a+'&s='+s
    +'&p='+encodeURIComponent(location.href)
    +'&'+location.search.replace(/^\\?/,'');
})('${profile.brokerage_id}','${profile.agent_id}');
</script>`
    : ''

  function handleCopy() {
    if (!snippet) return
    void navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const total       = visitors.length
  // Most recent activity across the loaded sessions — answers "is the snippet live?".
  const lastSeen = visitors.reduce<string | null>((acc, v) => {
    const t = v.last_seen_at ?? v.first_seen_at
    if (!t) return acc
    return !acc || new Date(t) > new Date(acc) ? t : acc
  }, null)
  const identified  = visitors.filter(v => v.identified_at).length
  const anonymous   = total - identified

  function fmt(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-destructive">{error}</p>
      </div>
    )
  }

  return (
    <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Website Visitor Tracking</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Anonymous pixel tracking. No contact is created on pixel fire — identification
          only occurs when a visitor is matched to an existing lead or contact.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Sessions',  value: total      },
          { label: 'Identified',      value: identified  },
          { label: 'Anonymous',       value: anonymous   },
        ].map(stat => (
          <div key={stat.label} className="border rounded-lg p-4 bg-card">
            <p className="text-sm text-muted-foreground">{stat.label}</p>
            <p className="text-3xl font-bold mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Tracking snippet */}
      <div className="border rounded-lg p-4 bg-card space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Tracking Snippet</h2>
          <button
            onClick={handleCopy}
            className="text-xs px-3 py-1 rounded border hover:bg-muted transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {snippet ? (
          <pre className="text-xs bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {snippet}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {profile
              ? "This snippet needs the app's public URL (NEXT_PUBLIC_APP_URL) to be configured before it can be installed — without it the pixel would point at your own website and record nothing."
              : "Loading your brokerage details…"}
          </p>
        )}

        {/* Real directions. The previous copy told the installer to "replace AGENT_ID",
            but both IDs are already filled in — it described a different snippet than the
            one on screen, which is the walkthrough's "snippet code but no directions". */}
        {snippet && (
          <div className="text-xs text-muted-foreground space-y-2 pt-1">
            <p className="font-medium text-foreground">How to install</p>
            <ol className="list-decimal ml-4 space-y-1">
              <li>Copy the snippet above — your brokerage and agent IDs are already filled in, nothing to edit.</li>
              <li>
                Paste it into your website&apos;s {'<head>'}, on every page you want tracked. On
                WordPress that is Appearance → Theme File Editor → header.php, or any
                header-scripts plugin; on Squarespace, Settings → Advanced → Code Injection → Header;
                on Wix, Settings → Custom Code → Add Code to Head.
              </li>
              <li>Publish the site, then open one of those pages in a normal browser tab.</li>
              <li>Come back here and press Refresh — a new session should appear within a few seconds.</li>
            </ol>
            <p>
              Nothing appearing? The three usual causes are the snippet landing in the body
              instead of the {'<head>'}, the page being cached and serving the old markup, or an
              ad-blocker on the browser you tested with.
            </p>
          </div>
        )}

        {/* Is it actually working? The page already loads the sessions, so it can answer
            the question the installer really has instead of leaving them guessing. */}
        <div className="border-t pt-2 mt-1">
          {total > 0 ? (
            <p className="text-xs text-emerald-700">
              Receiving traffic — {total} {total === 1 ? "session" : "sessions"} recorded
              {lastSeen ? `, most recently ${fmt(lastSeen)}` : ""}.
            </p>
          ) : (
            <p className="text-xs text-amber-700">
              No sessions recorded yet. Until the snippet is installed and a page is visited,
              this stays empty — that is expected, not an error.
            </p>
          )}
        </div>
      </div>

      {/* Visitor table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
          <h2 className="font-medium text-sm">Recent Sessions (last 200)</h2>
          <button
            onClick={() => startTransition(() => { void load() })}
            className="text-xs px-3 py-1 rounded border hover:bg-muted transition-colors"
          >
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-muted-foreground text-xs">
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Page URL</th>
                <th className="text-left px-4 py-2">UTM Source</th>
                <th className="text-left px-4 py-2">UTM Campaign</th>
                <th className="text-left px-4 py-2">First Seen</th>
                <th className="text-left px-4 py-2">Last Seen</th>
                <th className="text-left px-4 py-2">Identified At</th>
              </tr>
            </thead>
            <tbody>
              {visitors.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No visitor sessions yet. Add the tracking snippet to your website.
                  </td>
                </tr>
              )}
              {visitors.map(v => (
                <tr key={v.id} className="border-b hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                      v.identified_at
                        ? 'bg-green-100 text-green-800'
                        : 'bg-zinc-100 text-zinc-600'
                    }`}>
                      {v.identified_at ? 'Identified' : 'Anonymous'}
                    </span>
                  </td>
                  <td className="px-4 py-2 max-w-[200px] truncate" title={v.page_url ?? ''}>
                    {v.page_url ?? '—'}
                  </td>
                  <td className="px-4 py-2">{v.utm_source ?? '—'}</td>
                  <td className="px-4 py-2">{v.utm_campaign ?? '—'}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(v.first_seen_at)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(v.last_seen_at)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(v.identified_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
