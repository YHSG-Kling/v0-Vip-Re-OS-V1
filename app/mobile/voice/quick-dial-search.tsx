"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search, Phone, User } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface Contact {
  id: string
  first_name: string
  last_name: string
  phone: string
}

interface QuickDialSearchProps {
  agentId: string
  brokerageId: string
}

export function QuickDialSearch({ agentId, brokerageId }: QuickDialSearchProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Contact[]>([])
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    const searchContacts = async () => {
      if (query.length < 2) {
        setResults([])
        return
      }

      setIsSearching(true)
      const supabase = createClient()

      const { data } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, phone")
        .eq("brokerage_id", brokerageId)
        .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,phone.ilike.%${query}%`)
        .not("phone", "is", null)
        .limit(5)

      setResults(data || [])
      setIsSearching(false)
    }

    const debounce = setTimeout(searchContacts, 300)
    return () => clearTimeout(debounce)
  }, [query, brokerageId])

  const handleCall = (phone: string) => {
    // Open native dialer
    window.location.href = `tel:${phone}`
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts by name or phone..."
          className="pl-9 min-h-[44px]"
        />
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((contact) => (
            <div
              key={contact.id}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card"
            >
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                <User className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">
                  {contact.first_name} {contact.last_name}
                </p>
                <p className="text-xs text-muted-foreground">{contact.phone}</p>
              </div>
              <Button
                size="icon"
                variant="default"
                className="min-h-[44px] min-w-[44px] bg-emerald-500 hover:bg-emerald-600"
                onClick={() => handleCall(contact.phone)}
              >
                <Phone className="h-5 w-5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {query.length >= 2 && results.length === 0 && !isSearching && (
        <p className="text-sm text-center text-muted-foreground py-4">
          No contacts found matching &quot;{query}&quot;
        </p>
      )}
    </div>
  )
}
