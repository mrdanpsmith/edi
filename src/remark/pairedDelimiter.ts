import { toggleMark } from 'prosemirror-commands'
import { InputRule } from 'prosemirror-inputrules'
import type { MarkType, Schema } from 'prosemirror-model'
import { classifyCharacter } from 'micromark-util-classify-character'
import { resolveAll } from 'micromark-util-resolve-all'
import { splice } from 'micromark-util-chunked'

interface PairedDelimiterOptions {
  name: string
  marker: string
  charCode: number
  seqLength: number
  htmlTag: string
}

export function createPairedDelimiterMark({
  name,
  marker,
  charCode,
  seqLength,
  htmlTag,
}: PairedDelimiterOptions) {
  const seqType = `${name}SequenceTemporary`
  const resolvedType = `${name}Sequence`
  const textType = `${name}Text`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extension(): any {
    const tokenizer = {
      name,
      tokenize: tokenizePair,
      resolveAll: resolvePair,
    }
    return {
      text: { [charCode]: tokenizer },
      insideSpan: { null: [tokenizer] },
      attentionMarkers: { null: [charCode] },
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolvePair(events: any[], context: any): any[] {
    let index = -1
    while (++index < events.length) {
      const ev = events[index]
      if (ev[0] === 'enter' && ev[1].type === seqType && ev[1]._close) {
        let open = index
        while (open--) {
          const openEv = events[open]
          if (
            openEv[0] === 'exit' &&
            openEv[1].type === seqType &&
            openEv[1]._open &&
            ev[1].end.offset - ev[1].start.offset === openEv[1].end.offset - openEv[1].start.offset
          ) {
            ev[1].type = resolvedType
            openEv[1].type = resolvedType

            const wrapper = { type: name, start: { ...openEv[1].start }, end: { ...ev[1].end } }
            const txt = { type: textType, start: { ...openEv[1].end }, end: { ...ev[1].start } }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nextEvents: any[] = [
              ['enter', wrapper, context],
              ['enter', openEv[1], context],
              ['exit', openEv[1], context],
              ['enter', txt, context],
            ]

            const insideSpan = context.parser.constructs.insideSpan?.null
            if (insideSpan) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context))
            }

            splice(nextEvents, nextEvents.length, 0, [
              ['exit', txt, context],
              ['enter', ev[1], context],
              ['exit', ev[1], context],
              ['exit', wrapper, context],
            ])
            splice(events, open - 1, index - open + 3, nextEvents)
            index = open + nextEvents.length - 2
            break
          }
        }
      }
    }
    index = -1
    while (++index < events.length) {
      const ev = events[index]
      if (ev[1]?.type === seqType) {
        ev[1].type = 'data'
      }
    }
    return events
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tokenizePair(this: any, effects: any, ok: any, nok: any) {
    const previous = this.previous
    const events = this.events
    let size = 0
    return start

    function start(code: number | null) {
      if (previous === charCode && events[events.length - 1]?.[1]?.type !== 'characterEscape') {
        return nok(code)
      }
      effects.enter(seqType)
      return more(code)
    }

    function more(code: number | null) {
      const before = classifyCharacter(previous)
      if (code === charCode) {
        if (size >= seqLength) return nok(code)
        effects.consume(code)
        size++
        return more
      }
      if (size < seqLength) return nok(code)
      const token = effects.exit(seqType)
      const after = classifyCharacter(code!)
      token._open = !after || (after === 2 && Boolean(before))
      token._close = !before || (before === 2 && Boolean(after))
      return ok(code)
    }
  }

  // --- remark plugin ---
  function remarkPlugin() {
    // @ts-expect-error -- remark `this` typing
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const data = self.data()
    if (!data.micromarkExtensions) data.micromarkExtensions = []
    if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = []
    if (!data.toMarkdownExtensions) data.toMarkdownExtensions = []
    data.micromarkExtensions.push(extension())
    data.fromMarkdownExtensions.push({
      canContainEols: [name],
      enter: { [name]: enterNode },
      exit: { [name]: exitNode },
    })
    data.toMarkdownExtensions.push({
      unsafe: [{ character: marker, inConstruct: 'phrasing' }],
      handlers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [name]: (node: any, _: any, state: any, info: any) => {
          const tracker = state.createTracker(info)
          const exit = state.enter(name)
          let value = tracker.move(marker.repeat(seqLength))
          value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: marker })
          value += tracker.move(marker.repeat(seqLength))
          exit()
          return value
        },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function enterNode(this: any, token: any) {
      this.enter({ type: name, children: [] }, token)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function exitNode(this: any, token: any) {
      this.exit(token)
    }
  }

  // --- ProseMirror mark spec ---
  function markSpec() {
    return {
      parseDOM: [{ tag: htmlTag }],
      toDOM() {
        return [htmlTag, 0]
      },
    }
  }

  // --- Toggle command ---
  function createToggleCommand(schema: Schema) {
    const markType = schema.marks[name]
    return toggleMark(markType)
  }

  // --- Input rule ---
  function createInputRule(schema: Schema) {
    const markType: MarkType = schema.marks[name]
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escaped}{${seqLength}}(.*?)${escaped}{${seqLength}}$`)
    return new InputRule(pattern, (state, match, start, end) => {
      const tr = state.tr
      if (match[1]) {
        tr.replaceWith(start, end, state.schema.text(match[1], [markType.create()]))
      }
      return tr
    })
  }

  return {
    remarkPlugin,
    rawRemarkPlugin: remarkPlugin,
    markSpec,
    createToggleCommand,
    createInputRule,
  }
}
