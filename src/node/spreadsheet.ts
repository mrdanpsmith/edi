import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { computeSpreadsheet } from '../spreadsheet'

export const spreadsheetPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('MILKDOWN_SPREADSHEET'),
    view: () => ({
      update: (view) => {
        computeSpreadsheet(view.dom)
      },
    }),
  })
})
