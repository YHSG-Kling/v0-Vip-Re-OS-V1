"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Users, UserPlus, MapPin, Clock, QrCode, FileText, Navigation, Loader2 } from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { recordVisitor } from "@/app/actions/open-house-automation"
import { previewOpenHouseQr } from "@/app/actions/kernel-bridges"

interface OpenHouseEvent {
  id: string
  listing_id?: string
  event_date?: string
  start_time?: string
  end_time?: string
  status: string
  description?: string
  qr_code_id?: string
  listings?: {
    address?: string
    city?: string
    state?: string
    list_price?: number
  }
  open_house_attendees?: Array<{
    id: string
    first_name?: string
    last_name?: string
    check_in_time?: string
  }>
}

interface OpenHousePanelProps {
  events: OpenHouseEvent[]
  onEventSelect?: (eventId: string) => void
}

/** The scannable code itself, drawn locally from the qrcode package — the same
 *  renderer and the same scan-tracking URL the agent's desktop QR page uses, so
 *  a code shown at the door counts its scans exactly like a printed one. */
function QRCanvas({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return
      QRCode.toCanvas(canvasRef.current, url, {
        width: 220,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      })
    })
    return () => {
      cancelled = true
    }
  }, [url])

  return <canvas ref={canvasRef} aria-label={`QR code for ${url}`} />
}

export function OpenHousePanel({ events, onEventSelect }: OpenHousePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [visitorForm, setVisitorForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  })
  const [activeEventId, setActiveEventId] = useState<string | null>(null)

  const todaysEvents = events.filter((e) => {
    const eventDate = e.event_date?.split("T")[0]
    const today = new Date().toISOString().split("T")[0]
    return eventDate === today && e.status !== "cancelled"
  })

  const handleAddVisitor = (eventId: string) => {
    if (!visitorForm.firstName || !visitorForm.lastName) {
      toast.error("Please enter visitor name")
      return
    }

    startTransition(async () => {
      const result = await recordVisitor({
        openHouseId: eventId,
        firstName: visitorForm.firstName,
        lastName: visitorForm.lastName,
        email: visitorForm.email || undefined,
        phone: visitorForm.phone || undefined,
      })

      if (result.success) {
        toast.success(`${visitorForm.firstName} ${visitorForm.lastName} checked in`)
        setVisitorForm({ firstName: "", lastName: "", email: "", phone: "" })
        setActiveEventId(null)
      } else {
        toast.error("Failed to add visitor")
      }
    })
  }

  // ── QR CODE ────────────────────────────────────────────────────────────────
  // This button had no handler. previewQrAsset (lib/kernel/marketing) had ZERO
  // callers anywhere, so the code an open house was already provisioned with
  // (open_house_events.qr_code_id) could not be put in front of a visitor from
  // the one screen the agent is holding at the door. previewQrAsset is a kernel
  // function, not a server action — previewOpenHouseQr is the thin "use server"
  // seam, and it resolves the brokerage from the signed-in agent because this
  // panel is only handed `events`.
  const [qrOpen, setQrOpen] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrAsset, setQrAsset] = useState<{
    label: string
    slug: string
    targetUrl: string
    purpose: string
    scanCount: number
    leadCount: number
    isActive: boolean
    expiresAt: string | null
  } | null>(null)

  const handleShowQr = async (qrCodeId: string) => {
    setQrOpen(true)
    setQrLoading(true)
    setQrError(null)
    setQrAsset(null)
    try {
      const result = await previewOpenHouseQr({ qrCodeId })
      // The kernel returns { success, error } and does not throw — a refusal
      // (wrong tenant, deleted code) must show as a refusal, not an empty sheet.
      if (!result.success || !result.qr) {
        setQrError(result.error ?? "This QR code could not be loaded.")
        return
      }
      setQrAsset(result.qr)
    } catch {
      setQrError("This QR code could not be loaded. Check your connection and try again.")
    } finally {
      setQrLoading(false)
    }
  }

  // /api/qr/scan is what the printed codes point at — it counts the scan, then
  // redirects to the code's target. Using it here keeps the numbers honest.
  const qrScanUrl = (slug: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/api/qr/scan?slug=${slug}`

  const handleGetDirections = (address: string) => {
    const encodedAddress = encodeURIComponent(address)
    window.open(`https://maps.google.com/maps?daddr=${encodedAddress}`, "_blank")
  }

  if (todaysEvents.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4 text-purple-500" />
            Today's Open Houses
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No open houses scheduled for today
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4 text-purple-500" />
            Today's Open Houses
          </CardTitle>
          <Badge variant="secondary">{todaysEvents.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {todaysEvents.map((event) => {
          const address = event.listings?.address || "Address TBD"
          const attendeeCount = event.open_house_attendees?.length || 0
          const startTime = event.start_time || "TBD"
          const endTime = event.end_time || "TBD"

          return (
            <div
              key={event.id}
              className="p-3 rounded-lg border bg-purple-50/50 border-purple-100"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{address}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">
                      <Clock className="h-3 w-3 mr-1" />
                      {startTime} - {endTime}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      <Users className="h-3 w-3 mr-1" />
                      {attendeeCount} visitors
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      size="sm"
                      className="flex flex-col items-center gap-1 h-auto py-2 bg-purple-600 hover:bg-purple-700"
                      onClick={() => setActiveEventId(event.id)}
                    >
                      <UserPlus className="h-4 w-4" />
                      <span className="text-xs">Add Visitor</span>
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="h-[400px]">
                    <SheetHeader>
                      <SheetTitle>Quick Check-In</SheetTitle>
                    </SheetHeader>
                    <div className="mt-4 space-y-4">
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="First Name *"
                          value={visitorForm.firstName}
                          onChange={(e) =>
                            setVisitorForm({ ...visitorForm, firstName: e.target.value })
                          }
                        />
                        <Input
                          placeholder="Last Name *"
                          value={visitorForm.lastName}
                          onChange={(e) =>
                            setVisitorForm({ ...visitorForm, lastName: e.target.value })
                          }
                        />
                      </div>
                      <Input
                        placeholder="Email"
                        type="email"
                        value={visitorForm.email}
                        onChange={(e) =>
                          setVisitorForm({ ...visitorForm, email: e.target.value })
                        }
                      />
                      <Input
                        placeholder="Phone"
                        type="tel"
                        value={visitorForm.phone}
                        onChange={(e) =>
                          setVisitorForm({ ...visitorForm, phone: e.target.value })
                        }
                      />
                      <Button
                        className="w-full"
                        onClick={() => handleAddVisitor(event.id)}
                        disabled={isPending}
                      >
                        {isPending ? "Adding..." : "Check In Visitor"}
                      </Button>
                    </div>
                  </SheetContent>
                </Sheet>

                <Button
                  size="sm"
                  variant="outline"
                  className="flex flex-col items-center gap-1 h-auto py-2"
                  onClick={() => handleGetDirections(address)}
                >
                  <Navigation className="h-4 w-4 text-blue-600" />
                  <span className="text-xs">Directions</span>
                </Button>

                {event.qr_code_id && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex flex-col items-center gap-1 h-auto py-2"
                    onClick={() => handleShowQr(event.qr_code_id!)}
                    disabled={qrLoading}
                  >
                    {qrLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-gray-600" />
                    ) : (
                      <QrCode className="h-4 w-4 text-gray-600" />
                    )}
                    <span className="text-xs">QR Code</span>
                  </Button>
                )}
              </div>
            </div>
          )
        })}

        {/* QR preview — the real code, its live scan/lead counts, and where it points */}
        <Sheet open={qrOpen} onOpenChange={setQrOpen}>
          <SheetContent side="bottom" className="h-[520px] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Open House QR Code</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4">
              {qrLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading QR code…
                </div>
              )}

              {!qrLoading && qrError && (
                <p className="text-sm text-red-600 text-center py-8">{qrError}</p>
              )}

              {!qrLoading && !qrError && qrAsset && (
                <>
                  <div className="flex flex-col items-center gap-2">
                    <QRCanvas url={qrScanUrl(qrAsset.slug)} />
                    <p className="text-sm font-medium">{qrAsset.label}</p>
                    <div className="flex items-center gap-2">
                      <Badge variant={qrAsset.isActive ? "secondary" : "outline"} className="text-xs">
                        {qrAsset.isActive ? "Active" : "Inactive"}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {qrAsset.scanCount} scans
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {qrAsset.leadCount} leads
                      </Badge>
                    </div>
                    {qrAsset.expiresAt && (
                      <p className="text-xs text-muted-foreground">
                        Expires {format(new Date(qrAsset.expiresAt), "MMM d, yyyy")}
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg border p-3 space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Scanners land on</p>
                    <p className="text-xs break-all">{qrAsset.targetUrl}</p>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      navigator.clipboard.writeText(qrScanUrl(qrAsset.slug))
                      toast.success("Scan link copied")
                    }}
                  >
                    Copy scan link
                  </Button>
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </CardContent>
    </Card>
  )
}
