import { monaco } from './monacoSetup'

// ===== LSP Provider Bridge =====
// Registers Monaco language providers that forward requests to remote LSP servers via IPC.
// Each provider translates between Monaco's API and LSP protocol.

// Map Monaco language IDs to LSP server type
const LANGUAGE_TO_SERVER: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'typescript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  c: 'clangd',
  cpp: 'clangd',
}

interface BridgeConfig {
  sessionId: string
  rootPath: string
}

// Track file versions for didChange
const fileVersions = new Map<string, number>()

function getVersion(uri: string): number {
  const v = (fileVersions.get(uri) || 0) + 1
  fileVersions.set(uri, v)
  return v
}

function fileUri(path: string): string {
  return `file://${path}`
}

// Convert Monaco position to LSP position (0-based)
function toLspPosition(pos: monaco.Position) {
  return { line: pos.lineNumber - 1, character: pos.column - 1 }
}

// Convert LSP position to Monaco position (1-based)
function toMonacoPosition(pos: { line: number; character: number }): monaco.IPosition {
  return { lineNumber: pos.line + 1, column: pos.character + 1 }
}

// Convert LSP range to Monaco range
function toMonacoRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

// Convert LSP CompletionItemKind to Monaco CompletionItemKind
function toMonacoCompletionKind(kind?: number): monaco.languages.CompletionItemKind {
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  }
  return map[kind || 1] || monaco.languages.CompletionItemKind.Text
}

// Convert LSP SymbolKind to Monaco SymbolKind
function toMonacoSymbolKind(kind: number): monaco.languages.SymbolKind {
  // LSP and Monaco SymbolKinds are similar but not identical
  return kind as monaco.languages.SymbolKind
}

// ===== Disposables storage =====
let disposables: monaco.IDisposable[] = []

// ===== Register all providers for a language =====
export function registerLspProviders(config: BridgeConfig, languageId: string): void {
  const serverType = LANGUAGE_TO_SERVER[languageId]
  if (!serverType) return

  const { sessionId, rootPath } = config

  // ===== Completion Provider =====
  disposables.push(monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', ':', '<', '"', "'", '/', '@', '#'],
    provideCompletionItems: async (model, position, context, token) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/completion', {
          textDocument: { uri },
          position: toLspPosition(position),
          context: {
            triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1,
            triggerCharacter: context.triggerCharacter,
          }
        })
        if (!r.success || !r.result) return { suggestions: [] }

        const items = Array.isArray(r.result) ? r.result : (r.result.items || [])
        const suggestions: monaco.languages.CompletionItem[] = items.map((item: any) => {
          const label = typeof item.label === 'string' ? item.label : item.label?.label || ''
          const desc = typeof item.label === 'object' ? item.label?.description : undefined
          return {
            label: desc ? { label, description: desc } : label,
            kind: toMonacoCompletionKind(item.kind),
            detail: item.detail || '',
            documentation: item.documentation
              ? (typeof item.documentation === 'string'
                ? item.documentation
                : { value: item.documentation.value || '' })
              : undefined,
            insertText: item.insertText || (typeof item.label === 'string' ? item.label : item.label?.label || ''),
            insertTextRules: item.insertTextFormat === 2
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            sortText: item.sortText,
            filterText: item.filterText,
            preselect: item.preselect,
            range: item.textEdit?.range ? toMonacoRange(item.textEdit.range) : undefined,
          } as monaco.languages.CompletionItem
        })

        return { suggestions, incomplete: r.result.isIncomplete || false }
      } catch {
        return { suggestions: [] }
      }
    }
  }))

  // ===== Hover Provider =====
  disposables.push(monaco.languages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/hover', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        if (!r.success || !r.result) return null

        const contents: monaco.IMarkdownString[] = []
        const hoverContents = r.result.contents

        if (typeof hoverContents === 'string') {
          contents.push({ value: hoverContents })
        } else if (Array.isArray(hoverContents)) {
          for (const c of hoverContents) {
            if (typeof c === 'string') contents.push({ value: c })
            else contents.push({ value: `\`\`\`${c.language || ''}\n${c.value}\n\`\`\`` })
          }
        } else if (hoverContents?.value) {
          contents.push({ value: hoverContents.value })
        } else if (hoverContents?.language) {
          contents.push({ value: `\`\`\`${hoverContents.language}\n${hoverContents.value}\n\`\`\`` })
        }

        return {
          contents,
          range: r.result.range ? toMonacoRange(r.result.range) : undefined,
        }
      } catch {
        return null
      }
    }
  }))

  // ===== Definition Provider =====
  disposables.push(monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model, position) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/definition', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        if (!r.success || !r.result) return null

        const defs = Array.isArray(r.result) ? r.result : [r.result]
        return defs.map((d: any) => ({
          uri: monaco.Uri.parse(d.uri || d.targetUri || ''),
          range: toMonacoRange(d.range || d.targetRange || d.targetSelectionRange || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
        }))
      } catch {
        return null
      }
    }
  }))

  // ===== References Provider =====
  disposables.push(monaco.languages.registerReferenceProvider(languageId, {
    provideReferences: async (model, position, context) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/references', {
          textDocument: { uri },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        })
        if (!r.success || !r.result) return null

        return r.result.map((ref: any) => ({
          uri: monaco.Uri.parse(ref.uri),
          range: toMonacoRange(ref.range),
        }))
      } catch {
        return null
      }
    }
  }))

  // ===== Document Symbol Provider =====
  disposables.push(monaco.languages.registerDocumentSymbolProvider(languageId, {
    provideDocumentSymbols: async (model) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/documentSymbol', {
          textDocument: { uri },
        })
        if (!r.success || !r.result) return null

        const convert = (items: any[]): monaco.languages.DocumentSymbol[] => {
          return items.map((item: any) => ({
            name: item.name,
            detail: item.detail || '',
            kind: toMonacoSymbolKind(item.kind),
            tags: [],
            range: toMonacoRange(item.range || item.location?.range || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
            selectionRange: toMonacoRange(item.selectionRange || item.range || item.location?.range || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
            children: item.children ? convert(item.children) : [],
          }))
        }

        return convert(r.result)
      } catch {
        return null
      }
    }
  }))

  // ===== Signature Help Provider =====
  disposables.push(monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: async (model, position) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/signatureHelp', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        if (!r.success || !r.result) return null

        return {
          value: {
            signatures: (r.result.signatures || []).map((sig: any) => ({
              label: sig.label,
              documentation: sig.documentation
                ? (typeof sig.documentation === 'string' ? sig.documentation : { value: sig.documentation.value || '' })
                : undefined,
              parameters: (sig.parameters || []).map((p: any) => ({
                label: p.label,
                documentation: p.documentation
                  ? (typeof p.documentation === 'string' ? p.documentation : { value: p.documentation.value || '' })
                  : undefined,
              })),
            })),
            activeSignature: r.result.activeSignature || 0,
            activeParameter: r.result.activeParameter || 0,
          },
          dispose: () => {},
        }
      } catch {
        return null
      }
    }
  }))

  // ===== Rename Provider =====
  disposables.push(monaco.languages.registerRenameProvider(languageId, {
    provideRenameEdits: async (model, position, newName) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/rename', {
          textDocument: { uri },
          position: toLspPosition(position),
          newName,
        })
        if (!r.success || !r.result) return null

        const edits: monaco.languages.WorkspaceEdit = { edits: [] }
        if (r.result.changes) {
          for (const [fileUri, changes] of Object.entries(r.result.changes)) {
            for (const change of changes as any[]) {
              edits.edits.push({
                resource: monaco.Uri.parse(fileUri),
                textEdit: { range: toMonacoRange(change.range), text: change.newText },
                versionId: undefined,
              })
            }
          }
        }
        if (r.result.documentChanges) {
          for (const docChange of r.result.documentChanges) {
            if (docChange.edits) {
              for (const edit of docChange.edits) {
                edits.edits.push({
                  resource: monaco.Uri.parse(docChange.textDocument.uri),
                  textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
                  versionId: undefined,
                })
              }
            }
          }
        }

        return edits
      } catch {
        return null
      }
    },
    resolveRenameLocation: async (model, position) => {
      try {
        const uri = fileUri(model.uri.path || model.uri.toString())
        const r = await window.api.lsp.request(sessionId, serverType, 'textDocument/prepareRename', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        if (!r.success || !r.result) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '' }

        const range = r.result.range ? toMonacoRange(r.result.range) : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
        const text = r.result.placeholder || model.getValueInRange(range)
        return { range, text }
      } catch {
        return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '' }
      }
    }
  }))
}

// ===== File sync helpers =====
export function notifyFileOpen(sessionId: string, filePath: string, languageId: string, content: string): void {
  const serverType = LANGUAGE_TO_SERVER[languageId]
  if (!serverType) return
  const uri = fileUri(filePath)
  const version = getVersion(uri)
  window.api.lsp.didOpen(sessionId, serverType, uri, languageId, version, content).catch(() => {})
}

export function notifyFileChange(sessionId: string, filePath: string, languageId: string, content: string): void {
  const serverType = LANGUAGE_TO_SERVER[languageId]
  if (!serverType) return
  const uri = fileUri(filePath)
  const version = getVersion(uri)
  window.api.lsp.didChange(sessionId, serverType, uri, version, content).catch(() => {})
}

export function notifyFileClose(sessionId: string, filePath: string, languageId: string): void {
  const serverType = LANGUAGE_TO_SERVER[languageId]
  if (!serverType) return
  window.api.lsp.didClose(sessionId, serverType, fileUri(filePath)).catch(() => {})
  fileVersions.delete(fileUri(filePath))
}

export function notifyFileSave(sessionId: string, filePath: string, languageId: string, content: string): void {
  const serverType = LANGUAGE_TO_SERVER[languageId]
  if (!serverType) return
  window.api.lsp.didSave(sessionId, serverType, fileUri(filePath), content).catch(() => {})
}

// ===== Cleanup =====
export function disposeAllProviders(): void {
  for (const d of disposables) d.dispose()
  disposables = []
  fileVersions.clear()
}
