// lib/security/credential-projection.ts
//
// THE NON-SECRET PROJECTION OF A CREDENTIAL STORE (wave 140, lane 140P).
//
// lib/security/credential-rotation.ts SECRET_STORE_COLUMNS is the ONE list of the four credential
// stores and their secret columns (sealed `enc:v1:` envelopes since wave 140H). A reader whose rows
// reach a BROWSER — a page/component prop, a `"use server"` return value — must never carry those
// columns, sealed or not: the browser has no key, never needs the value, and a ciphertext shipped to
// every tab is still a secret shipped. Six readers selected `*` from a store and handed the rows on
// (lane 140H's census: 20 wildcard store readers). They now read THIS projection, spelled once per
// store (CLAUDE.md §6 — one vocabulary; five hand-typed column lists would drift).
//
// Each list is the store's live columns (scripts/schema-snapshot.ts) MINUS SECRET_STORE_COLUMNS;
// scripts/credential-migration-guard.ts proves both halves (no secret column, only live columns).
// PURE — no imports, no I/O.

export const CREDENTIAL_STORE_PUBLIC_COLUMNS = {
  platform_credentials: [
    "id", "brokerage_id", "owner_type", "owner_id", "agent_user_id", "platform", "scope", "api_url",
    "token_expires_at", "account_id", "account_name", "is_active", "last_synced_at", "last_tested_at",
    "test_status", "sync_error", "config", "created_at", "updated_at",
  ],
  social_media_accounts: [
    "id", "brokerage_id", "user_id", "agent_id", "platform", "account_id", "account_name", "scope",
    "token_expires_at", "is_active", "created_at", "updated_at",
  ],
  integration_credentials: ["id", "brokerage_id", "provider_name", "webhook_url", "is_active", "created_at", "updated_at"],
} as const

export type CredentialStoreWithProjection = keyof typeof CREDENTIAL_STORE_PUBLIC_COLUMNS

/** The `.select()` string for a store's non-secret columns. */
export function publicCredentialSelect(store: CredentialStoreWithProjection): string {
  return CREDENTIAL_STORE_PUBLIC_COLUMNS[store].join(", ")
}
