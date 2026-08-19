import { commandsCtx } from '@milkdown/core'
import { markRule } from '@milkdown/prose'
import { toggleMark } from '@milkdown/prose/commands'
import { $command, $inputRule, $markAttr, $markSchema, $remark, $useKeymap } from '@milkdown/utils'
import { classifyCharacter } from 'micromark-util-classify-character'
import { resolveAll } from 'micromark-util-resolve-all'
import { splice } from 'micromark-util-chunked'

interface PairedDelimiterOptions {
  name: string
  marker: string
  charCode: number
  seqLength: number
  htmlTag: string
  shortcuts?: string
}

export function createPairedDelimiterMark({
  name,
  marker,
  charCode,
  seqLength,
  htmlTag,
  shortcuts,
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

  // --- Milkdown components ---
  const attr = $markAttr(name)

  const schema = $markSchema(name, (ctx) => ({
    parseDOM: [{ tag: htmlTag }],
    toDOM: () => [htmlTag, ctx.get(attr.key)],
    parseMarkdown: {
      match: (node) => node.type === name,
      runner: (state, node, markType) => {
        state.openMark(markType)
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === name,
      runner: (state, mark) => {
        state.withMark(mark, name)
      },
    },
  }))

  const cmd = $command(`${name.charAt(0).toUpperCase() + name.slice(1)}Command`, (ctx) => () => {
    return toggleMark(schema.type(ctx))
  })

  const inputRule = $inputRule((ctx) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escaped}{${seqLength}}(.*?)${escaped}{${seqLength}}$`)
    return markRule(pattern, schema.type(ctx))
  })

  const keymap = shortcuts
    ? $useKeymap(`${name}Keymap`, {
        [`Toggle${name.charAt(0).toUpperCase() + name.slice(1)}`]: {
          shortcuts,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          command: (ctx: any) => {
            const commands = ctx.get(commandsCtx)
            return () => commands.call(cmd.key)
          },
        },
      })
    : null

  return {
    remark: $remark(`remark${name.charAt(0).toUpperCase() + name.slice(1)}`, () => remarkPlugin),
    rawRemarkPlugin: remarkPlugin,
    schema,
    command: cmd,
    inputRule,
    keymap,
  }
}
