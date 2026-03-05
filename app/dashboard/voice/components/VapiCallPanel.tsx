"use client"

import { useEffect, useRef, useState } from "react"
import { Phone, PhoneOff, Search, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface Contact {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
}

interface Script {
  id: string
  title: string
}

interface VapiCallPanelProps {
  contacts: Contact[]
  scripts: Script[]
  agentId: string
  brokerageId: string
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0")
  const s = (seconds % 60).toString().padStart(2, "0")
  return `${m}:${s}`
}

export function VapiCallPanel({ contacts, scripts, agentId, brokerageId }: VapiCallPanelProps) {
  const [search, setSearch] = useState("")
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [selectedScriptId, setSelectedScriptId] = useState<string>("")
  const [isLoading, setIsLoading] = useState(false)
  const [activeCallId, setActiveCallId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const filtered = contacts.filter((c) => {
    const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.toLowerCase()
    const q = search.toLowerCase()
    return name.includes(q) || (c.phone ?? "").includes(q)
  })

  // Timer
  useEffect(() => {
    if (activeCallId) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      setElapsed(0)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [activeCallId])

  async function startCall() {
    if (!selectedContact?.phone) return
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/voice/initiate-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: selectedContact.phone,
          contactId: selectedContact.id,
          scriptId: selectedScriptId || undefined,
          agentId,
          brokerageId,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data.blocked) {
          setError(`Call blocked: ${data.reason}`)
        } else {
          setError(data.error ?? "Failed to start call")
        }
        return
      }

      setActiveCallId(data.callId)
    } catch {
      setError("Network error — could not initiate call")
    } finally {
      setIsLoading(false)
    }
  }

  async function endCall() {
    if (!activeCallId) return
    setIsLoading(true)
    try {
      await fetch(`/api/voice/end-call?callId=${activeCallId}`, { method: "POST" })
    } finally {
      setActiveCallId(null)
      setIsLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">VAPI Outbound Call</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {activeCallId ? (
          // ── Active call ──────────────────────────────────────────────────
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-green-50 border border-green-200 p-3">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-sm font-medium text-green-700">Call Active</span>
              </div>
              <Badge variant="outline" className="font-mono text-green-700 border-green-300">
                {formatTimer(elapsed)}
              </Badge>
            </div>

            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground min-h-[60px]">
              Transcript will appear here during call
            </div>

            <Button
              variant="destructive"
              className="w-full gap-2"
              onClick={endCall}
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
              End Call
            </Button>
          </div>
        ) : (
          // ── Call setup ───────────────────────────────────────────────────
          <div className="space-y-3">
            {/* Contact search */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Contact</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search contacts..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setSelectedContact(null)
                  }}
                  className="pl-8 text-sm h-9"
                />
              </div>

              {search && !selectedContact && filtered.length > 0 && (
                <ul className="rounded-md border border-border bg-popover shadow-md max-h-40 overflow-y-auto">
                  {filtered.slice(0, 8).map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => {
                          setSelectedContact(c)
                          setSearch(`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim())
                        }}
                        className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex justify-between"
                      >
                        <span>{`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()}</span>
                        <span className="text-muted-foreground">{c.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {selectedContact && (
                <p className="text-xs text-green-600">
                  Selected: {selectedContact.first_name} {selectedContact.last_name} — {selectedContact.phone}
                </p>
              )}
            </div>

            {/* Script selector */}
            {scripts.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Script (optional)</label>
                <Select value={selectedScriptId} onValueChange={setSelectedScriptId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select approved script..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scripts.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <Button
              className="w-full gap-2"
              onClick={startCall}
              disabled={!selectedContact || isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Phone className="h-4 w-4" />
              )}
              Start AI Call
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
