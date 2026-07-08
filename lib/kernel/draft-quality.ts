// lib/kernel/draft-quality.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DRAFT-QUALITY FLYWHEEL — the reply-coach rail already RECORDS the
// signal nobody read: every accepted draft stores an edit_delta (how much the
// agent changed the AI's words before sending). Folding a week of
// ai_message_drafts into "drafted → accepted → sent-untouched → average edit"
// is both the agent's adoption mirror ("your AI drafted 14 replies; you sent
// 9, 6 untouched") and the platform's self-improvement metric (a rising
// untouched-rate means the drafting is genuinely getting better — measured,
// not claimed). Spoken in the Monday brief; silent weeks say nothing.

export interface DraftRow {
  status: string | null
  edit_delta: { changed?: boolean; pct_changed?: number } | null
  channel: string | null
}

export interface DraftQuality {
  drafted: number
  accepted: number
  dismissed: number
  pending: number
  sentUntouched: number
  /** Average % the agent edited ACCEPTED drafts (0 when all untouched). */
  avgEditPct: number | null
}

/** PURE: fold a period's drafts into the flywheel numbers. */
export function rollupDraftQuality(rows: DraftRow[]): DraftQuality {
  const q: DraftQuality = { drafted: rows.length, accepted: 0, dismissed: 0, pending: 0, sentUntouched: 0, avgEditPct: null }
  const edits: number[] = []
  for (const r of rows) {
    const s = (r.status ?? "").toLowerCase()
    if (s === "accepted" || s === "sent" || s === "edited") {
      q.accepted += 1
      const changed = r.edit_delta?.changed === true
      const pct = Number(r.edit_delta?.pct_changed ?? 0)
      if (!changed) q.sentUntouched += 1
      edits.push(changed ? (Number.isFinite(pct) ? pct : 0) : 0)
    } else if (s === "dismissed") q.dismissed += 1
    else q.pending += 1
  }
  if (edits.length > 0) q.avgEditPct = Math.round(edits.reduce((a, b) => a + b, 0) / edits.length)
  return q
}

/** PURE: the spoken flywheel line — "" when nothing was drafted (never pads). */
export function composeDraftQualityBrief(q: DraftQuality): string {
  if (q.drafted === 0) return ""
  const lines: string[] = [
    `Your AI drafted ${q.drafted} repl${q.drafted === 1 ? "y" : "ies"} this week — you used ${q.accepted}${q.sentUntouched > 0 ? `, ${q.sentUntouched} of them untouched` : ""}.`,
  ]
  if (q.accepted > 0 && q.avgEditPct != null && q.avgEditPct > 0) {
    lines.push(`Average edit before sending was ${q.avgEditPct}% — the drafts learn your voice from every change.`)
  }
  if (q.dismissed > q.accepted && q.drafted >= 4) {
    lines.push("You passed on more drafts than you used — tell me what was off and the next batch improves.")
  }
  return lines.join(" ")
}

/** Load one agent's last-N-days draft flywheel (read-only). */
export async function loadDraftQuality(svc: any, brokerageId: string, agentUserId: string, sinceDays = 7): Promise<DraftQuality> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data } = await svc.from("ai_message_drafts")
    .select("status, edit_delta, channel")
    .eq("brokerage_id", brokerageId).eq("agent_user_id", agentUserId)
    .gte("created_at", since).limit(500)
  return rollupDraftQuality((data ?? []) as DraftRow[])
}
