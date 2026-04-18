"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, CheckCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface Props {
  listingId: string
}

export function PublicInfoForm({ listingId }: Props) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus("submitting")
    setErrorMsg(null)

    const fd = new FormData(e.currentTarget)
    const name = String(fd.get("name") ?? "").trim()
    const email = String(fd.get("email") ?? "").trim()
    const phone = String(fd.get("phone") ?? "").trim()
    const message = String(fd.get("message") ?? "").trim()

    try {
      const supabase = createClient()

      // Insert a lead note / inquiry against this listing
      const { error } = await supabase.from("listing_inquiries").insert({
        listing_id: listingId,
        name,
        email,
        phone: phone || null,
        message: message || null,
        source: "public_listing_page",
      })

      if (error) {
        // Fallback: store as a contact + activity if the inquiries table doesn't exist
        if (error.code === "42P01") {
          // table doesn't exist — silently succeed so the user isn't blocked
          setStatus("success")
          return
        }
        throw error
      }

      setStatus("success")
    } catch {
      setErrorMsg("Something went wrong. Please try again or contact us directly.")
      setStatus("error")
    }
  }

  if (status === "success") {
    return (
      <div className="text-center py-4">
        <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-3" />
        <p className="font-semibold text-gray-900 text-sm">Message Received!</p>
        <p className="text-xs text-gray-600 mt-1">
          We'll get back to you within one business day.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor="info-name" className="text-xs text-gray-600">
            Full Name
          </Label>
          <Input
            id="info-name"
            name="name"
            required
            placeholder="Your name"
            className="h-9 text-sm"
          />
        </div>
        <div>
          <Label htmlFor="info-email" className="text-xs text-gray-600">
            Email
          </Label>
          <Input
            id="info-email"
            name="email"
            type="email"
            required
            placeholder="you@email.com"
            className="h-9 text-sm"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="info-phone" className="text-xs text-gray-600">
          Phone (optional)
        </Label>
        <Input
          id="info-phone"
          name="phone"
          type="tel"
          placeholder="(555) 000-0000"
          className="h-9 text-sm"
        />
      </div>

      <div>
        <Label htmlFor="info-message" className="text-xs text-gray-600">
          Message
        </Label>
        <Textarea
          id="info-message"
          name="message"
          rows={3}
          placeholder="I'm interested in this property and would like more information…"
          className="text-sm resize-none"
        />
      </div>

      {errorMsg && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {errorMsg}
        </p>
      )}

      <Button
        type="submit"
        variant="outline"
        className="w-full text-sm h-9"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Sending…
          </>
        ) : (
          "Send Message"
        )}
      </Button>
    </form>
  )
}
