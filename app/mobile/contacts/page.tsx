"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Search, Phone, Mail } from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface Contact {
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  contact_type: string
  stage: string
}

export default function MobileContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadContacts()
  }, [])

  const loadContacts = async () => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, phone, contact_type, stage")
        .order("last_contacted_at", { ascending: false })
        .limit(50)

      if (!error && data) {
        setContacts(data)
        setFilteredContacts(data)
      }
    } catch (err) {
      console.error("Error loading contacts:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setFilteredContacts(contacts)
      return
    }

    const q = query.toLowerCase()
    setFilteredContacts(
      contacts.filter(
        (c) =>
          c.first_name.toLowerCase().includes(q) ||
          c.last_name.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.phone?.includes(q)
      )
    )
  }

  const getStageColor = (stage: string) => {
    const colors: Record<string, string> = {
      lead: "bg-blue-100 text-blue-800",
      prospect: "bg-yellow-100 text-yellow-800",
      client: "bg-green-100 text-green-800",
      past_client: "bg-gray-100 text-gray-800",
    }
    return colors[stage] || "bg-gray-100 text-gray-800"
  }

  return (
    <div className="p-4 space-y-4 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Contacts</h1>
        <p className="text-sm text-muted-foreground">Quick contact lookup for field use</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          className="pl-10"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {/* Contacts List */}
      <div className="space-y-2">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading contacts...</div>
        ) : filteredContacts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No contacts found</div>
        ) : (
          filteredContacts.map((contact) => (
            <Link key={contact.id} href={`/crm?contact=${contact.id}`}>
              <Card className="cursor-pointer hover:shadow-md transition-shadow">
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <h3 className="font-semibold">
                        {contact.first_name} {contact.last_name}
                      </h3>
                      <div className="flex gap-2 mt-1">
                        {contact.email && (
                          <a
                            href={`mailto:${contact.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-muted-foreground hover:text-primary"
                          >
                            <Mail className="h-3 w-3" />
                          </a>
                        )}
                        {contact.phone && (
                          <a
                            href={`tel:${contact.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-muted-foreground hover:text-primary"
                          >
                            <Phone className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                    <Badge className={getStageColor(contact.stage)}>
                      {contact.stage}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
