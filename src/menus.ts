export interface MenuCommands {
  new: () => void
  open: () => void
  save: () => void
  saveAs: () => void
  revert: () => void
  importTable: () => void
  importText: () => void
  insertImage: () => void
  export: () => void
  toggleMode: () => void
  toggleFormatting: () => void
}

export function bindMenuCommands(handlers: MenuCommands): void {
  window.ediMenuCommand = (command: string) => {
    const handler = handlers[command as keyof MenuCommands]
    handler?.()
  }
}
