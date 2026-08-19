"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search, Phone, User } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { useDebounce } from "@/hooks/use-debounce"

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
  // The hand-rolled `setTimeout(searchContacts, 300)` this replaces debounced the
  // EFFECT rather than the value, which left `isSearching` lying: it was set true
  // only once the timer fired, so for the first 300ms of every keystroke the box
  // showed the PREVIOUS results with no pending indicator. Debouncing the value
  // instead lets the component compare `query` against `debouncedQuery` and say
  // truthfully that a search is pending.
  const debouncedQuery = useDebounce(query, 300)

  useEffect(() => {
    let cancelled = false
    const searchContacts = async () => {
      if (debouncedQuery.length < 2) {
        setResults([])
        return
      }

      setIsSearching(true)
      const supabase = createClient()

      // `error` destructured: supabase-js RESOLVES a refused read, so `data:null`
      // alone would have shown an RLS denial as "no contacts match".
      const { data, error } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, phone")
        .eq("brokerage_id", brokerageId)
        .or(`first_name.ilike.%${debouncedQuery}%,last_name.ilike.%${debouncedQuery}%,phone.ilike.%${debouncedQuery}%`)
        .not("phone", "is", null)
        .limit(5)

      if (cancelled) return
      if (error) {
        console.error("[quick-dial-search] contact search failed:", error.message)
        setResults([])
      } else {
        setResults(data || [])
      }
      setIsSearching(false)
    }

    void searchContacts()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, brokerageId])

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

      {/* "No contacts found" is a CLAIM ABOUT A COMPLETED SEARCH. While the
          debounce is still settling, `query !== debouncedQuery` and no search
          for the current text has run yet — saying "no contacts found" then
          would be reporting a result nobody has looked for. The name it quotes
          is `debouncedQuery` for the same reason: it is the string that was
          actually searched. */}
      {query.length >= 2 && query === debouncedQuery && results.length === 0 && !isSearching && (
        <p className="text-sm text-center text-muted-foreground py-4">
          No contacts found matching &quot;{debouncedQuery}&quot;
        </p>
      )}
    </div>
  )
}
