import { invoke } from './bridge'

export async function getRecentFiles(): Promise<string[]> {
  return invoke<string[]>('getRecentFiles', {})
}

export async function addRecentFile(path: string): Promise<void> {
  await invoke('addRecentFile', { path })
}