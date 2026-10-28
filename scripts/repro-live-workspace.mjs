import { chromium } from '../.assetcache/node_modules/playwright-core/index.mjs'

const url = process.env.PIFORGE_TEST_URL
const password = process.env.PIFORGE_TEST_PASSWORD
if (!url || !password) throw new Error('PIFORGE_TEST_URL and PIFORGE_TEST_PASSWORD are required')

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.locator('#username').fill('dadi')
  await page.locator('#password').fill(password)
  await page.locator('#login-form button').click()
  await page.locator('.dashboard-greeting').waitFor()

  const samples = await page.evaluate(async () => {
    const seen = []
    let redraws = 0
    const observer = new MutationObserver(records => { redraws += records.filter(record => record.target.id === 'page' && record.type === 'childList').length })
    observer.observe(document.querySelector('#page'), { childList: true })
    const listen = event => seen.push({ at: performance.now(), capturedAt: event.detail.capturedAt })
    document.addEventListener('piforge:system', listen)
    await new Promise(resolve => setTimeout(resolve, 6600))
    document.removeEventListener('piforge:system', listen)
    observer.disconnect()
    return { seen, redraws }
  })
  const gaps = samples.seen.slice(1).map((sample, index) => Math.round(sample.at - samples.seen[index].at))
  console.log('SYSTEM', JSON.stringify({ samples: samples.seen.length, gaps, redraws: samples.redraws, captured: samples.seen.map(item => item.capturedAt) }))
  const failures = []
  if (samples.seen.length < 2 || gaps.some(gap => gap > 3000) || samples.redraws < 2) failures.push('Dashboard stats are not displayed near the 2-second sampler cadence')

  await page.route('**/vendor/xterm.js', async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue() })
  await page.locator('a[data-route="/terminal"]').first().click()
  await page.locator('a[data-route="/editor"]').first().click()
  await page.locator('a[data-route="/terminal"]').first().click()
  try {
    await page.locator('#terminal-status').waitFor({ timeout: 10000 })
    await page.locator('#terminal-status').getByText('Connected').waitFor({ timeout: 10000 })
    await page.locator('.xterm-helper-textarea').focus({ timeout: 5000 })
    await page.keyboard.type('printf PIFORGE_REPRO_OK')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (document.querySelector('.xterm-screen')?.textContent?.match(/PIFORGE_REPRO_OK/g) || []).length >= 2, null, { timeout: 10000 })
  } catch (error) { failures.push(`Terminal after quick navigation: ${error.message.split('\n')[0]}; page=${(await page.locator('#page').innerText()).slice(0, 160)}`) }

  await page.route('**/vendor/codemirror/codemirror.js', async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue() })
  await page.locator('a[data-route="/editor"]').first().click()
  await page.locator('a[data-route="/files"]').first().click()
  await page.locator('a[data-route="/editor"]').first().click()
  const testFile = `repro-${Date.now()}.js`
  try {
    await page.locator('.editor-main').waitFor({ timeout: 10000 })
    await page.locator('.editor-page [data-action="new"]').click()
    await page.locator('#dialog-value').fill(testFile)
    await page.locator('dialog button[value="save"]').click()
    await page.locator('.CodeMirror').waitFor({ timeout: 10000 })
    await page.locator('.CodeMirror').click()
    await page.keyboard.type('const working = true')
    await page.locator('.editor-page [data-action="save"]').click()
    await page.locator('.toast').getByText('File saved').waitFor()
    const saved = await page.evaluate(async path => {
      const response = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`)
      return (await response.json()).content
    }, testFile)
    if (!saved.includes('const working = true')) failures.push('Editor did not persist typed content')
  } catch (error) { failures.push(`Editor after quick navigation: ${error.message.split('\n')[0]}`) }
  finally {
    await page.evaluate(async path => {
      const { api } = await import('/api.js')
      await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).catch(() => {})
    }, testFile)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${url}/terminal`)
  try {
    await page.locator('#terminal-status').getByText('Connected').waitFor({ timeout: 10000 })
    const box = await page.locator('.xterm').boundingBox()
    if (!box || box.height < 180 || box.width < 250) failures.push(`Mobile terminal is too small: ${JSON.stringify(box)}`)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf PIFORGE_MOBILE_OK')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (document.querySelector('.xterm-screen')?.textContent?.match(/PIFORGE_MOBILE_OK/g) || []).length >= 2, null, { timeout: 10000 })
  } catch (error) { failures.push(`Mobile terminal: ${error.message.split('\n')[0]}`) }
  await page.goto(`${url}/editor`)
  try {
    await page.locator('.editor-main').waitFor({ timeout: 10000 })
    const box = await page.locator('.editor-main').boundingBox()
    if (!box || box.height < 300 || box.width < 250) failures.push(`Mobile editor is too small: ${JSON.stringify(box)}`)
  } catch (error) { failures.push(`Mobile editor: ${error.message.split('\n')[0]}`) }
  if (errors.length) failures.push(`Browser errors: ${errors.join('; ')}`)
  if (failures.length) throw new Error(failures.join(' | '))
  console.log('WORKSPACE_OK')
} finally {
  await browser.close()
}
