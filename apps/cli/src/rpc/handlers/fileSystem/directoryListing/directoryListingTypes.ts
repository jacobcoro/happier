export type DirectoryListingEntryType = 'file' | 'directory' | 'other'

export type DirectoryListingEntry = Readonly<{
  name: string
  absolutePath: string
  type: DirectoryListingEntryType
  size?: number
  modified?: number
  gitIgnored?: boolean
}>

export type DirectoryListingResult = Readonly<{
  entries: DirectoryListingEntry[]
  truncated: boolean
  gitIgnoreAvailable?: boolean
}>
