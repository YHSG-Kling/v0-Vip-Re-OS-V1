// lib/agentic-os/mcp-tools.ts
// Pure mapping from the unified Agentic API manifest (buildFullActionManifest) to MCP tool
// descriptors. An MCP client calls tools/list and gets one tool per capability — name,
// human description (purpose + scope + ownership), and a JSON-Schema for its inputs. This
// is what makes the whole agentic surface usable by any MCP-speaking agent. Pure so the
// mapping is unit-tested; the JSON-RPC transport lives in app/api/agentic-os/mcp/route.ts.

import { parseInputSpec } from "./invoke-planner"
import type { UnifiedAction } from "./app-capability-registry"

export interface McpJsonSchema {
  type: "object"
  properties: Record<string, { type: "string"; description?: string }>
  required: string[]
}

export interface McpTool {
  name: string
  description: string
  inputSchema: McpJsonSchema
  /** Non-standard hint block — agents that understand it get richer planning signal. */
  _meta: {
    capability: string
    verb: string
    scope: string
    ownership: string
    mutates: boolean
    kind: string
  }
}

/** Pure: registry input tokens ("zipCode?") → a JSON-Schema object. */
export function inputsToJsonSchema(inputs: string[]): McpJsonSchema {
  const spec = parseInputSpec(inputs)
  const properties: McpJsonSchema["properties"] = {}
  const required: string[] = []
  for (const s of spec) {
    properties[s.name] = { type: "string" }
    if (s.required) required.push(s.name)
  }
  return { type: "object", properties, required }
}

/** MCP tool names must match ^[a-zA-Z0-9_-]+$ — capability ids already do, but guard anyway. */
export function toToolName(capability: string): string {
  return capability.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** Pure: turn the unified action manifest into MCP tool descriptors. */
export function manifestToMcpTools(manifest: UnifiedAction[]): McpTool[] {
  return manifest.map((a) => ({
    name: toToolName(a.capability),
    description: `${a.purpose} [scope: ${a.scope} · ${a.ownership}${a.mutates ? " · mutating" : ""}]`,
    inputSchema: inputsToJsonSchema(a.inputs),
    _meta: {
      capability: a.capability,
      verb: a.verb,
      scope: a.scope,
      ownership: a.ownership,
      mutates: a.mutates,
      kind: a.kind,
    },
  }))
}
