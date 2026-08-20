// scripts/platform-ops-wiring-simulator.ts
//
// PLATFORM OPS RAIL — wiring + honesty simulator.
//
// Run:  npx tsx scripts/platform-ops-wiring-simulator.ts
//       npx tsx scripts/platform-ops-wiring-simulator.ts --negative
//       npx tsx scripts/platform-ops-wiring-simulator.ts --live
//       npx tsx scripts/platform-ops-wiring-simulator.ts --negative --live
//
// WHAT IT PROVES
//   1. The eleven previously-orphaned exports on this rail are reached by a
//      real surface a real user can open.
//   2. Every cross-tenant reader is gated on the PLATFORM capability, not on a
//      tenant role — asserted structurally, by slicing the guarded function
//      body and checking the gate precedes the work.
//   3. A tenant-scoped reader carries an explicit brokerage filter (the RLS on
//      every table here is (brokerage_id IS NULL) OR (brokerage_id =
//      current_user_brokerage_id()), so an untenanted row is readable by every
//      brokerage — dropping the filter leaks, it does not merely widen).
//   4. A FAILED read cannot render as a healthy zero. Every reader reports
//      ok / empty / unavailable and no numeric render survives the last two.
//
// HOW IT SCANS
//   Comments are STRIPPED (replaced with spaces, so every byte offset still
//   lines up with the file on disk) before any assertion runs, so prose in a
//   docstring can never satisfy a check. String bodies are additionally
//   blanked into a "skeleton" used for brace matching, so a brace inside a
//   string literal cannot mis-slice a function body. Assertions run against
//   sliced FUNCTION BODIES, not against the whole file.
//
// NEGATIVE TESTING
//   --negative breaks each assertion at its source, PROVES the mutation
//   actually landed (byte length or content must differ), re-runs only that
//   assertion, requires it to flip to failure, restores the file, and verifies
//   the restore by sha256. An assertion that cannot be made to fail is
//   reported as THEATRE and fails the run.

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { blankComments, blankStrings, stripComments } from "./strip-comments"

// Resolved from the process CWD (repo root) so the file works as ESM or CJS.
const ROOT = process.cwd()

const F = {
  SH: "app/actions/system-health.ts",
  DC: "app/actions/admin/domain-coherence.ts",
  DCP: "app/dashboard/admin/domain-coherence/page.tsx",
  DCW: "app/components/features/admin/domain-coherence/DomainCoherenceWorkspace.tsx",
  SSP: "app/dashboard/system/components/os/service-sla-panel.tsx",
  SYSP: "app/dashboard/system/page.tsx",
  SCS: "app/dashboard/system/components/os/system-command-strip.tsx",
  OIP: "app/dashboard/system/components/os/operational-impact-panel.tsx",
  ADC: "app/dashboard/admin/admin-dashboard-client.tsx",
  ADP: "app/dashboard/admin/page.tsx",
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer: strip comments, blank string bodies. Length-preserving.
// ─────────────────────────────────────────────────────────────────────────────

interface Scanned {
  /** Comments replaced by spaces. Same length as the raw file. */
  noComments: string
  /** Comments AND string/template interiors replaced by spaces. Same length. */
  skeleton: string
}

/**
 * Both views come from the ONE scanner in scripts/strip-comments.ts (finding
 * #250). This used to be a 70-line character scan of its own — the same scan,
 * re-implemented, and therefore the same bugs re-implemented: it read a lone
 * backtick inside a double-quoted string as the start of a template and paired
 * every literal after it off by one, and it treated `${…}` as string content
 * when interpolations are CODE and can hold a real call.
 *
 * `blankComments` blanks comment bodies; `blankStrings` blanks comment bodies
 * AND string/template interiors. Both preserve length and every offset, which
 * is what the brace-matching below depends on. The `jsx` hint is no longer
 * needed: the canonical scanner decides `/` by what precedes it and abandons an
 * unterminated regex at the newline, so `</Tag>` cannot open one.
 */
function scan(raw: string, _opts: { jsx: boolean }): Scanned {
  return { noComments: blankComments(raw), skeleton: blankStrings(raw) }
}

interface Src extends Scanned {
  path: string
  raw: string
}

function load(rel: string): Src {
  const raw = readFileSync(resolve(ROOT, rel), "utf8")
  const s = scan(raw, { jsx: rel.endsWith(".tsx") })
  return { path: rel, raw, ...s }
}

/**
 * Slice a function body by NAME using brace matching over the skeleton, so
 * braces inside strings, comments and regexes cannot mis-close the body.
 * Returns the body WITH comments stripped (literals intact).
 */
function fnBody(src: Src, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`)
  const m = decl.exec(src.skeleton)
  if (!m) throw new Error(`function ${name} not found in ${src.path}`)
  let i = m.index + m[0].length - 1
  // walk out of the parameter list
  let paren = 0
  for (; i < src.skeleton.length; i++) {
    if (src.skeleton[i] === "(") paren++
    else if (src.skeleton[i] === ")") {
      paren--
      if (paren === 0) { i++; break }
    }
  }
  // Skip a return-type annotation. A `{` inside `Promise<{ ... }>` sits at
  // angle-depth > 0 and is NOT the function body.
  let angle = 0
  for (; i < src.skeleton.length; i++) {
    const ch = src.skeleton[i]
    if (ch === "<") angle++
    else if (ch === ">") angle = Math.max(0, angle - 1)
    else if (ch === "{" && angle === 0) break
  }
  if (i >= src.skeleton.length) throw new Error(`body of ${name} not found in ${src.path}`)
  let depth = 0
  const start = i
  for (; i < src.skeleton.length; i++) {
    if (src.skeleton[i] === "{") depth++
    else if (src.skeleton[i] === "}") {
      depth--
      if (depth === 0) return src.noComments.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced body for ${name} in ${src.path}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion plumbing
// ─────────────────────────────────────────────────────────────────────────────

class CheckFailed extends Error {}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new CheckFailed(msg)
}

function before(hay: string, first: string, second: string, msg: string): void {
  const a = hay.indexOf(first)
  const b = hay.indexOf(second)
  ok(a !== -1, `${msg}: missing anchor ${JSON.stringify(first)}`)
  ok(b !== -1, `${msg}: missing anchor ${JSON.stringify(second)}`)
  ok(a < b, `${msg}: ${JSON.stringify(first)} must precede ${JSON.stringify(second)}`)
}

interface Check { id: string; run: () => void }

// Tables this rail reads, and the columns each reader touches. Used by the
// live layer as a phantom-column probe.
const TABLE_COLUMNS: Record<string, string[]> = {
  service_status: "id,brokerage_id,service_name,service_key,service_category,current_status,last_checked_at,last_healthy_at,consecutive_failures,response_time_ms,error_message,is_critical".split(","),
  system_health_checks: "id,brokerage_id,service_key,service_name,service_category,status,response_time_ms,http_status_code,error_message,checked_at".split(","),
  health_check_history: "id,brokerage_id,service_key,snapshot_date,uptime_pct,total_checks,failed_checks,avg_response_ms,incidents".split(","),
  api_response_logs: "id,brokerage_id,service_key,endpoint,response_time_ms,status_code,is_error,error_type,recorded_at".split(","),
  message_provider_logs: "id,brokerage_id,provider_key,provider_status,sent_at,event_at".split(","),
  cron_execution_logs: "id,brokerage_id,cron_path,cron_name,status,duration_ms,records_processed,error_message,started_at,completed_at".split(","),
  automation_errors: "id,brokerage_id,workflow_name,error_message,severity,status,created_at,resolved_at".split(","),
}

const SH_ORPHANS = [
  "exportSLAReport",
  "getMessageProviderStats",
  "getResponseTimeLogs",
  "getServiceHealthHistory",
  "getUptimeHistory",
]

const DC_ORPHANS = [
  "actionClassifyRouteOwnership",
  "actionDetectDuplicateManagerSurfaces",
  "actionEnumerateDomainRoutes",
  "actionValidateCanonicalManagerUsage",
  "actionValidateContractIntegrity",
  "actionValidateProviderBackedFeatures",
]

const DC_ACTIONS = [...DC_ORPHANS, "actionNormalizeNavigationVisibility", "actionGenerateDomainCoherenceReport"]

/** Kernel commands an action must not reach before its gate. */
const KERNEL_CALLS = [
  "enumerateDomainRoutes(",
  "classifyRouteOwnership(",
  "validateCanonicalManagerUsage(",
  "detectDuplicateManagerSurfaces(",
  "normalizeNavigationVisibility(",
  "validateProviderBackedFeatures(",
  "validateContractIntegrity(",
  "generateDomainCoherenceReport(",
]

// Readers in system-health.ts that query a tenant table, and the table each one
// must filter. Every one of these tables has the untenanted-row RLS hole.
const TENANT_READERS: Array<{ fn: string; table: string }> = [
  { fn: "getServiceHealthHistory", table: "system_health_checks" },
  { fn: "getUptimeHistory", table: "health_check_history" },
  { fn: "getResponseTimeLogs", table: "api_response_logs" },
  { fn: "getMessageProviderStats", table: "message_provider_logs" },
  { fn: "readSLASummary", table: "health_check_history" },
  { fn: "getServiceStatuses", table: "service_status" },
]

const CHECKS: Check[] = [
  // ── 1. Orphans reach a surface ────────────────────────────────────────────
  {
    id: "orphans-system-health-wired",
    run: () => {
      const ssp = load(F.SSP)
      const importBlock = ssp.noComments.slice(
        ssp.noComments.indexOf("from '@/app/actions/system-health'") - 900,
        ssp.noComments.indexOf("from '@/app/actions/system-health'"),
      )
      const body = fnBody(ssp, "ServiceSLAPanel")
      const helpers = ssp.noComments // arrow-function helpers live outside the component body
      for (const fn of SH_ORPHANS) {
        ok(importBlock.includes(fn), `${F.SSP} does not import ${fn}`)
        const invoked =
          new RegExp(`\\b${fn}\\s*\\(`).test(body) || new RegExp(`\\b${fn}\\s*\\(`).test(helpers)
        ok(invoked, `${F.SSP} imports ${fn} but never calls it`)
      }
    },
  },
  {
    id: "orphans-domain-coherence-wired",
    run: () => {
      const dcp = load(F.DCP)
      const dcw = load(F.DCW)
      const page = fnBody(dcp, "DomainCoherencePage")
      const refresh = fnBody(dcw, "handleRefresh")
      for (const fn of DC_ORPHANS) {
        ok(
          new RegExp(`\\b${fn}\\s*\\(`).test(page),
          `${F.DCP} server render never calls ${fn}`,
        )
        ok(
          new RegExp(`\\b${fn}\\s*\\(`).test(refresh),
          `${F.DCW} re-run-audit never calls ${fn}`,
        )
      }
    },
  },
  {
    id: "sla-panel-mounted-on-system-page",
    run: () => {
      const p = load(F.SYSP)
      const body = fnBody(p, "SystemPage")
      ok(p.noComments.includes("ServiceSLAPanel"), `${F.SYSP} does not import ServiceSLAPanel`)
      ok(/<ServiceSLAPanel\b/.test(body), `${F.SYSP} never renders <ServiceSLAPanel>`)
    },
  },

  // ── 2. Every read destructures error ──────────────────────────────────────
  {
    id: "system-health-reads-destructure-error",
    run: () => {
      const sh = load(F.SH)
      const re = /const\s*\{([^}]*)\}\s*=\s*await\s+supabase/g
      let m: RegExpExecArray | null
      let seen = 0
      while ((m = re.exec(sh.noComments))) {
        seen++
        ok(
          /\berror\b/.test(m[1]),
          `${F.SH}: a supabase read destructures ${JSON.stringify(m[1].trim())} without error — supabase-js RESOLVES a refused query, so this silently becomes an empty result`,
        )
      }
      ok(seen >= 6, `${F.SH}: expected at least 6 destructured supabase reads, found ${seen}`)
    },
  },

  // ── 3. Tenant filter on every tenant-scoped read ──────────────────────────
  {
    id: "tenant-readers-carry-brokerage-filter",
    run: () => {
      const sh = load(F.SH)
      for (const { fn, table } of TENANT_READERS) {
        const body = fnBody(sh, fn)
        const at = body.indexOf(`.from("${table}")`)
        ok(at !== -1, `${F.SH}:${fn} no longer reads ${table}`)
        // the chain runs until the statement that consumes it
        const chain = body.slice(at, at + 700)
        ok(
          chain.includes('.eq("brokerage_id"'),
          `${F.SH}:${fn} reads ${table} without an explicit brokerage filter — RLS admits (brokerage_id IS NULL), so untenanted rows would be served to every brokerage`,
        )
      }
    },
  },
  {
    id: "tenant-readers-refuse-without-scope",
    run: () => {
      const sh = load(F.SH)
      for (const fn of [...SH_ORPHANS.filter((f) => f !== "exportSLAReport"), "readSLASummary"]) {
        const body = fnBody(sh, fn)
        ok(
          body.includes("ctx.brokerageId") && body.includes("not_scoped"),
          `${F.SH}:${fn} has no brokerage-scope guard returning not_scoped`,
        )
        before(
          body,
          "not_scoped",
          ".from(",
          `${F.SH}:${fn} scope guard must run before the query`,
        )
      }
    },
  },

  // ── 4. A failed read cannot render as a healthy zero ──────────────────────
  {
    id: "readers-report-ok-empty-unavailable",
    run: () => {
      const sh = load(F.SH)
      for (const fn of ["getServiceHealthHistory", "getUptimeHistory", "getResponseTimeLogs", "getMessageProviderStats", "readSLASummary"]) {
        const body = fnBody(sh, fn)
        ok(body.includes('status: "unavailable"'), `${F.SH}:${fn} has no unavailable verdict`)
        ok(body.includes('status: "empty"'), `${F.SH}:${fn} has no empty verdict distinct from ok`)
        ok(body.includes('status: "ok"'), `${F.SH}:${fn} never returns ok`)
        const errAt = body.indexOf("if (error)")
        ok(errAt !== -1, `${F.SH}:${fn} does not branch on the read error`)
        const okAt = body.indexOf('status: "ok"')
        const emptyAt = body.indexOf('status: "empty"')
        ok(
          errAt < okAt,
          `${F.SH}:${fn} returns ok before handling the read error — a refused read would render as data`,
        )
        ok(
          emptyAt < okAt,
          `${F.SH}:${fn} returns ok before distinguishing "nothing was collected" — an empty table would render as a measured value`,
        )
        ok(
          !/return\s*\[\s*\]/.test(body),
          `${F.SH}:${fn} still has a bare "return []" — an empty list reads exactly like healthy`,
        )
      }
    },
  },
  {
    id: "service-statuses-unknown-not-operational",
    run: () => {
      const sh = load(F.SH)
      const body = fnBody(sh, "getServiceStatuses")
      const errAt = body.indexOf("if (error)")
      ok(errAt !== -1, `${F.SH}:getServiceStatuses does not branch on the read error`)
      const errBlock = body.slice(errAt, errAt + 700)
      ok(
        errBlock.includes('overallStatus: "unknown"'),
        `${F.SH}:getServiceStatuses returns something other than "unknown" from a refused read`,
      )
      ok(
        !errBlock.includes('overallStatus: "operational"'),
        `${F.SH}:getServiceStatuses manufactures "operational" from a refused read`,
      )
      const emptyAt = body.indexOf("typedServices.length === 0")
      ok(emptyAt !== -1, `${F.SH}:getServiceStatuses does not detect the zero-service case`)
      const emptyBlock = body.slice(emptyAt, emptyAt + 700)
      ok(
        emptyBlock.includes('overallStatus: "unknown"'),
        `${F.SH}:getServiceStatuses calls an unmeasured platform "operational"`,
      )
      ok(
        body.includes('readStatus: "ok"') && body.includes('readStatus: "empty"') && body.includes('readStatus: "unavailable"'),
        `${F.SH}:getServiceStatuses does not expose all three read states to its callers`,
      )
    },
  },
  {
    id: "message-provider-window-matches-a-real-writer",
    run: () => {
      const sh = load(F.SH)
      const body = fnBody(sh, "getMessageProviderStats")
      ok(
        !/\.gte\(\s*"event_at"/.test(body),
        `${F.SH}:getMessageProviderStats filters on event_at, which has no default and no writer — a permanent zero wearing a working query`,
      )
      ok(
        /\.or\(/.test(body) && body.includes("sent_at.gte."),
        `${F.SH}:getMessageProviderStats must window on sent_at (the column the writers actually populate)`,
      )
      ok(
        body.includes("undatedExcluded"),
        `${F.SH}:getMessageProviderStats must report rows that carry no timestamp at all, or the delivery rate silently drops failures`,
      )
    },
  },
  {
    id: "sla-export-refuses-non-ok",
    run: () => {
      const sh = load(F.SH)
      const body = fnBody(sh, "exportSLAReport")
      const guard = body.indexOf('summary.status !== "ok"')
      ok(guard !== -1, `${F.SH}:exportSLAReport does not gate on the read verdict`)
      const csv = body.indexOf("csvData")
      ok(guard < csv, `${F.SH}:exportSLAReport builds a CSV before checking the read succeeded`)
      ok(
        body.includes("return summary"),
        `${F.SH}:exportSLAReport must hand the refusal back instead of emitting an empty report`,
      )
    },
  },

  // ── 5. Platform authorization on cross-tenant readers ─────────────────────
  {
    id: "domain-coherence-actions-are-platform-gated",
    run: () => {
      const dc = load(F.DC)
      for (const fn of DC_ACTIONS) {
        const body = fnBody(dc, fn)
        const gateAt = body.indexOf("requirePlatformStaff()")
        ok(gateAt !== -1, `${F.DC}:${fn} has no platform gate`)
        const refuseAt = body.indexOf('"error" in auth')
        ok(refuseAt !== -1, `${F.DC}:${fn} never refuses a failed gate`)
        ok(gateAt < refuseAt, `${F.DC}:${fn} refuses before it gates`)
        const workAt = KERNEL_CALLS.map((k) => body.indexOf(k))
          .filter((v) => v !== -1)
          .sort((a, b) => a - b)[0]
        ok(workAt !== undefined, `${F.DC}:${fn} calls no kernel command — is it still the same action?`)
        ok(
          refuseAt < workAt,
          `${F.DC}:${fn} reaches the registry before the gate has refused — cross-tenant governance data would be computed for an unauthorized caller`,
        )
      }
    },
  },
  {
    id: "domain-coherence-gate-is-platform-capability",
    run: () => {
      const dc = load(F.DC)
      const guard = fnBody(dc, "requirePlatformStaff")
      ok(
        guard.includes("requirePlatformCapability("),
        `${F.DC}: the guard no longer delegates to the canonical platform capability gate`,
      )
      ok(
        guard.includes("!gate.ok"),
        `${F.DC}: the guard does not refuse when the capability check fails`,
      )
      ok(
        !/user_type/.test(stripComments(dc.noComments.replace(/^[\s\S]*?\bimport\b/, ""))) ||
          !/\[[^\]]*"broker"[^\]]*\]\s*\.includes/.test(dc.noComments),
        `${F.DC}: a tenant-role list is being used as the authorization gate for platform-wide data`,
      )
    },
  },
  {
    id: "domain-coherence-page-is-platform-gated",
    run: () => {
      const dcp = load(F.DCP)
      const body = fnBody(dcp, "DomainCoherencePage")
      const gateAt = body.indexOf('requirePlatformCapability("sentinel")')
      ok(gateAt !== -1, `${F.DCP} does not call requirePlatformCapability("sentinel")`)
      const refuseAt = body.indexOf("!gate.ok")
      ok(refuseAt !== -1, `${F.DCP} never refuses a failed gate`)
      const firstAction = DC_ACTIONS.map((a) => body.indexOf(`${a}(`))
        .filter((v) => v !== -1)
        .sort((a, b) => a - b)[0]
      ok(firstAction !== undefined, `${F.DCP} calls no coherence action`)
      ok(refuseAt < firstAction, `${F.DCP} runs the audit before refusing an unauthorized caller`)
      ok(
        !body.includes("broker_admin"),
        `${F.DCP} still names broker_admin, which is not in the users.user_type CHECK vocabulary`,
      )
    },
  },
  {
    id: "coherence-workspace-computes-nothing-client-side",
    run: () => {
      const dcw = load(F.DCW)
      const imports = /import\s+(type\s+)?\{[^}]*\}\s+from\s+"@\/lib\/kernel\/routes"/g
      let m: RegExpExecArray | null
      let found = 0
      while ((m = imports.exec(dcw.noComments))) {
        found++
        ok(
          m[1] !== undefined,
          `${F.DCW} imports RUNTIME values from lib/kernel/routes — the client would recompute the platform registry with no authorization check`,
        )
      }
      ok(found >= 1, `${F.DCW} no longer references the kernel route types at all`)
      for (const fn of ["enumerateDomainRoutes(", "validateCanonicalManagerUsage(", "validateProviderBackedFeatures("]) {
        ok(
          !dcw.noComments.includes(fn),
          `${F.DCW} calls ${fn} in the browser instead of the gated server action`,
        )
      }
    },
  },
  {
    id: "coherence-workspace-renders-refusals",
    run: () => {
      const dcw = load(F.DCW)
      ok(
        /function\s+ActionRefusal\s*\(/.test(dcw.noComments),
        `${F.DCW} has no refusal renderer — a refused action would fall through to an empty, clean-looking tab`,
      )
      const body = fnBody(dcw, "DomainCoherenceWorkspace")
      const uses = body.match(/<ActionRefusal\b/g) ?? []
      ok(
        uses.length >= 6,
        `${F.DCW} renders only ${uses.length} refusal states; every one of the 6 server-fed panels needs one`,
      )
      for (const key of ["report", "routes", "ownership", "duplicates", "managers", "providers", "contracts"]) {
        ok(
          body.includes(`data.${key}.success`),
          `${F.DCW} renders data.${key} without checking the action succeeded`,
        )
      }
    },
  },

  // ── 6. Surfaces never turn a non-ok verdict into a number ─────────────────
  {
    id: "sla-panel-metrics-guarded-by-ok",
    run: () => {
      const ssp = load(F.SSP)
      const body = fnBody(ssp, "ServiceSLAPanel")
      const guards = body.match(/\.read\.status === 'ok'/g) ?? []
      ok(
        guards.length >= 5,
        `${F.SSP} guards only ${guards.length} renders on status 'ok'; all five readers must be guarded`,
      )
      const verdicts = body.match(/<ReadVerdict\b/g) ?? []
      ok(
        verdicts.length >= 5,
        `${F.SSP} renders only ${verdicts.length} verdicts; every reader must be able to say it is unavailable`,
      )
      for (const bad of ["?? 0", "|| 0", "?? 100", "|| 100"]) {
        ok(
          !body.includes(bad),
          `${F.SSP} contains ${JSON.stringify(bad)} — a missing measurement must not fall back to a number`,
        )
      }
    },
  },
  {
    id: "command-strip-unknown-outranks-operational",
    run: () => {
      const scs = load(F.SCS)
      const body = fnBody(scs, "SystemCommandStrip")
      ok(
        body.includes("const priorityAction = !measured"),
        `${F.SCS}: the unknown branch is no longer the FIRST branch of priorityAction`,
      )
      ok(
        /overallStatus !== 'unknown'/.test(body),
        `${F.SCS}: "measured" is not derived from the server's overallStatus verdict`,
      )
      before(
        body,
        "severity: 'unknown'",
        "All systems operational",
        `${F.SCS}: the green banner must be unreachable until something was measured`,
      )
    },
  },
  {
    id: "impact-panel-unknown-outranks-no-impact",
    run: () => {
      const oip = load(F.OIP)
      const body = fnBody(oip, "OperationalImpactPanel")
      ok(
        body.includes("serviceReadStatus === 'ok'"),
        `${F.OIP}: "measured" is not derived from the server's read verdict`,
      )
      before(
        body,
        "{!serviceHealthMeasured ? (",
        "No Operational Impact",
        `${F.OIP}: the green "no impact" claim must be unreachable until service health was actually read`,
      )
    },
  },
  {
    id: "coherence-entry-point-is-staff-only",
    run: () => {
      const adc = load(F.ADC)
      const linkAt = adc.noComments.indexOf('href="/dashboard/admin/domain-coherence"')
      ok(linkAt !== -1, `${F.ADC}: the domain coherence entry point disappeared`)
      const window = adc.noComments.slice(Math.max(0, linkAt - 400), linkAt)
      ok(
        window.includes("canReadDomainCoherence && ("),
        `${F.ADC}: the domain coherence link is shown to tenant admins who will only be refused`,
      )
      const adp = load(F.ADP)
      const page = fnBody(adp, "AdminPage")
      ok(
        page.includes('requirePlatformCapability("sentinel")') &&
          page.includes("canReadDomainCoherence={coherenceGate.ok}"),
        `${F.ADP}: the entry-point flag is not resolved from the same platform capability the page enforces`,
      )
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Negative tests — break it, prove the break landed, prove the check flips.
// ─────────────────────────────────────────────────────────────────────────────

interface Neg { check: string; file: string; find: string; replace: string }

const NEGATIVES: Neg[] = [
  {
    check: "orphans-system-health-wired",
    file: F.SSP,
    find: "getUptimeHistory(serviceKey, 7)",
    replace: "getServiceHealthHistory(serviceKey, 7)",
  },
  {
    check: "orphans-domain-coherence-wired",
    file: F.DCP,
    find: "    actionValidateContractIntegrity(),",
    replace: "    actionGenerateDomainCoherenceReport(),",
  },
  {
    check: "sla-panel-mounted-on-system-page",
    file: F.SYSP,
    find: "<ServiceSLAPanel brokerageId={brokerageId} />",
    replace: "<div />",
  },
  {
    check: "system-health-reads-destructure-error",
    file: F.SH,
    find: `const { data, error } = await supabase
    .from("system_health_checks")`,
    replace: `const { data } = await supabase
    .from("system_health_checks")`,
  },
  {
    check: "tenant-readers-carry-brokerage-filter",
    file: F.SH,
    find: `    .from("health_check_history")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)`,
    replace: `    .from("health_check_history")
    .select("*")`,
  },
  {
    check: "tenant-readers-refuse-without-scope",
    file: F.SH,
    find: `      reason: "not_scoped",
      detail:
        "This session has no brokerage. health_check_history is tenant-scoped`,
    replace: `      reason: "query_failed",
      detail:
        "This session has no brokerage. health_check_history is tenant-scoped`,
  },
  {
    check: "readers-report-ok-empty-unavailable",
    file: F.SH,
    find: `    console.error("Error fetching uptime history:", error)
    return {
      status: "unavailable",`,
    replace: `    console.error("Error fetching uptime history:", error)
    return {
      status: "ok",`,
  },
  {
    check: "service-statuses-unknown-not-operational",
    file: F.SH,
    find: `      services: [],
      overallStatus: "unknown",
      criticalIssues: [],
      lastCheckedAt: null,
      readStatus: "unavailable",
      readDetail: \`service_status read was refused: \${error.message}\`,`,
    replace: `      services: [],
      overallStatus: "operational",
      criticalIssues: [],
      lastCheckedAt: null,
      readStatus: "unavailable",
      readDetail: \`service_status read was refused: \${error.message}\`,`,
  },
  {
    check: "message-provider-window-matches-a-real-writer",
    file: F.SH,
    find: "    .or(`sent_at.gte.${since},event_at.gte.${since}`)",
    replace: '    .gte("event_at", since)',
  },
  {
    check: "sla-export-refuses-non-ok",
    file: F.SH,
    find: '  if (summary.status !== "ok") {',
    replace: "  if (false as boolean) {",
  },
  {
    check: "domain-coherence-actions-are-platform-gated",
    file: F.DC,
    find: `export async function actionValidateProviderBackedFeatures(input: ValidateProvidersInput) {
  const auth = await requirePlatformStaff()
  if ("error" in auth) return { success: false as const, error: auth.error }
`,
    replace: `export async function actionValidateProviderBackedFeatures(input: ValidateProvidersInput) {
`,
  },
  {
    check: "domain-coherence-gate-is-platform-capability",
    file: F.DC,
    find: '  const gate = await requirePlatformCapability("sentinel")',
    replace: '  const gate = { ok: true, userId: "anyone", role: "broker", error: "" }',
  },
  {
    check: "domain-coherence-page-is-platform-gated",
    file: F.DCP,
    find: '  const gate = await requirePlatformCapability("sentinel")',
    replace: '  const gate = { ok: true, userId: "anyone", role: "broker" }',
  },
  {
    check: "coherence-workspace-computes-nothing-client-side",
    file: F.DCW,
    find: 'import type {\n  CoherenceReport,',
    replace: 'import { enumerateDomainRoutes } from "@/lib/kernel/routes"\nimport {\n  CoherenceReport,',
  },
  {
    check: "coherence-workspace-renders-refusals",
    file: F.DCW,
    find: "function ActionRefusal({ label, error }",
    replace: "function ActionRefusalRenamed({ label, error }",
  },
  {
    check: "sla-panel-metrics-guarded-by-ok",
    file: F.SSP,
    find: "{delivery.phase === 'done' && delivery.read.status === 'ok' && (",
    replace: "{delivery.phase === 'done' && (delivery.read as any).data && (",
  },
  {
    check: "command-strip-unknown-outranks-operational",
    file: F.SCS,
    find: `  const priorityAction = !measured
    ? { label: 'System status UNKNOWN — nothing measured', severity: 'unknown' as const }
    : data!.criticalIssues[0]`,
    replace: `  const priorityAction = data!.criticalIssues[0]`,
  },
  {
    check: "impact-panel-unknown-outranks-no-impact",
    file: F.OIP,
    find: "{!serviceHealthMeasured ? (",
    replace: "{false ? (",
  },
  {
    check: "coherence-entry-point-is-staff-only",
    file: F.ADC,
    find: "        {canReadDomainCoherence && (\n",
    replace: "        {true && (\n",
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Live layer — creds-gated, SKIPS LOUDLY, never scores a network error as pass
// ─────────────────────────────────────────────────────────────────────────────

async function liveLayer(): Promise<{ pass: number; fail: number; skipped: boolean; lines: string[] }> {
  const lines: string[] = []
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    lines.push("LIVE LAYER SKIPPED — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    lines.push("  This is a SKIP, not a pass. Nothing about the live database was verified.")
    return { pass: 0, fail: 0, skipped: true, lines }
  }

  let createClient: any
  try {
    ;({ createClient } = await import("@supabase/supabase-js"))
  } catch {
    lines.push("LIVE LAYER SKIPPED — @supabase/supabase-js is not resolvable. This is a SKIP, not a pass.")
    return { pass: 0, fail: 0, skipped: true, lines }
  }

  const db = createClient(url, key, { auth: { persistSession: false } })

  // Reachability first: a network failure must SKIP, not fail and not pass.
  const probe = await db.from("brokerages").select("id", { count: "exact", head: true })
  if (probe.error && /fetch|ENOTFOUND|ECONN|network|timeout/i.test(String(probe.error.message))) {
    lines.push(`LIVE LAYER SKIPPED — database unreachable (${probe.error.message}). This is a SKIP, not a pass.`)
    return { pass: 0, fail: 0, skipped: true, lines }
  }

  let pass = 0
  let fail = 0

  // Phantom-column probe: every column the readers touch must exist.
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    const r = await db.from(table).select(cols.join(",")).limit(1)
    if (r.error) {
      fail++
      lines.push(`  FAIL  ${table}: ${r.error.message}`)
    } else {
      pass++
      lines.push(`  pass  ${table}: all ${cols.length} referenced columns exist`)
    }
  }

  // Writer evidence: which of these tables actually holds rows, and how many of
  // them are tenant-attributed. An untenanted row is invisible to every
  // tenant-scoped reader on this rail.
  lines.push("  writer evidence (rows / tenant-attributed rows):")
  for (const table of Object.keys(TABLE_COLUMNS)) {
    const total = await db.from(table).select("id", { count: "exact", head: true })
    const tenanted = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .not("brokerage_id", "is", null)
    if (total.error || tenanted.error) {
      fail++
      lines.push(`    FAIL  ${table}: ${(total.error ?? tenanted.error)!.message}`)
      continue
    }
    pass++
    const t = total.count ?? 0
    const n = tenanted.count ?? 0
    const verdict =
      t === 0 ? "NO ROWS — reader is a permanent zero here" : n === 0 ? "ALL UNTENANTED — invisible to every tenant-scoped read" : "tenant-attributed rows present"
    lines.push(`    ${table}: ${t} / ${n}  (${verdict})`)
  }

  return { pass, fail, skipped: false, lines }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

function sha(rel: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, rel))).digest("hex")
}

function runCheck(c: Check): string | null {
  try {
    c.run()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const wantNegative = args.has("--negative")
  const wantLive = args.has("--live")

  console.log("PLATFORM OPS WIRING SIMULATOR")
  console.log("=".repeat(72))

  let pass = 0
  let fail = 0

  console.log("\nSTATIC ASSERTIONS")
  for (const c of CHECKS) {
    const err = runCheck(c)
    if (err) {
      fail++
      console.log(`  FAIL  ${c.id}\n        ${err}`)
    } else {
      pass++
      console.log(`  pass  ${c.id}`)
    }
  }

  if (wantNegative) {
    console.log("\nNEGATIVE TESTS (break it, prove the break landed, prove the check flips)")
    const covered = new Set(NEGATIVES.map((n) => n.check))
    for (const c of CHECKS) {
      if (!covered.has(c.id)) {
        fail++
        console.log(`  FAIL  ${c.id} has NO negative test — an assertion that is never proven falsifiable is theatre`)
      }
    }

    for (const neg of NEGATIVES) {
      const abs = resolve(ROOT, neg.file)
      const before0 = readFileSync(abs, "utf8")
      const shaBefore = sha(neg.file)
      const occurrences = before0.split(neg.find).length - 1

      if (occurrences !== 1) {
        fail++
        console.log(
          `  FAIL  ${neg.check}: mutation anchor matched ${occurrences} times in ${neg.file} (need exactly 1)`,
        )
        continue
      }

      const mutated = before0.replace(neg.find, neg.replace)
      if (mutated === before0) {
        fail++
        console.log(`  FAIL  ${neg.check}: mutation was a NO-OP in ${neg.file}`)
        continue
      }
      writeFileSync(abs, mutated, "utf8")

      // Prove the mutation actually landed on disk.
      const onDisk = readFileSync(abs, "utf8")
      if (onDisk === before0 || sha(neg.file) === shaBefore) {
        writeFileSync(abs, before0, "utf8")
        fail++
        console.log(`  FAIL  ${neg.check}: mutation did not reach disk in ${neg.file}`)
        continue
      }

      const check = CHECKS.find((c) => c.id === neg.check)!
      const err = runCheck(check)

      writeFileSync(abs, before0, "utf8")
      const shaAfter = sha(neg.file)

      if (shaAfter !== shaBefore) {
        fail++
        console.log(`  FAIL  ${neg.check}: ${neg.file} was NOT restored (sha mismatch)`)
        continue
      }

      if (err) {
        pass++
        console.log(`  pass  ${neg.check} flipped to FAIL when broken, restored (sha256 verified)`)
      } else {
        fail++
        console.log(
          `  FAIL  ${neg.check} STILL PASSED with the code broken — the assertion is theatre and must be tightened`,
        )
      }
    }
  }

  if (wantLive) {
    console.log("\nLIVE LAYER")
    const live = await liveLayer()
    for (const l of live.lines) console.log(l)
    pass += live.pass
    fail += live.fail
    if (live.skipped) console.log("  (skipped loudly — no live assertion was scored as a pass)")
  } else {
    console.log("\nLIVE LAYER not requested (pass --live). No live assertion was scored.")
  }

  console.log("\n" + "=".repeat(72))
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
