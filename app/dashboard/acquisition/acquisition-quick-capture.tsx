"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { UserPlus, ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { createContact } from "@/app/actions/contacts"

const SOURCES = [
  { value: "business_card", label: "Business Card" },
  { value: "open_house", label: "Open House" },
  { value: "referral", label: "Referral" },
  { value: "event", label: "Event" },
  { value: "other", label: "Other" },
]

export function AcquisitionQuickCapture() {
  const [open, setOpen] = useState(false)
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [source, setSource] = useState("other")
  const [createdContactId, setCreatedContactId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  function reset() {
    setFirstName("")
    setLastName("")
    setPhone("")
    setEmail("")
    setSource("other")
    setCreatedContactId(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() && !lastName.trim()) {
      toast({ title: "Enter at least a first or last name", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await createContact({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        lead_source: source,
        status: "active",
      } as any)
      if (result.success && result.contact) {
        setCreatedContactId(result.contact.id as string | null)
        toast({ title: "Contact added", description: `${firstName} ${lastName}`.trim() })
      } else {
        toast({
          title: "Failed to add contact",
          description: result.error ?? "Unknown error",
          variant: "destructive",
        })
      }
    })
  }

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none pb-3"
        onClick={() => { setOpen((v) => !v); setCreatedContactId(null) }}
        role="button"
        aria-expanded={open}
        aria-controls="quick-capture-form"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-muted p-2">
              <UserPlus className="h-4 w-4 text-foreground" aria-hidden="true" />
            </div>
            <CardTitle className="text-base">Add a Contact Right Now</CardTitle>
          </div>
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">Quick capture — add a contact directly to your CRM</p>
      </CardHeader>

      {open && (
        <CardContent id="quick-capture-form">
          {createdContactId ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <p className="text-sm font-medium text-foreground">Contact added successfully.</p>
              <div className="flex gap-3 flex-wrap justify-center">
                <Link href={`/contacts/${createdContactId}`}>
                  <Button size="sm" variant="default">View Contact Record</Button>
                </Link>
                <Button size="sm" variant="outline" onClick={reset}>
                  Add Another
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="qc-first-name" className="text-sm">First Name</Label>
                  <Input
                    id="qc-first-name"
                    placeholder="Jane"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qc-last-name" className="text-sm">Last Name</Label>
                  <Input
                    id="qc-last-name"
                    placeholder="Smith"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="qc-phone" className="text-sm">Phone</Label>
                  <Input
                    id="qc-phone"
                    type="tel"
                    placeholder="(555) 000-0000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qc-email" className="text-sm">Email</Label>
                  <Input
                    id="qc-email"
                    type="email"
                    placeholder="jane@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qc-source" className="text-sm">Source</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger id="qc-source">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full gap-2" disabled={isPending}>
                {isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Adding...
                  </>
                ) : (
                  "Add to CRM"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      )}
    </Card>
  )
}
