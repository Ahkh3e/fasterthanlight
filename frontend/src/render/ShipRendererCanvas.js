
/**
 * Draws ships with position interpolation between server ticks.
 *
 * Call onTick(ships, now) each time the server delivers new positions.
 * Call draw(selectedShips) every render frame — positions are lerped
 * between prevPos and nextPos based on time elapsed since last tick.
 */
export default class ShipRendererCanvas {
  constructor(canvas) {
    this.canvas          = canvas
    this.ctx             = canvas.getContext('2d')
    this.ships           = []
    this.prevPos         = {}   // { id: {x, y} } — start of current lerp window
    this.nextPos         = {}   // { id: {x, y} } — end of current lerp window
    this.tickTime        = 0    // performance.now() when last tick arrived
    this.tickInterval    = 100  // ms between ticks — measured adaptively
    this.playerFactionId = null
    this.factionMap      = {}
    this.headingById     = {}
  }

  // ── Called once per server tick ──────────────────────────────────────────

  onTick(ships, now = performance.now(), playerFactionId = null, factionMap = {}) {
    // Measure actual server tick interval (clamped to sane range 20–500ms)
    if (this.tickTime > 0) {
      const measured = now - this.tickTime
      if (measured > 20 && measured < 500) {
        this.tickInterval = this.tickInterval * 0.8 + measured * 0.2  // EMA smoothing
      }
    }

    const prev = {}
    for (const s of ships) {
      prev[s.id] = this.nextPos[s.id] ?? { x: s.x, y: s.y }
    }
    const next = {}
    for (const s of ships) next[s.id] = { x: s.x, y: s.y }

    this.prevPos         = prev
    this.nextPos         = next
    this.tickTime        = now
    this.ships           = ships
    if (playerFactionId) this.playerFactionId = playerFactionId
    if (factionMap && Object.keys(factionMap).length) this.factionMap = factionMap
  }

  // ── Called every render frame ────────────────────────────────────────────

  draw(selectedShips = new Set()) {
    if (!this.ships.length) return

    const alpha = Math.min(1, (performance.now() - this.tickTime) / this.tickInterval)
    this.ctx.imageSmoothingEnabled = false

    // Lerp all ship positions for this frame
    const lerped = this.ships.map(s => {
      const p = this.prevPos[s.id]
      const n = this.nextPos[s.id]
      if (!p || !n) return s
      return {
        ...s,
        x: p.x + (n.x - p.x) * alpha,
        y: p.y + (n.y - p.y) * alpha,
        _motionDx: n.x - p.x,
        _motionDy: n.y - p.y,
      }
    })

    // ── Pixel-art ship sprites ─────────────────────────────────────────────
    for (const ship of lerped) {
      this._drawPixelShip(ship, this._colour(ship))
    }

    // ── Health bars (only damaged ships) ──────────────────────────────────
    for (const ship of lerped) {
      const h    = ship.health    ?? 1.0
      const maxH = ship.max_health ?? 1.0
      if (maxH > 0 && h < maxH && h > 0) this._healthBar(ship, h / maxH)
    }

    // ── Selection rings (one batched stroke) ──────────────────────────────
    if (selectedShips.size > 0) {
      this.ctx.strokeStyle = '#ffff00'
      this.ctx.lineWidth   = 2
      this.ctx.beginPath()
      for (const ship of lerped) {
        if (!selectedShips.has(ship.id)) continue
        const sz = this._size(ship.type)
        this.ctx.moveTo(ship.x + sz + 3, ship.y)
        this.ctx.arc(ship.x, ship.y, sz + 3, 0, Math.PI * 2)
      }
      this.ctx.stroke()
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _drawPixelShip(ship, baseColor) {
    const def = this._spriteDef(ship.type)
    const { rows, pixel } = def
    const scale = this._typeScale(ship.type)
    const h = rows.length
    const w = rows[0].length

    const motionDx = ship._motionDx ?? 0
    const motionDy = ship._motionDy ?? 0
    const motionMagSq = motionDx * motionDx + motionDy * motionDy
    const velMagSq = (ship.vx ?? 0) * (ship.vx ?? 0) + (ship.vy ?? 0) * (ship.vy ?? 0)

    let angle = this.headingById[ship.id] ?? 0
    if (motionMagSq > 1e-4) {
      angle = Math.atan2(motionDy, motionDx) + Math.PI / 2
      this.headingById[ship.id] = angle
    } else if (velMagSq > 1e-4) {
      angle = Math.atan2(ship.vy, ship.vx) + Math.PI / 2
      this.headingById[ship.id] = angle
    }

    const highlight = this._mix(baseColor, '#ffffff', 0.28)
    const shadow = this._mix(baseColor, '#000000', 0.35)
    const cockpit = '#6fb8ff'
    const canopyShadow = '#2a4a78'
    const engineHot = '#ff9c3a'
    const engineCore = '#ffd36a'

    this.ctx.save()
    this.ctx.translate(ship.x, ship.y)
    this.ctx.rotate(angle)
    this.ctx.scale(scale, scale)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = rows[y][x]
        if (cell === '0') continue

        if (cell === '1') this.ctx.fillStyle = baseColor
        else if (cell === '2') this.ctx.fillStyle = highlight
        else if (cell === '3') this.ctx.fillStyle = shadow
        else if (cell === '4') this.ctx.fillStyle = cockpit
        else if (cell === '5') this.ctx.fillStyle = canopyShadow
        else if (cell === '6') this.ctx.fillStyle = engineHot
        else if (cell === '7') this.ctx.fillStyle = engineCore
        else continue

        const px = Math.round((x - w / 2) * pixel)
        const py = Math.round((y - h / 2) * pixel)
        this.ctx.fillRect(px, py, pixel, pixel)
      }
    }

    this.ctx.restore()
  }

  _healthBar(ship, ratio) {
    const sz = this._size(ship.type)
    const bw = sz * 2 + 4
    const bx = ship.x - bw / 2
    const by = ship.y + sz + 4
    this.ctx.fillStyle = '#222222'
    this.ctx.fillRect(bx, by, bw, 2)
    this.ctx.fillStyle = ratio > 0.5 ? '#00cc44' : ratio > 0.25 ? '#ffaa00' : '#ff2200'
    this.ctx.fillRect(bx, by, bw * ratio, 2)
  }

  _colour(ship) {
    if (ship.owner === this.playerFactionId) return '#00ddff'   // player = cyan
    const faction = this.factionMap[ship.owner]
    if (faction?.colour) return faction.colour                  // NPC = faction colour
    return '#aaaaaa'                                            // neutral / unknown = grey
  }

  _size(type) {
    return { fighter: 4, bomber: 4.6, cruiser: 5.2, carrier: 6.2, dreadnought: 7.2 }[type] ?? 4
  }

  _typeScale(type) {
    return { fighter: 1.0, bomber: 1.08, cruiser: 1.16, carrier: 1.26, dreadnought: 1.36 }[type] ?? 1.0
  }

  _spriteDef(type) {
    const defs = {
      fighter: {
        pixel: 1,
        rows: [
          '000020000',
          '000242000',
          '000212000',
          '001111100',
          '011111110',
          '001131100',
          '001111100',
          '011303110',
          '110303011',
          '100303001',
          '000161000',
          '000070000',
        ],
      },
      cruiser: {
        pixel: 1,
        rows: [
          '000002200000',
          '000024420000',
          '000021120000',
          '000111111000',
          '001111111100',
          '011111111110',
          '001111111100',
          '001113331100',
          '011130331110',
          '111300003111',
          '100300003001',
          '000016610000',
          '000007700000',
        ],
      },
      bomber: {
        pixel: 1,
        rows: [
          '00002200000',
          '00024220000',
          '00021120000',
          '01111111110',
          '00111111100',
          '11111333111',
          '11113033111',
          '00130000300',
          '00016661000',
          '00007770000',
        ],
      },
      carrier: {
        pixel: 1,
        rows: [
          '0000002200000',
          '0000024420000',
          '0000021120000',
          '0000111111000',
          '0001111111100',
          '0011111111110',
          '0111111111111',
          '0011113331110',
          '1111133031111',
          '1111300003111',
          '0113000003110',
          '0001666661000',
          '0000777770000',
        ],
      },
      dreadnought: {
        pixel: 1,
        rows: [
          '000000022000000',
          '000000244200000',
          '000000211200000',
          '000001111110000',
          '000011111111000',
          '000111111111100',
          '001111111111110',
          '011111111111111',
          '001111133311110',
          '111111303031111',
          '111113000000311',
          '011130000000311',
          '001166666666110',
          '000077777777000',
        ],
      },
    }
    return defs[type] ?? defs.fighter
  }

  _mix(hexA, hexB, t = 0.5) {
    const a = this._hexToRgb(hexA)
    const b = this._hexToRgb(hexB)
    const r = Math.round(a.r + (b.r - a.r) * t)
    const g = Math.round(a.g + (b.g - a.g) * t)
    const bl = Math.round(a.b + (b.b - a.b) * t)
    return `rgb(${r}, ${g}, ${bl})`
  }

  _hexToRgb(hex) {
    const clean = (hex || '#aaaaaa').replace('#', '')
    const full = clean.length === 3
      ? clean.split('').map(ch => ch + ch).join('')
      : clean.padEnd(6, 'a').slice(0, 6)
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    }
  }

  destroy() {}
}
