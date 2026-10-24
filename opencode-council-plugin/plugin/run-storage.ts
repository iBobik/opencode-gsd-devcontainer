import type { CouncilDisplay } from "./council-rpc"

type Storage = {
  get(key: string): Promise<any>
  scan(input: { prefix: string; limit: number; after?: string }): Promise<{ entries: readonly { key: string; value: any }[]; next?: string }>
}

export const displayKey = (sessionID: string, invocationID: string) => `display/${sessionID}/${invocationID}`

export async function displayEntries(storage: Storage, prefix: string) {
  const entries: { key: string; value: CouncilDisplay }[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) })
    entries.push(...page.entries.filter((entry) => entry.key.startsWith(prefix)))
    after = page.next
  } while (after)
  return entries
}

export async function latestDisplay(storage: Storage, sessionID: string): Promise<CouncilDisplay | undefined> {
  const entries = await displayEntries(storage, `display/${sessionID}/`)
  entries.sort((a, b) => (b.value.createdAt ?? 0) - (a.value.createdAt ?? 0) || b.key.localeCompare(a.key))
  // Read old records for compatibility; new invocations never overwrite them.
  return entries[0]?.value ?? await storage.get(`display/${sessionID}`)
}
