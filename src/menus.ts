export interface MenuCommands {
  new: () => void
  open: () => void
  save: () => void
  saveAs: () => void
  rename: () => void
  revert: () => void
  importTable: () => void
  importText: () => void
  insertImage: () => void
  insertTableDefault: () => void
  insertKanban: () => void
  export: () => void
  toggleToolbar: () => void
  formulaReference: () => void
  helpGuide: () => void
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  pasteAsMarkdown: () => void
  selectAll: () => void
  find: () => void
  replace: () => void
  openRecent: (path?: string) => void
  copyFilePath: () => void
}

type MenuHandler = (argument?: string) => void

export function bindMenuCommands(handlers: MenuCommands): void {
  window.ediMenuCommand = (command: string, argument?: string) => {
    const handler: MenuHandler | undefined = handlers[command as keyof MenuCommands]
    handler?.(argument)
  }
}
