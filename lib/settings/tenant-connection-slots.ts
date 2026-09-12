// lib/settings/tenant-connection-slots.ts
// Slot definitions for tenant-finished vendor connections — lives OUTSIDE the
// "use server" action file so clients can import the const directly.

export const TENANT_CONNECTION_SLOTS = [
  { key: "listhub", label: "ListHub (listing syndication)", fields: ["api_key", "account_id"], note: "Your ListHub publisher credentials — syndication to Zillow/realtor.com flows through your ListHub account." },
  { key: "mls_direct", label: "MLS direct (your board's feed)", fields: ["api_key", "api_url", "account_id"], note: "RESO Web API credentials from your MLS board. Once connected, your board data supersedes the platform default feed." },
  { key: "showingtime", label: "ShowingTime", fields: ["api_key", "account_id"], note: "Your ShowingTime API credentials. The scheduling client is wired; activation completes when ShowingTime verifies partner access on your account." },
  // Ad providers (2026-09-07, m609 admits both names): the readers
  // lib/providers/openai-ads.ts and lib/providers/vibe.ts resolve these through
  // the Connection OS; until this wave nothing could WRITE them.
  { key: "openai_ads", label: "ChatGPT Ads (OpenAI Advertiser API)", fields: ["api_key"], note: "The Ads API key from ads.openai.com → Settings (one key per ad account). Once connected, approved ChatGPT campaigns launch from the ads workspace and the Ads Manager proposes launches automatically." },
  { key: "vibe", label: "Vibe streaming TV (Vibe Developer Platform)", fields: ["api_key", "api_secret", "account_id"], note: "Your Vibe app's client_id (API key) and client_secret, and the advertiser id to launch under. Once connected, staged TV spots launch on Vibe from the ads workspace." },
] as const
