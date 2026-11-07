import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { DEFAULT_TEXT_LAYOUT, defaultCut, newProject, type Project } from '../model'
import { scaleShape, textAtSize } from './geometry'
import { parseProject, parseProjectFile, serializeProject } from './projectFile'

const sample = (): Project => ({
  ...newProject(),
  name: 'Sign',
  units: 'in',
  bits: { rough: '1/8-endmill', detail: '90-vbit' },
  bitOrder: ['rough', 'detail'],
  cutSettings: { ...newProject().cutSettings, detail: { ...newProject().cutSettings.rough, feed: 900 } },
  cutSettingsCustom: { rough: false, detail: true },
  bitOverrides: { rough: { diameter: 3 }, detail: { angle: 60, flat: 0.5 } },
  gcode: { header: 'M8\n(coolant on)', footer: 'M9', replaceDefaults: true },
  shapes: [
    { id: 'a', type: 'rect', name: 'Rect', x: 10, y: 20, rotation: 15, w: 30, h: 40, cut: defaultCut(12) },
    { id: 'b', type: 'text', name: 'Text', x: 50, y: 50, rotation: 0, text: 'Hi\nthere', font: 'lora', size: 20, w: 18, h: 14, letterSpacing: -1.5, lineHeight: 0.9, align: 'right', arc: -120, mirror: true },
    { id: 'c', type: 'compound', name: 'Logo', x: 0, y: 0, rotation: 0, fillRule: 'evenodd', paths: [{ closed: true, points: [[0, 0], [5, 0], [5, 5]] }] },
    { id: 'd', type: 'path', name: 'Path', x: 1, y: 1, rotation: 0, closed: false, points: [[0, 0], [9, 9]], cut: { ...defaultCut(12), type: 'outline', side: 'on' } },
  ],
})

const file = (project: unknown, extra = {}) => JSON.stringify({ format: 'opencarve', version: 11, project, ...extra })

// A fresh project with a detail bit and one carved shape of every type.
const everyShape = (): Project => {
  const p = newProject()
  const cut = defaultCut(p.stock.thickness)
  const base = { x: 10, y: 10, rotation: 0, cut }
  return {
    ...p,
    bits: { rough: '1/8-endmill', detail: '90-vbit' },
    bitOrder: ['rough', 'detail'],
    cutSettings: { ...p.cutSettings, detail: p.cutSettings.rough },
    cutSettingsCustom: { rough: false, detail: false },
    shapes: [
      { ...base, id: 'r', type: 'rect', name: 'Rect', w: 5, h: 5 },
      { ...base, id: 'e', type: 'ellipse', name: 'Ellipse', w: 5, h: 5 },
      { ...base, id: 'p', type: 'polygon', name: 'Polygon', w: 5, h: 5, sides: 6 },
      { ...base, id: 'l', type: 'path', name: 'Path', closed: true, points: [[0, 0], [5, 0], [5, 5]] },
      { ...base, id: 't', type: 'text', name: 'Text', text: 'A', font: 'roboto', size: 10, w: 5, h: 7, ...DEFAULT_TEXT_LAYOUT },
      { ...base, id: 'c', type: 'compound', name: 'Logo', paths: [{ closed: true, points: [[0, 0], [5, 0], [5, 5]] }] },
    ],
  }
}

test('round-trips a project', () => {
  for (const p of [sample(), everyShape()]) expect(parseProject(serializeProject(p))).toEqual(p)
})

test('round-trips Bézier path nodes and accepts v7 polylines', () => {
  const p = sample()
  const path = p.shapes.find((s) => s.type === 'path')!
  if (path.type !== 'path') throw new Error('expected a path')
  path.nodes = [{ point: [0, 0], out: [2, 4] }, { point: [9, 9], in: [7, 5] }]
  expect(parseProject(serializeProject(p))).toEqual(p)
  const v7 = JSON.parse(serializeProject(p))
  v7.version = 7
  delete v7.project.shapes.find((s: { type: string }) => s.type === 'path').nodes
  const migrated = parseProject(JSON.stringify(v7))
  expect(migrated.shapes.find((s) => s.type === 'path')).not.toHaveProperty('nodes')
  const broken = JSON.parse(serializeProject(p))
  broken.project.shapes.find((s: { type: string }) => s.type === 'path').nodes[0].point = [0, 'bad']
  expect(() => parseProject(JSON.stringify(broken))).toThrow('shapes[3].nodes[0].point has a bad point')
})

test('round-trips an ordered extensible bit list and validates its order', () => {
  const p = sample()
  const role = 'tool-fine' as const
  p.bits[role] = '1mm-endmill'
  p.bitOrder.push(role)
  p.cutSettings[role] = { ...p.cutSettings.rough, feed: 400 }
  p.cutSettingsCustom[role] = true
  p.shapes[0].cut = { ...p.shapes[0].cut!, type: 'pocket', bit: role }
  expect(parseProject(serializeProject(p))).toEqual(p)
  for (const bitOrder of [['rough', 'detail'], ['detail', 'rough', role], ['rough', role, role]]) {
    expect(() => parseProject(file({ ...p, bitOrder }))).toThrow(/bitOrder must contain every configured bit exactly once/)
  }
})

// Deletes a field at a message-style path (e.g. shapes[4].font); top-level scalars are reported as project.<key>.
const without = (p: Project, path: string) => {
  const data = JSON.parse(serializeProject(p))
  const keys = path.replace(/^project\./, '').split(/[.[\]]+/).filter(Boolean)
  const parent = keys.slice(0, -1).reduce((o, k) => o[k], data.project)
  delete parent[keys.at(-1)!]
  return JSON.stringify(data)
}

test('a missing field is rejected with its path', () => {
  const paths = [
    'project.name', 'project.units', 'project.materialId', 'machine', 'bits', 'bitOrder', 'bitOverrides',
    'cutSettings', 'cutSettings.rough', 'cutSettings.detail', 'cutSettings.rough.feed', 'cutSettings.detail.direction',
    'cutSettingsCustom', 'cutSettingsCustom.rough', 'cutSettingsCustom.detail',
    'origin', 'origin.preset', 'origin.x', 'origin.y', 'origin.z',
    'gcode', 'gcode.header', 'gcode.footer', 'gcode.replaceDefaults',
    ...['name', 'rotation'].map((k) => `shapes[0].${k}`), 'shapes[2].sides', 'shapes[3].closed', 'shapes[5].paths[0].closed',
    ...['font', 'letterSpacing', 'lineHeight', 'align', 'arc', 'mirror'].map((k) => `shapes[4].${k}`),
    ...['type', 'bit', 'pocketPattern', 'pocketAngle', 'pocketPrecut', 'pocketRadius', 'pocketFillet', 'pocketFilletRadius', 'pocketFilletStepdown', 'side', 'depth', 'tabs', 'tabCount', 'tabWidth', 'tabHeight'].map((k) => `shapes[1].cut.${k}`),
  ]
  expect(() => parseProject(without(everyShape(), 'project.id'))).toThrow('Invalid project file: project.id is missing')
  expect(() => parseProject(without(everyShape(), 'bitOrder'))).toThrow('Invalid project file: bitOrder is missing')
  for (const path of paths) expect(() => parseProject(without(everyShape(), path)), path).toThrow(`Invalid project file: ${path} is missing`)
  // cut and fillRule are optional by design: no cut means not carved, no fillRule means non-zero.
  const plain = parseProject(without(everyShape(), 'shapes[0].cut'))
  expect(plain.shapes[0]).not.toHaveProperty('cut')
  expect(plain.shapes[0]).not.toHaveProperty('fillRule')
  // Every configured bit must appear exactly once in the ordered tool list.
  expect(() => parseProject(without(everyShape(), 'bits.detail'))).toThrow('Invalid project file: bitOrder must contain every configured bit exactly once, with rough first')
})

test('custom G-code: printable ASCII, tabs and line breaks, no G20/G91/G93 in the header, at most 20 000 characters', () => {
  const g = (patch: object) => file({ ...sample(), gcode: { ...sample().gcode, ...patch } })
  expect(parseProject(g({ header: 'G54\r\nM8 ; ok ~', footer: 'x'.repeat(20_000) })).gcode.header).toBe('G54\r\nM8 ; ok ~')
  expect(parseProject(g({ header: 'G21\tG90 (not G20) ; G91 later', footer: 'G91 G0 Z10\nG20' })).gcode.footer).toBe('G91 G0 Z10\nG20')
  // A Fusion 360 style header is fine: G91.1 only sets the arc-centre mode.
  expect(parseProject(file({ ...sample(), gcode: { header: 'G90 G94 G91.1 G40 G49 G17', footer: '', replaceDefaults: false } })).gcode.header).toBe('G90 G94 G91.1 G40 G49 G17')
  for (const [key, bad] of [['header', 'M3 S1000 °'], ['footer', 'M5\u0007M2'], ['header', 'é'], ['footer', 'x'.repeat(20_001)], ['header', 'G20'], ['header', 'G21 G020'], ['header', 'G90G91'], ['header', 'G93 G1 X1 F2']]) {
    expect(() => parseProject(g({ [key]: bad }))).toThrow(`Invalid project file: gcode.${key} `)
  }
  expect(() => parseProject(g({ header: 3 }))).toThrow('gcode.header must be a string')
  expect(() => parseProject(g({ replaceDefaults: 'yes' }))).toThrow('gcode.replaceDefaults must be true or false')
})

test('work zero: round-trips, validates and clamps', () => {
  const p = { ...sample(), origin: { preset: 'custom' as const, x: 12.5, y: 40, z: 'bottom' as const } }
  expect(JSON.parse(serializeProject(p)).version).toBe(11)
  expect(parseProject(serializeProject(p))).toEqual(p)
  const legacy = JSON.parse(serializeProject(p))
  legacy.version = 2
  for (const shape of legacy.project.shapes) {
    if (!shape.cut) continue
    delete shape.cut.bit
    delete shape.cut.pocketPattern
    delete shape.cut.pocketAngle
  }
  expect(parseProject(JSON.stringify(legacy))).toEqual(p)
  const v3 = JSON.parse(serializeProject(p))
  v3.version = 3
  for (const shape of v3.project.shapes) {
    if (!shape.cut) continue
    delete shape.cut.pocketPattern
    delete shape.cut.pocketAngle
  }
  expect(parseProject(JSON.stringify(v3))).toEqual(p)
  const v4 = JSON.parse(serializeProject(p))
  v4.version = 4
  expect(parseProject(JSON.stringify(v4))).toEqual(p)
  const v5 = JSON.parse(serializeProject(p))
  v5.version = 5
  delete v5.project.bitOrder
  expect(parseProject(JSON.stringify(v5))).toEqual(p)
  const v6 = JSON.parse(serializeProject(p))
  v6.version = 6
  for (const shape of v6.project.shapes) if (shape.cut) delete shape.cut.pocketPrecut
  expect(parseProject(JSON.stringify(v6))).toEqual(p)
  const old = sample()
  const v7 = JSON.parse(serializeProject(p))
  v7.version = 7
  for (const shape of v7.project.shapes) if (shape.cut) delete shape.cut.pocketRadius
  expect(parseProject(JSON.stringify(v7))).toEqual(p)
  const v8 = JSON.parse(serializeProject(p))
  v8.version = 8
  for (const shape of v8.project.shapes) if (shape.cut) delete shape.cut.pocketRadius
  expect(parseProject(JSON.stringify(v8))).toEqual(p)
  const v9 = JSON.parse(serializeProject(p))
  v9.version = 9
  for (const shape of v9.project.shapes) {
    if (!shape.cut) continue
    delete shape.cut.pocketFillet
    delete shape.cut.pocketFilletRadius
  }
  expect(parseProject(JSON.stringify(v9))).toEqual(p)
  const v10 = JSON.parse(serializeProject(p))
  v10.version = 10
  for (const shape of v10.project.shapes) if (shape.cut) delete shape.cut.pocketFilletStepdown
  expect(parseProject(JSON.stringify(v10))).toEqual(p)
  expect(() => parseProject(file(p, { version: 1 }))).toThrow('unsupported version 1')
  // Presets are re-derived from the stock.
  expect(parseProject(file({ ...old, origin: { preset: 'center', x: 1, y: 2, z: 'top' } })).origin).toMatchObject({ x: 150, y: 100 })
  const warnings: string[] = []
  expect(parseProject(file({ ...old, origin: { preset: 'custom', x: -5, y: 900, z: 'top' } }), warnings).origin).toMatchObject({ x: 0, y: 200 })
  expect(warnings).toEqual(['Work zero was outside the stock; moved to (0, 200) mm.'])
  expect(() => parseProject(file({ ...old, origin: { preset: 'middle' } }))).toThrow(/origin.preset/)
  expect(() => parseProject(file({ ...old, origin: { preset: 'custom', x: 'a' } }))).toThrow(/origin.x/)
  const full = { preset: 'custom', x: 1, y: 2, z: 'top' }
  expect(() => parseProject(file({ ...old, origin: { ...full, z: 'side' } }))).toThrow(/origin.z/)
  expect(() => parseProject(file({ ...old, origin: { ...full, x: null } }))).toThrow('Invalid project file: origin.x must be a number')
  expect(() => parseProject(file({ ...old, origin: null }))).toThrow(/origin must be an object/)
})

test('rejects garbage', () => {
  expect(() => parseProject('not json')).toThrow(/not JSON/)
  expect(() => parseProject('{"format":"svg"}')).toThrow(/not an OpenCarve project/)
  expect(() => parseProject(file(sample(), { version: 12 }))).toThrow('Invalid project file: unsupported version 12 (this app reads version 11)')
  expect(() => parseProject(file({ ...sample(), shapes: 'x' }))).toThrow(/shapes must be an array/)
  expect(() => parseProject(file({ ...sample(), stock: { w: NaN, h: 1, thickness: 1 } }))).toThrow(/stock.w/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'blob', x: 0, y: 0 }] }))).toThrow(/shapes\[0\].type/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'rect', name: 'R', x: 0, y: 0, rotation: 0, w: 1, h: -1 }] }))).toThrow(/shapes\[0\].h must be a number ≥ 0/)
})

test('validates cuts', () => {
  const rect = { id: 'a', type: 'rect', name: 'R', x: 0, y: 0, rotation: 0, w: 5, h: 5, cut: { ...defaultCut(6), type: 'pocket', depth: 99, tabCount: 0, pocketPattern: 'raster', pocketAngle: 225, pocketRadius: -2, pocketFillet: 'concave' as const, pocketFilletRadius: 8 } }
  expect(() => parseProject(file({ ...sample(), stock: { w: 100, h: 80, thickness: 6 }, shapes: [rect] }))).toThrow(/cut.pocketRadius/)
  rect.cut.pocketRadius = 2
  const p = parseProject(file({ ...sample(), stock: { w: 100, h: 80, thickness: 6 }, shapes: [rect] }))
  expect(p.shapes[0]).toMatchObject({ cut: { type: 'pocket', depth: 6, tabCount: 1, pocketPattern: 'raster', pocketAngle: 45, pocketRadius: 2, pocketFillet: 'concave', pocketFilletRadius: 6 } })
  expect(() => parseProject(file({ ...sample(), shapes: [{ ...rect, cut: { ...rect.cut, bit: 'laser' } }] }))).toThrow(/cut.bit/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ ...rect, cut: { ...rect.cut, pocketPattern: 'waves' } }] }))).toThrow(/cut.pocketPattern/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ ...rect, cut: { ...rect.cut, pocketFillet: 'undercut' } }] }))).toThrow(/cut.pocketFillet/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ ...rect, cut: { ...rect.cut, pocketFilletRadius: -1 } }] }))).toThrow(/cut.pocketFilletRadius/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ ...rect, cut: { ...rect.cut, pocketFilletStepdown: -1 } }] }))).toThrow(/cut.pocketFilletStepdown/)
})

test('rejects unknown bits and invalid cut settings', () => {
  expect(() => parseProject(file({ ...sample(), bits: { rough: 'laser' } }))).toThrow(/unknown bit laser/)
  expect(() => parseProject(file({ ...sample(), bits: { rough: '1/8-endmill', detail: 'nope' } }))).toThrow(/unknown bit nope/)
  const rough = newProject().cutSettings.rough
  for (const key of ['feed', 'plunge', 'stepdown', 'rpm']) {
    expect(() => parseProject(file({ ...sample(), cutSettings: { rough: { ...rough, [key]: 0 } } }))).toThrow(new RegExp(`${key} must be > 0`))
  }
  expect(() => parseProject(file({ ...sample(), cutSettings: { rough: { ...rough, safeZ: 0.2 } } }))).toThrow(/safeZ/)
})

test('maps unknown material and font ids to defaults with warnings', () => {
  const warnings: string[] = []
  const text = { ...textIn('comic', 't') }
  const p = parseProject(file({ ...sample(), materialId: 'unobtainium', shapes: [text, { ...text, id: 'u' }] }), warnings)
  expect(p.materialId).toBe('mdf')
  expect(p.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['roboto', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/unobtainium/), expect.stringMatching(/comic/)])
})

test('clamps polygon sides and renames duplicate shape ids', () => {
  const poly = { id: 'p', type: 'polygon', name: 'P', x: 0, y: 0, rotation: 0, w: 5, h: 5 }
  const p = parseProject(file({ ...sample(), shapes: [{ ...poly, sides: 1 }, { ...poly, sides: 500 }] }))
  expect(p.shapes.map((s) => s.type === 'polygon' && s.sides)).toEqual([3, 64])
  expect(p.shapes[0].id).toBe('p')
  expect(p.shapes[1].id).not.toBe('p')
})

const robotoBuf = () => {
  const b = readFileSync(new URL('../../public/fonts/Roboto-Regular.ttf', import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const textIn = (font: string, id = font) => ({ id, type: 'text' as const, name: 'T', x: 0, y: 0, rotation: 0, text: 'A', font, size: 10, w: 5, h: 7, ...DEFAULT_TEXT_LAYOUT })

test('embeds only the uploaded fonts text shapes use, and round-trips them', async () => {
  const data = robotoBuf()
  const p = { ...sample(), shapes: [textIn('upload:a'), textIn('fs:lora', 'f')] }
  const text = serializeProject(p, { 'upload:a': { name: 'Mine', data }, 'upload:b': { name: 'Unused', data } })
  expect(Object.keys(JSON.parse(text).fonts)).toEqual(['upload:a'])
  expect(JSON.parse(serializeProject(sample(), { 'upload:a': { name: 'Mine', data } })).fonts).toBeUndefined()
  const warnings: string[] = []
  const { project, fonts } = await parseProjectFile(text, warnings)
  expect(warnings).toEqual([])
  expect(project.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['upload:a', 'fs:lora'])
  expect(fonts['upload:a'].name).toBe('Mine')
  expect(new Uint8Array(fonts['upload:a'].data)).toEqual(new Uint8Array(data))
})

test('uploaded fonts must be embedded validly or already stored, else fall back to Roboto', async () => {
  const shapes = [textIn('upload:bad'), textIn('upload:big'), textIn('upload:stored'), textIn('upload:gone')]
  const big = 'A'.repeat(7_000_000 + 4)
  const text = file({ ...sample(), shapes }, { fonts: { 'upload:bad': { name: 'Bad', data: btoa('not a font') }, 'upload:big': { name: 'Big', data: big } } })
  const warnings: string[] = []
  const { project, fonts } = await parseProjectFile(text, warnings, async (id) => id === 'upload:stored')
  expect(fonts).toEqual({})
  expect(project.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['roboto', 'roboto', 'upload:stored', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/"Bad"/), expect.stringMatching(/"Big".*5 MB/), expect.stringMatching(/3 uploaded fonts are missing/)])
})

test('fontsource ids are kept; malformed ones fall back', () => {
  const warnings: string[] = []
  const p = parseProject(file({ ...sample(), shapes: [textIn('fs:great-vibes'), textIn('fs:../x', 'y')] }), warnings)
  expect(p.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['fs:great-vibes', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/fs:\.\.\/x/)])
})

test('rejects out-of-range text layout values', () => {
  const text = textIn('roboto', 't')
  expect(parseProject(file({ ...sample(), shapes: [{ ...text, letterSpacing: -5 }] })).shapes[0]).toMatchObject({ letterSpacing: -5 })
  for (const [key, bad] of [['letterSpacing', -5.1], ['lineHeight', 0.4], ['lineHeight', 3.5], ['arc', 400], ['arc', -361], ['align', 'justify'], ['mirror', 'yes']] as const) {
    expect(() => parseProject(file({ ...sample(), shapes: [{ ...text, [key]: bad }] }))).toThrow(new RegExp(`shapes\\[0\\].${key}`))
  }
})

test('a text with a broken bounds cache (NaN saved as null) still opens, with an estimate', () => {
  const text = { ...textIn('roboto', 't'), text: 'Hi', w: null, h: null, arc: 1e-320 }
  const p = parseProject(file({ ...sample(), shapes: [text] }))
  expect(p.shapes[0]).toMatchObject({ w: 12, h: 10, arc: 1e-320 })
  expect(parseProject(serializeProject(p))).toEqual(p)
})

test('validates bit overrides, dropping bad ones with a warning', () => {
  const warnings: string[] = []
  const p = parseProject(
    file({
      ...sample(),
      bits: { rough: '1/8-endmill' },
      bitOrder: ['rough'],
      cutSettings: { rough: newProject().cutSettings.rough },
      cutSettingsCustom: { rough: false },
      bitOverrides: { rough: { diameter: 6, bogus: 1 }, detail: { diameter: 2 }, laser: { diameter: 1 } },
    }),
    warnings,
  )
  expect(p.bitOverrides).toEqual({ rough: { diameter: 6 } })
  expect(warnings).toEqual(['Ignored the detail bit override: no detail bit.', 'Ignored the laser bit override: no laser bit.'])
  for (const bad of [{ diameter: 'x' }, { diameter: 60 }, { angle: 5 }, { flat: 20 }, { flat: null }, 3]) {
    const w: string[] = []
    expect(parseProject(file({ ...sample(), bitOverrides: { detail: bad } }), w).bitOverrides).toEqual({})
    expect(w).toHaveLength(1)
  }
  expect(() => parseProject(file({ ...sample(), bitOverrides: [] }))).toThrow(/bitOverrides must be an object/)
  // Values equal to the library bit (within display rounding) aren't overrides.
  expect(parseProject(file({ ...sample(), bitOverrides: { rough: { diameter: 3.17 }, detail: { angle: 90, flat: 1 } } })).bitOverrides).toEqual({ detail: { flat: 1 } })
})

test('resizing text at the tightest letter spacing still saves a file that opens', () => {
  // (17.3, 31) is a pair where plain proportional scaling rounds below -size/2.
  for (const [from, to] of [[17.3, 31], [10, 25.4], [7, 6.35], [33.3, 4.1]]) {
    const t = { ...textIn('roboto', 't'), size: from, letterSpacing: -from / 2 }
    for (const s of [textAtSize(t, to), scaleShape(t, to / from, to / from)]) {
      const p = { ...sample(), shapes: [s] }
      expect(parseProject(serializeProject(p))).toEqual(p)
    }
  }
})
