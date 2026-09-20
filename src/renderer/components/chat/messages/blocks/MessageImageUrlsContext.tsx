import type { ReactNode } from 'react'
import { createContext, use, useEffect, useMemo, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import type { CherryMessagePart } from '@shared/data/types/message'
import { readCherryMeta } from '@shared/data/types/uiParts'
import { toFileUrl } from '@shared/utils/file'

const MessageImageUrlsContext = createContext<ReadonlyMap<string, string> | null>(null)
const EMPTY_RESOLVED_IMAGE_URLS: ReadonlyMap<string, string> = new Map()

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

export function MessageImageUrlsProvider({ parts, children }: { parts: CherryMessagePart[]; children: ReactNode }) {
  const entryIdsKey = useMemo(() => managedImageEntryIds(parts).join('\0'), [parts])
  const [resolved, setResolved] = useState<{ key: string; urls: ReadonlyMap<string, string> }>({
    key: '',
    urls: EMPTY_RESOLVED_IMAGE_URLS
  })

  useEffect(() => {
    if (entryIdsKey === '') {
      setResolved((prev) => (prev.key === '' ? prev : { key: '', urls: EMPTY_RESOLVED_IMAGE_URLS }))
      return
    }

    let active = true
    const ids = entryIdsKey.split('\0')
    const load = async () => {
      try {
        const paths = await ipcApi.request('file.batch_get_physical_paths', { ids })
        if (!active) return
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
        setResolved({ key: entryIdsKey, urls })
      } catch {
        if (active) setResolved({ key: entryIdsKey, urls: EMPTY_RESOLVED_IMAGE_URLS })
      }
    }
    void load()

    return () => {
      active = false
    }
  }, [entryIdsKey])

  const urls = entryIdsKey === '' || resolved.key !== entryIdsKey ? EMPTY_RESOLVED_IMAGE_URLS : resolved.urls
  return <MessageImageUrlsContext value={urls}>{children}</MessageImageUrlsContext>
}

/**
 * Replace managed image URLs with current FileManager-backed locations for rendering only.
 * Stored parts stay unchanged; external and data URLs pass through.
 */
export function useResolvedMessageImageParts(parts: CherryMessagePart[]): CherryMessagePart[] {
  const urls = use(MessageImageUrlsContext)

  return useMemo(() => {
    if (urls === null) return parts

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
