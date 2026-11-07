import { expect, test } from '@playwright/test'
import { settledWidth, waitForCam } from './helpers'

// Each test gets a fresh browser context (empty IndexedDB), so the app opens on the home screen.
// A new project opens on Settings; most tests start drawing, so they move on to Design.
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Design', exact: true }).click()
})

test('loads the app shell', async ({ page }) => {
  await expect(page).toHaveTitle('Untitled – OpenCarve')
  for (const name of ['Settings', 'Design', 'Simulate', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
})

test('Settings hides the 3D preview and widens the panel', async ({ page }) => {
  const panel = page.locator('.panel')
  const preview = page.getByLabel('3D carve preview')
  await expect(preview).toBeVisible()
  const narrow = 280 // the Design panel column
  expect(await settledWidth(panel)).toBe(narrow)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(preview).toBeHidden()
  expect(await settledWidth(panel)).toBeGreaterThan(narrow + 200)
  await expect(page.getByLabel('Design canvas')).toBeVisible()
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await expect(preview).toBeVisible()
  expect(await settledWidth(panel)).toBe(narrow)
})

test('a stock change on Settings after orbiting re-frames the 3D view on return', async ({ page }) => {
  const preview = page.getByLabel('3D carve preview')
  const panelWidth = async () => (await page.locator('.panel').boundingBox())!.width
  await expect.poll(panelWidth).toBe(280) // the step transition is over
  await expect(preview).toHaveAttribute('data-view-distance', /\d/)
  const b = (await preview.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30, { steps: 5 })
  await page.mouse.up()
  // The width transition can leave the renderer at a tiny size before the preview reaches 0 wide; pin that state.
  const tiny = await page.addStyleTag({ content: '.app.step-settings .preview3d { flex-basis: 12px !important }' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeLessThan(20)
  await page.waitForTimeout(100) // let the ResizeObserver resize the renderer
  await tiny.evaluate((el) => (el as Element).remove())
  await expect(preview).toBeHidden()
  const width = page.getByLabel('Width', { exact: true })
  await width.fill('500')
  await width.press('Enter')
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await expect(preview).toBeVisible()
  await expect.poll(panelWidth).toBe(280)
  const distance = async () => Number(await preview.getAttribute('data-view-distance'))
  // A view framed on the collapsed canvas would be far away; polled, as a resize redraws on the next frame.
  await expect.poll(distance).toBeLessThan(10)
  const back = await distance()
  await page.getByRole('button', { name: 'Reset view' }).click()
  expect(await distance()).toBeCloseTo(back, 2)
})

test('Design with nothing selected summarises the project and links to Settings', async ({ page }) => {
  const summary = page.getByRole('region', { name: 'Project settings' })
  await expect(summary).toContainText('MDF')
  await expect(summary).toContainText('300.00 × 200.00 × 12.00 mm')
  await expect(summary).toContainText('bottom-left corner')
  await summary.getByRole('button', { name: 'Edit in Settings' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Rough bit')).toBeVisible()
})

test('draws a rectangle and undoes it', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect(page.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'true')
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 60, cy - 40)
  await page.mouse.down()
  await page.mouse.move(cx, cy, { steps: 4 })
  await page.mouse.move(cx + 60, cy + 40, { steps: 4 })
  await page.mouse.up()

  const shapes = page.locator('[data-id]')
  await expect(shapes).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
  const w = parseFloat(await page.getByLabel('W', { exact: true }).inputValue())
  const h = parseFloat(await page.getByLabel('H', { exact: true }).inputValue())
  expect(w).toBeGreaterThan(0)
  expect(w / h).toBeCloseTo(1.5, 1)
  await expect(page.getByLabel('3D carve preview')).toBeVisible()
  await expect(page.getByText('Simulating…')).toBeHidden({ timeout: 10_000 })

  await page.keyboard.press('ControlOrMeta+z')
  await expect(shapes).toHaveCount(0)
})

test('snaps a drawn rectangle to the grid, unless Alt is held', async ({ page }) => {
  const snap = page.getByRole('button', { name: 'Snap', exact: true })
  await snap.click()
  await expect(snap).toHaveAttribute('aria-pressed', 'true')
  await page.getByLabel('Snap size').selectOption({ label: '10 mm' })
  await expect(page.locator('.grid-step')).toHaveText('Grid 10 mm') // the minor grid shows the snap size
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const draw = async () => {
    await page.getByRole('button', { name: 'Rectangle' }).click()
    await page.mouse.move(cx - 63, cy - 37)
    await page.mouse.down()
    await page.mouse.move(cx + 58, cy + 41, { steps: 4 })
    await page.mouse.up()
    const v = async (label: string) => parseFloat(await page.getByLabel(label, { exact: true }).inputValue())
    const [x, y, w, h] = [await v('X'), await v('Y'), await v('W'), await v('H')]
    return [x - w / 2, y - h / 2, w, h] // X/Y are the centre; the corner and size land on the grid
  }
  const onGrid = (v: number) => Math.abs(v / 10 - Math.round(v / 10)) < 1e-6
  const snapped = await draw()
  expect(snapped.every(onGrid), String(snapped)).toBe(true)
  await page.keyboard.down('Alt')
  const free = await draw()
  await page.keyboard.up('Alt')
  expect(free.every(onGrid), String(free)).toBe(false)
  await page.keyboard.press('g')
  await expect(snap).toHaveAttribute('aria-pressed', 'false')
})

test('draws a path with the pen tool', async ({ page }) => {
  await page.getByRole('button', { name: 'Pen' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  for (const [dx, dy] of [[-50, 0], [50, 0], [0, 60]]) await page.mouse.click(cx + dx, cy + dy)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Path')
})

test('draws a curved path by dragging pen nodes', async ({ page }) => {
  await page.getByRole('button', { name: 'Pen' }).click()
  await expect(page.getByText('Click for corners · drag for curves · Enter to finish')).toBeVisible()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x - 60, y)
  await page.mouse.down()
  await page.mouse.move(x - 60, y - 45, { steps: 4 })
  await page.mouse.up()
  await page.mouse.move(x + 60, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y + 45, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.pen-control')).toHaveCount(4)
  await page.keyboard.press('Enter')
  const d = await page.locator('[data-id] path:not(.hit)').getAttribute('d')
  expect((d?.match(/L/g) ?? []).length).toBeGreaterThan(10)
})

test('edits a completed path through its anchors and handles', async ({ page }) => {
  await page.getByRole('button', { name: 'Pen' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x - 50, y)
  await page.mouse.down()
  await page.mouse.move(x - 50, y - 35, { steps: 4 })
  await page.mouse.up()
  await page.mouse.click(x + 50, y)
  await page.keyboard.press('Enter')
  await expect(page.locator('.path-anchor')).toHaveCount(2)
  await expect(page.locator('.path-control')).toHaveCount(2)
  const line = page.locator('[data-id] path:not(.hit)')
  const before = await line.getAttribute('d')
  const anchor = page.locator('.path-anchor').first()
  const position = await anchor.boundingBox()
  if (!position) throw new Error('missing path anchor')
  await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2)
  await page.mouse.down()
  await page.mouse.move(position.x + position.width / 2, position.y - 35, { steps: 4 })
  await page.mouse.up()
  await expect(line).not.toHaveAttribute('d', before!)
  const afterAnchor = await line.getAttribute('d')
  const control = page.locator('.path-control').first()
  const controlPosition = await control.boundingBox()
  if (!controlPosition) throw new Error('missing path control')
  await page.mouse.move(controlPosition.x + controlPosition.width / 2, controlPosition.y + controlPosition.height / 2)
  await page.mouse.down()
  await page.mouse.move(controlPosition.x + 24, controlPosition.y + controlPosition.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(line).not.toHaveAttribute('d', afterAnchor!)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(line).toHaveAttribute('d', afterAnchor!)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(line).toHaveAttribute('d', before!)
})

test('places a text shape with the text tool', async ({ page }) => {
  await page.getByRole('button', { name: 'Text' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Text')
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
})

test('bends a text and makes it two lines', async ({ page }) => {
  await page.getByRole('button', { name: 'Text' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const content = page.getByLabel('Text', { exact: true })
  await content.fill('Hello world')
  await content.press('Escape')
  const w = page.getByLabel('W', { exact: true })
  const h = page.getByLabel('H', { exact: true })
  const [w0, h0] = [parseFloat(await w.inputValue()), parseFloat(await h.inputValue())]

  const bend = page.getByLabel('Bend °', { exact: true })
  await bend.fill('90')
  await bend.press('Enter')
  await expect(page.getByRole('slider', { name: 'Bend' })).toHaveValue('90')
  await expect.poll(async () => parseFloat(await w.inputValue())).not.toBe(w0)
  await expect.poll(async () => parseFloat(await h.inputValue())).toBeGreaterThan(h0)
  const h1 = parseFloat(await h.inputValue())

  await content.fill('Hello\nworld')
  await content.press('Escape')
  await expect(content).toHaveValue('Hello\nworld')
  await expect.poll(async () => parseFloat(await h.inputValue())).toBeGreaterThan(h1)
})

test('imports an SVG file', async ({ page }) => {
  await page.locator('input[accept*=svg]').setInputFiles('e2e/fixtures/shapes.svg')
  await expect(page.locator('[data-id]')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: '3 shapes' })).toBeVisible()
})

test('sets a rectangle to a pocket cut', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  const shape = page.locator('[data-id]')
  await expect(shape).toHaveAttribute('data-cut', 'outline')
  await expect(page.getByRole('heading', { name: 'Cut' })).toBeVisible()
  await page.getByRole('radio', { name: 'Pocket' }).click()
  await expect(shape).toHaveAttribute('data-cut', 'pocket')
  const depth = page.getByLabel('Depth value', { exact: true })
  await expect(depth).toHaveValue('3.00') // a through depth becomes a pocket-sized default
  await depth.fill('3')
  await depth.press('Enter')
  await expect(depth).toHaveValue('3.00')
  await expect(page.getByRole('slider', { name: 'Depth' })).toHaveValue('3')
  await expect(page.getByLabel('Tabs')).toHaveCount(0)
  await expect(page.getByLabel('Bit usage')).toHaveValue('auto')
  await expect(page.getByLabel('Bit usage').locator('option')).toHaveCount(2)
  await expect(page.getByLabel('Pre-cut pocket edges')).toBeDisabled()
  const radius = page.getByLabel('Corner radius')
  await expect(radius).toHaveValue('0.00')
  await radius.fill('8')
  await radius.press('Enter')
  await expect(radius).toHaveValue('8.00')
  const fillet = page.getByRole('radiogroup', { name: 'Bottom fillet' })
  await expect(fillet.getByRole('radio', { name: 'None' })).toBeChecked()
  await fillet.getByRole('radio', { name: 'Concave' }).click()
  const filletRadius = page.getByLabel('Fillet radius')
  await expect(filletRadius).toHaveValue('0.00')
  await filletRadius.fill('5')
  await filletRadius.press('Enter')
  await expect(filletRadius).toHaveValue('3.00') // clamped to the pocket depth
  const filletStepdown = page.getByLabel('Fillet stepdown')
  await expect(filletStepdown).toHaveValue('0.00')
  await filletStepdown.fill('0.5')
  await filletStepdown.press('Enter')
  await expect(filletStepdown).toHaveValue('0.50')
  await fillet.getByRole('radio', { name: 'Convex' }).click()
  await expect(fillet.getByRole('radio', { name: 'Convex' })).toBeChecked()
  const pattern = page.getByLabel('Pocket pattern')
  await expect(pattern).toHaveValue('concentric')
  await expect(pattern.locator('option')).toHaveCount(5)
  await pattern.selectOption('raster')
  const angle = page.getByLabel('Pattern angle °')
  await expect(angle).toHaveValue('0')
  await angle.fill('225')
  await angle.press('Enter')
  await expect(angle).toHaveValue('45')
})

test('creates a positive relief pocket with a protected inner island', async ({ page }) => {
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const draw = async (x: number, y: number, w: number, h: number) => {
    await page.getByRole('button', { name: 'Rectangle' }).click()
    await page.mouse.move(x - w / 2, y - h / 2)
    await page.mouse.down()
    await page.mouse.move(x + w / 2, y + h / 2)
    await page.mouse.up()
  }
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await draw(x, y, 140, 100)
  await draw(x, y, 50, 40)
  await page.keyboard.down('Shift')
  await page.mouse.click(x - 70, y - 50)
  await page.keyboard.up('Shift')
  await expect(page.getByRole('button', { name: 'Make positive relief' })).toBeEnabled()
  await page.getByRole('button', { name: 'Make positive relief' }).click()
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.locator('[data-id]')).toHaveAttribute('data-cut', 'pocket')
  await page.getByRole('button', { name: /^Simulate/ }).click()
  await waitForCam(page)
  await expect(page.locator('.toolpath-rough')).toHaveAttribute('d', /M/)
})

test('assigns a shape exclusively to the detail bit', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Add bit' }).click()
  await page.getByLabel('Detail bit').selectOption('1mm-endmill')
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await page.getByLabel('Bit usage').selectOption('detail')

  await page.getByRole('button', { name: /^Simulate/ }).click()
  await waitForCam(page)
  await expect(page.locator('.op-list').getByRole('button')).toContainText('Detail bit')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download Rough G-code' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Download Detail G-code' })).toBeEnabled()
})

test('an edge pre-cut runs the smallest of three configured bits first', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Rough bit').selectOption('6mm-endmill')
  await page.getByRole('button', { name: 'Add bit' }).click()
  await page.getByLabel('Detail bit').selectOption('1/8-endmill')
  await page.getByRole('button', { name: 'Add bit' }).click()
  await expect(page.getByLabel('Bit 3 bit')).toHaveValue('1mm-endmill')

  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('radio', { name: 'Pocket' }).click()
  await expect(page.getByLabel('Bit usage')).toHaveValue('auto')
  await expect(page.getByLabel('Bit usage').locator('option')).toHaveCount(4)
  await page.getByLabel('Pre-cut pocket edges').check()

  await page.getByRole('button', { name: /^Simulate/ }).click()
  await waitForCam(page)
  const ops = page.locator('.op-list').getByRole('button')
  await expect(ops).toHaveCount(4)
  await expect(ops.nth(0)).toContainText('Pocket edge pre-cut · Bit 3 bit')
  await expect(ops.nth(1)).toContainText('Bit 3 bit')
  await expect(ops.nth(2)).toContainText('Rough bit')
  await expect(ops.nth(3)).toContainText('Detail bit')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.locator('.export-bit').first()).toContainText('Bit 3')
})

test('exports G-code for a rectangle', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const button = page.getByRole('button', { name: 'Download Rough G-code' })
  await expect(button).toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  expect(download.suggestedFilename()).toMatch(/^Untitled-.*\.nc$/)
  const gcode = await (await download.createReadStream()).toArray()
  expect(Buffer.concat(gcode).toString()).toContain('G21 G90 G17')
})

test('exports a V-carve with a V-bit as the detail bit', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Add bit' }).click()
  await page.getByLabel('Detail bit').selectOption('90-vbit')
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  await page.getByRole('radio', { name: 'V-carve' }).click()
  await expect(page.locator('[data-id]')).toHaveAttribute('data-cut', 'vcarve')
  await expect(page.getByRole('slider', { name: 'Max depth' })).toBeVisible()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download Detail G-code' })).toBeEnabled()
})

test('simulate lists ops and selects the shape', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-id].selected')).toHaveCount(0)

  await page.getByRole('button', { name: /^Simulate/ }).click()
  await waitForCam(page)
  const rows = page.locator('.op-list').getByRole('button')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Outline outside')
  await expect(page.getByText(/^about \d+:\d\d$/)).toBeVisible()
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-id].selected')).toHaveCount(1)
  await expect(page.locator('.toolpaths.highlight')).toHaveCount(1)
  await expect(page.locator('.selection-frame polygon')).toHaveCount(1)
  await expect(page.locator('.handle')).toHaveCount(0) // no scale/rotate handles outside Design

  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Rectangle')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download Rough G-code' })).toBeEnabled()
})

test('badges the Simulate step when a shape is partly outside the stock', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Simulate', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 100, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('button', { name: /^Simulate/ }).click()
  await waitForCam(page)
  await expect(page.getByRole('button', { name: 'Simulate 1 warning' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Warnings' })).toContainText('partly outside the stock')
})

test('overrides the rough bit diameter and resets it', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const rough = page.getByRole('group', { name: 'Rough dimensions' })
  const diameter = rough.getByLabel('Diameter (mm)')
  const custom = rough.getByText('Custom', { exact: true })
  await expect(diameter).toHaveValue('3.175')
  await expect(custom).toBeHidden()
  await diameter.fill('0')
  await diameter.press('Enter')
  await expect(diameter).toHaveAttribute('aria-invalid', 'true')
  await expect(diameter).toHaveAccessibleDescription('Diameter must be 0.1–50 mm')
  await expect(custom).toBeHidden()
  await diameter.fill('6')
  await diameter.press('Enter')
  await expect(custom).toBeVisible()
  await expect(diameter).not.toHaveAttribute('aria-invalid')
  await expect(diameter).toHaveValue('6')
  await expect(page.getByLabel('Stepdown')).toHaveValue('3.00')
  await rough.getByRole('button', { name: 'Reset rough bit' }).click()
  await expect(custom).toBeHidden()
  await expect(diameter).toHaveValue('3.175')
  await expect(page.getByLabel('Stepdown')).toHaveValue('1.60')
})

test('adds a custom G-code header and replaces the standard lines', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const header = page.getByLabel('Before the toolpaths')
  await header.fill('M8')
  await header.press('Escape')
  await expect(page.getByLabel('G-code preview')).toContainText('M8')
  await header.fill('M8\nG20')
  await expect(header).toHaveAttribute('aria-invalid', 'true')
  await header.press('Escape')
  await expect(header).toHaveValue('M8') // the rejected edit isn't kept
  const rough = async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const button = page.getByRole('button', { name: 'Download Rough G-code' })
    await expect(button).toBeEnabled()
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
    return Buffer.concat(await (await download.createReadStream()).toArray()).toString().split('\n')
  }
  const lines = await rough()
  expect(lines.indexOf('M8')).toBeGreaterThan(lines.indexOf('G21 G90 G17 G94'))
  expect(lines.indexOf('M8')).toBeLessThan(lines.findIndex((l) => l.startsWith('M3')))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Replace the standard header and footer' }).check()
  await expect(page.getByText("Custom G-code header doesn't start the spindle (M3/M4).")).toBeVisible()
  const replaced = await rough()
  expect(replaced).toContain('M8')
  expect(replaced.some((l) => l.startsWith('M3'))).toBe(false)
  expect(replaced).not.toContain('G21 G90 G17 G94')
})
