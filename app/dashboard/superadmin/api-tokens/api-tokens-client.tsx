"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog"
import { KeyRound, Loader2, Copy, Check, Ban } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { mintAgenticToken, revokeAgenticToken } from "@/app/actions/agentic-tokens"

/** Canonical AGIS action scopes (mirrors lib/agentic-os app-capability-registry). */
const SCOPES = [
  "*",
  "lead:read", "lead:write", "lead:qualify",
  "contact:read", "listing:write", "transaction:write",
  "cma:write", "valuation:read",
  "comms:write", "comms:voice", "marketing:write", "marketing:send", "social:write", "content:write",
  "calendar:write", "finance:write", "gifting:write", "reputation:write",
  "portal:read", "reporting:read", "education:read", "education:write", "connectivity:read",
] as const

type TokenRow = {
  id: string
  name: string
  scopes: string[]
  brokerage_id: string | null
  is_active: boolean
  created_at: string
  last_used_at: string | null
}

export function ApiTokensClient({ initialRows, loadError }: { initialRows: TokenRow[]; loadError: string | null }) {
  const { toast } = useToast()
  const router = useRouter()
  const [rows, setRows] = useState<TokenRow[]>(initialRows)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [brokerageId, setBrokerageId] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set(["lead:read"]))
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  function toggleScope(s: string) {
    setPicked((cur) => {
      const next = new Set(cur)
      if (s === "*") return next.has("*") ? new Set<string>() : new Set(["*"])
      next.delete("*")
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }

  async function mint() {
    if (!name.trim()) { toast({ title: "Name the token", variant: "destructive" }); return }
    if (picked.size === 0) { toast({ title: "Pick at least one scope", variant: "destructive" }); return }
    setBusy(true)
    try {
      const r = await mintAgenticToken({
        name: name.trim(),
        scopes: Array.from(picked),
        brokerageId: brokerageId.trim() || null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      })
      if (r.ok) {
        setMinted(r.token)
        toast({ title: "Token minted", description: "Copy it now — it is shown only once." })
        router.refresh()
      } else {
        toast({ title: "Mint failed", description: r.error, variant: "destructive" })
      }
    } finally { setBusy(false) }
  }

  async function revoke(id: string) {
    setRevoking(id)
    try {
      const r = await revokeAgenticToken(id)
      if (r.ok) {
        setRows((cur) => cur.map((x) => (x.id === id ? { ...x, is_active: false } : x)))
        toast({ title: "Token revoked" })
      } else {
        toast({ title: "Revoke failed", description: r.error, variant: "destructive" })
      }
    } finally { setRevoking(null) }
  }

  function resetDialog() {
    setName(""); setBrokerageId(""); setExpiresAt(""); setPicked(new Set(["lead:read"])); setMinted(null); setCopied(false)
  }

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><KeyRound className="h-5 w-5" />Agentic-API Tokens</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Bearer credentials for external agents/MCP clients invoking AGIS capabilities. Scopes gate which
            actions a token may call; the raw token is shown once at mint and only its hash is stored.
          </p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetDialog() }}>
          <DialogTrigger asChild>
            <Button><KeyRound className="h-4 w-4 mr-1" />Mint Token</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            {minted ? (
              <>
                <DialogHeader>
                  <DialogTitle>Token minted — copy it now</DialogTitle>
                  <DialogDescription>This is the only time the raw token is shown. Store it securely.</DialogDescription>
                </DialogHeader>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-muted rounded p-2 break-all">{minted}</code>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(minted); setCopied(true) }}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <DialogFooter>
                  <Button onClick={() => { setOpen(false); resetDialog() }}>Done</Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Mint an Agentic-API Token</DialogTitle>
                  <DialogDescription>Scope it narrowly. Leave brokerage blank for a platform-wide token.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="tok-name">Name</Label>
                    <Input id="tok-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Zapier lead sync" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="tok-brokerage">Brokerage ID (optional)</Label>
                      <Input id="tok-brokerage" value={brokerageId} onChange={(e) => setBrokerageId(e.target.value)} placeholder="uuid or blank" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="tok-exp">Expires (optional)</Label>
                      <Input id="tok-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Scopes</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-52 overflow-y-auto rounded border p-2">
                      {SCOPES.map((s) => (
                        <label key={s} className="flex items-center gap-2 text-xs">
                          <Checkbox checked={picked.has(s)} onCheckedChange={() => toggleScope(s)} />
                          <span className={s === "*" ? "font-semibold" : ""}>{s === "*" ? "* (all)" : s}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={mint} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Mint</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {loadError && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm text-destructive">Could not load tokens: {loadError}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tokens · {rows.length}</CardTitle>
          <CardDescription>Active tokens authenticate AGIS calls. Revoking is immediate.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No tokens yet — mint one to let an external agent call the AGIS API.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Scopes</th>
                    <th className="py-2 pr-4 font-medium">Brokerage</th>
                    <th className="py-2 pr-4 font-medium">Last used</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 font-medium">{r.name}</td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {r.scopes.map((s) => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">{r.brokerage_id ?? "platform-wide"}</td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">{r.last_used_at ? new Date(r.last_used_at).toLocaleDateString() : "never"}</td>
                      <td className="py-2 pr-4">
                        <Badge className={r.is_active ? "bg-emerald-100 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-500 border-gray-200"}>
                          {r.is_active ? "active" : "revoked"}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">
                        {r.is_active && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(r.id)} disabled={revoking === r.id}>
                            {revoking === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Ban className="h-3 w-3 mr-1" />}Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
