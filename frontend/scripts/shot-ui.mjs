// Screenshot helper for chrome states: opens the hamburger panel and/or
// clicks the map to raise the point popup before capturing.
//   node scripts/shot-ui.mjs <url> <out.png> [panel] [popup]
import { chromium } from 'playwright-core'
const [url, out, ...flags] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(8000)
if (flags.includes('panel')) {
  await page.click('.preset-menu-btn')
  await page.waitForTimeout(1200)
}
if (flags.includes('popup')) {
  await page.mouse.click(950, 450)
  await page.waitForTimeout(12000)
}
await page.screenshot({ path: out })
console.log('saved', out)
await browser.close()
