"use client"

/**
 * SHARE HOMES WITH FAMILY — the buyer's half of C28 (wave 149, lane 149B, owner ruling 6: "the buyer shares the
 * homes they were searching and brings in a family member to give their opinion on the selected properties").
 *
 * The buyer picks saved homes and one person (email or mobile). The server re-reads the homes from the buyer's own
 * saved rows; the family member opens ONLY those homes through a private, expiring link and gives an opinion. The
 * buyer reads every opinion here, decides whether those opinions may shape what the Shopping Agent suggests (off until
 * they say yes), and can close anyone's link. Server actions only — no lib import (proxy-graph budget).
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import {
  shareHomesWithFamilyAction,
  loadFamilyFeedbackAction,
  setFamilyFeedbackUseAction,
  removeMember,
} from "@/app/actions/collaborative-search"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"

export interface ShareableHome { ref: string; label: string }

type Digest = {
  searchId: string | null
  feedbackForShoppingAgent: boolean
  collaborators: Array<{ id: string; name: string | null; status: string; channel: string | null }>
  homes: Array<{ sharedHomeId: string; listingRef: string; address: string | null; opinions: Array<{ by: string | null; vote: string | null; comment: string | null }> }>
}

const VOTE_WORDS: Record<string, string> = { love: "loves it", like: "likes it", neutral: "isn't sure", dislike: "isn't keen", pass: "would pass" }

export function ShareWithFamilyCard({ contactId, homes }: { contactId: string; homes: ShareableHome[] }) {
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [pending, start] = useTransition()

  const refresh = useCallback(async () => {
    const r: any = await loadFamilyFeedbackAction(contactId)
    if (r?.ok) setDigest(r.digest as Digest)
    else if (r?.error) setMessage(r.error)
  }, [contactId])
  useEffect(() => { void refresh() }, [refresh])

  const toggle = (ref: string) => setPicked((p) => (p.includes(ref) ? p.filter((x) => x !== ref) : [...p, ref]))

  const share = () => start(async () => {
    setMessage(null); setLink(null)
    const r = await shareHomesWithFamilyAction({ contactId, listingRefs: picked, collaborator: { name, email: email || null, phone: phone || null } })
    if (!r.ok) { setMessage(r.error); return }
    setMessage([r.delivery === "email" ? `We emailed ${name} a private link to ${r.sharedCount} home${r.sharedCount === 1 ? "" : "s"}.` : `Here's ${name}'s private link — send it to them yourself.`, ...r.notes].join(" "))
    setLink(r.delivery === "link" ? r.link : null)
    setPicked([]); setName(""); setEmail(""); setPhone("")
    void refresh()
  })

  const setConsent = (allow: boolean) => start(async () => {
    const r: any = await setFamilyFeedbackUseAction({ contactId, allow })
    if (!r?.ok) setMessage(r?.error ?? "That didn't save — please try again.")
    void refresh()
  })

  const close = (memberId: string) => start(async () => {
    if (!digest?.searchId) return
    const r: any = await removeMember(digest.searchId, memberId)
    if (r?.error) setMessage(r.error)
    void refresh()
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask family what they think</CardTitle>
        <CardDescription>
          Share the homes you're weighing with someone you trust. They see only those homes — not your search, your messages
          or anything else in your portal — and you see everything they say.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {homes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Save a home or two first — then you can share them here.</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Which homes?</legend>
            {homes.map((h) => (
              <label key={h.ref} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.includes(h.ref)} onChange={() => toggle(h.ref)} />
                {h.label}
              </label>
            ))}
          </fieldset>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-sm">Their name<input className="mt-1 w-full rounded-md border bg-background p-2" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="text-sm">Email<input type="email" className="mt-1 w-full rounded-md border bg-background p-2" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="text-sm">or mobile<input type="tel" className="mt-1 w-full rounded-md border bg-background p-2" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>
        <Button type="button" onClick={share} disabled={pending || picked.length === 0 || !name.trim() || (!email.trim() && !phone.trim())}>
          {pending ? "Sharing…" : "Share these homes"}
        </Button>
        {message && <p className="text-sm text-muted-foreground" aria-live="polite">{message}</p>}
        {link && <p className="break-all rounded-md border bg-muted p-2 text-xs">{link}</p>}

        {digest && digest.collaborators.length > 0 && (
          <div className="space-y-3 border-t pt-3">
            <h3 className="text-sm font-medium">What your family said</h3>
            {digest.homes.filter((h) => h.opinions.length > 0).map((h) => (
              <div key={h.sharedHomeId} className="text-sm">
                <p className="font-medium">{h.address ?? "A shared home"}</p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {h.opinions.map((o, i) => (
                    <li key={i}>{o.by ?? "Family"} {VOTE_WORDS[o.vote ?? ""] ?? "shared a thought"}{o.comment ? ` — "${o.comment}"` : ""}</li>
                  ))}
                </ul>
              </div>
            ))}
            {digest.homes.every((h) => h.opinions.length === 0) && <p className="text-sm text-muted-foreground">No opinions yet.</p>}
            <ul className="space-y-1 text-sm">
              {digest.collaborators.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span>{c.name ?? "Family member"} · {c.status}</span>
                  {c.status !== "closed" && <Button type="button" size="sm" variant="ghost" onClick={() => close(c.id)} disabled={pending}>Close their link</Button>}
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={digest.feedbackForShoppingAgent} onChange={(e) => setConsent(e.target.checked)} disabled={pending} />
              <span>Let my family's opinions shape the homes my Shopping Agent suggests and tell my agent what they said. (Off until you tick it.)</span>
            </label>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
