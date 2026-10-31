// lib/social/inbound-social.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ARBITER'S SOCIAL EARS AND VOICE (wave 146, lane 146B — owner ruling 2, 2026-10-29: "Arbiter needs to consider and
// send social responses back and also should do 1:1 ad follow up with audiences").
//
// THREE HALVES, each on a survivor:
//   1. HEAR   — pure normalizers for what the providers PUSH (read at their primary sources 2026-10-29, cited in
//               lib/providers/channel-provider-matrix.ts PROVIDER_RECEIVE_TRUTH):
//                 · Meta Page `feed` (item=comment, verb=add: comment_id / post_id / parent_id / from / message) and `mention`;
//                 · Instagram `comments` (Facebook-Login shape: changes[] value.comment_id; Instagram-Login shape: entry.field/value
//                   value.id; media.ad_id on an AD — the campaign interaction) and `mentions`;
//                 · LinkedIn ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS (COMMENT / SHARE_MENTION; decoratedGeneratedActivity
//                   .comment / .share carries owner + text; notificationId dedupes — one per comment, whichever admin subscribed);
//                 · X Account Activity `tweet_create_events` (a reply to the subscribed account, or an @mention of it).
//               DMs keep their own extractors in the routes (meta-dm / whatsapp / linkedin / twitter) and land through the same
//               record. Our OWN account's comments (an echo of a reply we posted) are dropped at the normalizer.
//   2. RECORD — ingestInboundSocialEvents: the receiving account → its ONE tenant (social_media_accounts; ambiguity is not
//               a match), the author → an EXISTING contact by the platform identity already on file (never a fabricated
//               contact or lead — a public comment is not consent and leads enter through the lead gate), the thread, then
//               lib/communications/inbound-record.ts processInboundCommunication (contract C1: dedup on the provider's comment /
//               notification / tweet id → interpretation → the arbiter's inbound responder).
//   3. ANSWER — the executors the arbiter's responder (lib/communications/inbound-responder.ts respondToInboundCommunication) calls
//               AFTER it decided: composeInboundReply (brand voice + the thread's history + the platform's native register —
//               .claude/skills/social-media-manager-platform-native-voice), sendInboundSocialReply (a DM, through the TENANT's
//               own connected account — lib/social/dm-dispatch.ts, reply-only inside the platform's window), and
//               proposeInboundReply (a reply a PERSON approves: the smart-assistant card the agent already reads).
//
// Nothing here decides WHETHER to answer — that is the arbiter's (LAW 4). Nothing here posts publicly: a public comment reply
// is an external publication and is only ever PROPOSED (no comment-reply sender exists — lane 146E owns lib/social publishing).

import type { InboundChannel, InboundParty, InboundProcessDeps, InboundProcessResult } from "@/lib/communications/inbound-record"

type Client = { from: (t: string) => any }

// ── 1. HEAR ──────────────────────────────────────────────────────────────────────────────────

export type InboundSocialSurface = "facebook" | "instagram" | "linkedin" | "twitter" | "whatsapp"

export interface InboundSocialEvent {
  provider: "meta" | "linkedin" | "twitter"
  surface: InboundSocialSurface
  kind: "comment" | "mention"
  /** The RECEIVING account (page id / Instagram professional account id / organization id / X for_user_id). */
  accountId: string
  /** The platform-scoped id of whoever wrote it (null when the provider withholds it). */
  authorId: string | null
  authorName: string | null
  text: string
  /** The provider's own id for this event — the dedup key (comment id / notification id / tweet id). */
  providerRef: string
  /** The post / media / activity / tweet it was written on. */
  postRef: string | null
  parentRef: string | null
  /** Set when the post is an AD (Instagram comments carry media.ad_id) — the campaign interaction (ruling 2's 1:1 ad follow-up). */
  adId: string | null
  createdAt: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null)
const epoch = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

/**
 * PURE. Meta `changes` (Page feed / mention; Instagram comments / mentions in both login shapes) → events.
 * Messaging (`entry[].messaging`) is NOT read here — the meta-dm route's own DM extractor owns it.
 */
export function normalizeMetaChanges(body: unknown): InboundSocialEvent[] {
  const out: InboundSocialEvent[] = []
  const b = (body ?? {}) as Record<string, any>
  const object = String(b.object ?? "")
  if (object !== "page" && object !== "instagram") return out
  for (const entry of Array.isArray(b.entry) ? b.entry : []) {
    const accountId = str(entry?.id)
    if (!accountId) continue
    // Facebook-Login shape: entry.changes[]; Instagram-Login shape: entry.field + entry.value directly.
    const changes: Array<{ field?: unknown; value?: any }> = Array.isArray(entry?.changes) ? entry.changes : entry?.field ? [{ field: entry.field, value: entry.value }] : []
    for (const ch of changes) {
      const field = String(ch?.field ?? "")
      const v = ch?.value ?? {}
      if (object === "page" && field === "feed") {
        if (v.item !== "comment" || v.verb !== "add") continue // only a NEW comment is an inbound; posts / edits / removals are not
        const authorId = str(v.from?.id)
        if (authorId && authorId === accountId) continue // the Page's own comment — our reply echoing back
        const ref = str(v.comment_id)
        const text = str(v.message)
        if (!ref || !text) continue
        out.push({ provider: "meta", surface: "facebook", kind: "comment", accountId, authorId, authorName: str(v.from?.name), text, providerRef: ref, postRef: str(v.post_id), parentRef: str(v.parent_id), adId: null, createdAt: epoch(v.created_time) })
      } else if (object === "page" && field === "mention") {
        if (v.verb && v.verb !== "add") continue
        const ref = str(v.comment_id) ?? str(v.post_id)
        const text = str(v.message)
        if (!ref || !text) continue // a mention the platform withholds the text of is not invented
        out.push({ provider: "meta", surface: "facebook", kind: "mention", accountId, authorId: str(v.from?.id), authorName: str(v.from?.name), text, providerRef: ref, postRef: str(v.post_id), parentRef: str(v.parent_id), adId: null, createdAt: epoch(v.created_time) })
      } else if (object === "instagram" && (field === "comments" || field === "live_comments")) {
        const authorId = str(v.from?.id)
        if (authorId && authorId === accountId) continue
        const ref = str(v.comment_id) ?? str(v.id)
        const text = str(v.text)
        if (!ref || !text) continue
        out.push({ provider: "meta", surface: "instagram", kind: "comment", accountId, authorId, authorName: str(v.from?.username), text, providerRef: ref, postRef: str(v.media?.id), parentRef: str(v.parent_id), adId: str(v.media?.ad_id) ?? str(v.ad_id), createdAt: epoch(entry?.time) })
      } else if (object === "instagram" && field === "mentions") {
        // The Facebook-Login mention carries media_id (+ comment_id) and NO text — nothing to read without a fetch, which is
        // not built; it is dropped here rather than recorded as an invented sentence.
        const text = str(v.text)
        const ref = str(v.comment_id) ?? str(v.media_id)
        if (!ref || !text) continue
        out.push({ provider: "meta", surface: "instagram", kind: "mention", accountId, authorId: str(v.from?.id), authorName: str(v.from?.username), text, providerRef: ref, postRef: str(v.media_id), parentRef: null, adId: null, createdAt: epoch(entry?.time) })
      }
    }
  }
  return out
}

const urnTail = (urn: unknown): string | null => {
  const s = str(urn)
  if (!s) return null
  const m = /^urn:li:[A-Za-z]+:(.+)$/.exec(s)
  return m ? m[1] : s
}

/** PURE. LinkedIn organization social action notifications → events (COMMENT / SHARE_MENTION only; an admin's own comment is ours). */
export function normalizeLinkedInNotifications(body: unknown): InboundSocialEvent[] {
  const b = (body ?? {}) as Record<string, any>
  if (b.type !== "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS") return []
  const out: InboundSocialEvent[] = []
  for (const n of Array.isArray(b.notifications) ? b.notifications : []) {
    const action = String(n?.action ?? "")
    if (action !== "COMMENT" && action !== "SHARE_MENTION") continue
    const accountId = urnTail(n?.organizationalEntity)
    const ref = str(n?.notificationId)
    const generated = n?.decoratedGeneratedActivity ?? {}
    const item = action === "COMMENT" ? generated.comment : generated.share
    const text = str(item?.text)
    if (!accountId || !ref || !text) continue
    const ownerUrn = str(item?.owner)
    // A comment owned by the organization itself is our own (an ADMIN_COMMENT echo under another label).
    if (ownerUrn && /^urn:li:(organization|organizationBrand):/.test(ownerUrn)) continue
    out.push({
      provider: "linkedin", surface: "linkedin", kind: action === "COMMENT" ? "comment" : "mention", accountId,
      authorId: urnTail(ownerUrn), authorName: null, text, providerRef: ref, postRef: str(n?.sourcePost), parentRef: str(item?.object), adId: null, createdAt: epoch(n?.lastModifiedAt),
    })
  }
  return out
}

/** PURE. X Account Activity `tweet_create_events` → a reply to the subscribed account or an @mention of it. */
export function normalizeXTweetEvents(body: unknown): InboundSocialEvent[] {
  const b = (body ?? {}) as Record<string, any>
  const forUser = str(b.for_user_id)
  if (!forUser) return []
  const out: InboundSocialEvent[] = []
  for (const t of Array.isArray(b.tweet_create_events) ? b.tweet_create_events : []) {
    const authorId = str(t?.user?.id_str) ?? str(t?.user?.id)
    if (!authorId || authorId === forUser) continue // our own post / reply
    if (t?.retweeted_status) continue // a repost is not a message to us
    const text = str(t?.extended_tweet?.full_text) ?? str(t?.full_text) ?? str(t?.text)
    const ref = str(t?.id_str) ?? str(t?.id)
    if (!text || !ref) continue
    const isReply = str(t?.in_reply_to_user_id_str) === forUser
    const mentions: unknown[] = Array.isArray(t?.entities?.user_mentions) ? t.entities.user_mentions : []
    const isMention = mentions.some((m) => str((m as Record<string, unknown>)?.id_str) === forUser)
    if (!isReply && !isMention) continue
    out.push({ provider: "twitter", surface: "twitter", kind: isReply ? "comment" : "mention", accountId: forUser, authorId, authorName: str(t?.user?.screen_name), text, providerRef: ref, postRef: str(t?.in_reply_to_status_id_str), parentRef: null, adId: null, createdAt: epoch(t?.timestamp_ms ? Number(t.timestamp_ms) : t?.created_at) })
  }
  return out
}

// ── 2. RECORD ────────────────────────────────────────────────────────────────────────────────

/** The contact metadata key each surface's identity already lives under (written by the DM doors) — matched, never created. */
const IDENTITY_KEY: Readonly<Record<InboundSocialSurface, string>> = Object.freeze({
  facebook: "facebook_psid",
  instagram: "instagram_psid",
  linkedin: "linkedin_person_id",
  twitter: "twitter_user_id",
  whatsapp: "whatsapp_id",
})

/** social_media_accounts.platform values a surface's receiving account is stored under. */
const ACCOUNT_PLATFORMS: Readonly<Record<InboundSocialSurface, readonly string[]>> = Object.freeze({
  facebook: ["facebook"],
  instagram: ["instagram", "facebook"],
  linkedin: ["linkedin"],
  twitter: ["twitter"],
  whatsapp: ["whatsapp"],
})

export interface InboundSocialIngestResult {
  received: number
  recorded: number
  duplicates: number
  /** Events whose receiving account maps to no single tenant — acknowledged, never fabricated into one. */
  unowned: number
  refused: Array<{ providerRef: string; reason: string }>
  results: InboundProcessResult[]
}

export interface InboundSocialIngestDeps {
  /** The chain (default: lib/communications/inbound-record.ts processInboundCommunication). */
  process?: (input: Parameters<typeof import("@/lib/communications/inbound-record").processInboundCommunication>[0], deps?: InboundProcessDeps) => Promise<InboundProcessResult>
  processDeps?: InboundProcessDeps
}

/**
 * Record + interpret + answer every normalized social event. The tenant comes from the RECEIVING account the provider
 * named (one distinct brokerage or nothing — the rule app/api/webhooks/sendgrid-events already runs). Never throws.
 */
export async function ingestInboundSocialEvents(
  svc: Client,
  events: readonly InboundSocialEvent[],
  deps: InboundSocialIngestDeps = {},
): Promise<InboundSocialIngestResult> {
  const res: InboundSocialIngestResult = { received: events.length, recorded: 0, duplicates: 0, unowned: 0, refused: [], results: [] }
  const process = deps.process ?? (async (input, d) => (await import("@/lib/communications/inbound-record")).processInboundCommunication(input, d))
  for (const ev of events) {
    try {
      // ── the receiving account → its ONE tenant ──
      const { data: accounts, error: accErr } = await svc.from("social_media_accounts")
        .select("brokerage_id, agent_id, platform")
        .eq("account_id", ev.accountId)
        .in("platform", [...ACCOUNT_PLATFORMS[ev.surface]])
        .eq("is_active", true)
        .limit(2)
      if (accErr) { res.refused.push({ providerRef: ev.providerRef, reason: `account read refused: ${accErr.message}` }); continue }
      const rows = (accounts ?? []) as Array<{ brokerage_id: string | null; agent_id: string | null }>
      const tenants = new Set(rows.map((r) => r.brokerage_id).filter(Boolean))
      if (tenants.size !== 1) { res.unowned++; continue }
      const brokerageId = [...tenants][0] as string
      let agentId = rows.find((r) => r.brokerage_id === brokerageId)?.agent_id ?? null

      // ── the author → an EXISTING contact in that tenant (ambiguity is not a match; nobody is created) ──
      let party: InboundParty | null = null
      if (ev.authorId) {
        const { data: matches, error: mErr } = await svc.from("contacts").select("id")
          .eq("brokerage_id", brokerageId).contains("metadata", { [IDENTITY_KEY[ev.surface]]: ev.authorId }).limit(2)
        if (mErr) { res.refused.push({ providerRef: ev.providerRef, reason: `identity read refused: ${mErr.message}` }); continue }
        if ((matches ?? []).length === 1) party = { kind: "contact", id: (matches as Array<{ id: string }>)[0].id }
      }

      // ── the thread: a known person rides their ONE conversation (the resolver inside the record); an unidentified
      //    commenter gets the account's public thread keyed by (surface, account, post, author) ──
      let conversationId: string | null = null
      if (!party) {
        if (!agentId) {
          const { data: anyAgent, error: aErr } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).order("created_at", { ascending: true }).limit(1).maybeSingle()
          if (aErr) { res.refused.push({ providerRef: ev.providerRef, reason: `agent read refused: ${aErr.message}` }); continue }
          agentId = (anyAgent as { id?: string } | null)?.id ?? null
        }
        if (!agentId) { res.refused.push({ providerRef: ev.providerRef, reason: "the tenant has no agent to own the thread (conversations.agent_id is NOT NULL)" }); continue }
        const key = { surface: ev.surface, account_id: ev.accountId, post_id: ev.postRef ?? null, author_id: ev.authorId ?? null }
        const { data: existing, error: tErr } = await svc.from("conversations").select("id")
          .eq("brokerage_id", brokerageId).eq("type", "social_comment").contains("context_data", key).limit(1).maybeSingle()
        if (tErr) { res.refused.push({ providerRef: ev.providerRef, reason: `thread read refused: ${tErr.message}` }); continue }
        if (existing) conversationId = (existing as { id: string }).id
        else {
          const { data: created, error: cErr } = await svc.from("conversations").insert({
            brokerage_id: brokerageId, agent_id: agentId, contact_id: null, type: "social_comment", status: "active",
            message_count: 0, unread_count: 0, context_data: { ...key, author_name: ev.authorName ?? null },
          }).select("id").single()
          if (cErr) { res.refused.push({ providerRef: ev.providerRef, reason: `thread not created: ${cErr.message}` }); continue }
          conversationId = (created as { id: string }).id
        }
      }

      const channel: InboundChannel = ev.adId ? "ad_interaction" : ev.kind === "mention" ? "social_mention" : "social_comment"
      const r = await process({
        brokerageId, channel, provider: ev.provider, providerRef: ev.providerRef, party, conversationId, agentId,
        body: ev.text, surface: ev.surface, receivedAt: ev.createdAt,
        threadRef: { account_id: ev.accountId, post_id: ev.postRef, parent_id: ev.parentRef, comment_id: ev.providerRef, author_id: ev.authorId, ad_id: ev.adId },
      }, deps.processDeps)
      res.results.push(r)
      if (r.record.recorded) res.recorded++
      else if (r.record.duplicate) res.duplicates++
      else res.refused.push({ providerRef: ev.providerRef, reason: r.record.error ?? "not recorded" })
    } catch (e) {
      res.refused.push({ providerRef: ev.providerRef, reason: `threw: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return res
}

// ── 3. ANSWER (called by the arbiter AFTER it decided) ───────────────────────────────────────

/**
 * Each platform's native register for a REPLY (.claude/skills/social-media-manager-platform-native-voice): LinkedIn
 * professional peer-to-peer, X punchy, Facebook community-member, Instagram warm, WhatsApp / DM conversational. DATA the
 * composer reads — the brand voice (lib/ai-isa/brand-voice-prompt.ts) stays the authority on WHAT is said.
 */
export const PLATFORM_REPLY_VOICE: Readonly<Record<string, { register: string; maxChars: number }>> = Object.freeze({
  facebook:  { register: "a helpful community member, warm and plain; no hashtags", maxChars: 600 },
  instagram: { register: "warm and human, short; no hashtag stacks in a reply", maxChars: 400 },
  linkedin:  { register: "peer-to-peer professional, specific, no hype or emoji bullets", maxChars: 700 },
  twitter:   { register: "brief and direct, one clear point, no hashtags", maxChars: 270 },
  whatsapp:  { register: "conversational and personal, like a text from the agent", maxChars: 600 },
  email:     { register: "clear, warm and scannable; a plain-text reply", maxChars: 1500 },
  sms:       { register: "a short personal text", maxChars: 300 },
  portal:    { register: "a short, warm in-app note", maxChars: 500 },
})

export interface ComposeInboundReplyInput {
  brokerageId: string
  agentId: string | null
  contactId: string | null
  conversationId: string | null
  surface: string
  isPublic: boolean
  inboundBody: string
}

/**
 * Draft ONE reply in the tenant's brand voice, with the thread's own history and the platform's register. A reply to a
 * public comment says nothing about the person's situation (it is read by everyone) and invites the private conversation.
 * Returns null on any refusal (no draft beats a guessed one). Booked to ai_tool_usage under the existing reply-coach row.
 */
export async function composeInboundReply(svc: Client, input: ComposeInboundReplyInput): Promise<{ text: string } | null> {
  try {
    const voice = PLATFORM_REPLY_VOICE[input.surface] ?? PLATFORM_REPLY_VOICE.portal
    let history = ""
    if (input.conversationId) {
      const { data: recent, error } = await svc.from("messages").select("direction, body, created_at")
        .eq("conversation_id", input.conversationId).eq("brokerage_id", input.brokerageId)
        .order("created_at", { ascending: false }).limit(8)
      if (!error) history = ((recent ?? []) as Array<{ direction: string; body: string | null }>).reverse()
        .map((m) => `${m.direction === "inbound" ? "Them" : "Us"}: ${(m.body ?? "").slice(0, 200)}`).join("\n")
    }
    const { loadBrandVoicePrompt } = await import("@/lib/ai-isa/brand-voice-prompt")
    const brand = await loadBrandVoicePrompt({ brokerageId: input.brokerageId, agentId: input.agentId, managerKey: "ai_isa", knowledgeQuery: input.inboundBody.slice(0, 300), ...(input.contactId && !input.isPublic ? { contactId: input.contactId } : {}) })
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({
      feature: "ai_reply_coach",
      brokerageId: input.brokerageId,
      manager: "ai_isa",
      maxTokens: 300,
      temperature: 0.4,
      system: [
        "You write ONE reply on behalf of a real-estate agent's team, answering a message they received.",
        `Register for this platform: ${voice.register}. At most ${voice.maxChars} characters.`,
        input.isPublic
          ? "This is a PUBLIC reply anyone can read: never mention the person's situation, finances, home, family or any personal detail; never discuss price or terms in public; thank them and invite them to a private message or a call."
          : "This is a private reply in an ongoing conversation: answer what they asked, usefully and specifically; if you cannot answer from the history, say a person will follow up.",
        "Never promise outcomes, never mention commission or fees, never reason from or refer to any personal characteristic (fair housing), never invent facts, listings, prices or availability.",
        "Return only the reply text — no quotes, no subject line, no signature block.",
        brand.systemBlock,
      ].join("\n"),
      prompt: `${history ? `Conversation so far (oldest first):\n${history}\n\n` : ""}Message to answer:\n${input.inboundBody.slice(0, 1500)}`,
    })
    const reply = (text ?? "").trim().slice(0, voice.maxChars)
    return reply.length >= 2 ? { text: reply } : null
  } catch {
    return null
  }
}

export interface SendInboundSocialReplyInput {
  brokerageId: string
  conversationId: string | null
  contactId: string | null
  agentId: string | null
  /** facebook | instagram | whatsapp — the only surfaces with a DM send path (lib/social/dm-support.ts). */
  surface: string
  /** The RECEIVING account (page id / phone_number_id) the person wrote to. */
  accountId: string
  /** The platform-scoped id of the person (PSID / IGSID / wa_id). */
  recipientId: string
  text: string
  /** messages.id of the inbound this answers. */
  inReplyTo: string
}

/**
 * Send ONE reply DM through the tenant's own connected account (reply-only — the person wrote first, inside the platform's
 * window) and record it on the same thread. Never a fake "sent": a refused dispatch returns its reason and writes nothing.
 */
export async function sendInboundSocialReply(svc: Client, input: SendInboundSocialReplyInput): Promise<{ sent: boolean; providerMessageId?: string | null; error?: string }> {
  try {
    const { socialDmSupport, dispatchSocialDm } = await import("@/lib/social/dm-dispatch")
    const support = socialDmSupport(input.surface)
    if (!support.supported) return { sent: false, error: support.reason ?? "no DM send path on this platform" }
    const { data: account, error } = await svc.from("social_media_accounts").select("account_id, access_token")
      .eq("brokerage_id", input.brokerageId).eq("account_id", input.accountId).eq("is_active", true).limit(1).maybeSingle()
    if (error) return { sent: false, error: `connected account read refused: ${error.message}` }
    const { decryptSecret } = await import("@/lib/security/secret-crypto")
    const token = decryptSecret((account as { access_token?: string | null } | null)?.access_token ?? null)
    if (!account || !token) return { sent: false, error: "the tenant's account behind this thread is not connected — reconnect it in Settings → Social" }
    const r = await dispatchSocialDm({ platform: input.surface as "facebook" | "instagram" | "whatsapp", accountId: input.accountId, accessToken: token, recipientId: input.recipientId, text: input.text })
    if (!r.success) return { sent: false, error: r.error ?? "the platform refused the reply" }
    const nowIso = new Date().toISOString()
    const { error: recErr } = await svc.from("messages").insert({
      conversation_id: input.conversationId, brokerage_id: input.brokerageId, contact_id: input.contactId, agent_id: input.agentId,
      type: "social_dm", direction: "outbound", sender_type: "ai", body: input.text, status: "sent",
      metadata: { provider: input.surface === "whatsapp" ? "whatsapp" : "meta", surface: input.surface, provider_message_id: r.providerMessageId ?? null, in_reply_to: input.inReplyTo, autonomous: true },
      created_at: nowIso, updated_at: nowIso,
    })
    if (recErr) return { sent: true, providerMessageId: r.providerMessageId ?? null, error: `sent, but the outbound record was refused: ${recErr.message}` }
    if (input.conversationId) {
      const { touchConversation } = await import("@/lib/kernel/conversation-thread")
      await touchConversation(svc, input.conversationId, { inbound: false })
    }
    return { sent: true, providerMessageId: r.providerMessageId ?? null }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ProposeInboundReplyInput {
  brokerageId: string
  /** agents.id of the thread's agent (resolved to the user the card is for). */
  agentId: string | null
  contactId: string | null
  conversationId: string | null
  recordId: string
  surface: string
  isPublic: boolean
  proposedText: string | null
  why: string
  safety: string[]
  priority: "low" | "medium" | "high"
}

/**
 * A reply a PERSON approves: the smart-assistant card the agent already reads (lib/assistant/smart-suggestion.ts — THE
 * writer), carrying the proposed text, why the arbiter proposed it, any safety findings, and the thread to answer from.
 * The agent sends from the inbox composer (a DM) or on the platform (a public comment). Returns whether a card exists.
 */
export async function proposeInboundReply(svc: Client, input: ProposeInboundReplyInput): Promise<{ proposed: boolean; reason?: string }> {
  try {
    if (!input.agentId) return { proposed: false, reason: "no agent owns this thread — nobody to show the proposal to" }
    const { data: agent, error } = await svc.from("agents").select("user_id").eq("id", input.agentId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { proposed: false, reason: `agent read refused: ${error.message}` }
    const userId = (agent as { user_id?: string | null } | null)?.user_id ?? null
    const { writeSmartSuggestion } = await import("@/lib/assistant/smart-suggestion")
    const r = await writeSmartSuggestion(svc, input.brokerageId, {
      userId,
      contextType: input.contactId ? "contact" : "conversation",
      contextId: input.contactId ?? input.conversationId,
      suggestionType: "reply_proposal",
      priority: input.priority,
      title: input.isPublic ? `Suggested public reply on ${input.surface}` : `Suggested reply on ${input.surface}`,
      description: [
        input.proposedText ? `Suggested reply: "${input.proposedText}"` : "A person should answer this one.",
        `Why: ${input.why}`,
        ...(input.safety.length > 0 ? [`Review first — flagged: ${input.safety.join(", ")}`] : []),
        input.isPublic ? "Public replies are approved by a person and posted on the platform." : "Edit and send it from the inbox thread.",
      ].join("\n").slice(0, 1500),
      actionPayload: { kind: "inbound_reply_proposal", surface: input.surface, public: input.isPublic, conversation_id: input.conversationId, message_id: input.recordId, proposed_reply: input.proposedText, safety: input.safety },
    })
    return r.written ? { proposed: true } : { proposed: false, reason: r.reason }
  } catch (e) {
    return { proposed: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
