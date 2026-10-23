// lib/inbound-mail/message-meta.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT AN INBOUND MESSAGE CAN PROVE ABOUT ITSELF — its identity and whether its sender is who it says (wave 143, 143A).
//
// The outside-offer loop (lib/offers/outside-offer-loop.ts) matches an emailed reply to the offer it answers and decides
// whether to TRUST it. It needs three things the parsers in ./providers.ts and ./oauth-fetchers.ts did not carry:
//   · `messageId`   the RFC 5322 Message-ID — the IDEMPOTENCY key (a redelivered webhook is the same message),
//   · `inReplyTo` / `references`   the thread — a reply to OUR outbound packet names our outbound Message-ID,
//   · `senderAuth`  whether the receiving provider authenticated the From domain (DMARC / DKIM / SPF).
// All three are READ off headers the receiving provider already attached; nothing here asks a network. PURE.
//
// `senderAuth` is "pass" | "fail" | "unknown". UNKNOWN IS NOT PASS: a provider that exposes no authentication result
// (Resend, Outlook's default payload) yields "unknown", and the loop then files the documents and alerts the agent but
// requires an explicit acknowledgement before anything it read is acted on. "Nobody checked" never renders as "checked
// and fine" (CLAUDE.md §4).

export type SenderAuth = "pass" | "fail" | "unknown"

export interface InboundMessageMeta {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  senderAuth: SenderAuth
}

/** A header bag in any of the shapes the providers hand us: [{Name,Value}], [[name,value]], {name: value}, or a raw block. */
export type HeaderBag =
  | Array<{ Name?: string; name?: string; Value?: string; value?: string }>
  | Array<[string, string]>
  | Record<string, unknown>
  | string
  | null
  | undefined

/** PURE: lower-cased header name → value (the LAST occurrence of a repeated header wins, except Received-SPF/Authentication-Results which are joined). */
function headerMap(bag: HeaderBag): Map<string, string> {
  const out = new Map<string, string>()
  const put = (k: unknown, v: unknown) => {
    const key = String(k ?? "").trim().toLowerCase()
    if (!key) return
    const val = String(v ?? "").trim()
    if (key === "authentication-results" || key === "received-spf") out.set(key, out.has(key) ? `${out.get(key)}; ${val}` : val)
    else out.set(key, val)
  }
  if (!bag) return out
  if (typeof bag === "string") {
    // A raw RFC 5322 header block: unfold continuation lines, then "Name: value".
    const unfolded = bag.replace(/\r?\n[ \t]+/g, " ")
    for (const line of unfolded.split(/\r?\n/)) {
      const i = line.indexOf(":")
      if (i > 0) put(line.slice(0, i), line.slice(i + 1))
    }
    return out
  }
  if (Array.isArray(bag)) {
    for (const h of bag as unknown[]) {
      if (Array.isArray(h)) put(h[0], h[1])
      else if (h && typeof h === "object") put((h as any).Name ?? (h as any).name, (h as any).Value ?? (h as any).value)
    }
    return out
  }
  for (const [k, v] of Object.entries(bag as Record<string, unknown>)) put(k, v)
  return out
}

/** PURE: a Message-ID / In-Reply-To token, normalised (angle brackets and case stripped) so two spellings of one id compare equal. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase()
  return t ? t : null
}

function domainOf(addr: string | null | undefined): string {
  const at = (addr ?? "").lastIndexOf("@")
  return at >= 0 ? (addr as string).slice(at + 1).toLowerCase().trim() : ""
}

/** PURE: does `d` (a DKIM/SPF signing domain) align with the sender's domain — equal, or a parent/subdomain of it? */
function aligned(signing: string, sender: string): boolean {
  if (!signing || !sender) return false
  return signing === sender || sender.endsWith(`.${signing}`) || signing.endsWith(`.${sender}`)
}

/**
 * PURE — fold the receiving provider's authentication headers into one verdict about THIS From address.
 *   pass     dmarc=pass; or dkim=pass whose signing domain (header.d) aligns with the From domain;
 *            or spf=pass whose envelope domain (smtp.mailfrom / header.from) aligns with the From domain.
 *   fail     dmarc=fail; or an explicit dkim=fail / spf=fail.
 *   unknown  no authentication header at all, OR headers that prove nothing about THIS From domain (a pass for another
 *            domain, none/neutral/softfail) — neither a pass nor a failure.
 * A pass for SOME domain that is not the sender's is NOT a pass: a spoofer can DKIM-sign as themselves.
 */
function senderAuthFrom(authResults: string | null | undefined, receivedSpf: string | null | undefined, fromEmail: string): SenderAuth {
  const ar = (authResults ?? "").toLowerCase()
  const spfHdr = (receivedSpf ?? "").toLowerCase()
  if (!ar.trim() && !spfHdr.trim()) return "unknown"
  const sender = domainOf(fromEmail)
  const pick = (re: RegExp) => (ar.match(re) ?? [])[1] ?? ""
  const dmarc = pick(/dmarc=(pass|fail|none|bestguesspass|temperror|permerror)/)
  const dkimPass = [...ar.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.\-]+)/g)].map((m) => m[1])
  const dkimAny = pick(/dkim=(pass|fail|none|neutral|policy|temperror|permerror)/)
  const spfRes = pick(/spf=(pass|fail|softfail|neutral|none|temperror|permerror)/) || (spfHdr.match(/^\s*(pass|fail|softfail|neutral|none|temperror|permerror)/) ?? [])[1] || ""
  const spfDomain = (ar.match(/spf=pass[^;]*?smtp\.mailfrom=(?:[^@;\s]*@)?([a-z0-9.\-]+)/) ?? spfHdr.match(/(?:envelope-from|smtp\.mailfrom)=(?:[^@;\s]*@)?([a-z0-9.\-]+)/) ?? [])[1] ?? ""
  if (dmarc === "pass") return "pass"
  if (dkimPass.some((d) => aligned(d, sender))) return "pass"
  if (spfRes === "pass" && aligned(spfDomain, sender)) return "pass"
  if (dmarc === "fail") return "fail"
  if (dkimAny === "fail" || spfRes === "fail") return "fail" // an explicit failure
  return "unknown" // headers present, but nothing PROVES the From domain: not a pass, and not (yet) a failure
}

/**
 * PURE — the message meta from a provider's header bag. `fromEmail` is the parsed sender (alignment is checked against it).
 * `explicit` carries fields some providers hand over outside the headers (SendGrid's `dkim` / `SPF`, Mailgun's
 * X-Mailgun-* verdicts); an explicit verdict of "pass" still has to align via the headers when headers are present, and
 * stands alone only when the provider gave no header to align against.
 */
export function inboundMetaFrom(
  bag: HeaderBag,
  fromEmail: string,
  explicit: { dkim?: string | null; spf?: string | null } = {},
): InboundMessageMeta {
  const h = headerMap(bag)
  const refsRaw = h.get("references") ?? ""
  const references = refsRaw.split(/\s+/).map((r) => normalizeMessageId(r)).filter((r): r is string => !!r)
  let auth = senderAuthFrom(h.get("authentication-results"), h.get("received-spf"), fromEmail)
  if (auth === "unknown") {
    // Providers that expose only a verdict word: SendGrid `dkim` "{@example.com : pass}" + `SPF` "pass"; Mailgun
    // X-Mailgun-Dkim-Check-Result "Pass" + X-Mailgun-Spf "Pass". Both must pass; either failing is a fail.
    const word = (v: string | null | undefined) => ((v ?? "").toLowerCase().match(/\b(pass|fail|softfail|none|neutral)\b/) ?? [])[1] ?? ""
    const dk = word(explicit.dkim ?? h.get("x-mailgun-dkim-check-result")), sp = word(explicit.spf ?? h.get("x-mailgun-spf"))
    if (dk || sp) {
      const dkSigner = ((explicit.dkim ?? "").match(/@([a-z0-9.\-]+)/) ?? [])[1] ?? ""
      auth = dk === "fail" || sp === "fail" ? "fail"
        : dk === "pass" && sp === "pass" && (!dkSigner || aligned(dkSigner, domainOf(fromEmail))) ? "pass"
        : "unknown"
    }
  }
  return {
    messageId: normalizeMessageId(h.get("message-id")),
    inReplyTo: normalizeMessageId(h.get("in-reply-to")),
    references,
    senderAuth: auth,
  }
}
