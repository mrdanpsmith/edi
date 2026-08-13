import { invoke } from '@tauri-apps/api/core'
import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog'

export const SUPPORTED_EXTENSIONS = ['md', 'markdown', 'txt', 'mermaid'] as const

export const UNTITLED = 'Untitled'

export const FILE_FILTERS: DialogFilter[] = [
  {
    name: 'Markdown documents',
    extensions: [...SUPPORTED_EXTENSIONS],
  },
  {
    name: 'All files',
    extensions: ['*'],
  },
]

export const HTML_FILTERS: DialogFilter[] = [
  {
    name: 'HTML documents',
    extensions: ['html', 'htm'],
  },
  {
    name: 'All files',
    extensions: ['*'],
  },
]

export function fileExtension(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function fileName(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function isSupportedFile(path: string): boolean {
  const ext = fileExtension(path)
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke('write_text_file', { path, content })
}

export async function pickOpenPath(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [...FILE_FILTERS],
  })
  return typeof result === 'string' ? result : null
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  const result = await save({
    defaultPath: `${defaultName}.md`,
    filters: [...FILE_FILTERS],
  })
  return typeof result === 'string' ? result : null
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  const result = await save({
    defaultPath: `${defaultName}.html`,
    filters: [...HTML_FILTERS],
  })
  return typeof result === 'string' ? result : null
}
