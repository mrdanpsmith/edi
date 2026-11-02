// The encrypt and unlock dialogs (`src/crypto-dialog.ts`) and the encrypted
// block they guard, driven with the real mouse and keyboard.
//
// `src/crypto-dialog.test.ts` checks the dialogs' logic in jsdom. These go the
// whole way a reader does: a right-click on the block, the context menu, the
// password typed into fields found by their labels (which were not associated
// with them), Web Crypto in a real engine, and the reveal that results.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, center, pointer, waitFor, type BootedApp } from './app'
import {
  BLOCK_PASSWORD,
  blockWith,
  contextMenuItem,
  encryptBlock,
  press,
  revealedText,
  type,
} from './edit-helpers'

let app: BootedApp

beforeEach(async () => {
  app = bootApp()
  await app.setDocument('Opening the door.\n\nThe window.\n\nThe end.\n')
})

afterEach(() => app.dispose())

const dialog = (): HTMLElement | null => document.querySelector('.edi-dialog')

/** Press the encrypted block's own Lock/Unlock button with the real mouse. */
async function pressLockButton(): Promise<void> {
  const block = app.editor.querySelector('.encrypted-block')!
  await pointer.move(center(block))
  const button = block.querySelector<HTMLElement>(':scope > .block-controls .block-control-interaction')
    ?? block.querySelector<HTMLElement>('.block-control-interaction')!
  await waitFor(() => getComputedStyle(button.closest('.block-control-pill')!).opacity === '1', {
    message: 'the cluster never showed',
  })
  await pointer.press(center(button))
}

it('encrypting a block takes the plaintext out of the saved markdown', async () => {
  await encryptBlock(app, 'Opening the door.')
  expect(revealedText(app)).toEqual(['Opening the door.'])
  const saved = app.markdown()
  expect(saved).not.toContain('Opening the door.')
  expect(saved).toContain('The window.')
})

it('mismatched passwords are refused in place, and the confirm field is cleared', async () => {
  await contextMenuItem(blockWith(app, 'The window.'), 'Encrypt…')
  await page.getByLabelText('Password', { exact: true }).fill('one password')
  await page.getByLabelText('Confirm password', { exact: true }).fill('another one')
  await page.getByRole('dialog').getByRole('button', { name: 'Encrypt', exact: true }).click()
  await expect.element(page.getByText('Passwords do not match')).toBeVisible()
  await expect.element(page.getByLabelText('Confirm password', { exact: true })).toHaveValue('')
  await expect.element(page.getByLabelText('Confirm password', { exact: true })).toHaveFocus()
  expect(app.editor.querySelector('.encrypted-block')).toBeNull()
})

it('Escape cancels the encrypt dialog and leaves the block as it was', async () => {
  await contextMenuItem(blockWith(app, 'The end.'), 'Encrypt…')
  await expect.element(page.getByLabelText('Password', { exact: true })).toBeVisible()
  await page.getByLabelText('Password', { exact: true }).click()
  await press('Escape')
  await waitFor(() => dialog() === null, { message: 'Escape never closed the dialog' })
  expect(app.markdown()).toContain('The end.')
  expect(app.editor.querySelector('.encrypted-block')).toBeNull()
})

it('Lock hides the text; Unlock asks for the password, refuses a wrong one, then reveals', async () => {
  await encryptBlock(app, 'The window.')
  await pressLockButton()
  await waitFor(() => revealedText(app).length === 0, { message: 'Lock never locked' })
  expect(app.editor.textContent).not.toContain('The window.')

  await pressLockButton()
  await expect.element(page.getByText('Show encrypted block', { exact: true })).toBeVisible()
  const password = page.getByLabelText('Password', { exact: true })
  await expect.element(password).toHaveFocus()
  await type('not it{Enter}')
  await waitFor(() => (dialog()?.querySelector('.edi-dialog-error:not([hidden])')?.textContent ?? '') !== '', {
    message: 'a wrong password was not refused',
  })
  expect(revealedText(app)).toEqual([])

  await password.fill(BLOCK_PASSWORD)
  await press('Enter')
  await waitFor(() => revealedText(app).includes('The window.'), {
    timeout: 20_000,
    message: 'the right password never revealed the block',
  })
  expect(dialog()).toBeNull()
})

it('Show in the password field shows the typed password, and Hide masks it again', async () => {
  await encryptBlock(app, 'The window.')
  await pressLockButton()
  await waitFor(() => revealedText(app).length === 0, { message: 'Lock never locked' })
  await pressLockButton()
  const password = page.getByLabelText('Password', { exact: true })
  await expect.element(password).toHaveFocus()
  await type('secret')
  const input = password.element() as HTMLInputElement
  expect(input.type).toBe('password')
  await page.getByRole('button', { name: 'Show', exact: true }).click()
  expect(input.type).toBe('text')
  // The toggle hands the focus straight back, so typing carries on.
  expect(document.activeElement).toBe(input)
  await page.getByRole('button', { name: 'Hide', exact: true }).click()
  expect(input.type).toBe('password')
})
