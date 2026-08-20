/**
 * opencode-ppq.ts — PPQ (ppq.ai) provider plugin for opencode.
 *
 * Baked into the image at ~/.config/opencode/plugins/ and loaded via
 * `"plugin": ["./plugins/opencode-ppq.ts"]` in opencode.json (or auto-discovered
 * from a config dir). It gives the `ppq` provider:
 *
 *   1. `config` — the workhorse. It (a) injects PPQ_API_KEY from env (or a stored
 *      api key from auth.json) into `provider.ppq.options.apiKey`, and (b) fetches
 *      the LIVE PPQ catalog and writes EVERY model into
 *      `config.provider.ppq.models` in opencode's STATIC config-model shape.
 *   2. `auth` — a guided "paste your API key" flow (URL surfaced as text) that
 *      stores the key so it survives across restarts.
 *
 * WHY the config hook (not `provider.models()`): in opencode 1.17.14 the
 * `provider.models()` hook only runs for provider ids that already exist in the
 * built-in models.dev catalog (`database[providerID]` must be truthy). `ppq` is a
 * custom provider, so that hook is skipped entirely. The `config` hook runs before
 * providers are built from config, and config-defined providers/models are fully
 * supported — that's the mechanism the static "canary" config proved works.
 *
 * The PPQ /v1/models endpoint is PUBLIC, so the full catalog is ALWAYS loaded
 * whether or not a key is present — the key is only needed to actually call a
 * model. This keeps the `ppq` provider listed (opencode deletes config providers
 * with zero models) even before the user authenticates.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const PPQ_BASE_URL = "https://api.ppq.ai"
const MODELS_ENDPOINT = `${PPQ_BASE_URL}/v1/models`
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Raw model entry as returned by PPQ `/v1/models` (subset we rely on). */
interface PpqRawModel {
  id: string
  owned_by?: string
  name?: string
  created_at?: number // ms epoch
  context_length?: number
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: string[]
  pricing?: {
    input_per_1M_tokens?: number
    output_per_1M_tokens?: number
  }
}

/** opencode static config model shape (ProviderConfig.models[id]). */
type Modality = "text" | "audio" | "image" | "video" | "pdf"
interface ConfigModel {
  name: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit?: { context: number; output: number }
  modalities?: { input: Modality[]; output: Modality[] }
  status?: "alpha" | "beta" | "deprecated" | "active"
}

const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")

/** Resolve the on-disk cache path, honoring XDG_DATA_HOME (persists across rebuilds). */
function cachePath(): string {
  return path.join(dataHome(), "opencode", "ppq-models.cache.json")
}

/** Read the stored PPQ api key from opencode's auth.json (survives restarts). */
async function storedApiKey(): Promise<string | undefined> {
  try {
    const txt = await fs.readFile(path.join(dataHome(), "opencode", "auth.json"), "utf8")
    const auth = JSON.parse(txt) as Record<string, { type?: string; key?: string }>
    const entry = auth?.ppq
    if (entry?.type === "api" && entry.key) return entry.key
  } catch {
    /* no stored auth — ignore */
  }
  return undefined
}

interface CacheShape {
  fetchedAt: number
  data: PpqRawModel[]
}

async function readCache(): Promise<CacheShape | undefined> {
  try {
    const txt = await fs.readFile(cachePath(), "utf8")
    const parsed = JSON.parse(txt) as CacheShape
    if (Array.isArray(parsed?.data)) return parsed
  } catch {
    /* no cache / unreadable — ignore */
  }
  return undefined
}

async function writeCache(data: PpqRawModel[]): Promise<void> {
  try {
    const p = cachePath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = `${p}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt: Date.now(), data } satisfies CacheShape))
    await fs.rename(tmp, p)
  } catch {
    /* best-effort cache; never fail startup over it */
  }
}

/**
 * Fetch the raw PPQ catalog, falling back to (and refreshing) the on-disk cache.
 * The `/v1/models` endpoint is PUBLIC — no API key is required to list models
 * (the key is only needed to actually call a model). We send the key as a bearer
 * token when we have one (harmless), but never require it.
 */
async function fetchCatalog(apiKey?: string): Promise<PpqRawModel[]> {
  const cached = await readCache()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data

  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    // Add a 5-second timeout to avoid hanging opencode startup
    const res = await fetch(MODELS_ENDPOINT, { 
      headers,
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw new Error(`PPQ /v1/models -> ${res.status}`)
    const json = (await res.json()) as { data?: PpqRawModel[] }
    const data = json.data ?? []
    if (data.length) {
      await writeCache(data)
      return data
    }
    if (cached) return cached.data
    return []
  } catch {
    if (cached) return cached.data
    return []
  }
}

/** Map a PPQ raw model to opencode's STATIC config model shape (costs = USD/1M). */
function toConfigModel(m: PpqRawModel): ConfigModel {
  const params = new Set((m.supported_parameters ?? []).map((p) => p.toLowerCase()))
  const inputs = new Set((m.architecture?.input_modalities ?? ["text"]).map((s) => s.toLowerCase()))
  const outputs = new Set((m.architecture?.output_modalities ?? ["text"]).map((s) => s.toLowerCase()))

  const reasoning = params.has("reasoning") || params.has("include_reasoning") || params.has("reasoning_effort")
  const toolcall = params.has("tools") || params.has("tool_choice")
  const temperature = params.has("temperature")
  const attachment = inputs.has("image") || inputs.has("file") || inputs.has("video") || inputs.has("audio")

  // PPQ uses "file" to mean PDF/document attachments.
  const inputMods: Modality[] = []
  if (inputs.has("text") || inputs.size === 0) inputMods.push("text")
  if (inputs.has("image")) inputMods.push("image")
  if (inputs.has("video")) inputMods.push("video")
  if (inputs.has("audio")) inputMods.push("audio")
  if (inputs.has("file") || inputs.has("pdf")) inputMods.push("pdf")

  const outputMods: Modality[] = []
  if (outputs.has("text") || outputs.size === 0) outputMods.push("text")
  if (outputs.has("image")) outputMods.push("image")
  if (outputs.has("audio")) outputMods.push("audio")

  const inputCost = Math.max(0, m.pricing?.input_per_1M_tokens ?? 0)
  const outputCost = Math.max(0, m.pricing?.output_per_1M_tokens ?? 0)
  const context = m.context_length ?? 0
  const releaseDate =
    typeof m.created_at === "number" && m.created_at > 0
      ? new Date(m.created_at).toISOString().slice(0, 10)
      : undefined

  return {
    name: m.name || m.id,
    reasoning,
    tool_call: toolcall,
    temperature,
    attachment,
    cost: { input: inputCost, output: outputCost, cache_read: 0, cache_write: 0 },
    limit: { context, output: context > 0 ? Math.min(context, 32000) : 0 },
    modalities: { input: inputMods, output: outputMods },
    status: "active",
    ...(releaseDate ? { release_date: releaseDate } : {}),
  }
}

export const PpqPlugin: Plugin = async () => {
  return {
    /**
     * Runs before providers are built from config. We inject the api key (env or
     * stored) and populate the full live model list into config.provider.ppq.models
     * using opencode's static config-model shape.
     */
    config: async (config) => {
      const key = process.env.PPQ_API_KEY ?? (await storedApiKey())

      config.provider ??= {}
      const ppq = (config.provider.ppq ??= {})
      ppq.npm ??= "@ai-sdk/openai-compatible"
      ppq.name ??= "PayPerQ - ppq.ai"
      ppq.options ??= {}
      ppq.options.baseURL ??= PPQ_BASE_URL

      if (key && !ppq.options.apiKey) ppq.options.apiKey = key

      // If we have a key, fetch the full catalog. If we don't have a key, we
      // DO NOT pollute the model list with 300+ models the user can't use yet.
      // Instead, we inject exactly one stub model so the provider survives
      // opencode's "delete providers with zero models" rule, keeping the auth
      // flow reachable.
      //
      // NOTE ON SLASHES: Many PPQ models have IDs like `google/gemini-2.5-pro`.
      // Prefixed as `ppq/google/gemini-2.5-pro`, they still work fine because
      // opencode splits on the first slash to parse the provider vs model ID.
      const models: Record<string, ConfigModel> = {}

      if (key) {
        const raw = await fetchCatalog(key)
        for (const m of raw) {
          if (!m?.id) continue
          models[m.id] = toConfigModel(m)
        }
      }

      // If we still have zero models (either no key, or the key is present but
      // fetching the catalog failed offline with no cache), we MUST inject
      // the stub model so the provider survives and the auth flow is reachable.
      //
      // We set tool_call: true so this model isn't filtered out of agent model-pickers
      // before authentication.
      if (Object.keys(models).length === 0) {
        models["sign-in-required"] = {
          name: key ? "Connect PPQ (Failed to load models)" : "Connect PPQ to load models",
          tool_call: true,
          cost: { input: 0, output: 0 },
          limit: { context: 100000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          status: "active",
        }
      }

      // Merge (don't clobber) any statically-declared models.
      ppq.models = { ...models, ...(ppq.models ?? {}) }
    },

    /**
     * Guided API-key flow for interactive users.
     * In opencode 1.17.14, `type: "api"` methods automatically append a built-in
     * "API key" prompt. If we provide our own `prompts` array here, opencode treats
     * them as extra metadata prompts, causing a double-prompt (custom, then built-in).
     * To get a single prompt with instructions, we omit `prompts` and put the
     * instructions entirely in the `label` (which becomes the dialog title).
     */
    auth: {
      provider: "ppq",
      loader: async (getAuth) => {
        const a = (await getAuth()) as { type?: string; key?: string }
        return a?.type === "api" && a.key ? { apiKey: a.key } : {}
      },
      methods: [
        {
          type: "api",
          label: "Open https://ppq.ai/invite/a586e70a -> Add funds -> Get an API key -> paste key",
        },
      ],
    },

    /**
     * Preflight check before a chat request fires.
     * If the user selects the stub model because they haven't authenticated yet,
     * throw a friendly instructional error rather than a confusing 401.
     */
    "chat.params": async (input, output) => {
      if (input.model.id === "sign-in-required") {
        throw new Error(
          "PPQ is not connected yet (or opencode needs a restart after connecting).\n\n" +
          "1. Run /connect and choose PPQ\n" +
          "2. Open https://ppq.ai/invite/a586e70a\n" +
          "3. Add funds\n" +
          "4. Go to Get an API key and copy a key\n" +
          "5. Paste the key into OpenCode\n\n" +
          "If you already connected, please restart OpenCode so it can fetch the model catalog."
        )
      }
    },
  }
}

export default PpqPlugin
