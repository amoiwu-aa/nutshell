const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ts = require('typescript')

function loadTsModule(filePath, replacements, mocks) {
  let source = fs.readFileSync(filePath, 'utf8')
  for (const [from, to] of replacements) source = source.replace(from, to)
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filePath
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    require,
    __dirname: path.dirname(filePath),
    __filename: filePath,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    global: { __mocks: mocks }
  }
  vm.runInNewContext(compiled, sandbox, { filename: filePath })
  return module.exports
}

async function main() {
  const handlers = {}
  const calls = []

  const { registerPortForwardHandlers } = loadTsModule(
    path.resolve('src/main/ipc/portForwardHandlers.ts'),
    [
      ["import { ipcMain } from 'electron'", "const { ipcMain } = global.__mocks.electron"],
      ["import { portForwardManager } from '../ssh/PortForward'", "const { portForwardManager } = global.__mocks"],
      ["import { rustCoreService } from '../rust/RustCoreService'", "const { rustCoreService } = global.__mocks"]
    ],
    {
      electron: {
        ipcMain: {
          handle: (name, fn) => { handlers[name] = fn }
        }
      },
      portForwardManager: {
        createForward: async (rule) => { calls.push(['node-create', rule.id]) },
        removeForward: (id) => { calls.push(['node-remove', id]) },
        listForwards: (sessionId) => { calls.push(['node-list', sessionId]); return [] }
      },
      rustCoreService: {
        hasSshSession: (sessionId) => sessionId === 'rust-session',
        createPortForward: async (rule) => { calls.push(['rust-create', rule.id, rule.type]) },
        removePortForward: async (ruleId) => { calls.push(['rust-remove', ruleId]) },
        listPortForwards: async (sessionId) => {
          calls.push(['rust-list', sessionId])
          return { rules: [{ id: 'pf-1', connectionId: sessionId, type: 'local', localHost: '127.0.0.1', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, enabled: true }] }
        }
      }
    }
  )

  registerPortForwardHandlers()

  const rule = { id: 'pf-1', connectionId: 'rust-session', type: 'local', localHost: '127.0.0.1', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, enabled: true }
  const createResult = await handlers['portForward:create']({}, rule)
  const listResult = await handlers['portForward:list']({}, 'rust-session')
  const removeResult = await handlers['portForward:remove']({}, 'pf-1')

  console.log(JSON.stringify({ createResult, listResult, removeResult, calls }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
