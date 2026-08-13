import { invoke } from './bridge'

export const SUPPORTED_EXTENSIONS = ['md', 'markdown', 'txt', 'mermaid'] as const

export const UNTITLED = 'Untitled'

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
  return invoke<string>('readTextFile', { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke('writeTextFile', { path, content })
}

export async function pickOpenPath(): Promise<string | null> {
  return invoke<string | null>('pickOpenPath', {})
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>('pickSavePath', { defaultName })
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  return invoke<string | null>('pickExportPath', { defaultName })
}

export async function pickImportPath(): Promise<string | null> {
  return invoke<string | null>('pickImportPath', {})
}
