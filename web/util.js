import { icon } from './icons.js'

export { icon }
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
export const attr = esc
export function bytes(value, decimals = 1) {
  if (!Number.isFinite(Number(value))) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const n = Math.max(0, Number(value))
  const i = Math.min(4, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? decimals : 0)} ${units[i]}`
}
export function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
export function time(value) { return new Date(value).toLocaleString() }
export function state(title, detail, action = '') { return `<div class="state-box"><span class="state-icon">${icon('info', 20)}</span><strong>${esc(title)}</strong><p>${esc(detail)}</p>${action}</div>` }
export function errorBox(message, retry = true) { return `<div class="state-box error"><span class="state-icon">${icon('alert-circle', 21)}</span><strong>Couldn’t load this view</strong><p>${esc(message)}</p>${retry ? '<button class="button secondary" data-action="retry">'+icon('refresh-cw',15)+' Retry</button>' : ''}</div>` }
export function skeleton(rows = 3) { return `<div class="skeleton-stack" aria-label="Loading">${Array.from({ length: rows }, (_, i) => `<div class="skeleton" style="width:${100 - i * 11}%"></div>`).join('')}</div>` }
export function pageIntro(title, detail, action = '') { return `<div class="page-intro"><div><h1>${esc(title)}</h1><p>${esc(detail)}</p></div>${action ? `<div class="page-action">${action}</div>` : ''}</div>` }
export function sectionHead(title, detail = '', action = '') { return `<div class="section-head"><div><h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ''}</div>${action}</div>` }

export function sparkline(history, key, tone = 'accent') {
  const values = (history || []).slice(-32).map(point => Number(point[key])).filter(Number.isFinite)
  if (values.length < 2) return '<span class="sparkline-empty"></span>'
  const min = Math.min(0, ...values), max = Math.max(1, ...values)
  const points = values.map((value, i) => `${(i / (values.length - 1) * 100).toFixed(2)},${(32 - ((value - min) / Math.max(max - min, 1)) * 25).toFixed(2)}`).join(' ')
  return `<svg class="sparkline ${tone}" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" /></svg>`
}

export function lineChart(history, series = [{ key: 'cpu', label: 'CPU', color: 'var(--accent)' }, { key: 'memory', label: 'Memory', color: 'var(--success)' }]) {
  const data = (history || []).filter(point => Number.isFinite(point.at))
  if (data.length < 2) return skeleton(3)
  const grid = [0, 25, 50, 75, 100].map(y => `<line x1="0" x2="1000" y1="${240 - y * 2.2}" y2="${240 - y * 2.2}" stroke="var(--border)" stroke-dasharray="3 7"/><text x="0" y="${243 - y * 2.2}" fill="var(--muted)" font-size="11">${y}%</text>`).join('')
  const paths = series.map(item => {
    const points = data.map((point, i) => `${(i / (data.length - 1) * 1000).toFixed(1)},${(240 - Math.max(0, Math.min(100, Number(point[item.key]) || 0)) * 2.2).toFixed(1)}`).join(' ')
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`
  }).join('')
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 1000 260" preserveAspectRatio="none" role="img" aria-label="${series.map(s => s.label).join(' and ')} history">${grid}${paths}</svg><div class="chart-tooltip" hidden></div></div>`
}

export function bindChart(container, history, series = [{ key: 'cpu', label: 'CPU' }, { key: 'memory', label: 'Memory' }]) {
  const wrap = container.querySelector('.chart-wrap')
  if (!wrap || !history?.length) return
  const tooltip = wrap.querySelector('.chart-tooltip')
  wrap.addEventListener('pointermove', event => {
    const box = wrap.getBoundingClientRect()
    const index = Math.min(history.length - 1, Math.max(0, Math.round((event.clientX - box.left) / box.width * (history.length - 1))))
    const point = history[index]
    tooltip.innerHTML = `<strong>${new Date(point.at).toLocaleTimeString()}</strong>${series.map(s => `<span>${esc(s.label)}: ${Number(point[s.key]).toFixed(1)}%</span>`).join('')}`
    tooltip.style.left = `${Math.min(box.width - 135, Math.max(10, event.clientX - box.left + 12))}px`
    tooltip.hidden = false
  })
  wrap.addEventListener('pointerleave', () => { tooltip.hidden = true })
}
