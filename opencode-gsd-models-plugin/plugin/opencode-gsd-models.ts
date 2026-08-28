import type { Plugin } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import { watch, type FSWatcher } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const PROFILES = ["claude", "gpt", "mixed"] as const
type Profile = (typeof PROFILES)[number]
type Source = "environment" | "project .env" | "automatic" | "inherit"
type Tier = "heavy" | "standard" | "light"

const PROFILE_MODELS: Record<Profile, Record<Tier, string>> = {
  claude: {
    heavy: "anthropic/claude-opus-5",
    standard: "anthropic/claude-sonnet-5",
    light: "anthropic/claude-haiku-4-5",
  },
  gpt: {
    heavy: "openai/gpt-5.6-sol",
    standard: "openai/gpt-5.6-terra",
    light: "openai/gpt-5.6-luna",
  },
  mixed: {
    heavy: "ppq/claude-opus-5",
    standard: "ppq/gpt-5.6-sol",
    light: "ppq/claude-haiku-4.5",
  },
}

const MAX_DOTENV_BYTES = 64 * 1024
const MAX_CATALOG_BYTES = 2 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseProfile(value: unknown): Profile | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  return (PROFILES as readonly string[]).includes(normalized) ? normalized as Profile : undefined
}

function parseDotenvValue(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  const quote = trimmed[0]
  if (quote === "\"" || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    const trailing = trimmed.slice(end + 1).trim()
    if (end <= 0 || (trailing && !trailing.startsWith("#"))) return undefined
    return trimmed.slice(1, end)
  }
  const comment = trimmed.search(/\s#/)
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim()
}

export function parseDotenvProfile(contents: string): string | undefined {
  let result: string | undefined
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?GSD_MODELS_PROFILE\s*=\s*(.*)$/)
    if (!match) continue
    const value = parseDotenvValue(match[1])
    if (value !== undefined) result = value
  }
  return result
}

async function readDotenvProfile(worktree: string): Promise<{ value?: string; source?: string; warning?: string }> {
  // A project-level value is more specific than the template example.
  const files = [path.join(worktree, ".devcontainer", ".env"), path.join(worktree, ".env")]
  let value: string | undefined
  let source: string | undefined
  let warning: string | undefined
  for (const file of files) {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) { warning = `Ignoring unsafe ${path.relative(worktree, file)} (it is not a regular file).`; continue }
      if (stat.size > MAX_DOTENV_BYTES) { warning = `Ignoring ${path.relative(worktree, file)} because it exceeds 64 KiB.`; continue }
      const contents = await fs.readFile(file, "utf8")
      if (contents.includes("\0")) { warning = `Ignoring ${path.relative(worktree, file)} because it contains NUL bytes.`; continue }
      const parsed = parseDotenvProfile(contents)
      if (parsed !== undefined) { value = parsed; source = path.relative(worktree, file) || ".env" }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = `Could not read ${path.relative(worktree, file)}; ignoring its GSD_MODELS_PROFILE value.`
    }
  }
  return { value, source, warning }
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

async function authProviders(): Promise<Set<string>> {
  const result = new Set<string>()
  if (process.env.ANTHROPIC_API_KEY) result.add("anthropic")
  if (process.env.OPENAI_API_KEY) result.add("openai")
  if (process.env.PPQ_API_KEY) result.add("ppq")
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataHome(), "opencode", "auth.json"), "utf8"))
    if (isRecord(parsed)) for (const [provider, entry] of Object.entries(parsed)) if (isRecord(entry)) result.add(provider)
  } catch {
    // Stored auth is only a selection hint; OpenCode validates it after startup.
  }
  try {
    const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT || "")
    if (isRecord(parsed)) for (const [provider, entry] of Object.entries(parsed)) if (isRecord(entry)) result.add(provider)
  } catch {
    // Invalid OPENCODE_AUTH_CONTENT belongs to OpenCode's own auth handling.
  }
  return result
}

function profileFromAuth(auth: Set<string>, config: Record<string, any>): Profile | undefined {
  const disabled = new Set(Array.isArray(config.disabled_providers) ? config.disabled_providers : [])
  const enabled = Array.isArray(config.enabled_providers) ? new Set(config.enabled_providers) : undefined
  const available = (provider: string) => !disabled.has(provider) && (!enabled || enabled.has(provider))
  const configured = (provider: string) => typeof config.provider?.[provider]?.options?.apiKey === "string"
  if (available("anthropic") && (auth.has("anthropic") || configured("anthropic"))) return "claude"
  if (available("openai") && (auth.has("openai") || configured("openai"))) return "gpt"
  if (available("ppq") && (auth.has("ppq") || configured("ppq"))) return "mixed"
  return undefined
}

type CatalogAgent = { routingTier: Tier }

async function readCatalog(configRoot: string): Promise<{ agents?: Record<string, CatalogAgent>; warning?: string }> {
  const file = path.join(configRoot, "gsd-core", "bin", "shared", "model-catalog.json")
  try {
    const root = await fs.realpath(configRoot)
    const resolved = await fs.realpath(file)
    if (!resolved.startsWith(`${root}${path.sep}`)) return { warning: "GSD routing catalog is outside the OpenCode config directory." }
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return { warning: "GSD routing catalog is missing, invalid, or too large." }
    const parsed: unknown = JSON.parse(await fs.readFile(resolved, "utf8"))
    if (!isRecord(parsed) || !isRecord(parsed.agents)) return { warning: "GSD routing catalog has an unsupported schema." }
    const agents: Record<string, CatalogAgent> = {}
    for (const [name, value] of Object.entries(parsed.agents)) {
      if (!/^gsd-[a-z0-9-]+$/.test(name) || !isRecord(value)) return { warning: "GSD routing catalog contains an unsafe agent entry." }
      const tier = value.routingTier
      if (tier !== "heavy" && tier !== "standard" && tier !== "light") return { warning: "GSD routing catalog contains an unknown routing tier." }
      agents[name] = { routingTier: tier }
    }
    return Object.keys(agents).length ? { agents } : { warning: "GSD routing catalog contains no agents." }
  } catch {
    return { warning: "Could not load GSD routing catalog; GSD agents will inherit the session model." }
  }
}

function statusText(profile: Profile | undefined, source: Source, requested?: string, warnings: readonly string[] = []): string {
  const active = profile ?? "inherit"
  const lines = [
    `GSD model profile: ${active} (${source}).`,
    "Available profiles: claude, gpt, mixed.",
    "Nothing was changed. Set GSD_MODELS_PROFILE before restarting OpenCode.",
    "Temporary: GSD_MODELS_PROFILE=gpt opencode",
    "Shell: export GSD_MODELS_PROFILE=gpt && opencode",
    "Project .env (manual): GSD_MODELS_PROFILE=gpt",
  ]
  if (requested) lines.unshift(`Requested profile: ${requested}.`)
  for (const warning of warnings) lines.push(`Warning: ${warning}`)
  return lines.join("\n")
}

function resolveToolPath(value: string, directory: string): string {
  return path.resolve(directory, value)
}

function isGsdConfigPath(value: unknown, worktree: string, directory = worktree): boolean {
  if (typeof value !== "string") return false
  const normalized = resolveToolPath(value, directory)
  return normalized.startsWith(`${path.resolve(worktree)}${path.sep}`) && /[\\/]\.planning(?:[\\/].*)?[\\/]config\.json$/.test(normalized)
}

function unsafeConfigDocument(value: unknown): boolean {
  if (typeof value !== "string") return true
  try {
    const parsed: unknown = JSON.parse(value)
    return !isRecord(parsed) || parsed.model_profile !== "inherit" || parsed.resolve_model_ids !== "omit"
  } catch {
    return true
  }
}

async function unsafeConfigEdit(args: Record<string, any>, worktree: string, directory: string): Promise<boolean> {
  const file = args.filePath ?? args.path
  if (!isGsdConfigPath(file, worktree, directory)) return false
  const oldString = args.oldString ?? args.old_string
  const newString = args.newString ?? args.new_string
  if (typeof oldString !== "string" || typeof newString !== "string") return true
  try {
    const resolved = resolveToolPath(file, directory)
    const contents = await fs.readFile(resolved, "utf8")
    if (!contents.includes(oldString)) return true
    const updated = args.replaceAll ? contents.replaceAll(oldString, newString) : contents.replace(oldString, newString)
    return unsafeConfigDocument(updated)
  } catch {
    return true
  }
}

async function unsafeConfigTool(tool: string, args: Record<string, any>, worktree: string, directory: string): Promise<boolean> {
  if (tool === "write") {
    return isGsdConfigPath(args.filePath ?? args.path, worktree, directory) && unsafeConfigDocument(args.content)
  }
  if (tool === "edit") return unsafeConfigEdit(args, worktree, directory)
  if (tool === "multi_edit") {
    const edits = Array.isArray(args.edits) ? args.edits : []
    const file = args.filePath ?? args.path
    if (!file) {
      for (const edit of edits) if (await unsafeConfigEdit(edit, worktree, directory)) return true
      return false
    }
    if (!edits.length) return isGsdConfigPath(file, worktree, directory)
    let contents: string | undefined
    if (!isGsdConfigPath(file, worktree, directory)) return false
    try { contents = await fs.readFile(resolveToolPath(file, directory), "utf8") } catch { return true }
    for (const edit of edits) {
      const oldString = edit?.oldString ?? edit?.old_string
      const newString = edit?.newString ?? edit?.new_string
      if (typeof oldString !== "string" || typeof newString !== "string" || !contents.includes(oldString)) return true
      contents = edit.replaceAll ? contents.replaceAll(oldString, newString) : contents.replace(oldString, newString)
    }
    return unsafeConfigDocument(contents)
  }
  if (tool === "apply_patch" && typeof args.patchText === "string") {
    for (const match of args.patchText.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File:|Move to:)\s*(.+)$/gm)) {
      if (isGsdConfigPath(match[1].trim(), worktree, directory)) return true
    }
  }
  return false
}

async function gsdConfigWarning(worktree: string): Promise<string | undefined> {
  try {
    const file = path.join(worktree, ".planning", "config.json")
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOTENV_BYTES) return "Could not verify the root GSD configuration invariant."
    if (unsafeConfigDocument(await fs.readFile(file, "utf8"))) {
      return "Root .planning/config.json conflicts with managed GSD routing; keep model_profile=inherit and resolve_model_ids=omit."
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "Could not verify the root GSD configuration invariant."
  }
  return undefined
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote = ""
  let escaped = false
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === "\\" && quote !== "'") { escaped = true; continue }
    if (quote) { if (character === quote) quote = ""; else current += character; continue }
    if (character === "'" || character === "\"") { quote = character; continue }
    if (/\s/.test(character)) { if (current) { tokens.push(current); current = "" }; continue }
    current += character
  }
  if (current) tokens.push(current)
  return tokens
}

function isForbiddenGsdSetter(command: string): boolean {
  const tokens = tokenize(command)
  const shell = tokens.findIndex((token) => /(?:^|\/)(?:ba|z|da|fi)?sh$/.test(token))
  const shellCommand = shell === -1 ? -1 : tokens.findIndex((token, index) => index > shell && /^-[a-z]*c[a-z]*$/i.test(token))
  if (shellCommand !== -1 && tokens[shellCommand + 1] && isForbiddenGsdSetter(tokens[shellCommand + 1])) return true
  const launcher = tokens.findIndex((token) => /(?:^|\/)(?:gsd-tools(?:\.cjs)?|gsd_run)$/.test(token))
  const node = tokens.findIndex((token) => token === "node")
  if (launcher === -1 && (node === -1 || !/(?:^|\/)gsd-tools\.cjs$/.test(tokens[node + 1] || ""))) return false
  const rawArgs = tokens.slice(launcher === -1 ? node + 2 : launcher + 1)
  const args: string[] = []
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index]
    if (["--raw", "--json-errors"].includes(token) || /^(--cwd|--ws|--pick|--default)=/.test(token)) continue
    if (["--cwd", "--ws", "--pick", "--default"].includes(token)) { index++; continue }
    args.push(token)
  }
  const query = args.indexOf("query")
  const commandIndex = query === -1 ? 0 : query + 1
  const rawAction = args[commandIndex] || ""
  const [action, dottedValue] = rawAction.split(".", 2)
  if (action === "config-set-model-profile") return (dottedValue || args[commandIndex + 1])?.toLowerCase() !== "inherit"
  if (action !== "config-set") return false
  const assignment = !dottedValue ? args[commandIndex + 1]?.match(/^([^=]+)=(.*)$/) : undefined
  const key = dottedValue || assignment?.[1] || args[commandIndex + 1]
  const value = assignment?.[2] ?? (dottedValue ? args[commandIndex + 1] : args[commandIndex + 2])
  return (key === "model_profile" && value?.toLowerCase() !== "inherit") || (key === "resolve_model_ids" && value !== "omit")
}

export const GsdModelsPlugin: Plugin = async (input) => {
  const dotenv = await readDotenvProfile(input.worktree)
  const processValue = process.env.GSD_MODELS_PROFILE
  const explicitValue = processValue?.trim() ? processValue : dotenv.value
  const explicitProfile = parseProfile(explicitValue)
  const explicitSource: Source = processValue?.trim() ? "environment" : "project .env"
  const configRoot = path.dirname(process.env.OPENCODE_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "opencode.json"))
  const startupWarnings = dotenv.warning ? [dotenv.warning] : []
  let profile: Profile | undefined = explicitProfile
  let source: Source = explicitProfile ? explicitSource : "inherit"
  const watchers: FSWatcher[] = []
  let dotenvTimer: ReturnType<typeof setTimeout> | undefined
  let validationStarted = false
  const alerted = new Set<string>()
  const sessionAgents = new Map<string, string>()

  const warn = (message: string) => {
    void input.client.app.log({
      body: { service: "gsd-models", level: "warn", message },
    }).catch(() => {})
  }
  const toast = async (message: string, variant: "info" | "warning" | "error" = "warning") => {
    try { await input.client.tui.showToast({ body: { title: "GSD model routing", message, variant } }) } catch { /* headless or unavailable TUI */ }
  }
  const addWarning = (message: string) => {
    if (!startupWarnings.includes(message)) startupWarnings.push(message)
    warn(message)
  }
  const dotenvChanged = () => {
    if (dotenvTimer) clearTimeout(dotenvTimer)
    dotenvTimer = setTimeout(() => {
      void toast("Project .env changed. Restart OpenCode to apply GSD model profile changes.", "warning")
      warn("Project .env changed; restart OpenCode to apply its GSD model profile.")
    }, 150)
  }
  const trackWatcher = (watcher: FSWatcher) => {
    watcher.on("error", () => {
      watcher.close()
      warn("Project .env change detection stopped; restart OpenCode after changing it.")
    })
    watchers.push(watcher)
  }

  try {
    trackWatcher(watch(input.worktree, { persistent: false }, (_event, filename) => {
      if (filename?.toString() === ".env") dotenvChanged()
    }))
  } catch {
    warn("Project .env change detection is unavailable; restart OpenCode after changing it.")
  }
  try {
    trackWatcher(watch(path.join(input.worktree, ".devcontainer"), { persistent: false }, (_event, filename) => {
      if (filename?.toString() === ".env") dotenvChanged()
    }))
  } catch {
    // The OpenCode watcher still handles this file when .devcontainer does not exist yet.
  }

  return {
    config: async (config) => {
      const mutable = config as Record<string, any>
      if (explicitValue && !explicitProfile) {
        addWarning(`Ignoring invalid GSD_MODELS_PROFILE '${explicitValue}'.`)
      }
      const configWarning = await gsdConfigWarning(input.worktree)
      if (configWarning) addWarning(configWarning)
      if (!profile && !explicitValue) {
        const selected = profileFromAuth(await authProviders(), mutable)
        if (selected) { profile = selected; source = "automatic" }
      }
      const catalog = await readCatalog(configRoot)
      if (catalog.warning) addWarning(catalog.warning)
      mutable.agent ??= {}
      const installed = Object.keys(mutable.agent).filter((name) => name.startsWith("gsd-"))
      if (installed.length && catalog.agents) {
        const patches: Record<string, Record<string, unknown>> = {}
        for (const name of installed) {
          const tier = catalog.agents[name]?.routingTier
          if (!tier) { warn(`Unknown GSD agent '${name}' uses the standard tier.`) }
          const model = profile ? PROFILE_MODELS[profile][tier || "standard"] : undefined
          patches[name] = model ? { model, variant: undefined } : { model: undefined, variant: undefined }
        }
        for (const [name, patch] of Object.entries(patches)) Object.assign(mutable.agent[name], patch)
      } else if (installed.length) {
        for (const name of installed) { delete mutable.agent[name].model; delete mutable.agent[name].variant }
      }
      mutable.command ??= {}
      mutable.command["gsd-models-profile"] = {
        description: "show GSD model profile selection and manual switch instructions",
        template: "Report the injected GSD model-profile status verbatim. Do not change files or configuration.",
      }
      const state = statusText(profile, source, undefined, startupWarnings)
      warn(state.replace(/\n/g, " "))
    },
    "command.execute.before": async (command, output) => {
      if (command.command !== "gsd-models-profile") return
      const requested = command.arguments.trim()
      const requestWarning = requested && !parseProfile(requested) ? `Unknown requested profile '${requested}'.` : undefined
      const text = statusText(profile, source, requested || undefined, requestWarning ? [requestWarning] : startupWarnings)
      const existing = output.parts.find((part) => part.type === "text")
      const statusPart = existing?.type === "text" ? { ...existing, text } : {
        type: "text" as const,
        id: `gsd-models-profile-${command.sessionID}`,
        sessionID: command.sessionID,
        messageID: `gsd-models-profile-${command.sessionID}`,
        text,
      }
      output.parts.splice(0, output.parts.length, statusPart)
      await toast("GSD profile instructions were added to this command.", "info")
    },
    "chat.message": async (message) => {
      if (message.agent) sessionAgents.set(message.sessionID, message.agent)
    },
    "tool.execute.before": async (tool, output) => {
      if (tool.tool === "bash" && isForbiddenGsdSetter(String(output.args?.command || ""))) {
        throw new Error("GSD model routing is managed by GSD_MODELS_PROFILE. Keep model_profile=inherit and resolve_model_ids=omit; restart OpenCode after changing the environment.")
      }
      if (["write", "edit", "apply_patch", "multi_edit"].includes(tool.tool) && await unsafeConfigTool(tool.tool, output.args || {}, input.worktree, input.directory)) {
        throw new Error("GSD config must retain model_profile=inherit and resolve_model_ids=omit; use GSD_MODELS_PROFILE instead.")
      }
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.created" && !validationStarted) {
          validationStarted = true
          void (async () => {
            try {
              const result = await input.client.provider.list({ query: { directory: input.directory } })
              const data = result.data
              if (!data) throw new Error("provider list unavailable")
              if (profile) {
                const missing = Object.values(PROFILE_MODELS[profile]).filter((model) => {
                  const [provider, id] = model.split("/", 2)
                  return !data.connected.includes(provider) || !data.all.find((item) => item.id === provider)?.models[id] || id === "sign-in-required"
                })
                if (missing.length) await toast(`Selected ${profile} profile has unavailable models. Restart after connecting a provider or set another GSD_MODELS_PROFILE.`, "warning")
              }
            } catch { warn("Could not validate GSD provider catalogs after startup.") }
          })()
          return
        }
        if (event.type === "file.watcher.updated" && [
          path.join(path.resolve(input.worktree), ".env"),
          path.join(path.resolve(input.worktree), ".devcontainer", ".env"),
        ].includes(path.resolve(event.properties.file))) {
          dotenvChanged()
          return
        }
        if (event.type === "session.error" || event.type === "message.updated") {
          const error = event.type === "session.error" ? event.properties.error : (event.properties.info as any)?.error
          const sessionID = event.type === "session.error" ? event.properties.sessionID : (event.properties.info as any)?.sessionID
          const agent = sessionID ? sessionAgents.get(sessionID) : undefined
          if (agent && !String(agent).startsWith("gsd-")) return
          const text = JSON.stringify(error || "").toLowerCase()
          const kind = /402|429|quota|rate.?limit|billing|credits|resource_exhausted/.test(text) ? "quota" : /providerautherror|401|403|auth/.test(text) ? "auth" : undefined
          if (kind) {
            const key = `${kind}:${sessionID || "global"}`
            const subject = agent ? "A GSD agent" : "A provider request"
            const article = kind === "auth" ? "an" : "a"
            if (!alerted.has(key)) { alerted.add(key); await toast(`${subject} hit ${article} ${kind} failure. Connect another provider and restart with GSD_MODELS_PROFILE=claude, gpt, or mixed.`, "warning") }
          }
        }
      } catch { /* Plugin event handlers must never reject. */ }
    },
    dispose: async () => {
      if (dotenvTimer) clearTimeout(dotenvTimer)
      for (const watcher of watchers) watcher.close()
      sessionAgents.clear()
    },
  }
}

export default GsdModelsPlugin
