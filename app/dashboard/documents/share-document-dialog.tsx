"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Share2, Copy, Check, Users } from "lucide-react"
import { createDocumentShareLink } from "@/app/actions/dotloop-integration"

/**
 * THE SHARE CONTROL — where a team member actually shares a document.
 *
 * This lives on the Document Center row because that is the one surface that
 * already lists every document the agent can see. `createDocumentShareLink` was
 * written for a control like this and never got one, which is why its links had
 * no route and its cap had no column.
 *
 * The copy here states the real boundary rather than implying a public link:
 * the token is a handle for people already inside the brokerage.
 */
export function ShareDocumentDialog({
  documentId,
  documentName,
}: {
  documentId: string
  documentName: string
}) {
  const [open, setOpen] = useState(false)
  const [accessLevel, setAccessLevel] = useState<"view" | "download" | "sign">("view")
  const [expiresInDays, setExpiresInDays] = useState("30")
  const [limitOpens, setLimitOpens] = useState(false)
  const [maxOpens, setMaxOpens] = useState("5")
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [password, setPassword] = useState("")
  const [sharedWithEmail, setSharedWithEmail] = useState("")

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ shareUrl: string; shareToken: string } | null>(null)
  const [copied, setCopied] = useState(false)

  function reset() {
    setResult(null)
    setError(null)
    setCopied(false)
    setPassword("")
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const res = await createDocumentShareLink({
      documentId,
      accessLevel,
      expiresInDays: Number(expiresInDays) || 30,
      sharedWithEmail: sharedWithEmail.trim() || undefined,
      requiresPassword,
      password: requiresPassword ? password : undefined,
      maxAccessCount: limitOpens ? Number(maxOpens) || null : null,
    })
    setBusy(false)

    if (!res.success || !res.shareUrl || !res.link) {
      setError(res.error ?? "Could not create the share link.")
      return
    }
    setResult({ shareUrl: res.shareUrl, shareToken: res.link.shareToken })
  }

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Copy failed — select the link and copy it manually.")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-xs text-blue-600 hover:underline flex items-center gap-1"
          aria-label={`Share ${documentName} with your team`}
        >
          <Share2 className="h-3 w-3" />
          Share
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Share with your team</DialogTitle>
          <DialogDescription className="text-xs">
            <span className="block truncate font-medium text-foreground">{documentName}</span>
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Users className="h-3.5 w-3.5 mt-px shrink-0 text-green-600" />
              Anyone in your brokerage who is signed in can open this. People outside it are
              refused even with the link.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={result.shareUrl} className="text-xs" />
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <Link
              href={`/documents/shared/${result.shareToken}`}
              target="_blank"
              className="text-xs text-blue-600 hover:underline"
            >
              Preview the shared view
            </Link>
            {limitOpens && (
              <p className="text-[11px] text-amber-700">
                Previewing counts as one of the {maxOpens} permitted opens.
              </p>
            )}
            <Button size="sm" variant="outline" onClick={reset} className="w-full">
              Create another link
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">They can</Label>
                <Select value={accessLevel} onValueChange={(v) => setAccessLevel(v as typeof accessLevel)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">View</SelectItem>
                    <SelectItem value="download">Download</SelectItem>
                    <SelectItem value="sign">Sign</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="share-expiry" className="text-xs">
                  Expires in (days)
                </Label>
                <Input
                  id="share-expiry"
                  type="number"
                  min={1}
                  max={365}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="share-email" className="text-xs">
                Notify teammate (optional)
              </Label>
              <Input
                id="share-email"
                type="email"
                placeholder="teammate@brokerage.com"
                value={sharedWithEmail}
                onChange={(e) => setSharedWithEmail(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="flex items-center justify-between rounded border p-2.5">
              <div className="space-y-0.5 pr-3">
                <Label className="text-xs">Limit total opens</Label>
                <p className="text-[11px] text-muted-foreground">
                  Enforced on every open — the link stops working at the limit.
                </p>
              </div>
              <Switch checked={limitOpens} onCheckedChange={setLimitOpens} />
            </div>
            {limitOpens && (
              <Input
                type="number"
                min={1}
                value={maxOpens}
                onChange={(e) => setMaxOpens(e.target.value)}
                className="h-9 text-xs"
                aria-label="Maximum opens"
              />
            )}

            <div className="flex items-center justify-between rounded border p-2.5">
              <div className="space-y-0.5 pr-3">
                <Label className="text-xs">Require a password</Label>
                <p className="text-[11px] text-muted-foreground">
                  Stored hashed (scrypt) — never in plain text.
                </p>
              </div>
              <Switch checked={requiresPassword} onCheckedChange={setRequiresPassword} />
            </div>
            {requiresPassword && (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Password to share separately"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 text-xs"
                aria-label="Share password"
              />
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}

            <Button
              size="sm"
              className="w-full"
              onClick={submit}
              disabled={busy || (requiresPassword && password.length === 0)}
            >
              {busy ? "Creating…" : "Create team link"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
