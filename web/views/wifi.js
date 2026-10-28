import { mutate } from '../api.js'
import { icon, esc, pageIntro, sectionHead, skeleton, errorBox, state } from '../util.js'

function splitNmcli(line) {
  const fields = []; let value = '', escaped = false
  for (const char of line) {
    if (escaped) { value += char; escaped = false }
    else if (char === '\\') escaped = true
    else if (char === ':') { fields.push(value); value = '' }
    else value += char
  }
  fields.push(value)
  return fields
}

function fieldsFrom(lines) {
  return Object.fromEntries((lines || []).map(line => {
    const i = line.indexOf(':')
    return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]
  }))
}

function connectDialog(ssid = '', protectedNetwork = false) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'confirm-dialog wifi-dialog'
    dialog.innerHTML = `<form method="dialog"><h2>Connect to Wi-Fi</h2><p>The connection can change your Pi’s IP address. You will have two minutes to confirm it.</p><label for="wifi-ssid">Network name</label><input id="wifi-ssid" name="ssid" maxlength="32" required value="${esc(ssid)}"><label for="wifi-password">Wi-Fi password <span class="muted">${protectedNetwork ? 'required for this network' : 'leave blank for open networks'}</span></label><input id="wifi-password" name="password" type="password" autocomplete="new-password" ${protectedNetwork ? 'required minlength="8"' : ''} maxlength="63"><div class="dialog-actions"><button class="button secondary" value="cancel" formnovalidate>Cancel</button><button class="button primary" value="connect">Connect</button></div></form>`
    document.body.append(dialog)
    dialog.onclose = () => { const result = dialog.returnValue === 'connect' ? { ssid: dialog.querySelector('#wifi-ssid').value, password: dialog.querySelector('#wifi-password').value } : null; dialog.remove(); resolve(result) }
    dialog.showModal()
    dialog.querySelector(ssid ? '#wifi-password' : '#wifi-ssid').focus()
  })
}

function confirmAction(title, detail, label) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'confirm-dialog'
    dialog.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(detail)}</p><div class="dialog-actions"><button class="button secondary" value="cancel">Cancel</button><button class="button danger" value="confirm">${esc(label)}</button></div></form>`
    document.body.append(dialog)
    dialog.onclose = () => { const yes = dialog.returnValue === 'confirm'; dialog.remove(); resolve(yes) }
    dialog.showModal()
  })
}

function secondsLeft(pending) { return Math.max(0, Number(pending?.expiresAt || 0) - Math.floor(Date.now() / 1000)) }

function networkAction(active, ssid, security, available, locked) {
  if (active === '*') return '<span class="status-pill is-ok">Connected</span>'
  if (!available) return ''
  if (/WEP|802\.1X|WPA3|SAE/i.test(security || '')) return '<span class="status-pill is-muted" title="This release supports open and WPA-PSK networks">Unsupported security</span>'
  return `<button class="button secondary wifi-row-button" data-wifi="connect" data-ssid="${esc(ssid)}" data-protected="${security && security !== '--' ? 'true' : 'false'}" ${locked ? 'disabled' : ''}>Connect</button>`
}

export async function mountWifi(page, ctx) {
  let data = null, busy = false, cancelled = false, pendingTimer = null, progress = '', scanFeedback = ''
  page.innerHTML = `${pageIntro('Wi-Fi', 'Manage the Pi’s wireless connection.')}<section class="panel">${skeleton(4)}</section>`

  function render() {
    if (!data || cancelled) return
    clearInterval(pendingTimer)
    const fields = fieldsFrom(data.status)
    const connected = data.radioEnabled && fields['GENERAL.CONNECTION'] && fields['GENERAL.CONNECTION'] !== '--' ? fields['GENERAL.CONNECTION'] : null
    const networks = (data.networks || []).filter(Boolean).map(splitNmcli).filter(row => row.length >= 4 && row[1])
    const profiles = (data.profiles || []).filter(Boolean).map(splitNmcli).filter(row => row.length >= 6 && row[2] === '802-11-wireless')
    const pending = data.pending
    const locked = busy || Boolean(pending) || !data.radioEnabled
    const radioLocked = busy || !data.controlAvailable || (pending && pending.action !== 'radio-off')
    const radioPanel = `<section class="panel wifi-radio-panel"><div class="wifi-radio-main"><span class="wifi-emblem">${icon(data.radioEnabled ? 'wifi' : 'wifi-off', 22)}</span><div><h2>Wi-Fi radio</h2><p>${data.radioEnabled ? 'On · nearby networks can be scanned' : 'Off · wireless networks are unavailable'}</p></div></div><button class="wifi-switch ${data.radioEnabled ? 'is-on' : ''}" type="button" role="switch" aria-checked="${data.radioEnabled}" aria-label="Turn Wi-Fi ${data.radioEnabled ? 'off' : 'on'}" data-wifi="radio-toggle" ${radioLocked ? 'disabled' : ''}><span></span></button></section>`
    page.innerHTML = `${pageIntro('Wi-Fi', 'Manage the Pi’s wireless connection.', `<button class="button secondary" data-wifi="refresh" ${busy || !data.radioEnabled ? 'disabled' : ''}>${icon('refresh-cw', 15)} Scan again</button>`)}
      ${!data.controlAvailable ? `<div class="notice">${icon('info', 17)}<span>Wi-Fi control is unavailable because the restricted helper is not running. Connection details remain available.</span></div>` : ''}
      ${data.radioEnabled && !data.fallbackAvailable ? `<div class="notice warning">${icon('alert-triangle', 17)}<span>Wi-Fi is this Pi’s only active network route. Turning it off will interrupt this browser; a safety timer will turn it back on after two minutes unless you confirm from another connection.</span></div>` : ''}
      ${progress ? `<div class="notice wifi-progress" role="status">${icon('loader-circle', 17)}<span>${esc(progress)}</span></div>` : ''}
      ${pending ? `<div class="panel wifi-pending"><div><span class="eyebrow">Connection safeguard</span><h2>${pending.action === 'radio-off' ? 'Confirm Wi-Fi off' : 'Confirm the Wi-Fi change'}</h2><p>${pending.action === 'radio-off' ? 'The Wi-Fi radio will turn back on' : 'The connection will return to its previous state'} in <strong id="wifi-countdown">${secondsLeft(pending)} seconds</strong> unless you confirm it.</p></div><div class="wifi-pending-actions"><button class="button secondary" data-wifi="revert" ${busy ? 'disabled' : ''}>${pending.action === 'radio-off' ? 'Turn on now' : 'Revert now'}</button><button class="button primary" data-wifi="confirm" ${busy ? 'disabled' : ''}>${pending.action === 'radio-off' ? 'Keep Wi-Fi off' : 'Keep connection'}</button></div></div>` : ''}
      ${radioPanel}
      <section class="panel wifi-current">${sectionHead('Current connection', 'NetworkManager status')}<div class="wifi-current-row"><span class="wifi-emblem">${icon('wifi', 26)}</span><div><strong>${esc(connected || 'Not connected')}</strong><small>${esc(fields['GENERAL.STATE'] || 'State unavailable')}</small></div><span class="status-pill ${connected ? 'is-ok' : 'is-muted'}"><span class="status-dot"></span>${connected ? 'Connected' : 'Disconnected'}</span></div><div class="wifi-details"><div><span>Address</span><strong>${esc(fields['IP4.ADDRESS[1]'] || '—')}</strong></div><div><span>Gateway</span><strong>${esc(fields['IP4.GATEWAY'] || '—')}</strong></div><div><span>DNS</span><strong>${esc(fields['IP4.DNS[1]'] || '—')}</strong></div></div>${data.controlAvailable && connected ? `<div class="wifi-current-actions"><button class="button secondary" data-wifi="disconnect" ${locked ? 'disabled' : ''}>${icon('wifi-off', 16)} Disconnect</button></div>` : ''}</section>
      <section class="panel">${sectionHead('Nearby networks', `${networks.length} visible`, data.controlAvailable ? `<button class="button secondary" data-wifi="manual" ${locked ? 'disabled' : ''}>${icon('plus', 15)} Connect by name</button>` : '')}${scanFeedback ? `<p class="wifi-scan-feedback" role="status">${esc(scanFeedback)}</p>` : ''}${networks.length ? `<div class="network-list">${networks.map(([active, ssid, signal, security]) => `<div class="network-row"><span class="network-icon">${icon('wifi', 19)}</span><div><strong>${esc(ssid)}</strong><small>${esc(security && security !== '--' ? security : 'Open network')}</small></div><span class="signal-bars" aria-label="Signal ${esc(signal)} percent"><i style="width:${Math.max(0, Math.min(100, Number(signal) || 0))}%"></i></span>${networkAction(active, ssid, security, data.controlAvailable, locked)}</div>`).join('')}</div>` : state(data.radioEnabled ? 'No networks found' : 'Wi-Fi is off', data.radioEnabled ? 'Scan again or connect by name if the network is hidden.' : 'Turn Wi-Fi on to scan nearby networks.')}</section>
      <section class="panel">${sectionHead('Saved profiles', `${profiles.length} known wireless connections`)}${profiles.length ? `<div class="saved-profiles">${profiles.map(([uuid, name, , auto, active]) => `<div class="saved-profile-row">${icon('wifi', 17)}<strong>${esc(name)}</strong><span>Auto-connect ${auto === 'yes' ? 'on' : 'off'}</span><div class="saved-profile-actions">${active === 'yes' || uuid === data.activeUUID ? '<span class="status-pill is-ok">Active</span>' : data.controlAvailable ? `<button class="button secondary" data-wifi="activate" data-uuid="${esc(uuid)}" ${locked ? 'disabled' : ''}>Connect</button><button class="button quiet danger-text" data-wifi="forget" data-uuid="${esc(uuid)}" data-name="${esc(name)}" ${locked ? 'disabled' : ''}>Forget</button>` : ''}</div></div>`).join('')}</div>` : state('No saved networks', 'New connections will appear here after confirmation.')}</section>`
    if (pending) pendingTimer = setInterval(() => {
      const label = page.querySelector('#wifi-countdown')
      if (label) label.textContent = `${secondsLeft(pending)} seconds`
      if (secondsLeft(pending) === 0) { clearInterval(pendingTimer); setTimeout(refresh, 1500) }
    }, 1000)
  }

  async function refresh() {
    try { const result = await ctx.api('/api/wifi'); if (cancelled) return; data = result; progress = ''; render() }
    catch (error) { if (!cancelled) { page.innerHTML = errorBox(error.message); page.querySelector('[data-action="retry"]')?.addEventListener('click', refresh) } }
  }

  async function operate(path, body, successText) {
    busy = true; progress = 'Applying Wi-Fi change…'; render()
    try {
      await mutate(path, 'POST', body)
      if (!cancelled) { ctx.toast(successText); await refresh() }
    } catch (error) {
      if (!cancelled) {
        if (error.status) { ctx.toast(error.message, 'error'); await refresh() }
        else { progress = 'Connection interrupted. Reopen PiForge at the new address or wait two minutes for automatic rollback.'; render() }
      }
    } finally { busy = false; if (!cancelled && data) render() }
  }

  page.addEventListener('click', async event => {
    const button = event.target.closest('[data-wifi]')
    if (!button || busy) return
    const action = button.dataset.wifi
    if (action === 'refresh') {
      if (!data?.radioEnabled) return
      busy = true; progress = 'Scanning nearby networks…'; scanFeedback = ''; render()
      try {
        const result = await mutate('/api/wifi/scan', 'POST', {})
        await refresh()
        const count = (result.networks || '').split('\n').filter(line => splitNmcli(line)[1]).length
        scanFeedback = `Scan complete. ${count} network${count === 1 ? '' : 's'} visible from this Pi.${count <= 1 ? ' You can also connect by name.' : ''}`
      } catch (error) { ctx.toast(error.message || 'Wi-Fi scan failed', 'error'); progress = '' }
      finally { busy = false; render() }
      return
    }
    if (!data?.controlAvailable) return
    if (action === 'radio-toggle') {
      if (data.radioEnabled) {
        const detail = data.fallbackAvailable
          ? 'The Wi-Fi radio will turn off. You can keep it off from your other network route; otherwise it turns back on after two minutes.'
          : 'Wi-Fi is the only active route to this Pi. This browser will disconnect, and a safety timer will turn Wi-Fi back on after two minutes. To keep it off, connect through Ethernet first.'
        if (await confirmAction('Turn Wi-Fi off?', detail, 'Turn off')) await operate('/api/wifi/radio', { enabled: false }, 'Wi-Fi radio turned off. Confirm it to keep this state.')
      } else await operate('/api/wifi/radio', { enabled: true }, 'Wi-Fi radio turned on')
      return
    }
    if (action === 'connect' || action === 'manual') {
      const credentials = await connectDialog(button.dataset.ssid || '', button.dataset.protected === 'true')
      if (credentials) await operate('/api/wifi/connect', { ...credentials, hidden: action === 'manual' }, 'Wi-Fi connected. Confirm it to keep this connection.')
    }
    if (action === 'activate') await operate('/api/wifi/activate', { uuid: button.dataset.uuid }, 'Saved network activated. Confirm it to keep this connection.')
    if (action === 'disconnect' && await confirmAction('Disconnect Wi-Fi?', data.fallbackAvailable ? 'Your wireless connection may close. You have two minutes to confirm or NetworkManager will reconnect it.' : 'Wi-Fi is the only active route to this Pi. This browser will disconnect and NetworkManager will restore Wi-Fi automatically after two minutes.', 'Disconnect')) await operate('/api/wifi/disconnect', {}, 'Wi-Fi disconnected. Confirm it to keep this state.')
    if (action === 'forget' && await confirmAction('Forget saved network?', `${button.dataset.name} will be removed from this Pi.`, 'Forget')) await operate('/api/wifi/forget', { uuid: button.dataset.uuid }, 'Saved network forgotten')
    if (action === 'confirm') await operate('/api/wifi/confirm', { id: data.pending.id }, data.pending.action === 'radio-off' ? 'Wi-Fi will remain off' : 'Wi-Fi change confirmed')
    if (action === 'revert') await operate('/api/wifi/revert', { id: data.pending.id }, data.pending.action === 'radio-off' ? 'Wi-Fi radio turned on' : 'Previous Wi-Fi connection restored')
  })

  await refresh()
  return () => { cancelled = true; clearInterval(pendingTimer) }
}
