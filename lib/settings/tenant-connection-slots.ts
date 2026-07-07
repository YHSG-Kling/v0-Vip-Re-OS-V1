// lib/settings/tenant-connection-slots.ts
// Slot definitions for tenant-finished vendor connections — lives OUTSIDE the
// "use server" action file so clients can import the const directly.

export const TENANT_CONNECTION_SLOTS = [
  { key: "listhub", label: "ListHub (listing syndication)", fields: ["api_key", "account_id"], note: "Your ListHub publisher credentials — syndication to Zillow/realtor.com flows through your ListHub account." },
  { key: "mls_direct", label: "MLS direct (your board's feed)", fields: ["api_key", "api_url", "account_id"], note: "RESO Web API credentials from your MLS board. Once connected, your board data supersedes the platform default feed." },
  { key: "showingtime", label: "ShowingTime", fields: ["api_key", "account_id"], note: "Your ShowingTime API credentials. The scheduling client is wired; activation completes when ShowingTime verifies partner access on your account." },
] as const
