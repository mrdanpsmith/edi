/**
 * The "Edi Guide" help document. Opened in a tab from the Help menu, covering
 * the features that make Edi different from a plain markdown editor. The
 * content lives in `src/docs/guide.md` so it can be edited as markdown.
 */
import guideMarkdown from './docs/guide.md?raw'

export function buildHelpGuideMarkdown(): string {
  return guideMarkdown
}
