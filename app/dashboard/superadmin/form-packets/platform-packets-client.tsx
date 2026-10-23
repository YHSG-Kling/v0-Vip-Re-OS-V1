"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Upload } from "lucide-react"
import { approvePlatformPacketAction, retirePlatformPacketAction, uploadPlatformPacketAction } from "@/app/actions/superadmin/platform-form-packets"

export interface PacketListRow {
  id: string
  name: string
  state: string | null
  packet_type: string
  form_code: string | null
  description: string | null
  file_name: string
  field_count: number
  status: "draft" | "approved" | "retired"
  version: number
  license_note: string | null
  license_expires_at: string | null
  approved_at: string | null
  retired_at: string | null
  retired_reason: string | null
  created_at: string
}

export function PlatformPacketsClient({ packets, packetTypes }: { packets: PacketListRow[]; packetTypes: string[] }) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, start] = useTransition()
  const [notice, setNotice] = useState<string | null>(null)
  const [licenseDraft, setLicenseDraft] = useState<Record<string, { note: string; expires: string }>>({})
  const [retireReason, setRetireReason] = useState<Record<string, string>>({})

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setNotice(null)
    start(async () => {
      const r = await fn()
      setNotice(r.ok ? (r.message ?? "Done.") : `Failed: ${r.error}`)
      if (r.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Load a packet</CardTitle></CardHeader>
        <CardContent>
          <form
            ref={formRef}
            className="grid grid-cols-1 gap-3 md:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              run(async () => { const r = await uploadPlatformPacketAction(fd); if (r.ok) formRef.current?.reset(); return r })
            }}
          >
            <label className="text-sm"><span className="mb-1 block text-xs font-medium">Name</span>
              <input name="name" required minLength={3} className="w-full rounded border px-2 py-1.5 text-sm" placeholder="Residential purchase contract" /></label>
            <label className="text-sm"><span className="mb-1 block text-xs font-medium">Kind</span>
              <select name="packetType" className="w-full rounded border px-2 py-1.5 text-sm" defaultValue="offer">
                {packetTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label className="text-sm"><span className="mb-1 block text-xs font-medium">State (blank = every state)</span>
              <input name="state" maxLength={2} className="w-full rounded border px-2 py-1.5 text-sm uppercase" placeholder="FL" /></label>
            <label className="text-sm"><span className="mb-1 block text-xs font-medium">Association form number (optional)</span>
              <input name="formCode" className="w-full rounded border px-2 py-1.5 text-sm" placeholder="TAR 1601" /></label>
            <label className="text-sm md:col-span-2"><span className="mb-1 block text-xs font-medium">Description (optional)</span>
              <input name="description" className="w-full rounded border px-2 py-1.5 text-sm" /></label>
            <label className="text-sm md:col-span-2"><span className="mb-1 block text-xs font-medium">Fillable PDF (up to 4 MB)</span>
              <input name="file" type="file" accept="application/pdf" required className="w-full text-sm" /></label>
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Upload className="mr-2 h-3 w-3" />}Register as draft
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">A flat or scanned PDF with no form fields is refused. Registering does not publish: approve it below.</p>
        </CardContent>
      </Card>

      {notice && <p className="rounded border bg-muted/40 p-2 text-sm">{notice}</p>}

      <Card>
        <CardHeader><CardTitle>Packets ({packets.length})</CardTitle></CardHeader>
        <CardContent>
          {packets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No packets yet. Subscribers see only what you approve here.</p>
          ) : (
            <ul className="divide-y">
              {packets.map((p) => {
                const draft = licenseDraft[p.id] ?? { note: "", expires: "" }
                return (
                  <li key={p.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      <Badge variant="secondary" className="text-xs">{p.packet_type}</Badge>
                      <Badge variant="secondary" className="text-xs">{p.state ?? "all states"}</Badge>
                      {p.form_code && <Badge variant="outline" className="text-xs">{p.form_code}</Badge>}
                      <Badge className={p.status === "approved" ? "bg-green-100 text-green-900 text-xs" : p.status === "draft" ? "bg-amber-100 text-amber-900 text-xs" : "bg-slate-200 text-slate-800 text-xs"}>{p.status}</Badge>
                      <span className="text-xs text-muted-foreground">{p.field_count} fillable fields · v{p.version} · {p.file_name}</span>
                    </div>
                    {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                    {p.status === "approved" && (
                      <p className="text-xs text-muted-foreground">Licence: {p.license_note}{p.license_expires_at ? ` — expires ${p.license_expires_at}` : ""}</p>
                    )}
                    {p.status === "retired" && <p className="text-xs text-muted-foreground">Retired: {p.retired_reason}</p>}
                    {p.status === "draft" && (
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                        <input
                          className="rounded border px-2 py-1.5 text-sm md:col-span-2" placeholder="Licence basis — who licensed this form to the platform, under what agreement, what it permits"
                          value={draft.note} onChange={(e) => setLicenseDraft({ ...licenseDraft, [p.id]: { ...draft, note: e.target.value } })}
                        />
                        <input
                          type="date" className="rounded border px-2 py-1.5 text-sm" aria-label="Licence expiry (optional)"
                          value={draft.expires} onChange={(e) => setLicenseDraft({ ...licenseDraft, [p.id]: { ...draft, expires: e.target.value } })}
                        />
                        <Button size="sm" disabled={pending || draft.note.trim().length < 20}
                          onClick={() => run(() => approvePlatformPacketAction({ packetId: p.id, licenseNote: draft.note, licenseExpiresAt: draft.expires || null }))}>
                          Approve for all subscribers
                        </Button>
                      </div>
                    )}
                    {p.status !== "retired" && (
                      <div className="flex gap-2">
                        <input
                          className="flex-1 rounded border px-2 py-1.5 text-xs" placeholder="Reason to retire"
                          value={retireReason[p.id] ?? ""} onChange={(e) => setRetireReason({ ...retireReason, [p.id]: e.target.value })}
                        />
                        <Button size="sm" variant="outline" disabled={pending || (retireReason[p.id] ?? "").trim().length < 3}
                          onClick={() => run(() => retirePlatformPacketAction({ packetId: p.id, reason: retireReason[p.id] ?? "" }))}>
                          Retire
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
