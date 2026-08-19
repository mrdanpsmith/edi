export type Mode = 'visual' | 'text'

const MODE_KEY = 'edi.mode'

export interface ModeCallbacks {
  onModeChange(mode: Mode): void
}

export class EditorLayout {
  private _mode: Mode

  constructor(
    private readonly workspace: HTMLElement,
    private readonly visualPane: HTMLElement,
    private readonly textPane: HTMLElement,
    private readonly callbacks: ModeCallbacks,
  ) {
    this._mode = readMode()
    this.applyMode()
  }

  get mode(): Mode {
    return this._mode
  }

  setMode(mode: Mode): void {
    if (mode === this._mode) return
    this._mode = mode
    localStorage.setItem(MODE_KEY, mode)
    this.applyMode()
    this.callbacks.onModeChange(mode)
  }

  toggleMode(): void {
    this.setMode(this._mode === 'visual' ? 'text' : 'visual')
  }

  isVisualMode(): boolean {
    return this._mode === 'visual'
  }

  isTextMode(): boolean {
    return this._mode === 'text'
  }

  private applyMode(): void {
    const isVisual = this._mode === 'visual'
    this.visualPane.hidden = !isVisual
    this.textPane.hidden = isVisual
    this.workspace.classList.toggle('text-mode', !isVisual)
    this.workspace.classList.toggle('visual-mode', isVisual)
  }
}

function readMode(): Mode {
  const value = localStorage.getItem(MODE_KEY)
  if (value === 'text') return 'text'
  return 'visual'
}
