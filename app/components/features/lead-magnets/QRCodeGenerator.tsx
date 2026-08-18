"use client"

import { useState, useTransition } from "react"
import { generateQRCodeAction } from "@/app/actions/lead-magnets-actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { QrCode, Download, Copy, Check, Loader2, ExternalLink } from "lucide-react"

interface Props {
  magnetId: string
  magnetSlug: string
  brokerageId: string
  // No agentId prop: generateQRCodeAction stamps qr_codes.agent_id from the
  // session's agents.id. Callers only have the auth user id, which is the wrong
  // id class for that FK.
  existingQrCodeId?: string
  existingQrImageUrl?: string
}

export function QRCodeGenerator({
  magnetId,
  magnetSlug,
  brokerageId,
  existingQrCodeId,
  existingQrImageUrl,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [qrResult, setQrResult] = useState<{
    qrCodeId: string
    qrImageUrl?: string
    targetUrl?: string
    slug?: string
  } | null>(
    existingQrCodeId
      ? { qrCodeId: existingQrCodeId, qrImageUrl: existingQrImageUrl }
      : null
  )
  const [label, setLabel] = useState(`Lead Magnet: ${magnetSlug}`)
  const [copied, setCopied] = useState(false)

  // Build the landing page URL from current origin
  const targetUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/lm/${magnetSlug}`
      : `/lm/${magnetSlug}`

  // The QR image is a data: URI rendered SERVER-SIDE by the vendored `qrcode` package and handed
  // back by generateQRCodeAction. It used to be an <img> pointed at api.qrserver.com, which sent
  // the lead-bearing landing URL to a third party on every render and made the download button
  // depend on an outside host staying up. Until the code is generated there is nothing to show —
  // and there deliberately is no untracked preview: an image built from the raw landing URL
  // encodes a QR that bypasses /api/qr/scan and records no scan, which is the opposite of what
  // this card promises.
  const qrImageUrl = qrResult?.qrImageUrl ?? null

  function handleGenerate() {
    setError(null)
    startTransition(async () => {
      const result = await generateQRCodeAction({
        magnetId,
        url: targetUrl,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to generate QR code")
        return
      }

      setQrResult({
        qrCodeId: result.qrCode?.id ?? "",
        qrImageUrl: result.qrCode?.image_url,
        targetUrl: result.qrCode?.target_url ?? targetUrl,
        slug: result.qrCode?.slug ?? magnetSlug,
      })
    })
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(targetUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleDownload() {
    if (!qrImageUrl) return
    const a = document.createElement("a")
    a.href = qrImageUrl
    a.download = `lead-magnet-${magnetSlug}-qr.png`
    a.click()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="h-5 w-5" />
          QR Code
        </CardTitle>
        <CardDescription>
          Generate a scannable QR code that links to your lead magnet landing page
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* QR Display */}
        <div className="flex flex-col items-center gap-4 p-6 border rounded-lg bg-muted/20">
          {qrImageUrl ? (
            <img
              src={qrImageUrl}
              alt={`QR code for ${magnetSlug}`}
              className="w-[180px] h-[180px] rounded-lg border bg-white p-2"
            />
          ) : (
            <div className="w-[180px] h-[180px] rounded-lg border bg-white/60 flex flex-col items-center justify-center gap-2 text-center px-4">
              <QrCode className="h-9 w-9 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Generate the code to see it — the image is the tracked one, not a preview.
              </p>
            </div>
          )}
          {qrResult?.qrCodeId && (
            <Badge variant="secondary" className="text-xs">
              Tracked QR Code
            </Badge>
          )}
        </div>

        {/* Landing URL */}
        <div className="space-y-2">
          <Label>Landing Page URL</Label>
          <div className="flex gap-2">
            <Input value={targetUrl} readOnly className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={handleCopy} title="Copy URL">
              {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              asChild
              title="Open landing page"
            >
              <a href={targetUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>

        {/* Label */}
        {!qrImageUrl && (
          <div className="space-y-2">
            <Label htmlFor="qr-label">QR Code Label</Label>
            <Input
              id="qr-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Yard Sign QR Code"
            />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-3">
          {/* Shown whenever we have no image — including for a magnet that ALREADY has a code.
              Minting is idempotent on `lead_magnet:<magnetId>`, so pressing this on an existing
              code returns that same row and its rendered PNG rather than minting a second one. */}
          {!qrImageUrl ? (
            <Button onClick={handleGenerate} disabled={isPending} className="flex-1">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <QrCode className="h-4 w-4 mr-2" />}
              {qrResult?.qrCodeId ? "Show Tracked QR Code" : "Generate Tracked QR Code"}
            </Button>
          ) : (
            <Button variant="outline" onClick={handleDownload} className="flex-1">
              <Download className="h-4 w-4 mr-2" />
              Download QR Code
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Scans are tracked automatically. Each scan is recorded in your analytics.
        </p>
      </CardContent>
    </Card>
  )
}
