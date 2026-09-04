/**
 * Universal, read-only multi-model council for OpenCode.
 *
 * The plugin creates a hidden orchestrator and one hidden, model-pinned member
 * agent per configured council member. The orchestrator uses OpenCode's native
 * Task tool, so member calls can run concurrently without external processes.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

type Member = {
  name: string
  model: string
}

type CouncilConfig = {
  members: Member[]
  minimum_successful_members: number
  allow_web: boolean
}

const DEFAULT_CONFIG: CouncilConfig = {
  members: [
    { name: "claude", model: "ppq/claude-fable-5.1" },
    { name: "gpt", model: "ppq/gpt-5.6-sol" },
    { name: "gemini", model: "ppq/google/gemini-3.8-flash" },
    { name: "qwen", model: "ppq/qwen/qwen3.8-max" },
    { name: "kimi", model: "ppq/moonshotai/kimi-k3" },
    { name: "glm", model: "ppq/glm-5.3" },
    { name: "grok", model: "ppq/grok-4.6" },
  ],
  minimum_successful_members: 2,
  allow_web: true,
}

const CONFIG_NAME = "council.json"
const HISTORY_MESSAGE_LIMIT = 20
const HISTORY_CHARACTER_LIMIT = 24_000
const HISTORY_TRUNCATION_MARKER = "\n...[earlier content in this message omitted]...\n"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeMembers(value: unknown): Member[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return undefined
  const names = new Set<string>()
  const models = new Set<string>()
  const members: Member[] = []

  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.model !== "string") return undefined
    const name = item.name.trim()
    const model = item.model.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name) || !/^[^/\s]+\/.+/.test(model)) return undefined
    const agentName = name.toLowerCase()
    if (names.has(agentName) || models.has(model)) return undefined
    names.add(agentName)
    models.add(model)
    members.push({ name, model })
  }
  return members
}

function mergeConfig(base: CouncilConfig, value: unknown): CouncilConfig | undefined {
  if (!isRecord(value)) return undefined
  const membersOverridden = value.members !== undefined
  const members = membersOverridden ? normalizeMembers(value.members) : base.members
  if (!members) return undefined
  const minimum = value.minimum_successful_members === undefined
    ? (membersOverridden ? Math.min(base.minimum_successful_members, members.length) : base.minimum_successful_members)
    : value.minimum_successful_members
  const allowWeb = value.allow_web === undefined ? base.allow_web : value.allow_web

  if (!Number.isInteger(minimum) || minimum < 1 || minimum > members.length || typeof allowWeb !== "boolean") {
    return undefined
  }
  return { members, minimum_successful_members: minimum, allow_web: allowWeb }
}

async function readConfig(file: string, base: CouncilConfig): Promise<CouncilConfig> {
  let contents: string
  try {
    contents = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[council] Could not read configuration ${file}: ${message}`)
    }
    return base
  }

  try {
    const parsed: unknown = JSON.parse(contents)
    const merged = mergeConfig(base, parsed)
    if (merged) return merged
    console.warn(`[council] Ignoring invalid configuration ${file}: expected 1-12 uniquely named members, a valid quorum, and boolean allow_web`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[council] Could not parse configuration ${file}: ${message}`)
  }
  return base
}

function memberAgentName(name: string): string {
  return `council-member-${name.toLowerCase()}`
}

function truncateHistoryBlock(block: string, limit: number): string {
  if (block.length <= limit) return block
  if (limit <= HISTORY_TRUNCATION_MARKER.length) return block.slice(-limit)
  const available = limit - HISTORY_TRUNCATION_MARKER.length
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return block.slice(0, start) + HISTORY_TRUNCATION_MARKER + block.slice(-end)
}

function formatRecentHistory(value: unknown): string {
  if (!Array.isArray(value)) return ""

  const messages = value.flatMap((message, index) => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) return []
    const role = message.info.role
    if (role !== "user" && role !== "assistant") return []
    const text = message.parts
      .filter((part) => isRecord(part) && part.type === "text" && part.synthetic !== true && part.ignored !== true)
      .map((part) => String((part as Record<string, unknown>).text ?? "").trim())
      .filter(Boolean)
      .join("\n")
    if (!text) return []
    const time = isRecord(message.info.time) && typeof message.info.time.created === "number"
      ? message.info.time.created
      : index
    return [{ index, time, block: `${role === "user" ? "User" : "Assistant"}:\n${text}` }]
  })

  messages.sort((a, b) => a.time - b.time || a.index - b.index)
  const recent = messages.slice(-HISTORY_MESSAGE_LIMIT)
  const selected: string[] = []
  let remaining = HISTORY_CHARACTER_LIMIT

  for (let index = recent.length - 1; index >= 0; index--) {
    const block = recent[index].block
    const separatorLength = selected.length > 0 ? 2 : 0
    const allowance = remaining - separatorLength
    if (allowance <= 0) break
    selected.push(truncateHistoryBlock(block, allowance))
    remaining -= Math.min(block.length, allowance) + separatorLength
    if (block.length > allowance) break
  }

  return selected.reverse().join("\n\n")
}

function memberPrompt(member: Member): string {
  return `You are council member ${member.name} (${member.model}). Work independently on the user request supplied by the council orchestrator.

You are read-only. Inspect local files or web sources only when they materially help answer the request. Do not modify files, run shell commands, delegate work, or ask the user questions.

Return a concise, self-contained analysis. Clearly distinguish facts, assumptions, risks, and recommendations. Cite file paths and line numbers, URLs, or other evidence when available. State material uncertainty rather than inventing evidence. Do not try to predict or conform to other council members.`
}

function orchestratorPrompt(members: Member[], minimum: number): string {
  const agents = members.map((member) => `- ${memberAgentName(member.name)} (${member.model})`).join("\n")
  return `You are the hidden orchestrator for a multi-model council. The command input contains a user request. Turn it into one self-contained task prompt, including any relevant context supplied in the command, then send that exact prompt to every council member below.

Council members:
${agents}

Use the Task tool to invoke every member in ONE assistant message so OpenCode runs them in parallel. Do not delegate to any agent outside this list. Wait for all foreground results before responding.

After the initial calls finish, classify each result before retrying. For an explicit failure or a response with no usable analysis, retry once with the original task prompt. For a usable but incomplete response that says it reached its maximum steps, stopped early, or left requested work unfinished, retry once with a continuation prompt containing both the original task prompt and the member's full prior response. Explain that the prior attempt stopped before completing the request. Tell the fresh member to preserve and verify usable findings, avoid repeating completed work or any tool call identified as problematic, finish the remaining work, and return one complete self-contained analysis. Ordinary recommendations for future action do not by themselves make an otherwise complete response incomplete.

Submit all needed retries together in ONE assistant message and start fresh calls without task_id. Never retry a complete successful member and never retry any member more than once. Wait for the retry results, then continue even if some members still failed. During synthesis, retain useful evidence from an incomplete initial response when its retry fails or remains incomplete.

Compile the member responses into a direct answer. Prefer evidence and sound reasoning over majority count. Label a point as consensus only when at least ${minimum} successful members independently support it. This is a synthesis policy, not a completion gate: if fewer members succeed, respond with the available evidence and clearly state that the quorum was not met. Surface material disagreements, unique high-value observations, uncertainty, and failed members. Adapt the format to the request: severity-ordered findings for code review, steps and tradeoffs for plans, evidence and confidence for research, and concise recommendations for general questions. Never fabricate an absent member response.`
}

function memberPermission(allowWeb: boolean): Record<string, unknown> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    webfetch: allowWeb ? "allow" : "deny",
    websearch: allowWeb ? "allow" : "deny",
    doom_loop: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    todowrite: "deny",
    question: "deny",
    external_directory: "deny",
  }
}

export const CouncilPlugin: Plugin = async (input) => {
  const globalConfig = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", CONFIG_NAME)
  const projectConfig = path.join(input.worktree, ".opencode", CONFIG_NAME)
  const configured = await readConfig(globalConfig, DEFAULT_CONFIG)
  const council = await readConfig(projectConfig, configured)

  return {
    config: async (config) => {
      const mutable = config as Record<string, any>
      mutable.agent ??= {}
      mutable.command ??= {}

      for (const member of council.members) {
        mutable.agent[memberAgentName(member.name)] = {
          mode: "subagent",
          hidden: true,
          model: member.model,
          steps: 12,
          prompt: memberPrompt(member),
          permission: memberPermission(council.allow_web),
        }
      }

      mutable.agent["council-orchestrator"] = {
        mode: "subagent",
        hidden: true,
        steps: council.members.length + 4,
        prompt: orchestratorPrompt(council.members, council.minimum_successful_members),
        permission: {
          read: "deny",
          glob: "deny",
          grep: "deny",
          list: "deny",
          lsp: "deny",
          webfetch: "deny",
          websearch: "deny",
          doom_loop: "deny",
          edit: "deny",
          bash: "deny",
          task: {
            "*": "deny",
            "council-member-*": "allow",
          },
          todowrite: "deny",
          question: "deny",
          external_directory: "deny",
        },
      }

      mutable.command.council = {
        description: "ask independent models and synthesize their responses",
        agent: "council-orchestrator",
        subtask: true,
        template: "User request for the council:\n$ARGUMENTS",
      }

      const currentDepth = Number(mutable.subagent_depth)
      mutable.subagent_depth = Number.isFinite(currentDepth) ? Math.max(2, currentDepth) : 2
    },
    "command.execute.before": async (command, output) => {
      if (command.command !== "council") return
      const task = output.parts.find((part) => part.type === "subtask" && part.agent === "council-orchestrator")
      if (!task || task.type !== "subtask") return

      try {
        const response = await input.client.session.messages({
          path: { id: command.sessionID },
          query: { limit: HISTORY_MESSAGE_LIMIT },
        })
        const history = formatRecentHistory(response.data)
        if (!history) return
        task.prompt = `Recent conversation context (oldest to newest; may be truncated):\n\n${history}\n\nCurrent council request:\n${task.prompt}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[council] Could not read session history for ${command.sessionID}: ${message}`)
      }
    },
  }
}

export default CouncilPlugin
