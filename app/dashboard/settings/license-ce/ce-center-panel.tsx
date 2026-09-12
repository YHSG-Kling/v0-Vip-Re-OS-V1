"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { GraduationCap, ExternalLink, CheckCircle2, Plug } from "lucide-react"
import { launchCeCourse, connectCeProvider } from "@/app/actions/ce-provider"
import type { CeCenter } from "@/app/actions/ce-provider"

/**
 * In-app CE — accredited courses from the connected provider. The platform is NOT the accreditor; it
 * surfaces the provider's accredited catalog, launches the course, and records the credit the provider
 * reports (into the CE ledger the license-readiness engine reads). Honest empty state when no provider.
 */
export function CeCenterPanel({
  center,
  /**
   * Whether THIS viewer may configure the brokerage's CE provider. Computed
   * server-side from `users.user_type`; it only decides whether to render the
   * form. `connectCeProvider` re-checks the same allowlist server-side, so this
   * prop is a convenience, never the authorization.
   */
  canManageProvider = false,
}: {
  center: CeCenter
  canManageProvider?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)

  // Provider connect form (broker/admin only).
  const [providerName, setProviderName] = useState(center.providerName ?? "")
  const [launchBaseUrl, setLaunchBaseUrl] = useState("")
  const [connected, setConnected] = useState(center.connected)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function saveProvider() {
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      // The action THROWS on refusal (auth, validation, a save that matched
      // nothing) — it never returns a soft failure — so anything that reaches the
      // catch means nothing was stored, and must not be shown as saved.
      await connectCeProvider({
        name: providerName,
        connected,
        launchBaseUrl: launchBaseUrl.trim() || null,
        // The catalog is populated from the provider, not typed here; the action
        // preserves the shape and an empty array is an honest "none cached yet".
        catalog: [],
      })
      setSaved(true)
    } catch (err: any) {
      setSaveError(err?.message ?? "Could not save the CE provider.")
    } finally {
      setSaving(false)
    }
  }

  async function launch(courseId: string) {
    setBusy(courseId)
    try {
      const res = await launchCeCourse(courseId)
      if ("url" in res && res.url) window.open(res.url, "_blank", "noopener,noreferrer")
    } finally { setBusy(null) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" /> Complete CE in-app
          <Badge variant="secondary">{center.progress.completed}/{center.progress.required || "—"} hrs</Badge>
        </CardTitle>
        <CardDescription>
          {center.connected
            ? `Accredited courses via ${center.providerName}. Credit is issued by the provider and posts to your CE record automatically.`
            : "No accredited CE provider is connected yet. Ask your broker to connect one — platform lessons are professional development, not CE credit."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {center.progress.required > 0 && (
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div className="h-full bg-green-500" style={{ width: `${center.progress.pct}%` }} />
          </div>
        )}

        {center.connected && center.courses.length > 0 && (
          <div className="grid gap-2 md:grid-cols-2">
            {center.courses.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 p-3 border rounded-lg">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.title}</div>
                  <div className="text-xs text-muted-foreground capitalize">{c.category.replace("_", " ")} · {c.hours} hr{c.hours === 1 ? "" : "s"}{c.state ? ` · ${c.state}` : ""}</div>
                </div>
                <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => launch(c.id)}>
                  <ExternalLink className="h-4 w-4 mr-1" /> {busy === c.id ? "Opening…" : "Start"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* PROVIDER SETUP — the panel above tells agents to "ask your broker to
            connect one", and until now there was no control anywhere in the app
            for the broker to do it. connectCeProvider had zero callers. */}
        {canManageProvider && (
          <div className="border-t pt-4 space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <Plug className="h-3.5 w-3.5" /> Accredited CE provider
            </h4>
            <p className="text-xs text-muted-foreground">
              VIP Agents does not issue CE credit. Connect your brokerage&apos;s accredited provider so
              agents can launch its courses in-app and completions post to their CE record automatically.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ce-provider-name" className="text-xs">Provider name</Label>
                <Input
                  id="ce-provider-name"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder="e.g. The CE Shop"
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ce-launch-url" className="text-xs">Course launch URL (https)</Label>
                <Input
                  id="ce-launch-url"
                  value={launchBaseUrl}
                  onChange={(e) => setLaunchBaseUrl(e.target.value)}
                  placeholder="https://provider.example.com/sso/launch"
                  disabled={saving}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="ce-connected" checked={connected} onCheckedChange={setConnected} disabled={saving} />
              <Label htmlFor="ce-connected" className="text-xs">
                Live — show these courses to agents
              </Label>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={saveProvider} disabled={saving || !providerName.trim()}>
                {saving ? "Saving…" : "Save provider"}
              </Button>
              {saved && <span className="text-xs text-green-600">Saved. Reload to see the catalog.</span>}
              {saveError && <span className="text-xs text-red-600">{saveError}</span>}
            </div>
          </div>
        )}

        {center.completions.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Completed (accredited)</h4>
            <div className="space-y-1.5">
              {center.completions.slice(0, 8).map((comp, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                  <span className="truncate">{comp.course_name}</span>
                  <span className="text-xs text-muted-foreground">· {comp.hours} hr · {comp.provider}</span>
                  {comp.certificate_url && (
                    <a href={comp.certificate_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline ml-auto">Certificate</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
