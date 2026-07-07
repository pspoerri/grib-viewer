import { chromium } from 'playwright-core'
const [out] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5173/#m=auto&p=temperature&v=8.55,47.37,6', { waitUntil: 'load' })
await page.waitForTimeout(8000)
// the ⭐ topic tile is the last preset-topic button
await page.locator('.preset-topic-btn').last().click()
await page.waitForTimeout(600)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 720, height: 220 } })
// also load the server preset to prove the layer grammar decodes
const btn = page.locator('.preset-sub-btn', { hasText: 'Storm watch' })
console.log('storm-watch buttons:', await btn.count())
await btn.first().click()
await page.waitForTimeout(6000)
await page.screenshot({ path: out.replace('.png', '-loaded.png') })
await browser.close()
