import { createPairedDelimiterMark } from './pairedDelimiter'

export const highlight = createPairedDelimiterMark({
  name: 'highlight',
  marker: '=',
  charCode: 61,
  seqLength: 2,
  htmlTag: 'mark',
  shortcuts: 'Mod-Shift-h',
})
