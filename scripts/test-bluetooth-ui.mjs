import { chromium } from '../.assetcache/node_modules/playwright-core/index.mjs'
import { mkdir } from 'node:fs/promises'

const url = process.env.PIFORGE_TEST_URL
const password = process.env.PIFORGE_TEST_PASSWORD
if (!url || !password) throw new Error('PIFORGE_TEST_URL and PIFORGE_TEST_PASSWORD are required')

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${url}/bluetooth`)
  await page.locator('#username').fill('dadi')
  await page.locator('#password').fill(password)
  await page.locator('#login-form button').click()
  await page.locator('[data-bt="power"]').waitFor({ timeout: 15000 })
  if (await page.locator('[data-bt="power"]').isDisabled()) throw new Error('Bluetooth helper is unavailable')
  if (await page.locator('[data-bt="power"]').getAttribute('aria-checked') === 'true') {
    await page.locator('[data-bt="power"]').click()
    await page.waitForFunction(() => document.querySelector('[data-bt="power"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 25000 })
  }
  if (await page.locator('[data-bt="power"]').getAttribute('aria-checked') === 'false') {
    await page.locator('[data-bt="power"]').click()
    await page.waitForFunction(() => document.querySelector('[data-bt="power"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 25000 })
  }
  await page.locator('[data-bt="scan"]').click()
  await page.waitForFunction(() => !document.querySelector('.wifi-progress'), null, { timeout: 20000 })
  await mkdir('_screens', { recursive: true })
  await page.screenshot({ path: '_screens/bluetooth.png', fullPage: true })
  const state = await page.evaluate(async () => {
    const { mutate } = await import('/api.js')
    const result = await (await fetch('/api/bluetooth')).json()
    let invalidRejected = false
    let unknownRejected = false
    try { await mutate('/api/bluetooth/pair', 'POST', { address: 'invalid' }) }
    catch (error) { invalidRejected = error.status === 400 }
    try { await mutate('/api/bluetooth/pair', 'POST', { address: '00:00:00:00:00:00' }) }
    catch (error) { unknownRejected = error.status === 409 }
    return { powered: /Powered:\s+yes/.test(result.adapter), controlAvailable: result.controlAvailable, devices: result.devices.filter(Boolean).length, invalidRejected, unknownRejected }
  })
  if (!state.powered || !state.controlAvailable || !state.invalidRejected || !state.unknownRejected || errors.length) throw new Error(JSON.stringify({ state, errors }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${url}/bluetooth`)
  await page.locator('[data-bt="power"]').waitFor({ timeout: 15000 })
  const mobile = await page.locator('[data-bt="power"]').boundingBox()
  if (!mobile || mobile.width < 35 || mobile.x + mobile.width > 390) throw new Error(`Bluetooth power switch is not usable on mobile: ${JSON.stringify(mobile)}`)
  await page.screenshot({ path: '_screens/bluetooth-mobile.png', fullPage: true })
  console.log(JSON.stringify(state))
} finally {
  await browser.close()
}
