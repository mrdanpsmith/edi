import { createPairedDelimiterMark } from './pairedDelimiter'

export const superscript = createPairedDelimiterMark({
  name: 'sup',
  marker: '^',
  charCode: 94,
  seqLength: 1,
  htmlTag: 'sup',
})
