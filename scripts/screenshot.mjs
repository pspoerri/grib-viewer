// Headless full-stack check: loads the app in Chrome, logs console
// errors, saves a screenshot. Usage:
//   node scripts/screenshot.mjs [url] [out.png]
import { chromium } from 'playwright-core'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const out = process.argv[3] || 'shot.png'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let errors = 0
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors++
    console.log('[console.error]', m.text().slice(0, 300))
  }
})
page.on('pageerror', (e) => {
  errors++
  console.log('[pageerror]', String(e).slice(0, 300))
})
page.on('requestfailed', (r) => {
  if (!r.url().includes('nominatim')) console.log('[reqfail]', r.url().slice(0, 140), r.failure()?.errorText)
})
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(9000) // let catalog + windows + GPU settle
await page.screenshot({ path: out })
console.log(`screenshot: ${out}, console errors: ${errors}`)
await browser.close()
process.exit(0)
