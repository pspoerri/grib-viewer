import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 150)))
await page.goto('http://localhost:5173/#m=auto&p=temperature&v=8.55,47.37,6', { waitUntil: 'load' })
await page.waitForTimeout(8000)
await page.mouse.click(950, 450)
await page.waitForTimeout(3000)
console.log('popup open:', await page.locator('.point-popup').count())
console.log('close-btn present:', await page.locator('.point-popup .close-btn').count())
const box = await page.locator('.point-popup .close-btn').boundingBox().catch(() => null)
console.log('close-btn box:', JSON.stringify(box))
// what element actually receives the click at the button center?
if (box) {
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return el ? `${el.tagName}.${el.className}` : 'none'
  }, [box.x + box.width / 2, box.y + box.height / 2])
  console.log('elementFromPoint:', hit)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  console.log('popup after Escape:', await page.locator('.point-popup').count())
}
await browser.close()
