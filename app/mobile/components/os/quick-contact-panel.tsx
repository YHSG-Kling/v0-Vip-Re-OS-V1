"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Phone, MessageSquare, User, Search, Star, Clock } from "lucide-react"
import Link from "next/link"

interface Contact {
  id: string
  first_name: string
  last_name: string
  phone?: string
  email?: string
  contact_type?: string
  status?: string
  last_contacted_at?: string
}

interface QuickContactPanelProps {
  contacts: Contact[]
  recentActivityContactIds?: string[]
}

export function QuickContactPanel({
  contacts,
  recentActivityContactIds = [],
}: QuickContactPanelProps) {
  const [searchQuery, setSearchQuery] = useState("")

  const filteredContacts = contacts.filter((contact) => {
    if (!searchQuery.trim()) return true
    const fullName = `${contact.first_name} ${contact.last_name}`.toLowerCase()
    return (
      fullName.includes(searchQuery.toLowerCase()) ||
      contact.phone?.includes(searchQuery) ||
      contact.email?.toLowerCase().includes(searchQuery.toLowerCase())
    )
  })

  const priorityContacts = filteredContacts
    .filter((c) => recentActivityContactIds.includes(c.id))
    .slice(0, 3)

  const otherContacts = filteredContacts
    .filter((c) => !recentActivityContactIds.includes(c.id))
    .slice(0, 5)

  const handleCall = (phone: string) => {
    window.location.href = `tel:${phone}`
  }

  const handleText = (phone: string) => {
    window.location.href = `sms:${phone}`
  }

  const getContactTypeColor = (type?: string) => {
    switch (type) {
      case "buyer":
        return "bg-blue-100 text-blue-700"
      case "seller":
        return "bg-green-100 text-green-700"
      case "lead":
        return "bg-orange-100 text-orange-700"
      case "past_client":
        return "bg-purple-100 text-purple-700"
      default:
        return "bg-gray-100 text-gray-700"
    }
  }

  const ContactRow = ({ contact, isPriority }: { contact: Contact; isPriority?: boolean }) => (
    <div
      className={`flex items-center justify-between p-2 rounded-lg ${
        isPriority ? "bg-yellow-50 border border-yellow-200" : "bg-muted/30"
      }`}
    >
      <Link href="/dashboard/communications/inbox" className="flex items-center gap-2 flex-1 min-w-0">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">
            {contact.first_name?.[0]}
            {contact.last_name?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {contact.first_name} {contact.last_name}
          </p>
          <div className="flex items-center gap-1">
            {contact.contact_type && (
              <Badge className={`text-[10px] px-1 ${getContactTypeColor(contact.contact_type)}`}>
                {contact.contact_type}
              </Badge>
            )}
            {isPriority && (
              <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
            )}
          </div>
        </div>
      </Link>
      <div className="flex gap-1">
        {contact.phone && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => handleCall(contact.phone!)}
            >
              <Phone className="h-4 w-4 text-green-600" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => handleText(contact.phone!)}
            >
              <MessageSquare className="h-4 w-4 text-blue-600" />
            </Button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <User className="h-4 w-4 text-green-500" />
          Quick Contact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-9"
          />
        </div>

        {/* Priority Contacts */}
        {priorityContacts.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Recent Activity
            </p>
            {priorityContacts.map((contact) => (
              <ContactRow key={contact.id} contact={contact} isPriority />
            ))}
          </div>
        )}

        {/* Other Contacts */}
        {otherContacts.length > 0 && (
          <div className="space-y-1">
            {priorityContacts.length > 0 && (
              <p className="text-xs text-muted-foreground font-medium">All Contacts</p>
            )}
            {otherContacts.map((contact) => (
              <ContactRow key={contact.id} contact={contact} />
            ))}
          </div>
        )}

        {filteredContacts.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            {searchQuery ? "No contacts found" : "No contacts available"}
          </p>
        )}

        {/* View All Link */}
        {contacts.length > 8 && (
          <Link href="/dashboard/communications/inbox">
            <Button variant="outline" size="sm" className="w-full">
              View All Contacts
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
