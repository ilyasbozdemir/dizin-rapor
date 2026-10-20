export const ARSIV_CORE_VERSION = '1.0.0'

export interface FileTagMetadata {
  tags: string[]
  description?: string
}

export type TagspacesMetadata = FileTagMetadata

export * from './analyzer'
