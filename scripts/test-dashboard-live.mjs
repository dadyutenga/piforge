import { chromium } from '../.assetcache/node_modules/playwright-core/index.mjs'

const url = process.env.PIFORGE_TEST_URL
const password = process.env.PIFORGE_TEST_PASSWORD
if (!url || !password) throw new Error('PIFORGE_TEST_URL and PIFORGE_TEST_PASSWORD are required')

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  await page.goto(url)
  await page.locator('#username').fill('dadi')
  await page.locator('#password').fill(password)
  await page.locator('#login-form button').click()
  await page.locator('.dashboard-greeting').waitFor()
  const badge = page.locator('#dashboard-live')
  await badge.waitFor({ timeout: 3000 })
  const samples = []
  for (let i = 0; i < 3; i++) {
    const previous = samples.at(-1)?.at || 0
    await page.waitForFunction(last => Number(document.querySelector('#dashboard-live')?.dataset.sampleAt || 0) > last, previous, { timeout: 5000 })
    samples.push({ at: Number(await badge.getAttribute('data-sample-at')), label: await badge.innerText(), cpu: await page.locator('.metric-value').first().innerText() })
  }
  const snapshot = await page.evaluate(async () => (await (await fetch('/api/system')).json()))
  if (snapshot.capturedAt !== snapshot.current.at) throw new Error('API capture time does not match the actual metric sample')
  if (samples.some(sample => !sample.label.includes('Updated'))) throw new Error('Dashboard does not show when the sample was updated')
  const gaps = samples.slice(1).map((sample, index) => sample.at - samples[index].at)
  if (gaps.some(gap => gap > 4000)) throw new Error(`Dashboard samples are too far apart: ${gaps}`)
  await page.route('**/api/system', route => route.abort())
  await page.locator('#dashboard-live .dashboard-live-label').getByText('Offline').waitFor({ timeout: 5000 })
  if (!(await page.locator('#dashboard-connection-copy').innerText()).includes('Connection lost')) throw new Error('Offline dashboard copy did not update')
  await page.unroute('**/api/system')
  await page.locator('#dashboard-live .dashboard-live-label').getByText('Live').waitFor({ timeout: 5000 })
  await page.setViewportSize({ width: 390, height: 844 })
  if (!(await badge.isVisible())) throw new Error('Live sample indicator is hidden on mobile')
  await page.waitForResponse(response => response.url().endsWith('/api/activity') && response.status() === 200, { timeout: 18000 })
  console.log(JSON.stringify({ samples, gaps }))
} finally {
  await browser.close()
}
