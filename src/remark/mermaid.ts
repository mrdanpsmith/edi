import { visit } from 'unist-util-visit'

/**
 * A ```mermaid fence, as mdast.
 *
 * This lives beside the other remark extensions rather than in the node view
 * because it is the *only* thing `src/markdown.ts` needs from a diagram: the
 * markdown pipeline used to import `src/node/mermaid.ts` for this plugin, and
 * that put the whole rendering stack — the visual-editing layer, the diagram
 * session, the control cluster — behind every markdown conversion, in a cycle
 * that reaches straight back into `src/block-modes.ts`. A mode registry that a
 * node view fills in at import time cannot survive a cycle through the module
 * that owns it, so the edge that made the cycle is gone.
 */
export const MERMAID_TYPE = 'mermaid_block'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remarkPlugin(this: any) {
  const data = this.data()
  if (!data.micromarkExtensions) data.micromarkExtensions = []
  if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = []
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = []

  data.fromMarkdownExtensions.push({
    transforms: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tree: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        visit(tree, 'code', (node: any, index: number | undefined, parent: any) => {
          if (index !== undefined && node.lang === 'mermaid') {
            parent.children[index] = {
              type: MERMAID_TYPE,
              value: node.value ?? '',
              position: node.position,
            }
          }
        })
      },
    ],
  })

  data.toMarkdownExtensions.push({
    handlers: {
      [MERMAID_TYPE]: (
        node: { value?: string },
        _: unknown,
        state: { enter: (t: string) => () => void },
        info: unknown,
      ) => {
        const exit = state.enter('code')
        void info
        exit()
        return `\`\`\`mermaid\n${node.value ?? ''}\n\`\`\`\n`
      },
    },
  })
}
