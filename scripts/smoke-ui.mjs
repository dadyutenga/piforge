import { mkdir } from 'node:fs/promises'
import { chromium } from '../.assetcache/node_modules/playwright-core/index.mjs'

const url = process.env.PIFORGE_TEST_URL || 'http://127.0.0.1:18787'
const password = process.env.PIFORGE_TEST_PASSWORD
if (!password) throw new Error('PIFORGE_TEST_PASSWORD is required')

await mkdir('_screens', { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
page.on('requestfailed', request => errors.push(`FAILED ${request.url()}: ${request.failure()?.errorText}`))
await page.goto(url, { waitUntil: 'networkidle' })
await page.screenshot({ path: '_screens/login.png', fullPage: true })
await page.locator('#username').waitFor()
await page.locator('#username').fill('dadi')
await page.locator('#password').fill(password)
await page.locator('#login-form button').click()
await page.locator('.dashboard-greeting').waitFor({ timeout: 15000 })
await page.screenshot({ path: '_screens/dashboard.png', fullPage: true })
const dashboard = await page.locator('.dashboard-greeting h1').innerText()
const metricCount = await page.locator('.metric').count()
await page.keyboard.press('Control+k')
await page.locator('#palette-input').fill('Wi-Fi')
await page.locator('#palette-input').press('Enter')
await page.locator('.content h1').getByText('Wi-Fi', { exact: true }).waitFor()
await page.locator('a[data-route="/"]').first().click()
await page.locator('.dashboard-greeting').waitFor()
await page.locator('#theme-toggle').click()
await page.screenshot({ path: '_screens/light.png', fullPage: true })
await page.locator('#theme-toggle').click()
await page.locator('a[data-route="/terminal"]').first().click()
await page.locator('.xterm').waitFor({ timeout: 15000 })
await page.screenshot({ path: '_screens/terminal.png', fullPage: true })
const terminalStatus = await page.locator('#terminal-status').innerText()
await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('dadi@'))
await page.locator('.xterm-helper-textarea').focus()
await page.keyboard.type('printf PIFORGE_TERMINAL_OK')
await page.keyboard.press('Enter')
await page.waitForFunction(() => (document.querySelector('.xterm-screen')?.textContent?.match(/PIFORGE_TERMINAL_OK/g) || []).length >= 2, null, { timeout: 10000 })
await page.locator('a[data-route="/files"]').first().click()
await page.locator('.file-panel').waitFor({ timeout: 15000 })
await page.screenshot({ path: '_screens/files.png', fullPage: true })
const testFolder = `ui-smoke-${Date.now()}`
await page.locator('[data-action="new-folder"]').click()
await page.locator('#dialog-value').fill(testFolder)
await page.locator('dialog button[value="save"]').click()
await page.locator(`[data-open="${testFolder}"]`).waitFor()
await page.locator(`[data-open="${testFolder}"]`).click()
await page.locator(`.breadcrumbs [data-folder="${testFolder}"]`).waitFor()
await page.locator('#file-upload').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('PiForge file test') })
try { await page.locator('[data-open$="/hello.txt"]').waitFor({ timeout: 10000 }) }
catch (error) { await page.screenshot({ path: '_screens/upload-failed.png', fullPage: true }); console.log('UPLOAD DIAGNOSTIC', JSON.stringify({ body: (await page.locator('body').innerText()).slice(-1500), errors })); throw error }
await page.locator('[data-open$="/hello.txt"]').click()
await page.locator('.file-preview pre').getByText('PiForge file test').waitFor()
await page.locator('[data-open-editor$="/hello.txt"]').click()
await page.locator('.CodeMirror').waitFor({ timeout: 15000 })
await page.locator('.CodeMirror').click()
await page.keyboard.press('ControlOrMeta+End')
await page.keyboard.type(' edited')
await page.locator('[data-action="save"]').click()
await page.locator('.toast').getByText('File saved').waitFor()
const saved = await page.evaluate(async testFolder => {
  const response = await fetch(`/api/files/content?path=${encodeURIComponent(`${testFolder}/hello.txt`)}`)
  return (await response.json()).content
}, testFolder)
await page.evaluate(async testFolder => {
  const { api } = await import('/api.js')
  await api(`/api/files?path=${encodeURIComponent(testFolder)}`, { method: 'DELETE' })
}, testFolder)
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(url, { waitUntil: 'networkidle' })
await page.locator('.dashboard-greeting').waitFor({ timeout: 15000 })
await page.screenshot({ path: '_screens/mobile.png', fullPage: true })
await page.locator('#mobile-menu').click()
await page.locator('#sidebar .nav-link[data-route="/files"]').click()
await page.locator('.file-panel').waitFor({ timeout: 15000 })
const checkedPages = []
for (const route of ['/processes', '/services', '/storage', '/logs', '/wifi', '/bluetooth', '/network', '/about', '/settings']) {
  await page.goto(url + route, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !document.querySelector('.content .skeleton-stack'), { timeout: 15000 })
  const error = await page.locator('.content .state-box.error').count() ? await page.locator('.content .state-box.error').first().textContent() : null
  if (error) throw new Error(`${route}: ${error}`)
  if (route === '/wifi') {
    await page.locator('[data-wifi="disconnect"]').waitFor()
    await page.locator('[data-wifi="manual"]').click()
    await page.locator('#wifi-ssid').waitFor()
    await page.locator('.wifi-dialog button[value="cancel"]').click()
    await page.locator('[data-wifi="disconnect"]').click()
    await page.locator('dialog').getByText('Wi-Fi is the only active route').waitFor()
    await page.locator('dialog button[value="cancel"]').click()
    await page.locator('[data-wifi="radio-toggle"]').click()
    await page.locator('dialog').getByText('Wi-Fi is the only active route').waitFor()
    await page.locator('dialog button[value="cancel"]').click()
    if (await page.locator('[data-wifi="radio-toggle"]').getAttribute('aria-checked') !== 'true') throw new Error('Radio switch changed after cancellation')
    await page.locator('[data-wifi="refresh"]').click()
    await page.locator('.wifi-scan-feedback').waitFor({ timeout: 15000 })
    await page.screenshot({ path: '_screens/wifi.png', fullPage: true })
    const check = await page.evaluate(async () => {
      const { mutate } = await import('/api.js')
      const wifi = await (await fetch('/api/wifi')).json()
      const activation = await mutate('/api/wifi/activate', 'POST', { uuid: wifi.activeUUID })
      const radio = await mutate('/api/wifi/radio', 'POST', { enabled: true })
      let invalidRejected = false
      try { await mutate('/api/wifi/activate', 'POST', { uuid: 'not-a-uuid' }) } catch (error) { invalidRejected = error.status === 409 }
      const pending = await (await fetch('/api/wifi/pending')).json()
      return { activation, radio, invalidRejected, pending, radioEnabled: wifi.radioEnabled }
    })
    if (!check.activation.ok || !check.radio.ok || !check.radioEnabled || !check.invalidRejected || !check.pending.ok || check.pending.pending) throw new Error(`Wi-Fi helper check failed: ${JSON.stringify(check)}`)
  }
  checkedPages.push(route)
}
console.log(JSON.stringify({ dashboard, metricCount, terminalStatus, saved, checkedPages, browserErrors: errors.filter(error => !error.includes('/api/session')) }, null, 2))
await browser.close()
