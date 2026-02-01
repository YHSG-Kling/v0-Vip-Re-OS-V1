"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MapPin, Calendar, Clock, User, DollarSign, FileText } from "lucide-react"
import { updateVendorBookingStatus_v2 , submitVendorInvoice } from "@/app/actions/multi-persona"

interface Booking {
  id: string
  service_type: string
  scheduled_date: string
  scheduled_time: string
  status: string
  cost: number
  payment_status: string
  notes: string
  transactions?: {
    property_address: string
    agents?: {
      first_name: string
      last_name: string
      email: string
      phone: string
    }
  }
}

export function VendorBookingsList({ bookings }: { bookings: Booking[] }) {
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false)
  const [newStatus, setNewStatus] = useState("")
  const [notes, setNotes] = useState("")
  const [invoiceAmount, setInvoiceAmount] = useState("")
  const [isPending, startTransition] = useTransition()

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-100 text-green-800"
      case "scheduled":
        return "bg-blue-100 text-blue-800"
      case "in_progress":
        return "bg-purple-100 text-purple-800"
      case "cancelled":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getPaymentColor = (status: string) => {
    switch (status) {
      case "paid":
        return "text-green-600"
      case "invoiced":
        return "text-orange-600"
      default:
        return "text-muted-foreground"
    }
  }

  const handleUpdateStatus = () => {
    if (!selectedBooking || !newStatus) return

    startTransition(async () => {
      await updateVendorBookingStatus({
        bookingId: selectedBooking.id,
        status: newStatus,
        notes,
      })
      setUpdateDialogOpen(false)
      setNewStatus("")
      setNotes("")
      setSelectedBooking(null)
    })
  }

  const handleSubmitInvoice = () => {
    if (!selectedBooking || !invoiceAmount) return

    startTransition(async () => {
      await submitVendorInvoice({
        bookingId: selectedBooking.id,
        invoiceAmount: parseFloat(invoiceAmount),
        invoiceUrl: "",
        invoiceDetails: { notes },
      })
      setInvoiceDialogOpen(false)
      setInvoiceAmount("")
      setNotes("")
      setSelectedBooking(null)
    })
  }

  const upcomingBookings = bookings.filter((b) => b.status === "scheduled" && new Date(b.scheduled_date) >= new Date())
  const completedBookings = bookings.filter((b) => b.status === "completed")
  const allBookings = bookings

  const renderBookingCard = (booking: Booking) => (
    <div key={booking.id} className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={getStatusColor(booking.status)}>{booking.status?.replace(/_/g, " ")}</Badge>
            <Badge variant="outline">{booking.service_type?.replace(/_/g, " ")}</Badge>
            {booking.payment_status && (
              <span className={`text-xs ${getPaymentColor(booking.payment_status)}`}>
                {booking.payment_status === "paid" ? "Paid" : booking.payment_status === "invoiced" ? "Invoiced" : "Pending"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{booking.transactions?.property_address || "Address TBD"}</span>
          </div>

          <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {new Date(booking.scheduled_date).toLocaleDateString()}
            </span>
            {booking.scheduled_time && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {booking.scheduled_time}
              </span>
            )}
            {booking.transactions?.agents && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {booking.transactions.agents.first_name} {booking.transactions.agents.last_name}
              </span>
            )}
            {booking.cost && (
              <span className="flex items-center gap-1">
                <DollarSign className="h-3 w-3" />${booking.cost}
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          {booking.status !== "completed" && booking.status !== "cancelled" && (
            <Button
              variant="outline"
              size="sm"
              className="bg-transparent"
              onClick={() => {
                setSelectedBooking(booking)
                setNewStatus(booking.status)
                setUpdateDialogOpen(true)
              }}
            >
              Update
            </Button>
          )}
          {booking.status === "completed" && booking.payment_status !== "paid" && (
            <Button
              variant="outline"
              size="sm"
              className="bg-transparent"
              onClick={() => {
                setSelectedBooking(booking)
                setInvoiceAmount(booking.cost?.toString() || "")
                setInvoiceDialogOpen(true)
              }}
            >
              <FileText className="h-4 w-4 mr-1" />
              Invoice
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Service Bookings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="upcoming">
            <TabsList>
              <TabsTrigger value="upcoming">Upcoming ({upcomingBookings.length})</TabsTrigger>
              <TabsTrigger value="completed">Completed ({completedBookings.length})</TabsTrigger>
              <TabsTrigger value="all">All ({allBookings.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="upcoming" className="mt-4 space-y-3">
              {upcomingBookings.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No upcoming bookings</div>
              ) : (
                upcomingBookings.map(renderBookingCard)
              )}
            </TabsContent>

            <TabsContent value="completed" className="mt-4 space-y-3">
              {completedBookings.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No completed bookings</div>
              ) : (
                completedBookings.map(renderBookingCard)
              )}
            </TabsContent>

            <TabsContent value="all" className="mt-4 space-y-3">
              {allBookings.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No bookings</div>
              ) : (
                allBookings.map(renderBookingCard)
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Update Status Dialog */}
      <Dialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Booking Status</DialogTitle>
            <DialogDescription>{selectedBooking?.transactions?.property_address}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={newStatus} onValueChange={setNewStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea placeholder="Add notes..." value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button onClick={handleUpdateStatus} disabled={isPending}>
              {isPending ? "Updating..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Dialog */}
      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit Invoice</DialogTitle>
            <DialogDescription>{selectedBooking?.transactions?.property_address}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Invoice Amount ($)</Label>
              <Input
                type="number"
                placeholder="Enter amount"
                value={invoiceAmount}
                onChange={(e) => setInvoiceAmount(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Invoice details..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button onClick={handleSubmitInvoice} disabled={isPending || !invoiceAmount}>
              {isPending ? "Submitting..." : "Submit Invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
