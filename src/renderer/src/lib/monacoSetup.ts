import * as monaco from 'monaco-editor'

try {
  // @ts-ignore - Monaco worker setup using Vite's new URL pattern
  self.MonacoEnvironment = {
    getWorker(_: any, label: string) {
      if (label === 'json') {
        return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' })
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' })
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' })
      }
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' })
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' })
    }
  }
} catch (err) {
  console.error('Monaco setup failed:', err)
}

export { monaco }
