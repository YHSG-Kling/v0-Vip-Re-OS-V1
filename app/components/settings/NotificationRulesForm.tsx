'use client'

import React, { useState } from "react"
import { createRule, editRule, removeRule } from "@/app/actions/settings/manage-notification-rules"
import { updateNotificationRules as toggleRule } from "@/app/actions/settings/update-notification-rules"
import type { NotificationRuleRow } from "@/lib/kernel"
import { SettingsCard } from "./SettingsCard"

interface NotificationRulesFormProps {
  rules: NotificationRuleRow[]
  onRefresh: () => void
}

function formatNotificationType(type: "push" | "email" | "sms"): string {
  if (type === "push") return "In-App"
  if (type === "email") return "Email"
  return "SMS"
}

export function NotificationRulesForm({ rules, onRefresh }: NotificationRulesFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)

  const [addFormData, setAddFormData] = useState<{
    rule_name: string
    trigger_event: string
    notification_type: "push" | "email" | "sms"
    recipient_role: string
    is_active: boolean
  }>({
    rule_name: "",
    trigger_event: "",
    notification_type: "push",
    recipient_role: "agent",
    is_active: true,
  })

  const [editFormData, setEditFormData] = useState<
    Record<
      string,
      Partial<
        Pick<
          NotificationRuleRow,
          "rule_name" | "trigger_event" | "notification_type" | "recipient_role" | "is_active"
        >
      >
    >
  >({})

  const handleCreateRule = async () => {
    setLoading(true)
    setError("")
    try {
      await createRule({
        ...addFormData,
        trigger_event: addFormData.trigger_event.toLowerCase(),
      })
      setAddFormData({
        rule_name: "",
        trigger_event: "",
        notification_type: "push",
        recipient_role: "agent",
        is_active: true,
      })
      setShowAddForm(false)
      onRefresh()
    } catch {
      setError("Failed to create rule")
    } finally {
      setLoading(false)
    }
  }

  const handleEditRule = async (ruleId: string) => {
    setLoading(true)
    setError("")
    try {
      const updates = editFormData[ruleId] || {}
      if (updates.trigger_event) {
        updates.trigger_event = updates.trigger_event.toLowerCase()
      }
      await editRule(ruleId, updates)
      setEditingRuleId(null)
      setEditFormData({})
      onRefresh()
    } catch {
      setError("Failed to update rule")
    } finally {
      setLoading(false)
    }
  }

  const handleToggleActive = async (ruleId: string, newActive: boolean) => {
    setLoading(true)
    setError("")
    try {
      await toggleRule(ruleId, { is_active: newActive })
      onRefresh()
    } catch {
      setError("Failed to toggle rule")
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm("Are you sure you want to delete this rule?")) return
    setLoading(true)
    setError("")
    try {
      await removeRule(ruleId)
      onRefresh()
    } catch {
      setError("Failed to delete rule")
    } finally {
      setLoading(false)
    }
  }

  return (
    <SettingsCard title="Notification Rules">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* Add Rule Section */}
        {!showAddForm ? (
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
          >
            Add New Rule
          </button>
        ) : (
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <h4 className="font-medium text-gray-900 mb-3">Create New Rule</h4>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Rule Name (e.g., Agent: Task Due)"
                value={addFormData.rule_name}
                onChange={(e) => setAddFormData({ ...addFormData, rule_name: e.target.value })}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />
              <input
                type="text"
                placeholder="Trigger Event (e.g., task_due, inspection_due)"
                value={addFormData.trigger_event}
                onChange={(e) => setAddFormData({ ...addFormData, trigger_event: e.target.value })}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />
              <select
                value={addFormData.recipient_role}
                onChange={(e) => setAddFormData({ ...addFormData, recipient_role: e.target.value })}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="agent">Agent</option>
                <option value="broker">Broker</option>
                <option value="admin">Admin</option>
                <option value="TC">TC</option>
                <option value="compliance_officer">Compliance Officer</option>
                <option value="title_agent">Title Agent</option>
                <option value="closing_attorney">Closing Attorney</option>
              </select>
              <select
                value={addFormData.notification_type}
                onChange={(e) =>
                  setAddFormData({
                    ...addFormData,
                    notification_type: e.target.value as "push" | "email" | "sms",
                  })
                }
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="push">In-App</option>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={addFormData.is_active}
                  onChange={(e) => setAddFormData({ ...addFormData, is_active: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleCreateRule}
                  disabled={loading}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg"
                >
                  {loading ? "Creating..." : "Create Rule"}
                </button>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="bg-gray-300 hover:bg-gray-400 text-gray-900 text-sm font-medium py-2 px-4 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rules List */}
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="border border-gray-200 rounded-lg p-4">
              {editingRuleId === rule.id ? (
                <div className="space-y-3">
                  <input
                    type="text"
                    defaultValue={rule.rule_name}
                    onChange={(e) =>
                      setEditFormData({
                        ...editFormData,
                        [rule.id]: { ...(editFormData[rule.id] || {}), rule_name: e.target.value },
                      })
                    }
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    placeholder="Rule Name"
                  />
                  <input
                    type="text"
                    defaultValue={rule.trigger_event}
                    onChange={(e) =>
                      setEditFormData({
                        ...editFormData,
                        [rule.id]: { ...(editFormData[rule.id] || {}), trigger_event: e.target.value },
                      })
                    }
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    placeholder="Trigger Event"
                  />
                  <select
                    defaultValue={rule.recipient_role}
                    onChange={(e) =>
                      setEditFormData({
                        ...editFormData,
                        [rule.id]: { ...(editFormData[rule.id] || {}), recipient_role: e.target.value },
                      })
                    }
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  >
                    <option value="agent">Agent</option>
                    <option value="broker">Broker</option>
                    <option value="admin">Admin</option>
                    <option value="TC">TC</option>
                    <option value="compliance_officer">Compliance Officer</option>
                    <option value="title_agent">Title Agent</option>
                    <option value="closing_attorney">Closing Attorney</option>
                  </select>
                  <select
                    defaultValue={rule.notification_type}
                    onChange={(e) =>
                      setEditFormData({
                        ...editFormData,
                        [rule.id]: {
                          ...(editFormData[rule.id] || {}),
                          notification_type: e.target.value as "push" | "email" | "sms",
                        },
                      })
                    }
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  >
                    <option value="push">In-App</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      defaultChecked={rule.is_active}
                      onChange={(e) =>
                        setEditFormData({
                          ...editFormData,
                          [rule.id]: { ...(editFormData[rule.id] || {}), is_active: e.target.checked },
                        })
                      }
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-gray-700">Active</span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEditRule(rule.id)}
                      disabled={loading}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg"
                    >
                      {loading ? "Saving..." : "Save Changes"}
                    </button>
                    <button
                      onClick={() => setEditingRuleId(null)}
                      className="bg-gray-300 hover:bg-gray-400 text-gray-900 text-sm font-medium py-2 px-4 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <h4 className="font-medium text-gray-900">{rule.rule_name}</h4>
                    <p className="text-sm text-gray-600">Trigger: {rule.trigger_event}</p>
                    <p className="text-sm text-gray-600">Role: {rule.recipient_role}</p>
                    <p className="text-sm text-gray-600">
                      Type: {formatNotificationType(rule.notification_type)}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-col items-end">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={rule.is_active}
                        onChange={(e) => handleToggleActive(rule.id, e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-gray-700">Active</span>
                    </label>
                    <button
                      onClick={() => setEditingRuleId(rule.id)}
                      className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="text-red-600 hover:text-red-800 text-sm font-medium"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}
