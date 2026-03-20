import type { Terminal } from '@xterm/xterm'

function decodeBase64Utf8(input: string): string {
  const normalized = input.replace(/\s+/g, '')
  const binary = window.atob(normalized)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseOsc52Data(data: string): string | null {
  const parts = data.split(';')
  if (parts.length < 2) return null

  const payload = parts.slice(1).join(';').trim()
  if (!payload || payload === '?') return null

  try {
    return decodeBase64Utf8(payload)
  } catch {
    return null
  }
}

export function registerOsc52ClipboardHandler(
  terminal: Terminal,
  options: {
    enabled: boolean
    onCopy?: (text: string) => void
  }
): () => void {
  const parser = terminal.parser
  const disposable = parser.registerOscHandler(52, (data) => {
    if (!options.enabled) return true

    const text = parseOsc52Data(data)
    if (!text) return true

    window.api.clipboard.writeText(text)
    options.onCopy?.(text)
    return true
  })

  return () => {
    disposable.dispose()
  }
}
