import { StreamLanguage } from '@codemirror/language'

// Syntax highlighting for `edi-formula` definition blocks — the language of
// `code_block`s tagged `edi-formula`. One `NAME(params) = expression` per line,
// `#` starts a comment (outside string literals), and strings are
// double-quoted with doubled quotes (`""`) as the escape.
//
// There is no external grammar for the DSL, so this is a purpose-built
// `StreamLanguage`. The style names (`keyword`, `variableName`, …) resolve to
// lezer tags via the shared default token table, then render with the same
// `highlight` style used by source mode.
export const ediFormulaLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null

    // Double-quoted string, `""` doubles as an escaped quote. A literal is
    // line-local: the DSL treats an unclosed quote as an error to end-of-line.
    if (stream.eat('"')) {
      stream.match(/^(?:[^"]|"")*/, true)
      if (stream.peek() === '"') stream.eat('"')
      else stream.skipToEnd()
      return 'string'
    }

    if (stream.peek() === '#') {
      stream.skipToEnd()
      return 'comment'
    }

    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      // `NAME(` in a definition header or a call reads as a function name;
      // TRUE/FALSE are literals; any other bare identifier is a parameter.
      if (stream.peek() === '(') return 'keyword'
      const current = stream.current()
      if (current === 'TRUE' || current === 'FALSE') return 'atom'
      return 'variableName'
    }

    if (stream.match(/^[+\-*/<>=^]/, true)) return 'operator'
    if (stream.match(/^[(),]/, true)) return 'meta'

    stream.next()
    return null
  },
})