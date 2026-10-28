import { api, ApiError, login, mutate, setSession } from './api.js'
import { icon, esc, skeleton, errorBox } from './util.js'
import { mountDashboard, mountActivity, mountMonitor, mountAbout } from './views/dashboard.js'
import { mountSystem } from './views/system.js'
import { mountFiles, mountEditor } from './views/files.js'
import { mountTerminal } from './views/terminal.js'
import { mountWifi } from './views/wifi.js'

const root = document.getElementById('app')
const groups = [
  ['Overview', [['/', 'Dashboard', 'layout-dashboard'], ['/activity', 'Activity', 'activity'], ['/notifications', 'Notifications', 'bell']]],
  ['System', [['/monitor', 'System monitor', 'cpu'], ['/processes', 'Processes', 'boxes'], ['/services', 'Services', 'server-cog'], ['/storage', 'Storage', 'hard-drive'], ['/logs', 'System logs', 'file-text']]],
  ['Connectivity', [['/wifi', 'Wi-Fi', 'wifi'], ['/bluetooth', 'Bluetooth', 'bluetooth'], ['/network', 'Network', 'network']]],
  ['Workspace', [['/terminal', 'Terminal', 'terminal-square'], ['/files', 'File manager', 'files'], ['/editor', 'Code editor', 'code-2']]],
  ['Configuration', [['/settings', 'Settings', 'settings-2'], ['/about', 'About device', 'circle-help']]],
]
const pages = groups.flatMap(group => group[1])
let session = null
let snapshot = null
let viewCleanup = null
let statusTimer = null
let statusUpdating = false
let routeVersion = 0
let currentPath = location.pathname
let collapsed = localStorage.getItem('piforge.sidebar') === 'collapsed'
let theme = localStorage.getItem('piforge.theme') || 'dark'

function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
  localStorage.setItem('piforge.theme', theme)
}
applyTheme()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

export function toast(message, type = 'success') {
  const holder = document.getElementById('toast-stack')
  if (!holder) return
  const node = document.createElement('div')
  node.className = `toast ${type}`
  node.innerHTML = `${icon(type === 'success' ? 'check-circle-2' : 'alert-circle', 18)}<span>${esc(message)}</span><button aria-label="Dismiss notification">${icon('x', 16)}</button>`
  node.querySelector('button').onclick = () => node.remove()
  holder.append(node)
  setTimeout(() => node.remove(), 5500)
}

export function currentSnapshot() { return snapshot }

function bootScreen(content) { root.innerHTML = `<div class="boot-screen"><div class="boot-brand"><span class="brand-mark">${icon('command', 21)}</span><strong>PiForge</strong></div>${content}</div>` }

async function boot() {
  bootScreen(`<div class="boot-loading">${skeleton(2)}</div>`)
  try {
    const bootstrap = await api('/api/bootstrap')
    if (!bootstrap.initialized) {
      bootScreen(`<div class="setup-state">${icon('command', 28)}<h1>Finish setup on your Pi</h1><p>Create the first administrator from a terminal on the Raspberry Pi:</p><code>piforge init-admin dadi</code><p>Refresh after setup.</p><button class="button primary" id="setup-retry">Check again</button></div>`)
      root.querySelector('#setup-retry').onclick = boot
      return
    }
    try { session = await api('/api/session'); setSession(session) }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error }
    if (session) renderShell(); else renderLogin()
  } catch {
    bootScreen(errorBox('PiForge is unreachable. Check its service and your connection.', false) + '<button class="button primary" id="boot-retry">Try again</button>')
    root.querySelector('#boot-retry').onclick = boot
  }
}

function renderLogin() {
  root.innerHTML = `<div class="auth-page"><div class="auth-art" aria-hidden="true"><div class="auth-orbit"><span>Pi</span></div><p>A quieter way to run your Raspberry Pi.</p></div><main class="auth-card"><div class="brand"><span class="brand-mark">${icon('command', 20)}</span><span><strong>PiForge</strong><small>Your Raspberry Pi workspace</small></span></div><div class="auth-copy"><p class="eyebrow">Welcome back</p><h1>Sign in to your workspace</h1><p>Manage your Pi, work on projects, and keep everything in view.</p></div><form id="login-form"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p id="login-error" class="form-error" role="alert" hidden></p><button class="button primary auth-submit">Sign in ${icon('arrow-right', 16)}</button></form><p class="auth-foot">${icon('shield-check', 14)} Private device access</p></main></div>`
  root.querySelector('#username').focus()
  root.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.currentTarget, button = form.querySelector('button'), errorNode = form.querySelector('#login-error')
    button.disabled = true; button.textContent = 'Signing in…'; errorNode.hidden = true
    try { session = await login(form.elements.namedItem('username').value, form.elements.namedItem('password').value); renderShell() }
    catch (error) { errorNode.textContent = error.message || 'Sign in failed'; errorNode.hidden = false; button.disabled = false; button.innerHTML = `Sign in ${icon('arrow-right', 16)}` }
  })
}

function navHtml() {
  return groups.map(([label, items]) => `<div class="nav-group"><p>${esc(label)}</p>${items.map(([path, name, glyph]) => `<a href="${path}" data-route="${path}" class="nav-link" title="${esc(name)}">${icon(glyph, 18)}<span>${esc(name)}</span></a>`).join('')}</div>`).join('')
}

function renderShell() {
  root.innerHTML = `<div class="app-shell ${collapsed ? 'sidebar-collapsed' : ''}"><button class="drawer-scrim" id="drawer-scrim" aria-label="Close navigation" hidden></button><aside class="sidebar" id="sidebar"><div class="sidebar-top"><a href="/" data-route="/" class="brand" title="PiForge"><span class="brand-mark">${icon('command', 20)}</span><span class="brand-copy"><strong>PiForge</strong><small>Your Raspberry Pi workspace</small></span></a><button class="icon-button collapse-button" id="collapse" aria-label="Toggle sidebar">${icon(collapsed ? 'chevron-right' : 'chevron-left', 17)}</button></div><button class="sidebar-search" id="open-search">${icon('search', 17)}<span>Search anything</span><kbd>⌘ K</kbd></button><nav class="sidebar-nav" aria-label="Main navigation">${navHtml()}</nav><div class="sidebar-bottom"><div class="device-mini"><span class="device-light" id="device-light"></span><span><strong id="device-name">Raspberry Pi</strong><small id="device-connection">Connecting…</small></span></div><button class="user-mini" id="account-button"><span class="avatar">${esc(session.username.slice(0, 2).toUpperCase())}</span><span><strong>${esc(session.username)}</strong><small>Administrator</small></span>${icon('chevron-down', 15)}</button><div class="account-menu" id="account-menu" hidden><a href="/settings" data-route="/settings">${icon('settings-2', 15)} Settings</a><button id="logout">${icon('log-out', 15)} Sign out</button></div></div></aside><div class="app-main"><header class="topbar"><div class="topbar-left"><button class="icon-button mobile-menu" id="mobile-menu" aria-label="Open navigation">${icon('menu', 21)}</button><span class="breadcrumb-root">Workspace</span>${icon('chevron-right', 14)}<strong id="page-name">Dashboard</strong></div><div class="topbar-right"><button class="top-search" id="top-search">${icon('search', 16)}<span>Search</span><kbd>⌘ K</kbd></button><span class="status-pill is-ok" id="live-status"><span class="status-dot"></span>Live</span><a href="/notifications" data-route="/notifications" class="icon-button" aria-label="Notifications">${icon('bell', 18)}</a><button class="icon-button" id="theme-toggle" aria-label="Toggle theme">${icon(theme === 'dark' ? 'sun' : 'moon', 18)}</button><button class="top-avatar" id="top-account" aria-label="Account menu">${esc(session.username.slice(0, 2).toUpperCase())}</button></div></header><main class="content" id="page" tabindex="-1">${skeleton(3)}</main></div></div><div id="overlay"></div><div id="toast-stack" class="toast-stack" role="status" aria-live="polite"></div>`
  bindShell()
  navigate(location.pathname, true)
  refreshStatus()
  clearInterval(statusTimer)
  statusTimer = setInterval(refreshStatus, 2000)
}

function bindShell() {
  root.addEventListener('click', onRootClick)
  root.querySelector('#collapse').onclick = () => { collapsed = !collapsed; localStorage.setItem('piforge.sidebar', collapsed ? 'collapsed' : 'expanded'); root.querySelector('.app-shell').classList.toggle('sidebar-collapsed', collapsed); root.querySelector('#collapse').innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-left', 17) }
  root.querySelector('#mobile-menu').onclick = () => setDrawer(true)
  root.querySelector('#drawer-scrim').onclick = () => setDrawer(false)
  root.querySelector('#open-search').onclick = openPalette
  root.querySelector('#top-search').onclick = openPalette
  root.querySelector('#theme-toggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); root.querySelector('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 18) }
  root.querySelector('#account-button').onclick = toggleAccount
  root.querySelector('#top-account').onclick = toggleAccount
  root.querySelector('#logout').onclick = async () => { if (viewCleanup?.canLeave && !viewCleanup.canLeave()) return; try { await mutate('/api/logout', 'POST'); setSession(null); session = null; clearInterval(statusTimer); viewCleanup?.(); root.removeEventListener('click', onRootClick); renderLogin() } catch (error) { toast(error.message, 'error') } }
}

function toggleAccount() { const menu = root.querySelector('#account-menu'); menu.hidden = !menu.hidden }
function setDrawer(open) { root.querySelector('#sidebar')?.classList.toggle('drawer-open', open); const scrim = root.querySelector('#drawer-scrim'); if (scrim) scrim.hidden = !open }
function onRootClick(event) {
  const link = event.target.closest('[data-route]')
  if (!link) return
  event.preventDefault()
  navigate(link.dataset.route)
}

async function refreshStatus() {
  if (!session || statusUpdating) return
  statusUpdating = true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    snapshot = await api('/api/system', { signal: controller.signal })
    const light = root.querySelector('#device-light'), text = root.querySelector('#device-connection'), name = root.querySelector('#device-name'), live = root.querySelector('#live-status')
    if (light) { light.classList.remove('offline'); text.textContent = 'Connected to PiForge'; name.textContent = snapshot.device.hostname; live.className = 'status-pill is-ok'; live.innerHTML = '<span class="status-dot"></span>Live' }
    document.dispatchEvent(new CustomEvent('piforge:system', { detail: snapshot }))
  } catch (error) {
    const light = root.querySelector('#device-light'), text = root.querySelector('#device-connection'), live = root.querySelector('#live-status')
    if (light) { light.classList.add('offline'); text.textContent = 'Offline'; live.className = 'status-pill is-danger'; live.innerHTML = '<span class="status-dot"></span>Offline' }
    document.dispatchEvent(new Event('piforge:offline'))
    if (error instanceof ApiError && error.status === 401) { session = null; setSession(null); clearInterval(statusTimer); viewCleanup?.(); root.removeEventListener('click', onRootClick); renderLogin() }
  } finally {
    clearTimeout(timeout)
    statusUpdating = false
  }
}

async function navigate(path, replace = false) {
  if (viewCleanup?.canLeave && !viewCleanup.canLeave()) { if (replace) history.pushState({}, '', currentPath); return }
  if (!pages.some(item => item[0] === path)) path = '/'
  if (!replace) history.pushState({}, '', path)
  currentPath = path
  routeVersion++
  const token = routeVersion
  viewCleanup?.(); viewCleanup = null
  setDrawer(false)
  root.querySelector('#account-menu').hidden = true
  root.querySelector('#page-name').textContent = pages.find(item => item[0] === path)[1]
  root.querySelectorAll('.nav-link').forEach(link => { const active = link.dataset.route === path; link.classList.toggle('active', active); active ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current') })
  const previousPage = root.querySelector('#page')
  const page = document.createElement('main')
  page.id = 'page'
  page.className = 'content'
  page.tabIndex = -1
  previousPage.replaceWith(page)
  page.classList.toggle('content-wide', ['/terminal', '/files', '/editor'].includes(path))
  page.innerHTML = skeleton(3)
  page.focus({ preventScroll: true })
  try {
    let cleanup
    if (path === '/') cleanup = await mountDashboard(page, { api, snapshot, toast })
    else if (path === '/monitor') cleanup = await mountMonitor(page, { api, snapshot, toast })
    else if (path === '/activity' || path === '/notifications') cleanup = await mountActivity(page, { api, toast, notifications: path === '/notifications' })
    else if (path === '/about') cleanup = await mountAbout(page, { api, snapshot, toast })
    else if (path === '/files') cleanup = await mountFiles(page, { api, toast })
    else if (path === '/editor') cleanup = await mountEditor(page, { api, toast })
    else if (path === '/terminal') cleanup = await mountTerminal(page, { toast })
    else if (path === '/wifi') cleanup = await mountWifi(page, { api, toast })
    else if (path === '/settings') cleanup = mountSettings(page)
    else cleanup = await mountSystem(page, path, { api, toast })
    if (token === routeVersion) viewCleanup = cleanup || null; else cleanup?.()
  } catch (error) { if (token === routeVersion) { page.innerHTML = errorBox(error.message || 'This page is unavailable'); page.querySelector('[data-action=retry]')?.addEventListener('click', () => navigate(path, true)) } }
}

function mountSettings(page) {
  page.innerHTML = `<div class="page-intro"><div><h1>Settings</h1><p>Personalize this browser’s PiForge experience.</p></div></div><section class="panel"><div class="section-head"><div><h2>Appearance</h2><p>Theme changes are saved in this browser.</p></div></div><fieldset class="theme-options"><legend>Color theme</legend>${['dark', 'light', 'system'].map(value => `<label><input type="radio" name="theme" value="${value}" ${theme === value ? 'checked' : ''}><span>${value[0].toUpperCase() + value.slice(1)}</span></label>`).join('')}</fieldset></section><section class="panel"><div class="section-head"><div><h2>Change password</h2><p>Choose a new PiForge password. You will need to sign in again.</p></div></div><form class="settings-form" id="change-password"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="next" type="password" autocomplete="new-password" minlength="12" required></label><label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label><button class="button primary">Save password</button><p class="form-error" id="password-error" hidden></p></form></section><section class="panel"><div class="section-head"><div><h2>Access</h2><p>Your session expires after 12 hours. Terminal commands run as the PiForge service account.</p></div></div><p class="supporting-copy">This installation is intended for a private LAN or VPN. Keep the management port off the public internet.</p></section>`
  page.querySelectorAll('input[name=theme]').forEach(input => input.addEventListener('change', () => { theme = input.value; applyTheme(); root.querySelector('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 18); toast('Theme saved') }))
  page.querySelector('#change-password').addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.currentTarget, current = form.elements.namedItem('current').value, next = form.elements.namedItem('next').value, confirm = form.elements.namedItem('confirm').value, errorNode = form.querySelector('#password-error'), button = form.querySelector('button')
    errorNode.hidden = true
    if (next !== confirm) { errorNode.textContent = 'New passwords do not match'; errorNode.hidden = false; return }
    button.disabled = true
    try { await mutate('/api/account/password', 'POST', { current, next }); toast('Password changed. Sign in again.'); setTimeout(() => location.reload(), 900) }
    catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; button.disabled = false }
  })
}

function openPalette() {
  const holder = root.querySelector('#overlay')
  holder.innerHTML = `<div class="modal-backdrop" id="palette-backdrop"><div class="command-panel" role="dialog" aria-modal="true" aria-label="Search pages"><div class="command-search">${icon('search', 18)}<input id="palette-input" placeholder="Search pages and tools…" autocomplete="off"><kbd>Esc</kbd></div><div id="palette-results" class="command-results"></div><div class="command-hint">Use <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> anywhere</div></div></div>`
  const input = holder.querySelector('#palette-input'), results = holder.querySelector('#palette-results')
  const render = () => { const q = input.value.toLowerCase(); const found = pages.filter(item => item[1].toLowerCase().includes(q)); results.innerHTML = `<p class="small-label">Navigate</p>${found.length ? found.map(([path, name, glyph]) => `<button data-go="${path}">${icon(glyph, 17)}${esc(name)}${icon('chevron-right', 15)}</button>`).join('') : '<p class="command-empty">No matching tools.</p>'}` }
  render(); input.focus()
  input.oninput = render
  input.onkeydown = event => { if (event.key === 'Escape') closePalette(); if (event.key === 'Enter') { const first = results.querySelector('[data-go]'); if (first) { navigate(first.dataset.go); closePalette() } } }
  holder.onclick = event => { if (event.target.id === 'palette-backdrop') closePalette(); const button = event.target.closest('[data-go]'); if (button) { navigate(button.dataset.go); closePalette() } }
}
function closePalette() { root.querySelector('#overlay').innerHTML = '' }

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); root.querySelector('#palette-backdrop') ? closePalette() : session && openPalette() }
  if (event.key === 'Escape') { closePalette(); setDrawer(false) }
})
window.addEventListener('popstate', () => { if (session) navigate(location.pathname, true) })
boot()
