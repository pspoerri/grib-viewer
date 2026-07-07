import { chromium } from 'playwright-core'
const out = process.argv[2] || '/tmp'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
await page.goto('http://localhost:5174/', { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(9000)
await page.screenshot({ path: `${out}/shot-default.png` })
// temperature topic (left rail thermometer)
const temp = page.locator('button', { hasText: '' }).first()
try {
  await page.getByTitle(/temperature/i).first().click({ timeout: 3000 })
} catch { console.log('no temperature title; trying text 🌡') }
await page.waitForTimeout(6000)
await page.screenshot({ path: `${out}/shot-temp.png` })
try {
  await page.getByRole('button', { name: /precipitation/i }).first().click({ timeout: 3000 })
} catch (e) { console.log('precip click failed', String(e).slice(0,120)) }
await page.waitForTimeout(7000)
await page.screenshot({ path: `${out}/shot-precip.png` })
console.log('done')
await browser.close()
