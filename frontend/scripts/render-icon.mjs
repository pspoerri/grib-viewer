// Render favicon.svg to apple-touch-icon.png (180x180) via headless Chrome.
import { chromium } from 'playwright-core'
import { readFileSync } from 'fs'
const svg = readFileSync('public/favicon.svg', 'utf8')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 180, height: 180 } })
await page.setContent(`<body style="margin:0">${svg.replace('viewBox', 'width="180" height="180" viewBox')}</body>`)
await page.screenshot({ path: 'public/apple-touch-icon.png' })
console.log('rendered')
await browser.close()
