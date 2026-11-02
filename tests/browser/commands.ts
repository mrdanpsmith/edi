// Server-side Vitest browser commands: raw Playwright mouse and keyboard.
//
// `userEvent` covers clicks, typing and simple hovers, but a drag that has to
// stop part-way (to read the drop line before the release), a press at exact
// page coordinates, or a modifier held across a click needs Playwright's own
// `page.mouse` / `page.keyboard`. Those are trusted input, delivered by the
// browser exactly as a person's would be.
//
// The test page runs inside Vitest's tester iframe, so coordinates the test
// reads with `getBoundingClientRect` are relative to that iframe. Each step is
// translated into top-level page coordinates here, allowing for the iframe's
// offset and any scale the orchestrator applies to fit it.
//
// The client side is `pointer` in `tests/browser/app.ts`.

import type { BrowserCommand } from 'vitest/node'

export type InputStep =
  | { type: 'move'; x: number; y: number; steps?: number }
  | { type: 'down' | 'up'; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'keyDown' | 'keyUp'; key: string }
  | { type: 'pause'; ms: number }

const input: BrowserCommand<[steps: InputStep[]]> = async (context, steps) => {
  if (context.provider.name !== 'playwright') {
    throw new Error(`input is a Playwright command, not ${context.provider.name}`)
  }
  // The provider adds `page`/`frame` to the context; see
  // @vitest/browser-playwright's BrowserCommandContext augmentation.
  const { page } = context as typeof context & { page: import('playwright').Page }
  const frame = await (context as typeof context & {
    frame(): Promise<import('playwright').Frame>
  }).frame()
  const element = await frame.frameElement()
  const box = await element.boundingBox()
  if (!box) throw new Error('the tester iframe has no box')
  const innerWidth = await frame.evaluate(() => window.innerWidth)
  const scale = innerWidth > 0 ? box.width / innerWidth : 1

  for (const step of steps) {
    switch (step.type) {
      case 'move':
        await page.mouse.move(box.x + step.x * scale, box.y + step.y * scale, {
          steps: step.steps ?? 1,
        })
        break
      case 'down':
        await page.mouse.down({ button: step.button ?? 'left' })
        break
      case 'up':
        await page.mouse.up({ button: step.button ?? 'left' })
        break
      case 'wheel':
        await page.mouse.wheel(step.dx, step.dy)
        break
      case 'keyDown':
        await page.keyboard.down(step.key)
        break
      case 'keyUp':
        await page.keyboard.up(step.key)
        break
      case 'pause':
        await new Promise((resolve) => setTimeout(resolve, step.ms))
        break
    }
  }
}

export const browserCommands = { input }
