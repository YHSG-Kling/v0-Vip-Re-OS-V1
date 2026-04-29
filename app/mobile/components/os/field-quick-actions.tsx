"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Phone, MessageSquare, Clock, FileText, Navigation, User } from "lucide-react"
import { toast } from "sonner"
import { logActivity } from "@/app/actions/activities"

interface FieldQuickActionsProps {
  agentId: string
  contacts?: Array<{
    id: string
    first_name: string
    last_name: string
    phone?: string
    email?: string
  }>
}

export function FieldQuickActions({ agentId, contacts = [] }: FieldQuickActionsProps) {
  const [isPending, startTransition] = useTransition()
  const [noteContent, setNoteContent] = useState("")
  const [selectedContact, setSelectedContact] = useState<string | null>(null)

  const handleCall = (phone: string) => {
    window.location.href = `tel:${phone}`
  }

  const handleText = (phone: string) => {
    window.location.href = `sms:${phone}`
  }

  const handleLogFollowup = (contactId: string, contactName: string) => {
    startTransition(async () => {
      const result = await logActivity({
        brokerageId: "",
        agentId,
        contactId,
        activityType: "follow_up",
        title: `Follow-up with ${contactName}`,
        description: noteContent || "Quick follow-up logged from field",
        status: "completed",
      })

      if (result.success) {
        toast.success("Follow-up logged successfully")
        setNoteContent("")
        setSelectedContact(null)
      } else {
        toast.error("Failed to log follow-up")
      }
    })
  }

  const handleQuickNote = () => {
    if (!noteContent.trim()) {
      toast.error("Please enter a note")
      return
    }

    startTransition(async () => {
      const result = await logActivity({
        brokerageId: "",
        agentId,
        contactId: selectedContact || undefined,
        activityType: "note",
        title: "Quick Field Note",
        description: noteContent,
        status: "completed",
      })

      if (result.success) {
        toast.success("Note saved")
        setNoteContent("")
      } else {
        toast.error("Failed to save note")
      }
    })
  }

  const handleDirections = (address: string) => {
    const encodedAddress = encodeURIComponent(address)
    window.open(`https://maps.google.com/maps?daddr=${encodedAddress}`, "_blank")
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          Quick Field Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Note Input */}
        <div className="space-y-2">
          <Textarea
            placeholder="Quick note or follow-up..."
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            className="min-h-[60px] text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={handleQuickNote}
              disabled={isPending || !noteContent.trim()}
            >
              <FileText className="h-3 w-3 mr-1" />
              Save Note
            </Button>
          </div>
        </div>

        {/* Recent Contacts Quick Access */}
        {contacts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium">Quick Contact</p>
            <div className="space-y-1">
              {contacts.slice(0, 3).map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {contact.first_name} {contact.last_name}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {contact.phone && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => handleCall(contact.phone!)}
                        >
                          <Phone className="h-3 w-3 text-green-600" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => handleText(contact.phone!)}
                        >
                          <MessageSquare className="h-3 w-3 text-blue-600" />
                        </Button>
                      </>
                    )}
                    <Sheet>
                      <SheetTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setSelectedContact(contact.id)}
                        >
                          <Clock className="h-3 w-3 text-orange-600" />
                        </Button>
                      </SheetTrigger>
                      <SheetContent side="bottom" className="h-[300px]">
                        <SheetHeader>
                          <SheetTitle>Log Follow-up with {contact.first_name}</SheetTitle>
                        </SheetHeader>
                        <div className="mt-4 space-y-4">
                          <Textarea
                            placeholder="What did you discuss?"
                            value={noteContent}
                            onChange={(e) => setNoteContent(e.target.value)}
                            className="min-h-[100px]"
                          />
                          <Button
                            className="w-full"
                            onClick={() =>
                              handleLogFollowup(contact.id, `${contact.first_name} ${contact.last_name}`)
                            }
                            disabled={isPending}
                          >
                            {isPending ? "Logging..." : "Log Follow-up"}
                          </Button>
                        </div>
                      </SheetContent>
                    </Sheet>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
