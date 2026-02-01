"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Calendar } from "@/components/ui/calendar"
import {
  CalendarIcon,
  Clock,
  FileText,
  Home,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Download,
  Bell,
  Smartphone,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"

interface PortalCalendarDashboardProps {
  contact: any
  contactId: string
  showings: any[]
  milestones: any[]
  deadlines: any[]
  pendingDocuments: any[]
}

export default function PortalCalendarDashboard({
  contact,
  contactId,
  showings,
  milestones,
  deadlines,
  pendingDocuments,
}: PortalCalendarDashboardProps) {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date())
  const [calendarSyncOpen, setCalendarSyncOpen] = useState(false)

  // Combine all events into a unified list
  const allEvents = [
    ...showings.map((s) => ({
      id: s.id,
      type: "showing" as const,
      title: `Showing: ${s.property_address || "Property Viewing"}`,
      date: s.confirmed_date ? new Date(s.confirmed_date) : null,
      status: s.status,
      icon: Home,
      color: "bg-blue-100 text-blue-800 border-blue-200",
    })),
    ...milestones.map((m) => ({
      id: m.id,
      type: "milestone" as const,
      title: m.milestone_name || m.name || "Milestone",
      date: m.milestone_date ? new Date(m.milestone_date) : null,
      status: m.status,
      icon: CheckCircle2,
      color:
        m.status === "completed"
          ? "bg-green-100 text-green-800 border-green-200"
          : "bg-purple-100 text-purple-800 border-purple-200",
    })),
    ...deadlines.map((d) => ({
      id: d.id,
      type: "deadline" as const,
      title: d.title || d.description || "Deadline",
      date: d.deadline ? new Date(d.deadline) : null,
      status: d.status,
      icon: AlertCircle,
      color: "bg-red-100 text-red-800 border-red-200",
    })),
    ...pendingDocuments.map((d) => ({
      id: d.id,
      type: "document" as const,
      title: `Sign: ${d.name || d.document_type || "Document"}`,
      date: d.due_date ? new Date(d.due_date) : null,
      status: d.status,
      icon: FileText,
      color: "bg-amber-100 text-amber-800 border-amber-200",
    })),
  ].filter((e) => e.date !== null)

  // Get events for selected date
  const selectedDateEvents = selectedDate
    ? allEvents.filter((e) => e.date && e.date.toDateString() === selectedDate.toDateString())
    : []

  // Get upcoming events (next 14 days)
  const now = new Date()
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const upcomingEvents = allEvents
    .filter((e) => e.date && e.date >= now && e.date <= twoWeeksFromNow)
    .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))

  // Get overdue/urgent items
  const urgentItems = allEvents.filter(
    (e) => e.date && e.date < now && e.status !== "completed" && e.status !== "confirmed",
  )

  // Dates with events for calendar highlighting
  const eventDates = allEvents.filter((e) => e.date).map((e) => e.date!.toDateString())

  const generateICalFeed = () => {
    // Generate iCal format
    const icalEvents = allEvents
      .filter((e) => e.date)
      .map((e) => {
        const startDate = e.date!.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"
        return `BEGIN:VEVENT
DTSTART:${startDate}
SUMMARY:${e.title}
DESCRIPTION:${e.type} - ${e.status || "pending"}
END:VEVENT`
      })
      .join("\n")

    const ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Real Estate Portal//Calendar//EN
${icalEvents}
END:VCALENDAR`

    // Download the file
    const blob = new Blob([ical], { type: "text/calendar" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "real-estate-calendar.ics"
    a.click()
    URL.revokeObjectURL(url)
    toast.success("Calendar file downloaded! Import it into your calendar app.")
  }

  const copyCalendarLink = () => {
    // In production, this would be a real webcal:// URL
    const feedUrl = `${window.location.origin}/api/portal/${contactId}/calendar.ics`
    navigator.clipboard.writeText(feedUrl)
    toast.success("Calendar link copied! Paste it in your calendar app.")
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarIcon className="w-6 h-6" />
            My Calendar
          </h1>
          <p className="text-muted-foreground">All your important dates, deadlines, and appointments in one place</p>
        </div>
        <Dialog open={calendarSyncOpen} onOpenChange={setCalendarSyncOpen}>
          <DialogTrigger asChild>
            <Button>
              <Smartphone className="w-4 h-4 mr-2" />
              Sync to My Calendar
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Sync Your Real Estate Calendar</DialogTitle>
              <DialogDescription>
                Stay on top of showings, deadlines, and milestones by syncing with your favorite calendar app
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <Button variant="outline" className="w-full justify-start bg-transparent" onClick={generateICalFeed}>
                <Download className="w-4 h-4 mr-3" />
                Download Calendar File (.ics)
                <span className="ml-auto text-xs text-muted-foreground">Works with all apps</span>
              </Button>
              <Button variant="outline" className="w-full justify-start bg-transparent" onClick={copyCalendarLink}>
                <ExternalLink className="w-4 h-4 mr-3" />
                Copy Calendar Feed URL
                <span className="ml-auto text-xs text-muted-foreground">Auto-updates</span>
              </Button>
              <div className="border rounded-lg p-4 bg-slate-50">
                <h4 className="font-medium mb-2">Quick Add Instructions:</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>
                    <strong>Google Calendar:</strong> Settings → Add calendar → From URL
                  </li>
                  <li>
                    <strong>Apple Calendar:</strong> File → New Calendar Subscription
                  </li>
                  <li>
                    <strong>Outlook:</strong> Add calendar → Subscribe from web
                  </li>
                </ul>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Bell className="w-4 h-4" />
                You'll receive reminders based on your calendar app settings
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Urgent Items Alert */}
      {urgentItems.length > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-red-800 flex items-center gap-2 text-lg">
              <AlertCircle className="w-5 h-5" />
              Action Required ({urgentItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {urgentItems.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-2 bg-white rounded border border-red-100"
                >
                  <div className="flex items-center gap-2">
                    <item.icon className="w-4 h-4 text-red-600" />
                    <span className="text-sm font-medium">{item.title}</span>
                  </div>
                  <Badge variant="destructive">Overdue</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Calendar */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Select Date</CardTitle>
          </CardHeader>
          <CardContent>
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              className="rounded-md border"
              modifiers={{
                hasEvent: (date) => eventDates.includes(date.toDateString()),
              }}
              modifiersStyles={{
                hasEvent: {
                  fontWeight: "bold",
                  backgroundColor: "hsl(var(--primary) / 0.1)",
                  borderRadius: "50%",
                },
              }}
            />
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span>Showings</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-purple-500" />
                <span>Milestones</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span>Deadlines</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-amber-500" />
                <span>Documents</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Events List */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <Tabs defaultValue="upcoming" className="w-full">
              <TabsList>
                <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
                <TabsTrigger value="selected">
                  {selectedDate ? selectedDate.toLocaleDateString() : "Selected Date"}
                </TabsTrigger>
                <TabsTrigger value="all">All Events</TabsTrigger>
              </TabsList>

              <TabsContent value="upcoming" className="mt-4">
                <CardTitle className="mb-4">Next 14 Days</CardTitle>
                {upcomingEvents.length > 0 ? (
                  <div className="space-y-3">
                    {upcomingEvents.map((event) => (
                      <div
                        key={`${event.type}-${event.id}`}
                        className={`flex items-center justify-between p-3 rounded-lg border ${event.color}`}
                      >
                        <div className="flex items-center gap-3">
                          <event.icon className="w-5 h-5" />
                          <div>
                            <p className="font-medium">{event.title}</p>
                            <p className="text-sm opacity-75">
                              {event.date?.toLocaleDateString("en-US", {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                              })}
                              {event.date && (
                                <span className="ml-2">
                                  {event.date.toLocaleTimeString("en-US", {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <Badge variant="outline">{event.type}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <CalendarIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No upcoming events in the next 14 days</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="selected" className="mt-4">
                <CardTitle className="mb-4">
                  Events on{" "}
                  {selectedDate?.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </CardTitle>
                {selectedDateEvents.length > 0 ? (
                  <div className="space-y-3">
                    {selectedDateEvents.map((event) => (
                      <div
                        key={`${event.type}-${event.id}`}
                        className={`flex items-center justify-between p-3 rounded-lg border ${event.color}`}
                      >
                        <div className="flex items-center gap-3">
                          <event.icon className="w-5 h-5" />
                          <div>
                            <p className="font-medium">{event.title}</p>
                            <p className="text-sm opacity-75 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {event.date?.toLocaleTimeString("en-US", {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                        </div>
                        <Badge variant="outline">{event.status || "pending"}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <CalendarIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No events on this date</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="all" className="mt-4">
                <CardTitle className="mb-4">All Scheduled Events</CardTitle>
                {allEvents.length > 0 ? (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {allEvents
                      .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))
                      .map((event) => (
                        <div
                          key={`${event.type}-${event.id}`}
                          className={`flex items-center justify-between p-3 rounded-lg border ${event.color}`}
                        >
                          <div className="flex items-center gap-3">
                            <event.icon className="w-5 h-5" />
                            <div>
                              <p className="font-medium">{event.title}</p>
                              <p className="text-sm opacity-75">
                                {event.date?.toLocaleDateString("en-US", {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </p>
                            </div>
                          </div>
                          <Badge variant="outline">{event.type}</Badge>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <CalendarIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No scheduled events yet</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
}
