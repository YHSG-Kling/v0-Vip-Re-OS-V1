// lib/lead-magnets/book-entity.ts
//
// A BOOK IS ITS OWN ENTITY (wave 145, lane 145G — owner ruling 19, 2026-10-27: "A lead magnet is a guide, a video, etc. which
// is not a manuscript or book which has many sections/chapters and is created for publication").
//
// Waves 142-144 built the book pipeline (book-creator.ts research → outline → chapters → fact check → edit → layout; the KDP
// package in book-publishing-produce.ts) ON a lead magnet: the manuscript lived in lead_capture_forms.settings.book and the KDP
// package in settings.book_publishing, so a platform KDP book was a capture form that happened to carry a manuscript. The
// pipeline is the survivor and is unchanged — its stages, its BookProject record, its gates. What moves is WHERE the record
// lives: public.book_projects (m867), one row per book, owned the way the ruling says (platform / brokerage / team / agent),
// with its own editorial stage and publication context. A book DISTRIBUTED as a lead magnet keeps this row and its workflow;
// the capture form carries only a pointer (settings.book_id) and its landing copy. A KDP-only book has no capture form.
//
// THE LOCATOR. Every pipeline command addresses a book by its own id, or — for the review surfaces that are mounted on a capture
// form (app/components/features/lead-magnets/BookProjectPanel.tsx) — by the form that distributes it; both resolve to the SAME
// row (book_projects.distribution_form_id, unique). One store, two ways to find it; never two copies of the manuscript.
//
// Not server-only: the proofs (scripts/book-publishing-guard.ts, scripts/autonomous-marketing-guard.ts,
// scripts/content-distribution-guard.ts) drive it on an in-memory client.

import type { BookPublication } from "./book-editorial"

type Svc = { from: (t: string) => any }

export const BOOK_OWNER_SCOPES = ["platform", "brokerage", "team", "agent"] as const
export type BookOwnerScope = (typeof BOOK_OWNER_SCOPES)[number]

/** How a pipeline command names its book: the book's own id, or the capture form that distributes it. */
export type BookLocator = { bookId: string; magnetId?: undefined } | { magnetId: string; bookId?: undefined }

/** The book_projects row (m867). `project` is book-creator's BookProject; `publishing` the KDP package record. */
export interface BookRow {
  id: string
  brokerage_id: string
  owner_scope: BookOwnerScope
  team_id: string | null
  agent_id: string | null
  created_by: string | null
  title: string
  audience: "buyer" | "seller"
  publication_context: "lead_magnet" | "tenant_kdp" | "platform_kdp"
  stage: string
  project: Record<string, unknown>
  publishing: Record<string, unknown> | null
  distribution_form_id: string | null
  created_at?: string
  updated_at?: string
}

export const BOOK_ROW_COLUMNS = "id, brokerage_id, owner_scope, team_id, agent_id, created_by, title, audience, publication_context, stage, project, publishing, distribution_form_id, created_at, updated_at"

/**
 * PURE. Who owns a book. The publication record already says agent / brokerage / platform (book-editorial.ts
 * publicationRecord — the house tenant's books are the PLATFORM's); a book an agent makes for the team they LEAD is the
 * team's. Never "platform" outside the house tenant (publicationRecord decides that, not the caller).
 */
export function ownerScopeFor(publication: Pick<BookPublication, "owner"> | null | undefined, opts: { agentId: string | null; teamId?: string | null; teamOwned?: boolean }): BookOwnerScope {
  const owner = publication?.owner ?? (opts.agentId ? "agent" : "brokerage")
  if (owner === "platform") return "platform"
  if (opts.teamOwned && opts.teamId) return "team"
  if (owner === "agent" && opts.agentId) return "agent"
  return "brokerage"
}

/** PURE. The book a capture form distributes (lead_capture_forms.settings.book_id), or null for an ordinary lead magnet. */
function distributedBookIdOf(settings: Record<string, unknown> | null | undefined): string | null {
  const v = ((settings ?? {}) as Record<string, unknown>).book_id
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** PURE. Is this locator well-formed? */
export function locatorOf(input: { bookId?: string | null; magnetId?: string | null }): BookLocator | null {
  if (input.bookId && String(input.bookId).trim()) return { bookId: String(input.bookId).trim() }
  if (input.magnetId && String(input.magnetId).trim()) return { magnetId: String(input.magnetId).trim() }
  return null
}

/**
 * Read ONE book, tenant-pinned, by its id or by the capture form that distributes it. A refused read is an error (never "no
 * book"); a capture form that distributes no book is said in those words.
 */
export async function loadBookRow(svc: Svc, brokerageId: string, locator: BookLocator | null): Promise<{ ok: true; row: BookRow } | { ok: false; error: string; notABook?: boolean }> {
  if (!brokerageId) return { ok: false, error: "No tenant — a book is read inside its own brokerage." }
  if (!locator) return { ok: false, error: "Name the book (its id) or the lead magnet that distributes it." }
  let q = svc.from("book_projects").select(BOOK_ROW_COLUMNS).eq("brokerage_id", brokerageId)
  q = locator.bookId ? q.eq("id", locator.bookId) : q.eq("distribution_form_id", locator.magnetId)
  const { data, error } = await q.maybeSingle()
  if (error) return { ok: false, error: `Book project unreadable: ${error.message ?? "unknown"}` }
  if (!data) {
    return locator.bookId
      ? { ok: false, error: "Book project not found in this brokerage", notABook: true }
      : { ok: false, error: "This lead magnet carries no book project (a book distributed by it was not found in this brokerage)", notABook: true }
  }
  return { ok: true, row: data as BookRow }
}

/** Insert the book (COUNTED: exactly one row back, else refused). */
export async function insertBookRow(svc: Svc, row: Omit<BookRow, "id" | "distribution_form_id" | "publishing"> & { distribution_form_id?: string | null; publishing?: Record<string, unknown> | null }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await svc.from("book_projects").insert({ ...row, distribution_form_id: row.distribution_form_id ?? null, publishing: row.publishing ?? null }).select("id")
  const one = ((data ?? []) as Array<{ id: string }>)
  if (error) return { ok: false, error: `Book project not created: ${error.message ?? "unknown"}` }
  if (one.length !== 1) return { ok: false, error: `Book project not created: ${one.length} rows returned` }
  return { ok: true, id: String(one[0].id) }
}

/**
 * Write the book's record (COUNTED, tenant-pinned). The project's stage, title and publication context are mirrored onto
 * their columns in the SAME write, so the entity's stage is never a second, drifting spelling of the project's.
 */
export async function saveBookRow(svc: Svc, brokerageId: string, bookId: string, patch: { project?: Record<string, unknown>; publishing?: Record<string, unknown> | null; distribution_form_id?: string | null; updatedAt: string }): Promise<string | null> {
  const update: Record<string, unknown> = { updated_at: patch.updatedAt }
  if (patch.project) {
    update.project = patch.project
    if (typeof patch.project.stage === "string") update.stage = patch.project.stage
    if (typeof patch.project.title === "string" && patch.project.title.trim()) update.title = patch.project.title
    const ctx = (patch.project.publication as { context?: string } | undefined)?.context
    if (ctx) update.publication_context = ctx
  }
  if (patch.publishing !== undefined) update.publishing = patch.publishing
  if (patch.distribution_form_id !== undefined) update.distribution_form_id = patch.distribution_form_id
  const { data, error } = await svc.from("book_projects").update(update).eq("brokerage_id", brokerageId).eq("id", bookId).select("id")
  if (error) return `Book project not saved: ${error.message ?? "unknown"}`
  if ((data ?? []).length !== 1) return "Book project not saved: no row matched this brokerage + id"
  return null
}

/**
 * The capture form a DISTRIBUTED book rides (its landing copy is what the layout stage updates), tenant-pinned. null when the
 * book is not distributed as a lead magnet. A refused read is an error.
 */
export async function loadDistributionForm(svc: Svc, brokerageId: string, formId: string | null): Promise<{ ok: true; form: { id: string; name: string | null; slug: string | null; landing_content: Record<string, unknown> | null } | null } | { ok: false; error: string }> {
  if (!formId) return { ok: true, form: null }
  const { data, error } = await svc.from("lead_capture_forms").select("id, name, slug, landing_content").eq("id", formId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `The distributing lead magnet is unreadable: ${error.message ?? "unknown"}` }
  return { ok: true, form: (data as { id: string; name: string | null; slug: string | null; landing_content: Record<string, unknown> | null } | null) ?? null }
}

/**
 * The book a capture form distributes, for the lead-magnet kernel's publish gate and delivery (lib/kernel/lead-magnets.ts)
 * and the review surface. THE POINTER IS THE MARKER: the start writes settings.book_id in the SAME insert that creates the
 * form, so a form without one is an ordinary lead magnet and nothing is read. A pointer whose book is unreadable, missing, or
 * distributed by ANOTHER form is `error` — the publish gate then FAILS CLOSED rather than publishing a book page it could not
 * check.
 */
export async function loadDistributedBook(svc: Svc, brokerageId: string, formId: string, settings?: Record<string, unknown> | null): Promise<{ book: BookRow | null; error: string | null }> {
  const pointer = distributedBookIdOf(settings ?? null)
  if (!pointer) return { book: null, error: null }
  const res = await loadBookRow(svc, brokerageId, { bookId: pointer })
  if (!res.ok) return { book: null, error: res.error }
  if (res.row.distribution_form_id && res.row.distribution_form_id !== formId) return { book: null, error: `book ${pointer} is distributed by another lead magnet` }
  return { book: res.row, error: null }
}
