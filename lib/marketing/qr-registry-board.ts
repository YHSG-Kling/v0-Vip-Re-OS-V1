// lib/marketing/qr-registry-board.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers for the QR registry boards (wave 81D). The registry is
// `qr_codes` (lib/marketing/tracked-qr.ts is its ONE writer); the tenant board
// is app/dashboard/agent/qr-codes and the platform board is
// app/dashboard/superadmin/qr-codes. Both classify ownership through ONE
// function (tracked-qr.ts qrOwnerKind) and this module holds the summary
// arithmetic so the page file exports nothing but Next's page fields.

import { qrOwnerKind } from "./tracked-qr"

export interface QrRegistrySummary {
  total: number
  platform: number
  tenant: number
  active: number
  scans: number
}

/** PURE: the board's summary line — counts by owner and activity. */
export function summarizeQrRegistry(rows: ReadonlyArray<{ brokerage_id?: string | null; is_active: boolean; scan_count: number | null }>): QrRegistrySummary {
  let platform = 0, tenant = 0, active = 0, scans = 0
  for (const r of rows) {
    if (qrOwnerKind(r) === "platform") platform++; else tenant++
    if (r.is_active) active++
    scans += r.scan_count ?? 0
  }
  return { total: rows.length, platform, tenant, active, scans }
}
