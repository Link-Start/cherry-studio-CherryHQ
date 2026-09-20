import type { ReactNode } from 'react'
import { createContext, use, useEffect, useMemo, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import type { CherryMessagePart } from '@shared/data/types/message'
import { readCherryMeta } from '@shared/data/types/uiParts'
import { toFileUrl } from '@shared/utils/file'

const MessageImageUrlsContext = createContext<ReadonlyMap<string, string> | null>(null)
const EMPTY_RESOLVED_IMAGE_URLS: ReadonlyMap<string, string> = new Map()

// Concurrent mounts for the same entries (grid trigger + popover, remounts)
// share one IPC round-trip. Settled promises leave the map so later mounts
// refetch and still observe file moves.
const inflightEntryUrls = new Map<string, Promise<ReadonlyMap<string, string>>>()

function managedImageEntryId(part: CherryMessagePart): string | undefined {
  if (part.type !== 'file') return undefined
  const mediaType = (part as { mediaType?: unknown }).mediaType
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return undefined
  return readCherryMeta(part)?.fileEntryId
}

function managedImageEntryIds(parts: readonly CherryMessagePart[]): string[] {
  const ids = new Set<string>()
  for (const part of parts) {
    const entryId = managedImageEntryId(part)
    if (entryId) ids.add(entryId)
  }
  return [...ids].sort()
}

function loadEntryUrls(key: string, ids: string[]): Promise<ReadonlyMap<string, string>> {
  const running = inflightEntryUrls.get(key)
  if (running) return running

  const pending = (async (): Promise<ReadonlyMap<string, string>> => {
    try {
      const paths = await ipcApi.request('file.batch_get_physical_paths', { ids })
      const urls = new Map<string, string>()
      for (const entryId of ids) {
        const path = paths[entryId]
        if (!path) continue
        try {
          urls.set(entryId, toFileUrl(path))
        } catch {
          continue
        }
      }
      return urls
    } catch {
      return EMPTY_RESOLVED_IMAGE_URLS
    } finally {
      inflightEntryUrls.delete(key)
    }
  })()
  inflightEntryUrls.set(key, pending)
  return pending
}

function useEntryUrls(key: string): ReadonlyMap<string, string> {
  const [resolved, setResolved] = useState<{ key: string; urls: ReadonlyMap<string, string> }>({
    key: '',
    urls: EMPTY_RESOLVED_IMAGE_URLS
  })

  useEffect(() => {
    if (key === '') {
      setResolved((prev) => (prev.key === '' ? prev : { key: '', urls: EMPTY_RESOLVED_IMAGE_URLS }))
      return
    }

    let active = true
    void loadEntryUrls(key, key.split('\0')).then((urls) => {
      if (active) setResolved({ key, urls })
    })

    return () => {
      active = false
    }
  }, [key])

  return key === '' || resolved.key !== key ? EMPTY_RESOLVED_IMAGE_URLS : resolved.urls
}

export function MessageImageUrlsProvider({ parts, children }: { parts: CherryMessagePart[]; children: ReactNode }) {
  const entryIdsKey = useMemo(() => managedImageEntryIds(parts).join('\0'), [parts])
  const urls = useEntryUrls(entryIdsKey)
  return <MessageImageUrlsContext value={urls}>{children}</MessageImageUrlsContext>
}

/**
 * Replace managed image URLs with current FileManager-backed locations for rendering only.
 * Stored parts stay unchanged; external and data URLs pass through. Consumers outside a
 * message scope resolve on their own instead of silently keeping stale stored URLs.
 */
export function useResolvedMessageImageParts(parts: CherryMessagePart[]): CherryMessagePart[] {
  const scoped = use(MessageImageUrlsContext)
  const fallbackKey = useMemo(() => (scoped === null ? managedImageEntryIds(parts).join('\0') : ''), [scoped, parts])
  const fallback = useEntryUrls(fallbackKey)
  const urls = scoped ?? fallback

  return useMemo(() => {
    let changed = false
    const resolvedParts = parts.map((part) => {
      const entryId = managedImageEntryId(part)
      if (!entryId) return part

      const hit = urls.get(entryId)
      const current = (part as { url?: unknown }).url
      if (typeof hit === 'string') {
        if (current === hit) return part
        changed = true
        return { ...part, url: hit }
      }
      if (typeof current !== 'string' || current === '') return part
      changed = true
      return { ...part, url: '' }
    })
    return changed ? resolvedParts : parts
  }, [parts, urls])
}
