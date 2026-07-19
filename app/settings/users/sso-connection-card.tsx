"use client"

// Settings → Users → "SSO / SAML" card. Lives on the Users surface because
// SSO is TEAM ACCESS policy — who signs in and how — and this page is already
// the brokerage-admin-gated access-management home (roles, seats). The
// brokerage connects its IdP's SAML metadata to its email domain; states are
// honest end-to-end: Pending (registration not run), Active (Supabase
// returned a provider id — never faked), Error (incl. the flagship "SAML is
// not enabled on this Supabase project" plan boundary), Disabled, and a
// tier-gated message for plans below Brokerage.

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { KeyRound, Copy, Check, RefreshCw, Loader2 } from "lucide-react"
import {
  getSsoPanel,
  configureSsoAction,
  checkSsoStatusAction,
  disableSsoAction,
  type SsoPanel,
  type SsoConnectionView,
} from "@/app/actions/tenant-sso"

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  active:   { label: "Active",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  disabled: { label: "Disabled", cls: "bg-gray-50 text-gray-600 border-gray-200" },
  error:    { label: "Error",    cls: "bg-red-50 text-red-700 border-red-200" },
}

function StatusChip({ status }: { status: string }) {
  const chip = STATUS_CHIP[status] ?? { label: status, cls: "bg-gray-50 text-gray-600 border-gray-200" }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
      {chip.label}
    </span>
  )
}

export function SsoConnectionCard() {
  const [panel, setPanel] = useState<SsoPanel | null>(null)
  const [emailDomain, setEmailDomain] = useState("")
  const [metadataUrl, setMetadataUrl] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<"save" | "check" | "disable" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    getSsoPanel().then((r) => { if (r.ok) setPanel(r.panel) }).catch(() => {})
  }, [])

  if (!panel) return null

  const conn = panel.connection
  const showForm = panel.canManage && panel.tierAllowed && (editing || !conn)

  function copy(value: string) {
    navigator.clipboard.writeText(value)
    setCopied(value)
    setTimeout(() => setCopied(null), 2000)
  }

  function applyConnection(next: SsoConnectionView) {
    setPanel((p) => p && { ...p, connection: next })
  }

  async function onSave() {
    if (busy) return
    setBusy("save"); setError(null)
    try {
      const r = await configureSsoAction(emailDomain, metadataUrl)
      if (r.ok) { applyConnection(r.connection); setEditing(false); setEmailDomain(""); setMetadataUrl("") }
      else setError(r.error)
    } catch { setError("Something went wrong — try again") }
    setBusy(null)
  }

  async function onCheck() {
    if (busy) return
    setBusy("check"); setError(null)
    try {
      const r = await checkSsoStatusAction()
      if (r.ok) applyConnection(r.connection)
      else setError(r.error)
    } catch { setError("Something went wrong — try again") }
    setBusy(null)
  }

  async function onDisable() {
    if (busy) return
    setBusy("disable"); setError(null)
    try {
      const r = await disableSsoAction()
      if (r.ok) applyConnection(r.connection)
      else setError(r.error)
    } catch { setError("Something went wrong — try again") }
    setBusy(null)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-indigo-600" />
          <CardTitle className="text-base">SSO / SAML</CardTitle>
          {conn && <StatusChip status={conn.status} />}
        </div>
        <CardDescription>
          Let everyone on your brokerage's email domain sign in through your identity provider
          (Okta, Microsoft Entra ID, Google Workspace…). Password and magic-link sign-in stay available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!panel.tierAllowed ? (
          <p className="text-sm text-muted-foreground">
            Enterprise SSO is available on the Brokerage and Multi-Location plans. On {panel.tierLabel}{" "}
            plan, your team signs in with email &amp; password or magic links — nothing about sign-in breaks
            on any plan.
          </p>
        ) : (
          <>
            {!panel.adminConfigured && panel.unconfiguredNote && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-2">
                {panel.unconfiguredNote}
              </p>
            )}

            {/* ── Existing connection ─────────────────────────────────── */}
            {conn && !editing && (
              <div className="rounded border p-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{conn.emailDomain}</span>
                  <StatusChip status={conn.status} />
                  {panel.canManage && (
                    <span className="ml-auto flex items-center gap-2">
                      <button
                        onClick={onCheck}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3 w-3 ${busy === "check" ? "animate-spin" : ""}`} />
                        Check status
                      </button>
                      <button
                        onClick={() => {
                          setEditing(true)
                          setEmailDomain(conn.emailDomain)
                          setMetadataUrl(conn.metadataUrl)
                          setError(null)
                        }}
                        disabled={busy !== null}
                        className="text-[11px] text-gray-600 hover:text-gray-900 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      {conn.status !== "disabled" && (
                        <button
                          onClick={onDisable}
                          disabled={busy !== null}
                          className="text-[11px] text-red-600 hover:text-red-800 disabled:opacity-50"
                        >
                          {busy === "disable" ? "Disabling…" : "Disable"}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground break-all">Metadata: {conn.metadataUrl}</p>

                {conn.status === "active" && (
                  <p className="text-xs text-emerald-700">
                    Active — sign-ins from @{conn.emailDomain} can use "Sign in with SSO" on the login page
                    {conn.activatedAt ? ` (since ${new Date(conn.activatedAt).toLocaleDateString()})` : ""}.
                  </p>
                )}
                {conn.status === "pending" && (
                  <p className="text-xs text-amber-700">
                    Saved but not yet registered with the identity backend — use Check status to retry
                    once registration is available.
                  </p>
                )}
                {conn.status === "disabled" && (
                  <p className="text-xs text-muted-foreground">
                    Disabled — SSO is not offered at login. Edit and save to re-enable.
                  </p>
                )}
                {conn.status === "error" && conn.errorDetail && (
                  <p className="text-xs text-red-700">{conn.errorDetail}</p>
                )}
              </div>
            )}

            {/* ── Configure form ──────────────────────────────────────── */}
            {showForm && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sso-domain">Company email domain</Label>
                  <Input
                    id="sso-domain"
                    placeholder="yourbrokerage.com"
                    value={emailDomain}
                    onChange={(e) => setEmailDomain(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    The domain after the @ in your team's work email. Public providers (gmail.com,
                    yahoo.com…) can't be used — SSO claims every sign-in on the domain.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sso-metadata">IdP SAML metadata URL</Label>
                  <Input
                    id="sso-metadata"
                    placeholder="https://your-idp.example.com/app/metadata.xml"
                    value={metadataUrl}
                    onChange={(e) => setMetadataUrl(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    From your identity provider's SAML app — https only.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={onSave} disabled={busy !== null || !emailDomain.trim() || !metadataUrl.trim()} size="sm">
                    {busy === "save" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {conn ? "Save & re-register" : "Connect SSO"}
                  </Button>
                  {conn && (
                    <Button variant="outline" size="sm" onClick={() => { setEditing(false); setError(null) }} disabled={busy !== null}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            )}

            {!panel.canManage && (
              <p className="text-xs text-muted-foreground">Only brokerage admins can configure SSO.</p>
            )}

            {error && <p className="text-xs text-red-700">{error}</p>}

            {/* ── IdP setup values ────────────────────────────────────── */}
            {panel.canManage && (panel.acsUrl || panel.entityId) && (
              <div className="border-t pt-3 space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Values for your identity provider
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Create a SAML app in your IdP and paste these in, then save the app's metadata URL above.
                </p>
                {[
                  panel.acsUrl && { label: "ACS URL (Single Sign-On URL)", value: panel.acsUrl },
                  panel.entityId && { label: "Entity ID (Audience URI)", value: panel.entityId },
                ].filter(Boolean).map((entry) => {
                  const e = entry as { label: string; value: string }
                  return (
                    <div key={e.label} className="text-[11px]">
                      <span className="text-muted-foreground">{e.label}</span>
                      <div className="font-mono text-gray-800 break-all flex items-center gap-1">
                        {e.value}
                        <button onClick={() => copy(e.value)} className="text-gray-400 hover:text-gray-700 shrink-0" aria-label={`Copy ${e.label}`}>
                          {copied === e.value ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    </div>
                  )
                })}
                <p className="text-[11px] text-muted-foreground">
                  SAML sign-in runs on the platform's Supabase project and requires its Pro plan with the
                  SAML add-on — if it isn't enabled, the connection shows an honest Error state instead of
                  pretending to work.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
