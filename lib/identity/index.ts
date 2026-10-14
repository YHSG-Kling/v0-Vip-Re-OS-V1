// ─── AGENT CONTEXT ────────────────────────────────────────────────────────────
export { getAgentContext } from "./get-agent-context"

// ─── ACT-AS WRITE SEAM ────────────────────────────────────────────────────────
// Tenant-writing server actions gate through resolveWriteContext() and write
// through its `db`: cookie (RLS) client normally, service client ONLY under an
// active FULL impersonation grant re-validated at call time. read_only grants
// are refused. See lib/platform/acting-context.ts for the doctrine.
export {
  resolveWriteContext,
  resolveActingContext,
  READ_ONLY_ACTING_ERROR,
  type WriteContext,
} from "@/lib/platform/acting-context"
