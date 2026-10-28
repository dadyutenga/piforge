import { mutate } from '../api.js'
import { icon, esc, bytes, pageIntro, sectionHead, skeleton, errorBox, state } from '../util.js'

const config = {
  '/processes': ['Processes', 'Inspect running processes and terminate your own processes.', '/api/processes'],
  '/services': ['Services', 'Inspect systemd units and their current state.', '/api/services'],
  '/storage': ['Storage', 'Physical disks, partitions and mounted filesystems.', '/api/storage'],
  '/logs': ['System logs', 'Recent journal entries from this device.', '/api/logs'],
  '/bluetooth': ['Bluetooth', 'Adapter and device state reported by BlueZ.', '/api/bluetooth'],
  '/network': ['Network', 'Interfaces and routes reported by Linux.', '/api/network'],
}

function sectionNote(message) { return `<div class="notice">${icon('info', 17)}<span>${esc(message)}</span></div>` }
function refreshButton() { return `<button class="button secondary" data-refresh>${icon('refresh-cw', 15)} Refresh</button>` }
function filterInput() { return `<label class="table-search">${icon('search', 16)}<input id="page-filter" type="search" placeholder="Filter results" autocomplete="off"></label>` }
function bindFilter(page, rowSelector) {
  page.querySelector('#page-filter')?.addEventListener('input', event => {
    const query = event.target.value.toLowerCase()
    page.querySelectorAll(rowSelector).forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(query) })
  })
}

function confirm(title, detail, label, onConfirm) {
  const dialog = document.createElement('dialog')
  dialog.className = 'confirm-dialog'
  dialog.innerHTML = `<h2>${esc(title)}</h2><p>${esc(detail)}</p><div class="dialog-actions"><button class="button secondary" data-cancel>Cancel</button><button class="button danger" data-confirm>${esc(label)}</button></div>`
  document.body.append(dialog)
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close()
  dialog.querySelector('[data-confirm]').onclick = async () => { const button = dialog.querySelector('[data-confirm]'); button.disabled = true; button.textContent = 'Working…'; try { await onConfirm(); dialog.close() } catch (error) { button.disabled = false; button.textContent = label; dialog.querySelector('p').textContent = error.message } }
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  dialog.showModal()
}

function renderProcesses(page, items, ctx, refresh) {
  page.innerHTML = `${pageIntro('Processes', 'Inspect running processes and terminate your own processes.', refreshButton())}<section class="panel">${sectionHead('Running processes', `${items.length} shown · CPU is the process lifetime average`)}<div class="table-tools">${filterInput()}</div><div class="table-scroll"><table><thead><tr><th>Process</th><th>PID</th><th>User</th><th>CPU</th><th>Memory</th><th>State</th><th></th></tr></thead><tbody>${items.map(p => `<tr><td class="name-cell">${icon('boxes', 16)}<strong>${esc(p.name)}</strong></td><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td class="mono">${p.cpu.toFixed(1)}%</td><td class="mono">${p.memory.toFixed(1)}%</td><td>${esc(p.state)}</td><td><button class="table-action" data-pid="${p.pid}" aria-label="Terminate ${esc(p.name)}">Terminate</button></td></tr>`).join('')}</tbody></table></div></section>`
  bindFilter(page, 'tbody tr')
  page.querySelectorAll('[data-pid]').forEach(button => button.addEventListener('click', () => {
    const process = items.find(item => item.pid === Number(button.dataset.pid))
    confirm('Terminate process?', `${process.name} (PID ${process.pid}) will receive SIGTERM. Unsaved work in that process may be lost.`, 'Terminate', async () => { await mutate(`/api/processes/${process.pid}/terminate`, 'POST'); ctx.toast(`Sent SIGTERM to ${process.name}`); refresh() })
  }))
}

function renderServices(page, items, caps, ctx, refresh) {
  const running = items.filter(unit => unit.active === 'active').length
  page.innerHTML = `${pageIntro('Services', 'Inspect systemd units and their current state.', refreshButton())}${!caps.serviceControl ? sectionNote('Service actions need the restricted PiForge helper. Status is available in read-only mode.') : ''}<section class="panel">${sectionHead('System services', `${running} active · ${items.length} units`)}<div class="table-tools">${filterInput()}</div><div class="table-scroll"><table><thead><tr><th>Service</th><th>Description</th><th>Status</th>${caps.serviceControl ? '<th>Actions</th>' : ''}</tr></thead><tbody>${items.map(unit => `<tr><td class="name-cell">${icon('server-cog', 16)}<strong>${esc(unit.name)}</strong></td><td>${esc(unit.description)}</td><td><span class="status-pill ${unit.active === 'active' ? 'is-ok' : 'is-muted'}"><span class="status-dot"></span>${esc(unit.state)}</span></td>${caps.serviceControl ? `<td><button class="table-action" data-unit="${esc(unit.name)}" data-action="${unit.active === 'active' ? 'restart' : 'start'}">${unit.active === 'active' ? 'Restart' : 'Start'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div></section>`
  bindFilter(page, 'tbody tr')
  if (caps.serviceControl) page.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
    const name = button.dataset.unit, action = button.dataset.action
    confirm(`${action === 'restart' ? 'Restart' : 'Start'} service?`, `${name} will ${action}. Active connections may be interrupted.`, action === 'restart' ? 'Restart' : 'Start', async () => { await mutate(`/api/services/${encodeURIComponent(name)}/${action}`, 'POST'); ctx.toast(`${name} ${action} completed`); refresh() })
  }))
}

function storageRows(nodes, depth = 0) {
  return (nodes || []).map(node => `<tr><td class="name-cell" style="padding-left:${18 + depth * 22}px">${icon(node.type === 'disk' ? 'hard-drive' : 'folder', 16)}<strong>${esc(node.name)}</strong></td><td>${esc(node.type)}</td><td class="mono">${bytes(Number(node.size))}</td><td class="mono">${esc(node.fstype || '—')}</td><td class="mono">${esc(node.mountpoint || '—')}</td></tr>${storageRows(node.children, depth + 1)}`).join('')
}
function renderStorage(page, data) { page.innerHTML = `${pageIntro('Storage', 'Physical disks, partitions and mounted filesystems.')}<section class="panel">${sectionHead('Devices', 'Read from lsblk on the Pi')}<div class="table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Filesystem</th><th>Mount</th></tr></thead><tbody>${storageRows(data.blockdevices)}</tbody></table></div></section>` }

function renderLogs(page, data, refresh) {
  const lines = (data.lines || []).filter(line => line && line !== '-- No entries --')
  page.innerHTML = `${pageIntro('System logs', 'Recent journal entries from this device.', refreshButton())}<section class="panel">${sectionHead('Journal', `${lines.length} recent lines`)}<div class="table-tools">${filterInput()}</div>${lines.length ? `<div class="log-list">${lines.map(line => `<div class="log-line">${esc(line)}</div>`).join('')}</div>` : state('No logs available', 'This account may need journal access or the journal may be empty.')}</section>`
  bindFilter(page, '.log-line')
}

function parseDevices(lines) { return (lines || []).filter(Boolean).map(line => { const match = line.match(/^Device\s+([0-9A-F:]+)\s+(.+)$/i); return match ? { address: match[1], name: match[2] } : null }).filter(Boolean) }
function renderBluetooth(page, data, ctx, refresh) {
  const powered = /Powered:\s+yes/.test(data.adapter || '')
  const address = (data.adapter || '').match(/Controller\s+([0-9A-F:]+)/i)?.[1] || '—'
  const all = parseDevices(data.devices), paired = parseDevices(data.paired)
  const connected = new Set(parseDevices(data.connected).map(device => device.address))
  const pairedSet = new Set(paired.map(device => device.address))
  const nearby = all.filter(device => !pairedSet.has(device.address))
  page.innerHTML = `${pageIntro('Bluetooth', 'Manage the Pi’s Bluetooth adapter and nearby devices.', `<button class="button secondary" data-bt="scan" ${!powered || !data.controlAvailable ? 'disabled' : ''}>${icon('refresh-cw', 15)} Scan devices</button>`)}
    ${!data.controlAvailable ? sectionNote('Bluetooth control is unavailable because the restricted helper is not running. Device information remains available.') : ''}
    <section class="panel"><div class="bluetooth-adapter-head"><div>${sectionHead('Adapter', 'Built-in Bluetooth controller')}</div><button class="wifi-switch ${powered ? 'is-on' : ''}" type="button" role="switch" aria-checked="${powered}" aria-label="Turn Bluetooth ${powered ? 'off' : 'on'}" data-bt="power" ${!data.controlAvailable ? 'disabled' : ''}><span></span></button></div><div class="wifi-current-row"><span class="wifi-emblem">${icon('bluetooth', 25)}</span><div><strong>${esc(address)}</strong><small>${powered ? 'Radio on' : 'Radio off'}</small></div><span class="status-pill ${powered ? 'is-ok' : 'is-muted'}"><span class="status-dot"></span>${powered ? 'Powered' : 'Off'}</span></div></section>
    <section class="panel">${sectionHead('Paired devices', `${paired.length} known`)}${paired.length ? `<div class="network-list">${paired.map(device => `<div class="network-row"><span class="network-icon">${icon('bluetooth', 18)}</span><div><strong>${esc(device.name)}</strong><small>${esc(device.address)}</small></div><span class="status-pill ${connected.has(device.address) ? 'is-ok' : 'is-muted'}">${connected.has(device.address) ? 'Connected' : 'Paired'}</span><div class="bluetooth-actions"><button class="button secondary" data-bt="${connected.has(device.address) ? 'disconnect' : 'connect'}" data-address="${esc(device.address)}" ${!powered || !data.controlAvailable ? 'disabled' : ''}>${connected.has(device.address) ? 'Disconnect' : 'Connect'}</button><button class="button quiet danger-text" data-bt="remove" data-address="${esc(device.address)}" data-name="${esc(device.name)}" ${!data.controlAvailable ? 'disabled' : ''}>Remove</button></div></div>`).join('')}</div>` : state('No paired devices', 'Scan for a device and choose Pair.')}</section>
    <section class="panel">${sectionHead('Nearby devices', `${nearby.length} seen`)}${nearby.length ? `<div class="network-list">${nearby.map(device => `<div class="network-row"><span class="network-icon">${icon('bluetooth', 18)}</span><div><strong>${esc(device.name)}</strong><small>${esc(device.address)}</small></div><button class="button secondary" data-bt="pair" data-address="${esc(device.address)}" ${!powered || !data.controlAvailable ? 'disabled' : ''}>Pair</button></div>`).join('')}</div>` : state(powered ? 'No devices found' : 'Bluetooth is off', powered ? 'Make another device discoverable, then scan.' : 'Turn Bluetooth on to scan nearby devices.')}</section>
    ${data.controlAvailable ? `<p class="supporting-copy">Pairing supports devices that do not require a PIN or passkey. Devices that require one will report an error.</p>` : ''}`
  async function action(name, body, success) {
    page.querySelectorAll('[data-bt]').forEach(button => { button.disabled = true })
    const progress = document.createElement('div')
    progress.className = 'notice wifi-progress'
    progress.setAttribute('role', 'status')
    progress.textContent = name === 'scan' ? 'Scanning for Bluetooth devices…' : 'Applying Bluetooth change…'
    page.querySelector('.page-intro').after(progress)
    try {
      await mutate(`/api/bluetooth/${name === 'power' ? 'power' : name}`, 'POST', body)
      await refresh()
      ctx.toast(success)
    } catch (error) {
      progress.remove()
      await refresh()
      page.querySelectorAll('[data-bt]').forEach(button => { button.disabled = false })
      ctx.toast(error.message || 'Bluetooth operation failed', 'error')
    }
  }
  page.querySelectorAll('[data-bt]').forEach(button => button.addEventListener('click', () => {
    const name = button.dataset.bt, target = button.dataset.address
    if (name === 'power') { action('power', { enabled: !powered }, `Bluetooth turned ${powered ? 'off' : 'on'}`); return }
    if (name === 'scan') { action('scan', {}, 'Bluetooth scan complete'); return }
    if (name === 'remove') {
      confirm('Remove Bluetooth device?', `${button.dataset.name} will need to be paired again before use.`, 'Remove', () => action('remove', { address: target }, 'Bluetooth device removed'))
      return
    }
    action(name, { address: target }, `Bluetooth ${name} completed`)
  }))
}

function renderNetwork(page, data) {
  page.innerHTML = `${pageIntro('Network', 'Interfaces and routes reported by Linux.', refreshButton())}<section class="panel">${sectionHead('Interfaces', `${(data.interfaces || []).length} found`)}<div class="interface-list">${(data.interfaces || []).map(i => `<div><span class="interface-icon">${icon('network', 18)}</span><div><strong>${esc(i.ifname)}</strong><small>${(i.addr_info || []).map(a => esc(`${a.local}/${a.prefixlen}`)).join(' · ') || 'No address'}</small></div><span class="status-pill ${i.operstate === 'UP' ? 'is-ok' : 'is-muted'}"><span class="status-dot"></span>${esc(i.operstate)}</span></div>`).join('')}</div></section><section class="panel">${sectionHead('Routes', 'Active IPv4 routes')}<div class="table-scroll"><table><thead><tr><th>Destination</th><th>Gateway</th><th>Interface</th><th>Metric</th></tr></thead><tbody>${(data.routes || []).map(route => `<tr><td class="mono">${esc(route.dst || 'default')}</td><td class="mono">${esc(route.gateway || '—')}</td><td>${esc(route.dev || '—')}</td><td class="mono">${esc(route.metric ?? '—')}</td></tr>`).join('')}</tbody></table></div></section>`
}

export async function mountSystem(page, path, ctx) {
  const [title, detail, endpoint] = config[path] || config['/processes']
  page.innerHTML = `${pageIntro(title, detail)}<section class="panel">${skeleton(5)}</section>`
  let cancelled = false
  async function refresh() {
    try {
      const [data, caps] = await Promise.all([ctx.api(endpoint), path === '/services' ? ctx.api('/api/capabilities') : Promise.resolve({})])
      if (cancelled) return
      if (path === '/processes') renderProcesses(page, data, ctx, refresh)
      else if (path === '/services') renderServices(page, data, caps, ctx, refresh)
      else if (path === '/storage') renderStorage(page, data)
      else if (path === '/logs') renderLogs(page, data, refresh)
      else if (path === '/bluetooth') renderBluetooth(page, data, ctx, refresh)
      else renderNetwork(page, data)
      page.querySelector('[data-refresh]')?.addEventListener('click', () => { page.querySelector('[data-refresh]').disabled = true; refresh() })
    } catch (error) { if (!cancelled) { page.innerHTML = errorBox(error.message); page.querySelector('[data-action=retry]')?.addEventListener('click', refresh) } }
  }
  await refresh()
  return () => { cancelled = true }
}
