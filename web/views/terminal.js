import { icon, esc, pageIntro, errorBox } from '../util.js'
import { loadVendorScript } from '../vendor-loader.js'
function terminalTheme() { return document.documentElement.dataset.theme === 'light' ? { background: '#F7F9FC', foreground: '#19202D', cursor: '#4565D9', selectionBackground: '#BBC9FA' } : { background: '#0D1118', foreground: '#E8ECF4', cursor: '#8FA3FF', selectionBackground: '#344164' } }

export async function mountTerminal(page, ctx) {
  page.innerHTML = `${pageIntro('Terminal', 'A real shell on your Raspberry Pi.')}<section class="panel">Loading terminal…</section>`
  if (!document.querySelector('link[href="/vendor/xterm.css"]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/vendor/xterm.css'; document.head.append(link) }
  try { await loadVendorScript('/vendor/xterm.js'); await loadVendorScript('/vendor/addon-fit.js') }
  catch (error) { page.innerHTML = errorBox(error.message); return }
  if (!page.isConnected) return
  const sessions = new Map()
  let nextID = 1, activeID = null, size = Number(localStorage.getItem('piforge.terminalFontSize')) || 13
  page.innerHTML = `<div class="terminal-page"><div class="page-intro"><div><h1>Terminal</h1><p>Commands run as your PiForge service account on the Raspberry Pi.</p></div><div class="page-action"><button class="button secondary" data-action="new">${icon('plus', 16)} New session</button><button class="icon-button" data-action="fullscreen" aria-label="Toggle fullscreen">${icon('maximize', 18)}</button></div></div><div class="terminal-frame"><div class="terminal-tabs" id="terminal-tabs"></div><div class="terminal-tools"><span id="terminal-status" class="status-pill is-muted"><span class="status-dot"></span>Connecting</span><div><button class="icon-button" data-action="smaller" title="Smaller font">A−</button><button class="icon-button" data-action="larger" title="Larger font">A+</button><button class="icon-button" data-action="copy" title="Copy selection">${icon('copy', 16)}</button><button class="icon-button" data-action="paste" title="Paste">${icon('pencil', 16)}</button><button class="icon-button" data-action="reconnect" title="Reconnect">${icon('refresh-cw', 16)}</button></div></div><div class="terminal-surface" id="terminal-surface"></div></div><p class="terminal-note">Closing a tab ends its shell process. Keep a second network path available before changing connectivity.</p></div>`
  const tabs = page.querySelector('#terminal-tabs'), surface = page.querySelector('#terminal-surface'), status = page.querySelector('#terminal-status')
  const observer = new ResizeObserver(() => { const current = sessions.get(activeID); if (current) { current.fit.fit(); resize(current) } })
  observer.observe(surface)
  const themeObserver = new MutationObserver(() => { for (const item of sessions.values()) item.term.options.theme = terminalTheme() })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  function resize(item) { if (item.ws?.readyState === WebSocket.OPEN) item.ws.send(JSON.stringify({ type: 'resize', cols: item.term.cols, rows: item.term.rows })) }
  function renderTabs() {
    tabs.innerHTML = [...sessions.values()].map(item => `<button class="terminal-tab ${activeID === item.id ? 'active' : ''}" data-tab="${item.id}">${icon('terminal-square', 15)}<span>${esc(item.title)}</span><i class="tab-signal ${item.connected ? 'on' : ''}"></i><span class="tab-close" data-close="${item.id}" aria-label="Close ${esc(item.title)}">×</span></button>`).join('')
    const active = sessions.get(activeID)
    status.className = `status-pill ${active?.connected ? 'is-ok' : 'is-muted'}`
    status.innerHTML = `<span class="status-dot"></span>${active?.connected ? 'Connected' : active?.connecting ? 'Connecting' : 'Disconnected'}`
  }
  function activate(id) { activeID = id; for (const item of sessions.values()) item.host.hidden = item.id !== id; renderTabs(); const current = sessions.get(id); if (current) { requestAnimationFrame(() => { current.fit.fit(); resize(current); current.term.focus() }) } }
  function connect(item) {
    if (item.ws && item.ws.readyState < 2) item.ws.close()
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal`)
    ws.binaryType = 'arraybuffer'; item.ws = ws; item.connected = false; item.connecting = true; renderTabs()
    ws.onopen = () => { if (item.ws !== ws) return; item.connected = true; item.connecting = false; renderTabs(); resize(item); item.term.focus() }
    ws.onmessage = event => {
      if (event.data instanceof ArrayBuffer) item.term.write(new Uint8Array(event.data))
      else { try { const message = JSON.parse(event.data); if (message.type === 'error') item.term.writeln(`\r\n[PiForge] ${message.message}`) } catch { item.term.write(event.data) } }
    }
    ws.onerror = () => { item.term.writeln('\r\n[PiForge] Terminal connection error') }
    ws.onclose = () => { if (item.ws !== ws) return; item.connected = false; item.connecting = false; item.term.writeln('\r\n[PiForge] Session closed. Use Reconnect to start a new shell.'); renderTabs() }
  }
  function createSession() {
    if (sessions.size >= 3) { ctx.toast('Up to three terminal sessions can run at once', 'error'); return }
    const id = nextID++, host = document.createElement('div'); host.className = 'terminal-host'; host.hidden = true; surface.append(host)
    const term = new window.Terminal({ cursorBlink: true, fontFamily: 'JetBrains Mono, monospace', fontSize: size, lineHeight: 1.32, scrollback: 1500, theme: terminalTheme(), allowTransparency: false })
    const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(host)
    const item = { id, title: `Terminal ${id}`, host, term, fit, ws: null, connected: false, connecting: true }
    term.onData(data => { if (item.ws?.readyState === WebSocket.OPEN) item.ws.send(JSON.stringify({ type: 'input', data })) })
    sessions.set(id, item); activate(id); connect(item)
  }
  function closeSession(id) { const item = sessions.get(id); if (!item) return; item.ws?.close(); item.term.dispose(); item.host.remove(); sessions.delete(id); if (activeID === id) activeID = sessions.keys().next().value ?? null; if (activeID) activate(activeID); else renderTabs() }
  page.addEventListener('click', async event => {
    const close = event.target.closest('[data-close]'); if (close) { closeSession(Number(close.dataset.close)); return }
    const tab = event.target.closest('[data-tab]'); if (tab) { activate(Number(tab.dataset.tab)); return }
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'new') createSession()
    if (action === 'fullscreen') { page.classList.toggle('terminal-fullscreen'); event.target.closest('button').innerHTML = icon(page.classList.contains('terminal-fullscreen') ? 'minimize' : 'maximize', 18); requestAnimationFrame(() => { const item = sessions.get(activeID); item?.fit.fit(); if (item) resize(item) }) }
    if (action === 'smaller' || action === 'larger') { size = Math.max(10, Math.min(22, size + (action === 'larger' ? 1 : -1))); localStorage.setItem('piforge.terminalFontSize', size); for (const item of sessions.values()) item.term.options.fontSize = size; const item = sessions.get(activeID); item?.fit.fit(); if (item) resize(item) }
    if (action === 'reconnect') { const item = sessions.get(activeID); if (item) { item.term.reset(); connect(item) } }
    if (action === 'copy') { const item = sessions.get(activeID); const value = item?.term.getSelection(); if (value) { try { await navigator.clipboard.writeText(value); ctx.toast('Selection copied') } catch { ctx.toast('Clipboard access denied', 'error') } } else ctx.toast('Select terminal text first', 'error') }
    if (action === 'paste') { const item = sessions.get(activeID); if (!item || item.ws?.readyState !== WebSocket.OPEN) return; try { const value = await navigator.clipboard.readText(); item.ws.send(JSON.stringify({ type: 'input', data: value })) } catch { ctx.toast('Clipboard access denied', 'error') } }
  })
  createSession()
  return () => { observer.disconnect(); themeObserver.disconnect(); for (const item of sessions.values()) { item.ws?.close(); item.term.dispose() } sessions.clear(); page.classList.remove('terminal-fullscreen') }
}
