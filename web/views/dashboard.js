import { api as fetchApi } from '../api.js'
import { icon, esc, bytes, uptime, time, sparkline, lineChart, bindChart, pageIntro, sectionHead, skeleton, errorBox, state } from '../util.js'

const quick = [
  ['Terminal', '/terminal', 'terminal-square', 'Run commands'],
  ['File manager', '/files', 'files', 'Browse workspace'],
  ['Wi-Fi', '/wifi', 'wifi', 'Network status'],
  ['Bluetooth', '/bluetooth', 'bluetooth', 'Nearby devices'],
  ['Code editor', '/editor', 'code-2', 'Edit files'],
  ['Services', '/services', 'server-cog', 'System units'],
]
const greeting = () => { const hour = new Date().getHours(); return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening' }
const address = device => device.interfaces.flatMap(i => i.addresses).find(a => /^(10\.|192\.168\.|172\.)/.test(a))?.split('/')[0] || 'Local network'
const tone = (value, caution, danger) => value > danger ? 'danger' : value > caution ? 'warning' : 'normal'

function metric(label, value, detail, glyph, history, key, mood = 'normal') {
  return `<div class="metric ${mood}"><div class="metric-top"><span>${esc(label)}</span>${icon(glyph, 18)}</div><div class="metric-value">${esc(value)}</div><div class="metric-bottom"><small>${esc(detail)}</small>${sparkline(history, key, mood)}</div></div>`
}

function eventRow(event) {
  return `<div class="event-row"><span class="event-indicator ${event.success ? 'ok' : 'bad'}"></span><div><strong>${esc(event.action.replaceAll('.', ' '))}</strong><small>${esc(event.target)} · ${esc(event.actor)}</small></div><time datetime="${esc(event.at)}">${time(event.at)}</time></div>`
}

function liveBadge(snapshot) {
  const sampledAt = Number(snapshot.current?.at || 0)
  const delayed = !sampledAt || Date.now() - sampledAt > 6000
  const label = delayed ? 'Data delayed' : 'Live'
  const updated = sampledAt ? `Updated ${new Date(sampledAt).toLocaleTimeString()}` : 'Waiting for first sample'
  return `<span id="dashboard-live" class="status-pill dashboard-live ${delayed ? 'is-muted' : 'is-ok'}" data-sample-at="${sampledAt}"><span class="status-dot"></span><span class="dashboard-live-label">${label}</span><small>${esc(updated)}</small></span>`
}

function drawDashboard(page, s, events) {
  const m = s.current, d = s.device, history = s.history || []
  page.innerHTML = `<div class="dashboard"><div class="dashboard-greeting"><div><p class="eyebrow">Your workspace</p><h1>${greeting()}, welcome to PiForge</h1><p id="dashboard-connection-copy">Your Raspberry Pi is online and ready.</p></div>${liveBadge(s)}</div><div class="device-banner"><div class="device-emblem">${icon('cpu', 24)}</div><div class="device-banner-main"><strong>${esc(d.hostname)}</strong><span>${esc(d.model || 'Raspberry Pi')} <i></i> ${esc(d.os)}</span></div><div class="device-banner-stat"><small>IP address</small><strong>${esc(address(d))}</strong></div><div class="device-banner-stat"><small>Uptime</small><strong>${uptime(d.uptimeSec)}</strong></div><a href="/about" data-route="/about" class="icon-button" aria-label="View device details">${icon('arrow-up-right', 18)}</a></div><div class="metric-grid">${metric('CPU usage', `${m.cpu.toFixed(1)}%`, `${d.cores} cores · ${d.arch}`, 'cpu', history, 'cpu', tone(m.cpu, 65, 85))}${metric('Memory', `${m.memory.toFixed(1)}%`, `${bytes(d.memoryBytes * m.memory / 100)} of ${bytes(d.memoryBytes)}`, 'memory-stick', history, 'memory', tone(m.memory, 75, 90))}${metric('Storage', `${m.disk.toFixed(1)}%`, `${bytes(d.diskUsed)} of ${bytes(d.diskBytes)}`, 'hard-drive', history, 'disk', tone(m.disk, 75, 90))}${metric('CPU temperature', s.temperatureAvailable ? `${m.temperature.toFixed(1)}°` : '—', s.temperatureAvailable ? 'Celsius · SoC sensor' : 'Sensor unavailable', 'thermometer', history, 'temperature', tone(m.temperature, 70, 80))}</div><div class="dashboard-main-grid"><section class="panel activity-panel">${sectionHead('System activity', 'Live measurements from this device', `<a href="/monitor" data-route="/monitor" class="text-link">Open monitor ${icon('arrow-up-right', 15)}</a>`)}<div class="chart-legend"><span><i class="legend-cpu"></i> CPU</span><span><i class="legend-memory"></i> Memory</span><small>Last ${Math.max(1, Math.round(history.length * 2 / 60))} minutes</small></div>${lineChart(history)}</section><section class="panel network-panel">${sectionHead('Network traffic', 'Throughput across active interfaces')}<div class="network-values"><div><span>Download</span><strong>${bytes(m.rxBytesSec)}/s</strong></div><div><span>Upload</span><strong>${bytes(m.txBytesSec)}/s</strong></div></div><div class="network-bars"><div><span>Receive</span><i style="width:${Math.min(100, m.rxBytesSec / Math.max(m.rxBytesSec, m.txBytesSec, 1) * 100)}%"></i></div><div><span>Transmit</span><i style="width:${Math.min(100, m.txBytesSec / Math.max(m.rxBytesSec, m.txBytesSec, 1) * 100)}%"></i></div></div><a href="/network" data-route="/network" class="text-link">View interfaces ${icon('arrow-up-right', 15)}</a></section></div><section class="panel shortcuts-panel">${sectionHead('Quick access', 'Open the tools you use most')}<div class="shortcut-grid">${quick.map(([label, path, glyph, note]) => `<a href="${path}" data-route="${path}" class="shortcut"><span class="shortcut-icon">${icon(glyph, 19)}</span><span><strong>${label}</strong><small>${note}</small></span>${icon('arrow-up-right', 16)}</a>`).join('')}</div></section><section class="panel recent-panel">${sectionHead('Recent activity', 'Actions recorded on this Pi', `<a href="/activity" data-route="/activity" class="text-link">View all ${icon('arrow-up-right', 15)}</a>`)}${events?.length ? `<div class="event-list">${events.slice(0, 5).map(eventRow).join('')}</div>` : state('No activity yet', 'Sign-ins and system actions will appear here as they happen.')}</section></div>`
  bindChart(page, history)
}

export async function mountDashboard(page, ctx) {
  page.innerHTML = `<div class="page-intro"><h1>Dashboard</h1></div><section class="panel">${skeleton(4)}</section>`
  let snapshot = ctx.snapshot
  let events = []
  try {
    const [fresh, activity] = await Promise.all([ctx.api('/api/system'), ctx.api('/api/activity')])
    snapshot = fresh; events = activity
    drawDashboard(page, snapshot, events)
  } catch (error) { page.innerHTML = errorBox(error.message); page.querySelector('[data-action=retry]')?.addEventListener('click', () => mountDashboard(page, ctx)) }
  let online = true
  const update = event => { online = true; snapshot = event.detail; if (page.isConnected) drawDashboard(page, snapshot, events) }
  let activityRefreshing = false
  const refreshActivity = async () => {
    if (activityRefreshing || !page.isConnected) return
    activityRefreshing = true
    try {
      const fresh = await ctx.api('/api/activity')
      if (page.isConnected) { events = fresh; if (online && snapshot) drawDashboard(page, snapshot, events) }
    } catch { /* Keep the last successful activity list until the next refresh. */ }
    finally { activityRefreshing = false }
  }
  const activityTimer = setInterval(refreshActivity, 15000)
  const offline = () => {
    online = false
    const badge = page.querySelector('#dashboard-live')
    if (!badge) return
    badge.className = 'status-pill dashboard-live is-danger'
    badge.querySelector('.dashboard-live-label').textContent = 'Offline'
    page.querySelector('#dashboard-connection-copy').textContent = 'Connection lost. Waiting to reconnect.'
  }
  document.addEventListener('piforge:system', update)
  document.addEventListener('piforge:offline', offline)
  return () => { clearInterval(activityTimer); document.removeEventListener('piforge:system', update); document.removeEventListener('piforge:offline', offline) }
}

export async function mountMonitor(page, ctx) {
  page.innerHTML = `${pageIntro('System monitor', 'Live measurements from your Raspberry Pi.')}<section class="panel">${skeleton(4)}</section>`
  function draw(s) {
    const m = s.current
    page.innerHTML = `${pageIntro('System monitor', 'CPU, memory, storage, temperature and network activity, sampled every two seconds.')}<div class="monitor-metrics"><span>CPU <strong>${m.cpu.toFixed(1)}%</strong></span><span>Memory <strong>${m.memory.toFixed(1)}%</strong></span><span>Storage <strong>${m.disk.toFixed(1)}%</strong></span><span>Temperature <strong>${s.temperatureAvailable ? `${m.temperature.toFixed(1)}°C` : 'Unavailable'}</strong></span></div><section class="panel">${sectionHead('CPU and memory', 'Recent utilization · percentages')}<div class="chart-legend"><span><i class="legend-cpu"></i> CPU</span><span><i class="legend-memory"></i> Memory</span></div>${lineChart(s.history)}</section><section class="panel">${sectionHead('Network throughput', 'Current receive and transmit rate')}<div class="network-values"><div><span>Download</span><strong>${bytes(m.rxBytesSec)}/s</strong></div><div><span>Upload</span><strong>${bytes(m.txBytesSec)}/s</strong></div></div></section>`
    bindChart(page, s.history)
  }
  try { draw(ctx.snapshot || await fetchApi('/api/system')) } catch (error) { page.innerHTML = errorBox(error.message) }
  const update = event => { if (page.isConnected) draw(event.detail) }
  document.addEventListener('piforge:system', update)
  return () => document.removeEventListener('piforge:system', update)
}

export async function mountActivity(page, ctx) {
  const title = ctx.notifications ? 'Notifications' : 'Activity'
  page.innerHTML = `${pageIntro(title, ctx.notifications ? 'Failed operations and events that need attention.' : 'A timeline of sign-ins and actions performed through PiForge.')}<section class="panel">${skeleton(5)}</section>`
  async function refresh() {
    try {
      const all = await ctx.api('/api/activity')
      const events = ctx.notifications ? all.filter(event => !event.success) : all
      page.innerHTML = `${pageIntro(title, ctx.notifications ? 'Failed operations and events that need attention.' : 'A timeline of sign-ins and actions performed through PiForge.')}<section class="panel">${sectionHead(ctx.notifications ? 'Needs attention' : 'Audit timeline', ctx.notifications ? 'Only failed actions appear here' : 'Most recent events first')}${events.length ? `<div class="event-list">${events.map(eventRow).join('')}</div>` : state(ctx.notifications ? 'All clear' : 'No recorded actions', ctx.notifications ? 'There are no failed operations to review.' : 'Actions will appear after they are completed.')}</section>`
    } catch (error) { page.innerHTML = errorBox(error.message) }
  }
  await refresh()
  const timer = setInterval(refresh, 15000)
  return () => clearInterval(timer)
}

export async function mountAbout(page, ctx) {
  page.innerHTML = `${pageIntro('About device', 'Hardware and operating system details.')}<section class="panel">${skeleton()}</section>`
  try {
    const s = ctx.snapshot || await ctx.api('/api/system'), d = s.device
    const rows = [['Device name', d.hostname], ['Model', d.model], ['Operating system', d.os], ['Kernel', d.kernel], ['Architecture', d.arch], ['CPU cores', d.cores], ['Memory', bytes(d.memoryBytes)], ['Storage', bytes(d.diskBytes)], ['Uptime', uptime(d.uptimeSec)]]
    page.innerHTML = `${pageIntro('About device', 'This information is read directly from your Raspberry Pi.')}<section class="panel">${sectionHead('Hardware and software')}<dl class="details-grid">${rows.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value || 'Unavailable')}</dd></div>`).join('')}</dl></section><section class="panel">${sectionHead('Network interfaces', 'Addresses reported by the operating system')}<div class="interface-list">${d.interfaces.map(iface => `<div><span class="interface-icon">${icon('network', 18)}</span><div><strong>${esc(iface.name)}</strong><small>${esc(iface.addresses.join(' · ') || 'No address')}</small></div><span class="status-pill ${iface.up ? 'is-ok' : 'is-danger'}"><span class="status-dot"></span>${iface.up ? 'Up' : 'Down'}</span></div>`).join('')}</div></section>`
  } catch (error) { page.innerHTML = errorBox(error.message) }
}
