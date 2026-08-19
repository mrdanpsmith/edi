import { createPairedDelimiterMark } from './pairedDelimiter'

export const subscript = createPairedDelimiterMark({
  name: 'sub',
  marker: '~',
  charCode: 126,
  seqLength: 1,
  htmlTag: 'sub',
})
