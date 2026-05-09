"use client"

/**
 * Workflow Canvas — React Flow visual step graph.
 *
 * Renders the sequence as a directed node graph (top-to-bottom).
 * Steps become custom nodes; sequence order defines edges.
 * Condition steps get two output handles (yes/no branches).
 * Wait steps show delay badge on the edge label.
 *
 * Clicking a node fires onSelectStep(index) to sync with the
 * step-editor panel. The parent holds all step state; the canvas
 * is a read/select view — editing happens in the side panel.
 */

import "@xyflow/react/dist/style.css"

import { useCallback, useMemo } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  BackgroundVariant,
} from "@xyflow/react"
import {
  Mail,
  MessageSquare,
  Phone,
  Clock,
  Sparkles,
  Wand2,
  Video,
  FileText,
  Target,
  CheckSquare,
  Calendar,
  Map,
  BarChart2,
  Megaphone,
  Bell,
  GitBranch,
  ArrowUpRight,
} from "lucide-react"
import type { SequenceBuilderStep } from "@/app/actions/campaign-sequences"

// ---------------------------------------------------------------------------
// Node type → icon + colour
// ---------------------------------------------------------------------------

const STEP_META: Record<string, { icon: React.ElementType; bg: string; border: string; text: string; label: string }> = {
  email:            { icon: Mail,         bg: "bg-blue-50",    border: "border-blue-300",   text: "text-blue-700",   label: "Email" },
  sms:              { icon: MessageSquare,bg: "bg-green-50",   border: "border-green-300",  text: "text-green-700",  label: "SMS" },
  voice_drop:       { icon: Phone,        bg: "bg-purple-50",  border: "border-purple-300", text: "text-purple-700", label: "Voice Drop" },
  ai_call:          { icon: Sparkles,     bg: "bg-amber-50",   border: "border-amber-300",  text: "text-amber-700",  label: "AI Call" },
  wait:             { icon: Clock,        bg: "bg-slate-50",   border: "border-slate-300",  text: "text-slate-600",  label: "Wait" },
  condition:        { icon: GitBranch,    bg: "bg-neutral-50", border: "border-neutral-400",text: "text-neutral-700",label: "Condition" },
  direct_mail:      { icon: Mail,         bg: "bg-orange-50",  border: "border-orange-300", text: "text-orange-700", label: "Direct Mail" },
  ai_image:         { icon: Wand2,        bg: "bg-pink-50",    border: "border-pink-300",   text: "text-pink-700",   label: "AI Image" },
  video:            { icon: Video,        bg: "bg-violet-50",  border: "border-violet-300", text: "text-violet-700", label: "Video" },
  newsletter:       { icon: Mail,         bg: "bg-teal-50",    border: "border-teal-300",   text: "text-teal-700",   label: "Newsletter" },
  social_post:      { icon: ArrowUpRight, bg: "bg-sky-50",     border: "border-sky-300",    text: "text-sky-700",    label: "Social Post" },
  in_app:           { icon: Bell,         bg: "bg-lime-50",    border: "border-lime-300",   text: "text-lime-700",   label: "In-App" },
  assign_task:      { icon: CheckSquare,  bg: "bg-yellow-50",  border: "border-yellow-300", text: "text-yellow-700", label: "Assign Task" },
  draft_document:   { icon: FileText,     bg: "bg-stone-50",   border: "border-stone-300",  text: "text-stone-700",  label: "Draft Document" },
  schedule_showing: { icon: Calendar,     bg: "bg-emerald-50", border: "border-emerald-300",text: "text-emerald-700",label: "Schedule Showing" },
  schedule_tour:    { icon: Map,          bg: "bg-cyan-50",    border: "border-cyan-300",   text: "text-cyan-700",   label: "Schedule Tour" },
  avm_cma:          { icon: BarChart2,    bg: "bg-indigo-50",  border: "border-indigo-300", text: "text-indigo-700", label: "AVM / CMA" },
  ad_campaign:      { icon: Megaphone,    bg: "bg-rose-50",    border: "border-rose-300",   text: "text-rose-700",   label: "Ad Campaign" },
  listing_landing_page: { icon: Target,  bg: "bg-fuchsia-50", border: "border-fuchsia-300",text: "text-fuchsia-700",label: "Landing Page" },
  segment_ops:      { icon: Target,      bg: "bg-gray-50",    border: "border-gray-300",   text: "text-gray-700",   label: "Segment" },
}

const DEFAULT_META = STEP_META.email

// ---------------------------------------------------------------------------
// Custom step node
// ---------------------------------------------------------------------------

interface StepNodeData extends Record<string, unknown> {
  step: SequenceBuilderStep
  index: number
  isSelected: boolean
  onSelect: (index: number) => void
}

function StepNode({ data }: { data: StepNodeData }) {
  const { step, index, isSelected, onSelect } = data
  const meta = STEP_META[step.step_type] ?? DEFAULT_META
  const Icon = meta.icon
  const isCondition = step.step_type === "condition"

  const delayLabel =
    step.step_type === "wait"
      ? `${step.delay_days}d${step.delay_hours ? ` ${step.delay_hours}h` : ""}`
      : step.delay_days > 0 || step.delay_hours > 0
      ? `+${step.delay_days}d`
      : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(index)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(index)}
      className={`
        w-52 rounded-xl border-2 shadow-sm cursor-pointer transition-all
        ${meta.bg} ${meta.border}
        ${isSelected ? "ring-2 ring-offset-2 ring-blue-500 scale-105" : "hover:scale-102 hover:shadow-md"}
      `}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400 !w-2 !h-2" />

      <div className="px-4 py-3 flex items-start gap-3">
        <div className={`mt-0.5 p-1.5 rounded-lg ${meta.bg} ${meta.border} border`}>
          <Icon className={`h-3.5 w-3.5 ${meta.text}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className={`text-xs font-semibold ${meta.text}`}>{meta.label}</span>
            <span className="text-[10px] text-muted-foreground">#{index + 1}</span>
          </div>
          <p className="text-xs text-foreground font-medium truncate mt-0.5">
            {step.step_name || step.subject || step.body?.slice(0, 40) || "Untitled step"}
          </p>
          {delayLabel && (
            <span className="inline-block mt-1 text-[10px] bg-white/60 border rounded px-1.5 py-0.5 text-muted-foreground font-mono">
              {delayLabel}
            </span>
          )}
        </div>
      </div>

      {/* Condition: two output handles */}
      {isCondition ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="yes"
            style={{ left: "30%" }}
            className="!bg-green-500 !w-2 !h-2"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="no"
            style={{ left: "70%" }}
            className="!bg-red-400 !w-2 !h-2"
          />
          <div className="flex justify-between px-6 pb-2 text-[10px] text-muted-foreground">
            <span className="text-green-600 font-medium">Yes</span>
            <span className="text-red-500 font-medium">No</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!bg-slate-400 !w-2 !h-2" />
      )}
    </div>
  )
}

const NODE_TYPES: NodeTypes = { step: StepNode as any }

// ---------------------------------------------------------------------------
// Main canvas component
// ---------------------------------------------------------------------------

interface WorkflowCanvasProps {
  steps: SequenceBuilderStep[]
  selectedIdx: number | null
  onSelectStep: (index: number) => void
}

const NODE_WIDTH  = 208   // w-52 = 13rem = 208px
const NODE_HEIGHT = 88
const VERTICAL_GAP = 64
const HORIZONTAL_CENTER = 300

export default function WorkflowCanvas({ steps, selectedIdx, onSelectStep }: WorkflowCanvasProps) {
  const onSelect = useCallback((idx: number) => onSelectStep(idx), [onSelectStep])

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []

    // Group by branch. For now, linear layout with condition branching stubs.
    steps.forEach((step, i) => {
      const nodeId = step.id ?? `step-${i}`
      nodes.push({
        id: nodeId,
        type: "step",
        position: {
          x: HORIZONTAL_CENTER - NODE_WIDTH / 2,
          y: i * (NODE_HEIGHT + VERTICAL_GAP),
        },
        data: {
          step,
          index: i,
          isSelected: selectedIdx === i,
          onSelect,
        } as StepNodeData,
        draggable: false, // order managed by list panel; canvas is visual-select only
      })

      if (i > 0) {
        const prev = steps[i - 1]
        const prevId = prev.id ?? `step-${i - 1}`
        const isWait = prev.step_type === "wait"
        const isCondition = prev.step_type === "condition"

        const delayLabel =
          isWait
            ? `${prev.delay_days}d${prev.delay_hours ? ` ${prev.delay_hours}h` : ""}`
            : prev.delay_days > 0
            ? `+${prev.delay_days}d`
            : undefined

        edges.push({
          id: `e-${prevId}-${nodeId}`,
          source: prevId,
          target: nodeId,
          sourceHandle: isCondition ? "yes" : undefined,
          type: isWait ? "smoothstep" : "default",
          animated: isWait,
          label: delayLabel,
          labelStyle: { fontSize: 10, fill: "#94a3b8" },
          style: {
            stroke: isWait ? "#94a3b8" : "#cbd5e1",
            strokeDasharray: isWait ? "4 4" : undefined,
          },
        })
      }
    })

    return { nodes, edges }
  }, [steps, selectedIdx, onSelect])

  if (steps.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Canvas is empty</p>
          <p className="text-xs text-muted-foreground">Add steps from the left panel to see the flow.</p>
        </div>
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      className="bg-muted/5"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} className="!shadow-sm" />
      <MiniMap
        nodeColor={(n) => {
          const step = ((n.data as unknown) as StepNodeData)?.step
          const meta = step ? (STEP_META[step.step_type] ?? DEFAULT_META) : DEFAULT_META
          return meta.border.replace("border-", "#").replace("-300", "") // rough color hint
        }}
        className="!shadow-sm !rounded-lg"
        maskColor="rgba(255,255,255,0.6)"
      />
    </ReactFlow>
  )
}
