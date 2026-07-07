import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const attrib = async (label) => {
  const t = await page.evaluate(() => {
    const els = document.querySelectorAll('.maplibregl-ctrl-attrib')
    return [...els].map((e) => `visible=${!!(e.offsetWidth || e.offsetHeight)} text="${e.textContent.trim().slice(0, 120)}"`)
  })
  console.log(label, '→', t.length ? t.join(' | ') : 'NO CONTROL')
}
await page.goto('http://localhost:5173/#m=auto&p=temperature&v=8.55,47.37,6', { waitUntil: 'load' })
await page.waitForTimeout(8000)
await attrib('initial (globe)')
// flat projection via the custom control
await page.click('.wx-projection-toggle')
await page.waitForTimeout(2500)
await attrib('after flat toggle')
await page.click('.wx-projection-toggle')
await page.waitForTimeout(2500)
await attrib('back to globe')
// terrain on/off via panel
await page.click('.preset-menu-btn')
await page.waitForTimeout(500)
await page.click('.settings-toggle')
await page.waitForTimeout(400)
await page.locator('.checkbox-label', { hasText: 'Terrain' }).locator('input').click()
await page.waitForTimeout(2500)
await attrib('terrain ON')
await page.locator('.checkbox-label', { hasText: 'Terrain' }).locator('input').click()
await page.waitForTimeout(2500)
await attrib('terrain OFF')
// model switch via status badge select
await page.selectOption('.status-badge-select', 'icond2')
await page.waitForTimeout(3000)
await attrib('model icond2')
await browser.close()
