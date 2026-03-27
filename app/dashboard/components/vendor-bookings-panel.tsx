"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Wrench, CalendarDays, CheckCircle2, XCircle, AlertCircle } from "lucide-react"
import { transitionBookingStatus, type VendorBookingStatus } from "@/app/actions/ai-vendor-management"
import { cn } from "@/lib/utils"

export type VendorBookingRow = {
  id: string
  service_type: string | null
  status: string | null
  scheduled_date: string | null
  notes: string | null
  contact_id: string | null
  listing_id: string | null
  vendors: { name: string } | null
}

interface VendorBookingsPanelProps {
  bookings: VendorBookingRow[]
}

const STATUS_CONFIG: Record<string, { label: string; variant: string; icon: React.ReactNode }> = {
  booked:    { label: "Booked",     variant: "secondary",    icon: <CalendarDays className="h-3 w-3" /> },
  confirmed: { label: "Confirmed",  variant: "default",      icon: <CheckCircle2 className="h-3 w-3 text-blue-600" /> },
  completed: { label: "Completed",  variant: "outline",      icon: <CheckCircle2 className="h-3 w-3 text-green-600" /> },
  cancelled: { label: "Cancelled",  variant: "destructive",  icon: <XCircle className="h-3 w-3" /> },
  no_show:   { label: "No Show",    variant: "destructive",  icon: <AlertCircle className="h-3 w-3" /> },
}

export function VendorBookingsPanel({ bookings }: VendorBookingsPanelProps) {
  const [statuses, setStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(bookings.map(b => [b.id, b.status ?? "booked"]))
  )
  const [pending, setPending] = useState<Record<string, boolean>>({})

  async function handleTransition(bookingId: string, toStatus: VendorBookingStatus) {
    setPending(p => ({ ...p, [bookingId]: true }))
    const result = await transitionBookingStatus({ bookingId, toStatus })
    if (result.success) {
      setStatuses(s => ({ ...s, [bookingId]: toStatus }))
    }
    setPending(p => ({ ...p, [bookingId]: false }))
  }

  if (!bookings.length) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          Vendor Bookings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {bookings.map(booking => {
          const currentStatus = statuses[booking.id] ?? "booked"
          const config = STATUS_CONFIG[currentStatus] ?? STATUS_CONFIG.booked
          const isLoading = pending[booking.id]

          return (
            <div
              key={booking.id}
              className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm"
            >
              {/* Row: vendor name + service + status badge */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium leading-tight">
                    {booking.vendors?.name ?? "Unknown Vendor"}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {booking.service_type?.replace(/_/g, " ") ?? "Service"}
                  </p>
                </div>
                <Badge
                  variant={config.variant as any}
                  className="flex items-center gap-1 shrink-0 text-xs"
                >
                  {config.icon}
                  {config.label}
                </Badge>
              </div>

              {/* Scheduled date + notes */}
              {(booking.scheduled_date || booking.notes) && (
                <div className="space-y-0.5">
                  {booking.scheduled_date && (
                    <p className="text-xs text-muted-foreground">
                      Scheduled:{" "}
                      {new Date(booking.scheduled_date).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  )}
                  {booking.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{booking.notes}</p>
                  )}
                </div>
              )}

              {/* Action buttons — only for actionable statuses */}
              {!["completed", "cancelled", "no_show"].includes(currentStatus) && (
                <div className="flex gap-2">
                  {currentStatus === "booked" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={isLoading}
                      onClick={() => handleTransition(booking.id, "confirmed")}
                    >
                      Mark Confirmed
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn("h-7 text-xs", currentStatus === "confirmed" && "border-green-300 text-green-700 hover:bg-green-50")}
                    disabled={isLoading}
                    onClick={() => handleTransition(booking.id, "completed")}
                  >
                    Mark Complete
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
