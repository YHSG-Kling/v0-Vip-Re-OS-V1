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
  agentId: string
  existingQrCodeId?: string
  existingQrImageUrl?: string
}

export function QRCodeGenerator({
  magnetId,
  magnetSlug,
  brokerageId,
  agentId,
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

  // QR API URL using qrserver.com — no auth token needed, purely URL-based
  const qrApiUrl = qrResult?.qrImageUrl
    ?? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(targetUrl)}&format=png&margin=10`

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
        qrImageUrl: result.qrCode?.qr_image_url ?? undefined,
        targetUrl,
        slug: magnetSlug,
      })
    })
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(targetUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleDownload() {
    const a = document.createElement("a")
    a.href = qrApiUrl
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
          <img
            src={qrApiUrl}
            alt={`QR code for ${magnetSlug}`}
            className="w-[180px] h-[180px] rounded-lg border bg-white p-2"
          />
          {qrResult && (
            <Badge variant="secondary" className="text-xs">
              {qrResult.qrCodeId ? "Tracked QR Code" : "Preview"}
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
        {!qrResult && (
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
          {!qrResult ? (
            <Button onClick={handleGenerate} disabled={isPending} className="flex-1">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <QrCode className="h-4 w-4 mr-2" />}
              Generate Tracked QR Code
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
