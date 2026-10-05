/**
 * Unicode emoji data for the `:` autocomplete.
 *
 * The names come from the `unicode-emoji-json` package (CLDR names, in the
 * package's canonical order). A small curated alias map adds the short forms
 * people actually type in chat clients (`:smile`, `:+1`, `:tada`) that the
 * CLDR names do not carry.
 */
import byEmoji from 'unicode-emoji-json/data-by-emoji.json'

export interface EmojiEntry {
  name: string
  emoji: string
  keywords: string[]
}

interface RawEmoji {
  name: string
}

/**
 * Common aliases, keyed by the emoji itself. Only the short forms that are not
 * already a word of the CLDR name — `grinning face` is searchable as typed.
 */
const ALIASES: Record<string, string[]> = {
  '😀': ['grinning', 'grin', 'happy', 'smile'],
  '😄': ['smile', 'happy', 'joy'],
  '😁': ['grin', 'happy'],
  '😂': ['laugh', 'lol', 'joy', 'tears'],
  '🤣': ['laugh', 'lol', 'rofl'],
  '🙂': ['smile'],
  '😉': ['wink'],
  '😊': ['smile', 'blush'],
  '😍': ['love', 'heart_eyes'],
  '😘': ['kiss'],
  '😎': ['cool', 'sunglasses'],
  '🤔': ['thinking', 'hmm'],
  '🤨': ['raised_eyebrow', 'skeptical'],
  '😐': ['neutral'],
  '😴': ['sleep', 'zzz'],
  '😭': ['cry', 'sob'],
  '😢': ['cry', 'sad'],
  '😱': ['scream', 'shock'],
  '😡': ['angry', 'rage'],
  '🥳': ['party', 'celebrate'],
  '🤯': ['mind_blown', 'shocked'],
  '🤩': ['star_struck'],
  '🤗': ['hug'],
  '🤫': ['shush', 'quiet'],
  '🤭': ['giggle'],
  '😇': ['angel', 'innocent'],
  '🥺': ['pleading', 'please'],
  '🫡': ['salute'],
  '🙃': ['upside_down'],
  '💀': ['skull', 'dead'],
  '👻': ['ghost'],
  '👽': ['alien'],
  '🤖': ['robot'],
  '💩': ['poop', 'shit'],
  '🤡': ['clown'],
  '🙈': ['see_no_evil'],
  '🙉': ['hear_no_evil'],
  '🙊': ['speak_no_evil'],
  '😺': ['cat'],
  '🐶': ['dog', 'puppy'],
  '🐱': ['cat', 'kitten'],
  '🦊': ['fox'],
  '🐻': ['bear'],
  '🐼': ['panda'],
  '🦁': ['lion'],
  '🐯': ['tiger'],
  '🦄': ['unicorn'],
  '🐔': ['chicken'],
  '🐧': ['penguin'],
  '🐸': ['frog'],
  '🐢': ['turtle'],
  '🐍': ['snake'],
  '🐝': ['bee'],
  '🦋': ['butterfly'],
  '🐞': ['bug', 'ladybug'],
  '❤️': ['heart', 'love', 'red_heart'],
  '🧡': ['heart', 'orange_heart'],
  '💛': ['heart', 'yellow_heart'],
  '💚': ['heart', 'green_heart'],
  '💙': ['heart', 'blue_heart'],
  '💜': ['heart', 'purple_heart'],
  '🖤': ['heart', 'black_heart'],
  '🤍': ['heart', 'white_heart'],
  '💔': ['broken_heart'],
  '💕': ['hearts', 'love'],
  '💯': ['100', 'hundred', 'perfect'],
  '🔥': ['fire', 'lit'],
  '✨': ['sparkles', 'shiny'],
  '⭐': ['star'],
  '🌟': ['star', 'glow'],
  '⚡': ['zap', 'lightning', 'bolt'],
  '💥': ['boom', 'explosion'],
  '🎉': ['tada', 'party', 'celebrate'],
  '🎊': ['confetti'],
  '🎁': ['gift', 'present'],
  '🏆': ['trophy', 'win'],
  '🥇': ['medal', 'gold', 'first'],
  '✅': ['check', 'done', 'white_check_mark'],
  '☑️': ['check', 'checkbox'],
  '❌': ['x', 'cross', 'no'],
  '❎': ['x', 'negative'],
  '⚠️': ['warning', 'warn'],
  '🚨': ['rotating_light', 'alert'],
  '⛔': ['no_entry'],
  '🚫': ['no', 'forbidden'],
  '👍': ['thumbsup', '+1', 'up', 'approve'],
  '👎': ['thumbsdown', '-1', 'down', 'disapprove'],
  '👏': ['clap', 'applause'],
  '🙌': ['raise_hands', 'hooray'],
  '🙏': ['pray', 'thanks', 'please'],
  '👋': ['wave', 'hi', 'hello'],
  '🤝': ['handshake', 'deal'],
  '💪': ['muscle', 'strong'],
  '👀': ['eyes', 'look'],
  '🧠': ['brain'],
  '💡': ['bulb', 'idea'],
  '🔔': ['bell', 'notification'],
  '🔒': ['lock', 'secure'],
  '🔓': ['unlock'],
  '🔑': ['key'],
  '🛠️': ['tools'],
  '🔧': ['wrench', 'fix'],
  '🐛': ['bug'],
  '💻': ['computer', 'laptop', 'code'],
  '🖥️': ['desktop', 'computer'],
  '📱': ['phone', 'mobile'],
  '⌨️': ['keyboard'],
  '🗑️': ['trash', 'delete'],
  '📝': ['memo', 'note', 'write'],
  '📌': ['pin', 'pushpin'],
  '📎': ['paperclip', 'attach'],
  '📅': ['calendar', 'date'],
  '⏰': ['alarm', 'clock'],
  '⌛': ['hourglass', 'time'],
  '⏳': ['hourglass', 'loading'],
  '🚀': ['rocket', 'ship', 'launch'],
  '🛑': ['stop'],
  '▶️': ['play'],
  '⏸️': ['pause'],
  '🔄': ['refresh', 'reload'],
  '🔗': ['link'],
  '📦': ['package', 'box'],
  '🗂️': ['files', 'folder'],
  '📁': ['folder'],
  '📄': ['document', 'page'],
  '☕': ['coffee', 'tea'],
  '🍺': ['beer'],
  '🍻': ['beers', 'cheers'],
  '🍕': ['pizza'],
  '🍔': ['burger'],
  '🍟': ['fries'],
  '🍰': ['cake', 'dessert'],
  '🎂': ['cake', 'birthday'],
  '🍎': ['apple'],
  '🍌': ['banana'],
  '🌈': ['rainbow'],
  '☀️': ['sun', 'sunny'],
  '🌙': ['moon', 'night'],
  '☁️': ['cloud'],
  '❄️': ['snow', 'snowflake'],
  '🌧️': ['rain'],
  '🌊': ['wave', 'ocean'],
  '🌍': ['earth', 'globe', 'world'],
  '🏠': ['home', 'house'],
  '🚗': ['car'],
  '✈️': ['plane', 'flight'],
  '🛰️': ['satellite'],
  '🧪': ['test', 'experiment'],
  '🔬': ['microscope', 'science'],
  '🎯': ['target', 'dart'],
  '🎨': ['art', 'palette'],
  '🎵': ['music', 'note'],
  '🏁': ['flag', 'finish'],
  '🚩': ['flag'],
  '🍀': ['clover', 'luck'],
}

function keywordsFor(emoji: string): string[] {
  return ALIASES[emoji] ?? []
}

/** Every emoji, in the package's canonical (CLDR, frequency-ish) order. */
export const EMOJI_ENTRIES: EmojiEntry[] = Object.keys(byEmoji).map((emoji) => ({
  emoji,
  name: (byEmoji as Record<string, RawEmoji>)[emoji]!.name,
  keywords: keywordsFor(emoji),
}))

/**
 * Emoji matching `query`, best match first, capped at `limit`. Scoring mirrors
 * `matchFunctions`: a name prefix beats a keyword prefix beats a name substring
 * beats a keyword substring; ties keep the canonical order. An empty query is
 * the familiar head of the list (the smileys), not alphabetical noise.
 */
export function matchEmoji(
  entries: readonly EmojiEntry[],
  query: string,
  limit = 10,
): EmojiEntry[] {
  const needle = query.toLowerCase()
  if (needle === '') return entries.slice(0, limit)
  return entries
    .map((entry, order) => ({ entry, order, score: matchScore(entry, needle) }))
    .filter((row): row is { entry: EmojiEntry; order: number; score: number } => row.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((row) => row.entry)
}

function matchScore(entry: EmojiEntry, needle: string): number | null {
  const name = entry.name.toLowerCase()
  if (name.startsWith(needle)) return 0
  if (entry.keywords.some((keyword) => keyword.startsWith(needle))) return 1
  if (name.includes(needle)) return 2
  if (entry.keywords.some((keyword) => keyword.includes(needle))) return 3
  return null
}
