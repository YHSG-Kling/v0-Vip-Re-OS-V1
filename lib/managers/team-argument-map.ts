/**
 * lib/managers/team-argument-map.ts
 *
 * THE TEAM ARGUMENT MAP (round 41 — owner: "deliberation is happening amongst all
 * of the managers like a real human team"; constraint: "I don't want to continue
 * noise"). A PURE, REGISTRY-DERIVED projection of who argues with whom:
 *
 *   · every seat row is computed from MANAGERS + MANAGER_COLLABORATIONS +
 *     REFERRAL_EMITTERS + MANAGER_FACT_LOADERS — zero hardcoding, so the surface
 *     can never drift from the law the guards enforce;
 *   · deliberative edges carry their peers AND their live emitters (a domain with
 *     no raiser could never argue — the simulator forbids that state anyway);
 *   · managers that have NEVER deliberated are shown HONESTLY (neverDeliberates)
 *     — their no-edge verdicts are documented in the registry beside
 *     MANAGER_COLLABORATIONS and simulator-locked, never padded with ceremonial
 *     edges.
 *
 * Pure of I/O (safe for the simulator and for a server component to compute and
 * hand to the client as plain data).
 */

import {
  MANAGERS, collaborationsFor, type ManagerKey,
} from "@/lib/kernel/manager-registry"
import { emittersForDomain } from "@/lib/managers/cross-referral"
import { MANAGER_FACT_LOADERS, isDeliberativeDomain } from "@/lib/managers/deliberation"

export interface TeamArgumentDomain {
  key: string
  label: string
  deliberative: boolean
  /** The OTHER managers at this table (the seat's peers on the edge). */
  peers: ManagerKey[]
  /** The live raisers registered for this domain (sweeps + hooks). */
  emitters: Array<{ key: string; kind: "sweep" | "hook"; what: string }>
}

export interface TeamArgumentSeat {
  manager: ManagerKey
  label: string
  accent: string
  domain: string
  /** Every declared collaboration this manager sits on (deliberative or handoff). */
  domains: TeamArgumentDomain[]
  /** Peers this manager ARGUES with — union of its deliberative domains' co-managers. */
  arguesWith: ManagerKey[]
  /** True when at least one of the seat's domains escalates to a full deliberation. */
  deliberates: boolean
  /** A grounded fact loader exists for this manager (a seat can't argue without one). */
  hasGroundedLoader: boolean
  /** HONEST flag: this manager holds no deliberative seat anywhere — its no-edge
   *  verdict is documented in the registry (simulator-locked), never papered over. */
  neverDeliberates: boolean
}

/** PURE: the whole team's argument map, derived from the registry alone. */
export function composeTeamArgumentMap(): TeamArgumentSeat[] {
  return (Object.keys(MANAGERS) as ManagerKey[]).map((mk) => {
    const info = MANAGERS[mk]
    const domains: TeamArgumentDomain[] = collaborationsFor(mk).map((d) => ({
      key: d.key,
      label: d.label,
      // The same predicate the referral handler escalates on — never a re-spelling of it.
      deliberative: isDeliberativeDomain(d.key),
      peers: d.managers.filter((m) => m !== mk),
      emitters: emittersForDomain(d.key).map((e) => ({ key: e.key, kind: e.kind, what: e.what })),
    }))
    const arguesWith = Array.from(new Set(
      domains.filter((d) => d.deliberative).flatMap((d) => d.peers),
    )).sort()
    const deliberates = domains.some((d) => d.deliberative)
    return {
      manager: mk,
      label: info.label,
      accent: info.accent,
      domain: info.domain,
      domains,
      arguesWith,
      deliberates,
      hasGroundedLoader: typeof MANAGER_FACT_LOADERS[mk] === "function",
      neverDeliberates: !deliberates,
    }
  })
}
