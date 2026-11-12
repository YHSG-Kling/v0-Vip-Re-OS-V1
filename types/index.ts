// Re-export all types from the main types file
export * from '../types'

// TOMBSTONE (§1.1, 2026-08-31, lane M4): `DemoUser` + `DEMO_USERS` deleted —
// a dead second copy of the demo roster (3 users, hard-coded plaintext
// passwords, a nested shape nothing consumed). SURVIVOR:
// app/constants/auth.ts:DEMO_USERS (20 personas), the copy the live demo flow
// actually reads (app/actions/demo-auth.ts → the login page's demo picker).
// Nothing merged: the survivor's consumer wants none of this copy's shape,
// and its only unique content — three invented UUIDs and weaker passwords —
// is not a capability.
