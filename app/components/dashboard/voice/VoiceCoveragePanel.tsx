/**
 * VoiceCoveragePanel — the read-only "What can I say?" surface.
 *
 * Server component. Everything rendered here is DERIVED from the single
 * source of truth (lib/voice/command-coverage.ts) — no hardcoded counts, no
 * aspirational rows. A command shows as speakable only when a conv-ai webhook
 * tool actually dispatches it; honest not-yet rows show the concrete reason.
 */

import {
  coverageByDomain,
  coverageStats,
  speakableToolNames,
  type VoiceCommandCoverageRow,
} from "@/lib/voice/command-coverage"
import { voiceCoverageViolations, registeredVoiceTools } from "@/lib/voice/voice-coverage"

/**
 * Registry health — the invariants scripts/voice-coverage-simulator.ts fails CI
 * on, rendered on the surface itself so a broker (or the next author) sees the
 * same verdict without running a script. Everything below is DERIVED: the
 * registry's own invariant walk (voiceCoverageViolations) plus the two
 * directions of map↔registry drift. Zero everywhere = healthy; anything else is
 * listed by name, never summarised away.
 */
function registryHealth() {
  const violations = voiceCoverageViolations()
  const registered = registeredVoiceTools()
  const speakables = speakableToolNames()
  const speakableNotRegistered = speakables.filter((t) => !registered.includes(t))
  const registeredNotSpeakable = registered.filter((t) => !speakables.includes(t))
  return {
    violations,
    registeredCount: registered.length,
    speakableNotRegistered,
    registeredNotSpeakable,
    healthy: violations.length === 0 && speakableNotRegistered.length === 0 && registeredNotSpeakable.length === 0,
  }
}

const DOMAIN_LABELS: Record<string, string> = {
  "offers": "Offers — deal decisions",
  "deal-documents": "Deal documents & e-sign",
  "approvals": "Approvals",
  "contacts": "Contacts",
  "leads": "Leads",
  "tasks": "Tasks",
  "showings": "Showings",
  "messaging": "Messaging",
  "marketing-content": "Marketing content",
  "team-coordination": "Team coordination",
  "broadcast": "Broadcast",
  "reporting": "Reporting & briefings",
  "scheduling": "Scheduling",
}

function RowLine({ row }: { row: VoiceCommandCoverageRow }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-card/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {row.speakable ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            speakable
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            not yet
          </span>
        )}
        {row.toolName && (
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80">{row.toolName}</code>
        )}
        <span className="text-xs text-muted-foreground truncate" title={row.command}>
          {row.command}
        </span>
      </div>
      {row.speakable && row.sayIt && (
        <p className="text-sm text-foreground/90">{row.sayIt}</p>
      )}
      {row.speakable ? (
        <p className="text-[11px] text-muted-foreground leading-snug">
          <span className="font-medium">Who:</span> {row.guard}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground leading-snug">
          <span className="font-medium">Why not yet:</span> {row.notYetReason}
        </p>
      )}
    </li>
  )
}

export function VoiceCoveragePanel() {
  const stats = coverageStats()
  const domains = coverageByDomain()
  const health = registryHealth()

  return (
    <section className="mt-8 rounded-lg border border-border bg-background p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">What can I say?</h2>
          <p className="text-sm text-muted-foreground">
            Voice-admin command coverage — every row is derived from the live tool bridge. A spoken
            command lands in the same kernel transition, behind the same guard, with the same audit
            trail as the click.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {stats.speakable} speakable
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {stats.notYet} not yet
          </span>
          <span className="text-muted-foreground">of {stats.total} commands</span>
        </div>
      </div>

      <div
        className={`mb-5 rounded-md border px-3 py-2 text-xs ${
          health.healthy
            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
            : "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300"
        }`}
      >
        <p className="font-medium">
          Registry health — {health.registeredCount} registered tools · {health.violations.length} invariant{" "}
          {health.violations.length === 1 ? "violation" : "violations"} ·{" "}
          {health.speakableNotRegistered.length + health.registeredNotSpeakable.length} map/registry drift
        </p>
        {health.violations.length > 0 && (
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {health.violations.map((v) => (
              <li key={`${v.tool}:${v.rule}:${v.detail}`}>
                <code className="rounded bg-muted px-1 py-0.5">{v.tool}</code> — {v.rule}: {v.detail}
              </li>
            ))}
          </ul>
        )}
        {health.speakableNotRegistered.length > 0 && (
          <p className="mt-1">
            Speakable in the map but not in the tool registry (no authority row — the route's role gate
            cannot see them): {health.speakableNotRegistered.map((t) => <code key={t} className="mr-1 rounded bg-muted px-1 py-0.5">{t}</code>)}
          </p>
        )}
        {health.registeredNotSpeakable.length > 0 && (
          <p className="mt-1">
            Registered but with no speakable row in the map: {health.registeredNotSpeakable.map((t) => <code key={t} className="mr-1 rounded bg-muted px-1 py-0.5">{t}</code>)}
          </p>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {domains.map((d) => (
          <div key={d.domain}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
              {DOMAIN_LABELS[d.domain] ?? d.domain}
              <span className="text-[11px] font-normal text-muted-foreground">
                {d.speakable}/{d.speakable + d.notYet} speakable
              </span>
            </h3>
            <ul className="space-y-1.5">
              {d.rows.map((row) => (
                <RowLine key={`${row.domain}:${row.command}`} row={row} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
