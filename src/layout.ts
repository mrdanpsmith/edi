const PREVIEW_VISIBLE_KEY = 'edi.previewVisible'
const EDITOR_VISIBLE_KEY = 'edi.editorVisible'
const PREVIEW_RATIO_KEY = 'edi.previewRatio'

const DEFAULT_PREVIEW_RATIO = 0.42

export class SplitLayout {
  private previewVisible: boolean
  private editorVisible: boolean
  private previewRatio: number
  private dragging = false

  constructor(
    private workspace: HTMLElement,
    private editorPane: HTMLElement,
    private previewPane: HTMLElement,
    private divider: HTMLElement,
  ) {
    this.previewVisible = readBool(PREVIEW_VISIBLE_KEY, true)
    this.editorVisible = readBool(EDITOR_VISIBLE_KEY, true)
    this.previewRatio = readRatio(PREVIEW_RATIO_KEY)
    this.ensureOnePaneVisible()

    this.divider.addEventListener('mousedown', this.onDragStart)
    this.divider.addEventListener('dblclick', () => this.togglePreview())
    this.applyVisibility()
  }

  private onDragStart = (event: MouseEvent) => {
    event.preventDefault()
    this.dragging = true
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', this.onDragMove)
    window.addEventListener('mouseup', this.onDragEnd)
  }

  private onDragMove = (event: MouseEvent) => {
    if (!this.dragging) {
      return
    }
    const rect = this.workspace.getBoundingClientRect()
    const editorWidth = event.clientX - rect.left
    const ratio = clamp(editorWidth / rect.width, 0.2, 0.8)
    this.previewRatio = 1 - ratio
    this.applyGridColumns()
    localStorage.setItem(PREVIEW_RATIO_KEY, String(this.previewRatio))
  }

  private onDragEnd = () => {
    this.dragging = false
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', this.onDragMove)
    window.removeEventListener('mouseup', this.onDragEnd)
  }

  isPreviewVisible(): boolean {
    return this.previewVisible
  }

  togglePreview(): void {
    this.setPreviewVisible(!this.previewVisible)
  }

  setPreviewVisible(visible: boolean): void {
    this.previewVisible = visible
    if (!visible && !this.editorVisible) {
      this.editorVisible = true
      localStorage.setItem(EDITOR_VISIBLE_KEY, 'true')
    }
    localStorage.setItem(PREVIEW_VISIBLE_KEY, String(visible))
    this.applyVisibility()
  }

  isEditorVisible(): boolean {
    return this.editorVisible
  }

  toggleEditor(): void {
    this.setEditorVisible(!this.editorVisible)
  }

  setEditorVisible(visible: boolean): void {
    this.editorVisible = visible
    if (!visible && !this.previewVisible) {
      this.previewVisible = true
      localStorage.setItem(PREVIEW_VISIBLE_KEY, 'true')
    }
    localStorage.setItem(EDITOR_VISIBLE_KEY, String(visible))
    this.applyVisibility()
  }

  private ensureOnePaneVisible(): void {
    if (!this.editorVisible && !this.previewVisible) {
      this.previewVisible = true
      localStorage.setItem(PREVIEW_VISIBLE_KEY, 'true')
    }
  }

  private applyVisibility(): void {
    const previewVisible = this.previewVisible
    const editorVisible = this.editorVisible
    this.previewPane.hidden = !previewVisible
    this.editorPane.hidden = !editorVisible
    this.divider.hidden = !previewVisible || !editorVisible
    this.workspace.classList.toggle('preview-hidden', !previewVisible)
    this.workspace.classList.toggle('editor-hidden', !editorVisible)
    this.applyGridColumns()
  }

  private applyGridColumns(): void {
    if (this.editorVisible && this.previewVisible) {
      const editor = Math.round((1 - this.previewRatio) * 100)
      const preview = 100 - editor
      this.workspace.style.gridTemplateColumns = `${editor}fr 5px ${preview}fr`
    } else if (this.editorVisible) {
      this.workspace.style.gridTemplateColumns = '1fr 0px 0px'
    } else if (this.previewVisible) {
      this.workspace.style.gridTemplateColumns = '0px 0px 1fr'
    } else {
      this.workspace.style.gridTemplateColumns = '0px 0px 0px'
    }
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}

function readRatio(key: string): number {
  const value = Number.parseFloat(localStorage.getItem(key) ?? '')
  return Number.isFinite(value) ? clamp(value, 0.2, 0.8) : DEFAULT_PREVIEW_RATIO
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
