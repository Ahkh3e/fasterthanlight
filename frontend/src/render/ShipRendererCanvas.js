
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

    // Lerp all ship positions for this frame
    const lerped = this.ships.map(s => {
      const p = this.prevPos[s.id]
      const n = this.nextPos[s.id]
      if (!p || !n) return s
      return { ...s, x: p.x + (n.x - p.x) * alpha, y: p.y + (n.y - p.y) * alpha }
    })

    // ── Batch fills by colour ──────────────────────────────────────────────
    const groups = new Map()
    for (const ship of lerped) {
      const col = this._colour(ship)
      if (!groups.has(col)) groups.set(col, [])
      groups.get(col).push(ship)
    }
    for (const [col, batch] of groups) {
      this.ctx.fillStyle = col
      this.ctx.beginPath()
      for (const ship of batch) this._triangle(ship)
      this.ctx.fill()
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

  _triangle(ship) {
    const sz = this._size(ship.type)
    let c = 1, s = 0
    if (ship.vx || ship.vy) {
      const a = Math.atan2(ship.vy, ship.vx)
      c = Math.cos(a)
      s = Math.sin(a)
    }
    this.ctx.moveTo(ship.x + sz * c,                        ship.y + sz * s)
    this.ctx.lineTo(ship.x - 0.5 * sz * c - 0.8 * sz * s,  ship.y - 0.5 * sz * s + 0.8 * sz * c)
    this.ctx.lineTo(ship.x - 0.5 * sz * c + 0.8 * sz * s,  ship.y - 0.5 * sz * s - 0.8 * sz * c)
    this.ctx.closePath()
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
    return { fighter: 6, cruiser: 8, bomber: 7, carrier: 10, dreadnought: 12 }[type] ?? 6
  }

  destroy() {}
}
