"use client"

/**
 * Wave 31 — share buttons component for the hosted blog landing page.
 * Each click fires POST /api/blog/track-share BEFORE opening the
 * platform-specific share dialog. Channel set matches the Wave 30
 * WordPress-injected handler (facebook | twitter | linkedin | whatsapp |
 * email_share | copy_link) so the aggregator's per-(topic, persona)
 * scoring covers both hosting paths uniformly.
 */
type ShareChannel = "facebook" | "twitter" | "linkedin" | "whatsapp" | "email_share" | "copy_link"

const CHANNEL_LABELS: Record<ShareChannel, { label: string; bg: string }> = {
  facebook:    { label: "Facebook",    bg: "#1877f2" },
  twitter:     { label: "X / Twitter", bg: "#000" },
  linkedin:    { label: "LinkedIn",    bg: "#0a66c2" },
  whatsapp:    { label: "WhatsApp",    bg: "#25d366" },
  email_share: { label: "Email",       bg: "#374151" },
  copy_link:   { label: "Copy Link",   bg: "#6b7280" },
}

export function BlogShareButtons({
  blogPostId,
  shareUrl,
  title,
  personaSnapshot,
  contactId,
}: {
  blogPostId:       string
  shareUrl:         string
  title:            string
  personaSnapshot:  string | null
  contactId:        string | null
}) {
  function handleShare(channel: ShareChannel) {
    void fetch("/api/blog/track-share", {
      method:    "POST",
      headers:   { "Content-Type": "application/json" },
      body:      JSON.stringify({
        blog_post_id:     blogPostId,
        share_channel:    channel,
        persona_snapshot: personaSnapshot,
        contact_id:       contactId,
      }),
      keepalive: true,
    }).catch(() => { /* best-effort */ })

    if (channel === "copy_link") {
      try { navigator.clipboard.writeText(shareUrl) } catch { /* ignore */ }
      return
    }
    const encodedUrl = encodeURIComponent(shareUrl)
    const encodedTitle = encodeURIComponent(title)
    let target = ""
    switch (channel) {
      case "facebook":    target = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`; break
      case "twitter":     target = `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`; break
      case "linkedin":    target = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`; break
      case "whatsapp":    target = `https://api.whatsapp.com/send?text=${encodedTitle}%20${encodedUrl}`; break
      case "email_share": target = `mailto:?subject=${encodedTitle}&body=${encodedUrl}`; break
    }
    if (target) window.open(target, "_blank", "noopener,noreferrer")
  }

  return (
    <div className="py-6 border-t border-b border-gray-200 text-center">
      <div className="text-sm font-semibold text-gray-700 mb-3">Found this useful? Share it</div>
      <div className="flex justify-center gap-2 flex-wrap">
        {(Object.keys(CHANNEL_LABELS) as ShareChannel[]).map((ch) => {
          const meta = CHANNEL_LABELS[ch]
          return (
            <button
              key={ch}
              onClick={() => handleShare(ch)}
              style={{ backgroundColor: meta.bg }}
              className="px-3 py-1.5 text-white text-xs rounded hover:opacity-90 transition-opacity"
            >
              {meta.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
