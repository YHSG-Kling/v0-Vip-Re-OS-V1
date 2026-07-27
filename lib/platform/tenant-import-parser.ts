// lib/platform/tenant-import-parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT DATA IMPORT — the PURE half of the white-glove migration lever (the
// inbound mirror of lib/platform/tenant-export.ts). This module is deliberately
// CLIENT-SAFE: no supabase, no env, no server imports — the god-console panel
// runs the SAME parser for its dry-run preview that the server engine runs for
// the real import, so what staff preview is exactly what lands.
//
// CSV dialect: RFC-4180-tolerant, hand-rolled (no csv dep exists in
// package.json and one function doesn't justify adding one). Handles quoted
// fields, commas + newlines inside quotes, "" escapes, CRLF/LF, and a BOM.
//
// Honesty rule: a row either parses cleanly and is returned in `rows`, or it
// is reported in `errors` with its 1-based file line number. Nothing is
// silently dropped — every input row is accounted for on one side or the other.

// ─── Low-level CSV records ───────────────────────────────────────────────────

interface CsvRecord {
  /** 1-based line number in the file where this record STARTS. */
  line: number
  cells: string[]
}

/** RFC-4180-tolerant scan: quoted fields, "" escapes, newlines inside quotes. */
export function csvToRecords(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // strip BOM
  const records: CsvRecord[] = []
  let cells: string[] = []
  let cell = ""
  let inQuotes = false
  let line = 1
  let recordStartLine = 1
  let sawAny = false // current record has content (guards trailing newline)

  const pushCell = () => { cells.push(cell); cell = ""; }
  const pushRecord = () => {
    pushCell()
    // Skip records that are entirely empty (blank lines).
    if (cells.length > 1 || cells[0].trim() !== "") records.push({ line: recordStartLine, cells })
    cells = []
    sawAny = false
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } // escaped quote
        else inQuotes = false
      } else {
        if (ch === "\n") line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === "") { inQuotes = true; sawAny = true; continue }
    if (ch === '"') { cell += ch; sawAny = true; continue } // stray quote mid-cell — tolerate literally
    if (ch === ",") { pushCell(); sawAny = true; continue }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; pushRecord(); line++; recordStartLine = line; continue }
    if (ch === "\n") { pushRecord(); line++; recordStartLine = line; continue }
    cell += ch
    sawAny = true
  }
  if (sawAny || cell !== "" || cells.length > 0) pushRecord()
  return records
}

// ─── Header alias mapping ────────────────────────────────────────────────────

/** Normalize a header for alias matching: lowercase, strip everything non-alphanumeric. */
function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Canonical contact fields ← common CRM/spreadsheet header spellings (normalized). */
const CONTACT_HEADER_ALIASES: Record<string, string> = {
  // names
  firstname: "first_name", first: "first_name", fname: "first_name", givenname: "first_name",
  lastname: "last_name", last: "last_name", lname: "last_name", surname: "last_name", familyname: "last_name",
  name: "full_name", fullname: "full_name", contactname: "full_name",
  // reach
  email: "email", emailaddress: "email", primaryemail: "email",
  phone: "phone", phonenumber: "phone", mobile: "phone", mobilephone: "phone",
  cell: "phone", cellphone: "phone", primaryphone: "phone", telephone: "phone", phone1: "phone",
  // address
  address: "address", street: "address", streetaddress: "address", address1: "address",
  addressline1: "address", mailingaddress: "address",
  city: "city", town: "city",
  state: "state", province: "state", region: "state",
  zip: "zip", zipcode: "zip", postalcode: "zip", postal: "zip",
  // provenance + context
  source: "source", leadsource: "source", contactsource: "source",
  notes: "notes", note: "notes", comments: "notes", comment: "notes", description: "notes",
  tags: "tags", labels: "tags", groups: "tags",
}

/** Canonical listing fields ← common header spellings (normalized). */
const LISTING_HEADER_ALIASES: Record<string, string> = {
  address: "address", street: "address", streetaddress: "address", address1: "address",
  propertyaddress: "address", fulladdress: "address",
  city: "city", town: "city",
  state: "state", province: "state", region: "state",
  zip: "zip", zipcode: "zip", postalcode: "zip", postal: "zip",
  listprice: "list_price", price: "list_price", askingprice: "list_price", listingprice: "list_price",
  listingdate: "listing_date", listdate: "listing_date", datelisted: "listing_date",
  mlsnumber: "mls_number", mls: "mls_number", mlsid: "mls_number",
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface ParsedContactRow {
  /** 1-based line number in the source file (header line counted). */
  line: number
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  /** Digits-only phone, only when >= 7 digits (the platform's dedupe key). */
  phoneDigits: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  source: string | null
  notes: string | null
  tags: string[] | null
}

export interface CsvRowError { line: number; problem: string }

export interface ParseContactsCsvResult {
  rows: ParsedContactRow[]
  errors: CsvRowError[]
  /** Raw headers as they appeared in the file. */
  headers: string[]
  /** Headers that matched no known alias (their data is not imported — surfaced, never hidden). */
  unmappedHeaders: string[]
  /** Total data records seen (rows.length + row-level errors). */
  totalDataRows: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").trim()
  return t === "" ? null : t
}

/**
 * PURE header-mapped contacts CSV parser. Every data record ends up either in
 * `rows` or in `errors` (with its file line number) — never both, never neither.
 * Row-level problems: no name/email/phone at all; malformed email; more cells
 * than headers (a mangled line whose values can't be trusted column-wise).
 */
export function parseContactsCsv(csvText: string): ParseContactsCsvResult {
  const records = csvToRecords(csvText)
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, problem: "File is empty" }], headers: [], unmappedHeaders: [], totalDataRows: 0 }
  }

  const headerRec = records[0]
  const headers = headerRec.cells.map((h) => h.trim())
  const mapping: (string | null)[] = headers.map((h) => CONTACT_HEADER_ALIASES[normHeader(h)] ?? null)
  const unmappedHeaders = headers.filter((_, i) => mapping[i] === null)

  if (!mapping.some((m) => m !== null)) {
    return {
      rows: [], headers, unmappedHeaders, totalDataRows: records.length - 1,
      errors: [{ line: headerRec.line, problem: `No recognizable columns. Found: ${headers.join(", ") || "(none)"}. Expected headers like first_name, last_name, email, phone, address, city, state, zip, source, notes, tags.` }],
    }
  }

  const rows: ParsedContactRow[] = []
  const errors: CsvRowError[] = []

  for (let r = 1; r < records.length; r++) {
    const { line, cells } = records[r]
    if (cells.length > headers.length) {
      errors.push({ line, problem: `Row has ${cells.length} fields but the header has ${headers.length} — check for an unquoted comma` })
      continue
    }
    const field: Record<string, string | null> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = mapping[c]
      if (!key) continue
      const val = clean(cells[c])
      if (val !== null && field[key] == null) field[key] = val
    }

    const out = parseContactFields(field, line)
    if ("problem" in out) errors.push(out)
    else rows.push(out)
  }

  return { rows, errors, headers, unmappedHeaders, totalDataRows: records.length - 1 }
}

/**
 * PURE: one already-header-mapped record → a row or the reason it cannot be one.
 *
 * Extracted so a CSV file and a vendor-API pull produce contacts through the SAME
 * validation. The CRM pull used to run a second, separate pipeline; this is the
 * single definition of "what a valid imported contact is".
 */
export function parseContactFields(
  field: Record<string, string | null>,
  line: number,
): ParsedContactRow | CsvRowError {
  // full_name → first/last when no explicit name columns filled
  let firstName = field.first_name ?? null
  let lastName = field.last_name ?? null
  if (!firstName && !lastName && field.full_name) {
    const parts = field.full_name.split(/\s+/)
    firstName = parts[0] ?? null
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null
  }

  const email = field.email ? field.email.toLowerCase() : null
  if (email && !EMAIL_RE.test(email)) {
    return { line, problem: `Invalid email: "${field.email}"` }
  }

  const phone = field.phone ?? null
  const digits = phone ? phone.replace(/\D/g, "") : ""
  const phoneDigits = digits.length >= 7 ? digits : null

  if (!firstName && !lastName && !email && !phoneDigits) {
    return { line, problem: "Row has no name, email, or usable phone" }
  }

  const tags = field.tags
    ? field.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean)
    : null

  return {
    line, firstName, lastName, email, phone, phoneDigits,
    address: field.address ?? null,
    city: field.city ?? null,
    state: field.state ?? null,
    zip: field.zip ?? null,
    source: field.source ?? null,
    notes: field.notes ?? null,
    tags: tags && tags.length > 0 ? tags : null,
  }
}

/**
 * Same contract as parseContactsCsv, for rows that arrive as objects rather than
 * CSV text — a vendor API pull. Keys are that vendor's CSV-export header names, so
 * they run through the identical CONTACT_HEADER_ALIASES mapping; `line` is the
 * 1-based position in the pulled page, for error reporting.
 */
export function parseContactRecords(records: Record<string, unknown>[]): ParseContactsCsvResult {
  const rows: ParsedContactRow[] = []
  const errors: CsvRowError[] = []
  const headerSet = new Set<string>()
  const unmapped = new Set<string>()

  records.forEach((rec, i) => {
    const field: Record<string, string | null> = {}
    for (const [rawKey, rawVal] of Object.entries(rec)) {
      headerSet.add(rawKey)
      const key = CONTACT_HEADER_ALIASES[normHeader(rawKey)] ?? null
      if (!key) { unmapped.add(rawKey); continue }
      const val = clean(rawVal == null ? "" : String(rawVal))
      if (val !== null && field[key] == null) field[key] = val
    }
    const out = parseContactFields(field, i + 1)
    if ("problem" in out) errors.push(out)
    else rows.push(out)
  })

  return {
    rows, errors,
    headers: [...headerSet],
    unmappedHeaders: [...unmapped],
    totalDataRows: records.length,
  }
}

// ─── Listings ────────────────────────────────────────────────────────────────

export interface ParsedListingRow {
  line: number
  address: string
  city: string | null
  state: string | null
  zip: string | null
  listPrice: number | null
  /** ISO date (YYYY-MM-DD) or null. */
  listingDate: string | null
  mlsNumber: string | null
}

export interface ParseListingsCsvResult {
  rows: ParsedListingRow[]
  errors: CsvRowError[]
  headers: string[]
  unmappedHeaders: string[]
  totalDataRows: number
}

/** Parse "$1,250,000" / "1250000.00" → integer dollars; null when absent; NaN → error upstream. */
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "")
  if (cleaned === "") return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : Number.NaN
}

/**
 * PURE header-mapped listings CSV parser — minimal draft shape only
 * (address/city/state/zip/list_price/listing_date/mls_number). Address is the
 * one hard requirement (listings.address is NOT NULL); a bad price or date is
 * a row error, never a silently-nulled field.
 */
export function parseListingsCsv(csvText: string): ParseListingsCsvResult {
  const records = csvToRecords(csvText)
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, problem: "File is empty" }], headers: [], unmappedHeaders: [], totalDataRows: 0 }
  }

  const headers = records[0].cells.map((h) => h.trim())
  const mapping: (string | null)[] = headers.map((h) => LISTING_HEADER_ALIASES[normHeader(h)] ?? null)
  const unmappedHeaders = headers.filter((_, i) => mapping[i] === null)

  if (!mapping.includes("address")) {
    return {
      rows: [], headers, unmappedHeaders, totalDataRows: records.length - 1,
      errors: [{ line: records[0].line, problem: `No address column found. Found: ${headers.join(", ") || "(none)"}. Expected headers like address, city, state, zip, list_price, listing_date, mls_number.` }],
    }
  }

  const rows: ParsedListingRow[] = []
  const errors: CsvRowError[] = []

  for (let r = 1; r < records.length; r++) {
    const { line, cells } = records[r]
    if (cells.length > headers.length) {
      errors.push({ line, problem: `Row has ${cells.length} fields but the header has ${headers.length} — check for an unquoted comma` })
      continue
    }
    const field: Record<string, string | null> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = mapping[c]
      if (!key) continue
      const val = clean(cells[c])
      if (val !== null && field[key] == null) field[key] = val
    }

    const address = field.address ?? null
    if (!address) {
      errors.push({ line, problem: "Row has no address (required for a listing)" })
      continue
    }

    let listPrice: number | null = null
    if (field.list_price != null) {
      listPrice = parsePrice(field.list_price)
      if (Number.isNaN(listPrice)) {
        errors.push({ line, problem: `Invalid list price: "${field.list_price}"` })
        continue
      }
    }

    let listingDate: string | null = null
    if (field.listing_date != null) {
      const d = new Date(field.listing_date)
      if (Number.isNaN(d.getTime())) {
        errors.push({ line, problem: `Invalid listing date: "${field.listing_date}"` })
        continue
      }
      listingDate = d.toISOString().slice(0, 10)
    }

    rows.push({
      line, address,
      city: field.city ?? null,
      state: field.state ?? null,
      zip: field.zip ?? null,
      listPrice, listingDate,
      mlsNumber: field.mls_number ?? null,
    })
  }

  return { rows, errors, headers, unmappedHeaders, totalDataRows: records.length - 1 }
}
