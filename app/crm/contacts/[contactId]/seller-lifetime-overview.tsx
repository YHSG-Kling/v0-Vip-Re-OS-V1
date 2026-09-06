// app/crm/contacts/[contactId]/seller-lifetime-overview.tsx
// Agent-facing detail view for non-buyer-stage contacts (sellers, lifetime customers, prospects).
// This is the consolidated path — the same /crm/contacts/[contactId] route now renders ALL contact
// types (buyer/seller/lifetime) in one place instead of redirecting non-buyers to the legacy /crm
// workspace. Heavy buyer-specific tools live in BuyerOverviewClient; here we render the
// agent-most-useful slices for non-buyers (recent listings, transactions, last activity) plus a
// pointer to the full CRM workspace for advanced tools.
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { LifetimeSegmentSelector } from "./components/lifetime-segment-selector"
import { normalizeLifetimeSegment } from "@/lib/portal/lifetime-segment"
import { MemoryVideoCard } from "./components/memory-video-card"
import { parseLengthOfResidence } from "@/lib/avm/provider-chain"
import {
  assessMemoryVideoTenure,
  MEMORY_VIDEO_PROMPTS,
  type SellerDictatedSegment,
} from "@/lib/video/memory-video-gate"
import { MEMORY_VIDEO_OFFER_TAG } from "@/lib/video/memory-video"
import {
  threeSidedContactTransactionFilter,
  deriveTransactionRollup,
} from "@/lib/contacts/transaction-rollup"

interface Props {
  contactId:    string
  contact:      Record<string, any>
  brokerageId:  string
}

function fmtMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || !isFinite(n)) return "—"
  return `$${Math.round(n).toLocaleString()}`
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString()
}

export async function SellerLifetimeOverview({ contactId, contact, brokerageId }: Props) {
  const svc = createServiceClient()
  const [listingsRes, transactionsRes, activitiesRes, callClassificationsRes] = await Promise.all([
    // Listings where this contact is the seller — recent first
    svc.from("listings")
       .select("id, address, list_price, status, lifecycle_stage, created_at, listing_date")
       .eq("brokerage_id", brokerageId)
       .eq("seller_contact_id", contactId)
       .order("created_at", { ascending: false })
       .limit(5),
    // Transactions where this contact is buyer OR seller — both sides because lifetime contacts
    // may have been on either side of past deals. The three-sided filter is the ONE shared
    // definition (lib/contacts/transaction-rollup.ts), also used by getContact's derived
    // transaction_count / last_closed_at.
    svc.from("transactions")
       .select("id, deal_name, property_address, stage, status, purchase_price, close_date, created_at")
       .eq("brokerage_id", brokerageId)
       .or(threeSidedContactTransactionFilter(contactId))
       .order("created_at", { ascending: false })
       .limit(5),
    // Last 10 activities
    svc.from("activities")
       .select("id, activity_type, title, description, status, created_at")
       .eq("brokerage_id", brokerageId)
       .eq("contact_id", contactId)
       .order("created_at", { ascending: false })
       .limit(10),
    // Inbound call classifications — written by the Twilio-native reception lane
    // (app/api/voice/twilio/inbound) when it resolves a caller, keyed to this
    // contact via resulting_contact_id. Merged into the activity feed as calls.
    // WHO the call was handed to travels with WHY (lane W3, 2026-09-01):
    // transferred_to_user_id is stamped by the same update that stamps
    // transfer_reason (app/api/voice/twilio/turn/route.ts:253) and had no reader,
    // so the timeline could say a call was handed off and never say to whom —
    // on a contact record whose whole job is "who talked to this person".
    // ORPHAN DOCTRINE §1.2 (2026-09-04) — `caller_phone` and
    // `caller_phone_digits` joined this select. Both were written by the
    // reception lane (app/api/voice/twilio/inbound/route.ts:127) and read by
    // NOBODY, so this timeline — the one place a call is shown to the person
    // who has to follow it up — could say a call happened and never say WHICH
    // number it came from. A contact routinely has several (mobile, office, a
    // spouse's), and "call them back" is unanswerable without it. The DIGITS
    // column is the normalised match key, which is what makes counting repeat
    // calls from one number possible below.
    svc.from("inbound_call_classifications")
       .select("id, classification, transfer_reason, transferred_to_user_id, ai_handled, classified_at, caller_phone, caller_phone_digits")
       .eq("brokerage_id", brokerageId)
       .eq("resulting_contact_id", contactId)
       .order("classified_at", { ascending: false })
       .limit(10),
  ])

  const listings     = listingsRes.data ?? []
  const transactions = transactionsRes.data ?? []
  const activities   = activitiesRes.data ?? []
  const callClassifications = callClassificationsRes.error ? [] : (callClassificationsRes.data ?? [])

  // ── WHO THE CALL WENT TO ────────────────────────────────────────────────────
  // transferred_to_user_id is a USERS.id, not an agents.id — the two are DISJOINT
  // id spaces here. Both of the writer's sources agree: ctx.agentUserId comes off
  // phone_numbers.agent_user_id, and lib/voice/call-analysis.ts:88-91 derives the
  // same value by crossing agents.user_id. There is no FK on the column (checked
  // live, 2026-09-01: inbound_call_classifications has exactly one FK, on
  // brokerage_id), so nothing in scripts/agent-fk-columns.ts constrains it and the
  // class had to be established from the writers — looking the id up in `agents`
  // would return nothing, forever, and read as "no name on file".
  // Tenant-scoped: only users of THIS brokerage are resolved, so a stale id from
  // another tenant renders as no name rather than leaking one. The error is read
  // (§3) and a refused read degrades to "a teammate", never to a wrong name.
  const transferUserIds = Array.from(new Set(
    callClassifications
      .map((c: any) => c.transferred_to_user_id as string | null)
      .filter((id: string | null): id is string => typeof id === "string" && id.length > 0),
  ))
  const transferNameById = new Map<string, string>()
  if (transferUserIds.length > 0) {
    const { data: transferUsers, error: transferErr } = await svc
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", brokerageId)
      .in("id", transferUserIds)
    if (transferErr) {
      console.error("[seller-lifetime-overview] transfer recipient read refused:", transferErr.message)
    } else {
      for (const u of transferUsers ?? []) {
        const name = [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ").trim()
        if (name) transferNameById.set((u as any).id as string, name)
      }
    }
  }

  // §1.2 — repeat calls per NUMBER, from caller_phone_digits. Counted over the
  // full 10-row window before the timeline is trimmed, so "3rd call from this
  // number" stays true even when older calls fall off the display.
  const callsPerNumber = new Map<string, number>()
  for (const c of callClassifications as Array<{ caller_phone_digits?: string | null }>) {
    const d = c.caller_phone_digits
    if (d) callsPerNumber.set(d, (callsPerNumber.get(d) ?? 0) + 1)
  }

  // Merge activities + classified inbound calls into one newest-first timeline
  const timeline = [
    ...activities.map((a: any) => ({ kind: "activity" as const, ts: a.created_at as string, entry: a })),
    ...callClassifications.map((c: any) => ({ kind: "call" as const, ts: c.classified_at as string, entry: c })),
  ]
    .sort((x, y) => new Date(y.ts ?? 0).getTime() - new Date(x.ts ?? 0).getTime())
    .slice(0, 10)

  const contactType = (contact.contact_type as string | null) ?? "contact"
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(unnamed)"

  // ─── THE MEMORY-VIDEO OFFER (m565) ──────────────────────────────────────────
  // "memory video is for sellers that have been in their home more than 20 years
  // ... (this is a special service that can be offered)". This is the seller-side
  // detail view, so this is where an agent offers it.
  //
  // ELIGIBILITY IS TENURE AND IT FAILS CLOSED. Tenure comes from the ONE parser
  // this repo has for contacts.length_of_residence (lib/avm/provider-chain.ts
  // parseLengthOfResidence — the same survivor lib/predictive-listing/
  // signal-generators.ts uses), falling back to years since the most recent
  // CLOSED transaction already loaded above. Neither available → verdict refuses
  // → the card is not rendered at all. There is deliberately no disabled teaser:
  // an affordance for a service this family cannot be offered is worse than none.
  // "Most recent close" comes from the ONE shared derivation
  // (lib/contacts/transaction-rollup.ts — same predicate getContact's derived
  // last_closed_at uses). RESIDUAL, recorded: this view derives off the 5-row
  // display window loaded above, so a contact with >5 deals could miss an older
  // close — irrelevant here because only the MOST RECENT close feeds tenure and
  // the window is newest-first.
  const txRollup = deriveTransactionRollup(
    transactions as Array<{ status?: string | null; close_date?: string | null }>,
  )
  const tenureFromClose = txRollup.last_closed_at
    ? (Date.now() - new Date(txRollup.last_closed_at).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
    : null
  const memoryVideoVerdict = assessMemoryVideoTenure(
    parseLengthOfResidence(contact.length_of_residence as string | null) ?? tenureFromClose,
  )

  let memoryVideoProjectId: string | null = null
  const memoryVideoWords: Record<string, string> = {}
  let memoryVideoOfferStanding = false
  if (memoryVideoVerdict.eligible) {
    // Read the two halves the card needs: the capture so far, and whether an
    // offer is already standing. Both reads are tenant-scoped; a refusal is
    // logged rather than rendered as "nothing captured yet", which would invite
    // the agent to re-record what the seller already said.
    const [projectRes, offerRes] = await Promise.all([
      svc.from("ai_video_projects")
         .select("id, video_metadata")
         .eq("brokerage_id", brokerageId)
         .eq("contact_id", contactId)
         .eq("video_type", "memory_video")
         .limit(1),
      svc.from("agent_client_messages")
         .select("id")
         .eq("brokerage_id", brokerageId)
         .eq("recipient_contact_id", contactId)
         .like("rationale", `%${MEMORY_VIDEO_OFFER_TAG}%`)
         .limit(1),
    ])
    if (projectRes.error) console.error("[seller-overview] memory-video project read refused:", projectRes.error.message)
    if (offerRes.error) console.error("[seller-overview] memory-video offer read refused:", offerRes.error.message)
    const project = (projectRes.data?.[0] as { id: string; video_metadata: unknown } | undefined) ?? null
    if (project) {
      memoryVideoProjectId = project.id
      const dictation = ((project.video_metadata ?? {}) as { dictation?: SellerDictatedSegment[] }).dictation
      const known = new Set(MEMORY_VIDEO_PROMPTS.map((p) => p.id))
      for (const seg of Array.isArray(dictation) ? dictation : []) {
        if (known.has(seg?.promptId)) memoryVideoWords[seg.promptId] = seg.sellerWords ?? ""
      }
    }
    memoryVideoOfferStanding = !offerRes.error && (offerRes.data?.length ?? 0) > 0
  }

  return (
    <div className="p-4 pt-2 space-y-4">
      {/* Identity / status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            {fullName}
            <Badge variant="outline">{contactType}</Badge>
            {contact.lifecycle_state && <Badge variant="outline">{contact.lifecycle_state}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-muted-foreground">Email </span>{contact.email ?? "—"}</div>
          <div><span className="text-muted-foreground">Phone </span>{contact.phone ?? "—"}</div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Address </span>
            {[contact.mailing_address, contact.mailing_city, contact.mailing_state, contact.mailing_zip].filter(Boolean).join(", ") || "—"}
          </div>
          {/* Staff-only writer of contacts.lifetime_segment — the column the
              lifetime portal's card plan branches on. The action itself refuses
              a contact-self session (requireContactAccess + !isContactSelf). */}
          <LifetimeSegmentSelector
            contactId={contactId}
            initialSegment={normalizeLifetimeSegment(contact.lifetime_segment)}
          />
          <div className="col-span-2 pt-1">
            <Link href={`/crm?contact=${contactId}`}
                  className="text-xs underline inline-flex items-center gap-1">
              Open in full CRM workspace <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Memory video — rendered ONLY for a seller the tenure gate admitted. */}
      {memoryVideoVerdict.eligible && memoryVideoVerdict.tenureYears != null ? (
        <MemoryVideoCard
          contactId={contactId}
          tenureYears={memoryVideoVerdict.tenureYears}
          offerStanding={memoryVideoOfferStanding}
          initialWords={memoryVideoWords}
          projectId={memoryVideoProjectId}
        />
      ) : null}

      {/* Listings */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Listings ({listings.length})</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {listings.length === 0 ? (
            <p className="text-muted-foreground text-xs">No listings yet for this contact.</p>
          ) : (
            <ul className="divide-y">
              {listings.map((l: any) => (
                <li key={l.id} className="py-2 flex items-center justify-between gap-2">
                  <Link href={`/dashboard/listings/${l.id}`} className="hover:underline">{l.address ?? "(no address)"}</Link>
                  <span className="text-xs text-muted-foreground">
                    {fmtMoney(l.list_price)} · {l.lifecycle_stage ?? l.status ?? "—"} · {fmtDate(l.listing_date ?? l.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Transactions */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Transactions ({transactions.length})</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {transactions.length === 0 ? (
            <p className="text-muted-foreground text-xs">No transactions for this contact.</p>
          ) : (
            <ul className="divide-y">
              {transactions.map((t: any) => (
                <li key={t.id} className="py-2 flex items-center justify-between gap-2">
                  <Link href={`/dashboard/transactions/${t.id}`} className="hover:underline">{t.deal_name ?? t.property_address ?? "(deal)"}</Link>
                  <span className="text-xs text-muted-foreground">
                    {fmtMoney(t.purchase_price)} · {t.stage ?? t.status ?? "—"} · close {fmtDate(t.close_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent activity</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {timeline.length === 0 ? (
            <p className="text-muted-foreground text-xs">No activity logged yet.</p>
          ) : (
            <ul className="divide-y">
              {timeline.map((item) =>
                item.kind === "activity" ? (
                  <li key={`a-${item.entry.id}`} className="py-2 flex items-start justify-between gap-2">
                    <div>
                      <span className="font-medium">{item.entry.title ?? item.entry.activity_type}</span>
                      {item.entry.description && <p className="text-xs text-muted-foreground line-clamp-1">{item.entry.description}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(item.entry.created_at)}</span>
                  </li>
                ) : (
                  <li key={`c-${item.entry.id}`} className="py-2 flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium">Inbound call</span>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {String(item.entry.classification ?? "unknown").replace(/_/g, " ")}
                      </Badge>
                      {item.entry.transfer_reason && (
                        <Badge variant="secondary" className="text-[10px] capitalize">
                          {String(item.entry.transfer_reason).replace(/_/g, " ")}
                        </Badge>
                      )}
                      {/* WHO it went to. Rendered only when the call was actually
                          transferred; the name falls back to "a teammate" when the
                          id resolves to nobody in this brokerage, which is honest
                          about an unresolvable id instead of inventing a person. */}
                      {item.entry.transferred_to_user_id && (
                        <span className="text-[11px] text-muted-foreground">
                          → transferred to {transferNameById.get(String(item.entry.transferred_to_user_id)) ?? "a teammate"}
                        </span>
                      )}
                      {/* §1.2 — the number they called from, and how many times
                          that number has called. Rendered only when recorded;
                          an absent number is never guessed at from the contact
                          record, which may hold a different one. */}
                      {item.entry.caller_phone && (
                        <span className="text-[11px] text-muted-foreground">
                          from {String(item.entry.caller_phone)}
                          {(() => {
                            const n = callsPerNumber.get(String(item.entry.caller_phone_digits ?? "")) ?? 0
                            return n > 1 ? ` · ${n} calls from this number` : ""
                          })()}
                        </span>
                      )}
                      {item.entry.ai_handled && (
                        <Badge variant="outline" className="text-[10px]">AI handled</Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(item.entry.classified_at)}</span>
                  </li>
                )
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
