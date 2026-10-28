import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// One-time asset build on a development computer. The Pi serves the generated
// icons.js directly and does not need npm or this script at runtime.
const names = [
  'activity', 'alert-circle', 'alert-triangle', 'arrow-left', 'arrow-right', 'arrow-up-right',
  'bell', 'bluetooth', 'boxes', 'check', 'check-circle-2', 'chevron-down',
  'chevron-left', 'chevron-right', 'circle-help', 'code-2', 'command', 'copy',
  'cpu', 'database', 'download', 'ellipsis', 'external-link', 'file',
  'file-plus', 'file-text', 'files', 'filter', 'folder', 'folder-plus',
  'git-branch', 'hard-drive', 'info', 'layout-dashboard', 'list', 'loader-circle',
  'log-out', 'maximize', 'menu', 'memory-stick', 'minimize', 'moon', 'network',
  'pause', 'pencil', 'play', 'plus', 'power', 'refresh-cw', 'rocket', 'search',
  'server-cog', 'settings-2', 'shield-check', 'sort-asc', 'sun', 'terminal-square',
  'thermometer', 'trash-2', 'upload', 'users', 'wifi', 'wifi-off', 'x',
]

const packageDir = resolve('.assetcache/node_modules/lucide-static')
const icons = {}
for (const name of names) {
  const svg = readFileSync(resolve(packageDir, 'icons', `${name}.svg`), 'utf8')
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)
  if (!match) throw new Error(`Bad SVG: ${name}`)
  icons[name] = match[1].replace(/\s+/g, ' ').trim()
}
writeFileSync('web/icons.js', `// Generated from lucide-static (ISC license).\nconst paths = ${JSON.stringify(icons)};\nexport function icon(name, size=18) { const content=paths[name] || paths['circle-help']; return '<svg class="icon" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+content+'</svg>'; }\n`)
writeFileSync('web/vendor/lucide-LICENSE', readFileSync(resolve(packageDir, 'LICENSE')))
console.log(`Generated ${names.length} icons`)
