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
        .from('user_profiles')
        .select('brokerage_id, agent_id: id, user_type')
        .eq('id', user.id)
        .single()

      if (!prof || !['admin', 'broker', 'superadmin'].includes(prof.user_type)) {
        setError('Forbidden')
        setLoading(false)
        return
      }

      setProfile({ ...prof, brokerage_id: prof.brokerage_id ?? '' } as Profile)

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

  const snippet = profile
    ? `<script>
(function(b,a){
  var s=localStorage.getItem('_vip')||Math.random().toString(36).slice(2);
  localStorage.setItem('_vip',s);
  new Image().src='/api/track/pixel?b='+b+'&a='+a+'&s='+s
    +'&p='+encodeURIComponent(location.href);
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
        <pre className="text-xs bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
          {snippet}
        </pre>
        <p className="text-xs text-muted-foreground">
          Paste this snippet into the {'<head>'} of your website. The BROKERAGE_ID is pre-filled.
          Replace AGENT_ID if you want attribution to a specific agent.
        </p>
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
