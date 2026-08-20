import { Plugin, PluginKey } from 'prosemirror-state'
import { computeSpreadsheet } from '../spreadsheet'

export const spreadsheetPlugin = new Plugin({
  key: new PluginKey('EDI_SPREADSHEET'),
  view: () => ({
    update: (view) => {
      computeSpreadsheet(view.dom)
    },
  }),
})
