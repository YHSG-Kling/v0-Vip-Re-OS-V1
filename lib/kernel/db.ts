// lib/kernel/db.ts
// ─────────────────────────────────────────────────────────────────────────────
// TOMBSTONE (orphan burn-down, lane E). `expectSingle` and `maybeSingleRow`
// were deleted here. They had ZERO importers anywhere in the tree — not one,
// ever — and the discipline they encoded is enforced in this codebase by two
// live mechanisms that between them cover every call site, which two opt-in
// wrappers nobody opted into never did.
//
// WHAT THEY DID. Both took a `Promise<QueryResult<T>>`, destructured `error`
// for the caller, and returned a discriminated `{ success, data | error }` so a
// refused read could not be misread as an empty one — the real hazard, since
// supabase-js RESOLVES a refused query.
//
// WHERE THAT LIVES NOW — both halves, named:
//
//   · READS that must distinguish "refused" from "no rows" return a
//     DISCRIMINATED RESULT written at the call site, which is this repo's house
//     shape and is already used everywhere the distinction matters. The
//     canonical example is lib/auth/role-grants.ts:readRoleGrants (returns
//     `{ ok:false, error }` on refusal), and the pattern it feeds —
//     lib/auth/resolve-user-role.ts:361 `resolveTenantAdmin` and :414
//     `resolveBrokerageFinanceAdmin`, whose headers state the rule verbatim:
//     "supabase-js RESOLVES a refused query, so a boolean return would have to
//     report 'the read was denied' as false". Those carry the tenant pin and the
//     `via` provenance the generic wrapper could never carry, so they are
//     strictly MORE complete, not a restatement.
//
//   · WRITES that are deliberately allowed to fail declare it through
//     lib/db/best-effort.ts:1, and scripts/silent-write-guard.ts (npm run
//     test:silent-write, in the guard chain) FAILS CI on any write to a
//     consequential table that neither checks its error nor declares itself
//     there. That is a ratchet over the whole repo; `expectSingle` was a
//     courtesy two files could have chosen to use.
//
// Nothing was merged onto the survivors because the wrappers carried nothing
// they lack: `notFoundMessage` is a caller-supplied string the call-site shape
// already writes inline, and the try/catch is redundant against a client that
// resolves rather than throws.
//
// The module is kept as this note rather than removed so the next person to
// reach for a generic single-row helper finds the reason it is not here.

export {}
