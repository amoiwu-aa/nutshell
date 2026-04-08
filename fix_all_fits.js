const fs = require('fs')

const safeFitFunc = `
function safeTerminalFit(terminal: any, addon: any, container: HTMLElement | null) {
  try {
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return
    if (terminal?._core?._renderService) {
      if (typeof addon?.fit === 'function') {
        addon.fit()
      }
    }
  } catch(e) {}
}
`

const files = [
  'src/renderer/src/components/workspace/WorkspacePanel.tsx',
  'src/renderer/src/components/terminal/TerminalPanel.tsx',
  'src/renderer/src/components/settings/TerminalDiagnostics.tsx'
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf-8');
  
  // Add safe function if not there
  if (!content.includes('safeTerminalFit')) {
    content = content.replace("import", safeFitFunc + "\nimport");
  }

  // Replace various fit() calls
  content = content.replace(/fitAddon\.fit\(\)/g, "safeTerminalFit(terminalRef.current || terminal, fitAddon, containerRef.current || terminal.element || null)");
  content = content.replace(/fitAddonRef\.current\?\.fit\(\)/g, "safeTerminalFit(terminalRef.current, fitAddonRef.current, containerRef.current || (terminalRef.current?.element) || null)");
  content = content.replace(/try\s*\{\s*fitAddonRef\.current\?\.fit\(\)\s*\}\s*catch\s*\{\s*\}/g, "safeTerminalFit(terminalRef.current, fitAddonRef.current, containerRef.current || (terminalRef.current?.element) || null)");
  content = content.replace(/fit\.fit\(\)/g, "safeTerminalFit(termRef.current || term, fitAddonRef.current || fit, containerRef.current || term.element || null)");
  content = content.replace(/try\s*\{\s*fit\.fit\(\)\s*\}\s*catch\s*\{\s*\}/g, "safeTerminalFit(termRef.current || term, fitAddonRef.current || fit, containerRef.current || term.element || null)");
  content = content.replace(/try\s*\{\s*fitAddon\.fit\(\)\s*\}\s*catch\s*\{\s*\}/g, "safeTerminalFit(terminalRef.current || terminal, fitAddon, containerRef.current || terminal.element || null)");

  fs.writeFileSync(file, content);
}
console.log("Done fixing fits.");
