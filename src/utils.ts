export function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      default:
        return '&amp;'
    }
  })
}
