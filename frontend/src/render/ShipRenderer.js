/**
 * ShipRenderer — draws all ships, selection rings, and destination markers.
 *
 * Call draw() once per tick delta (or whenever gameState ships change).
 * Call drawSelectionOverlay() each frame to keep selection rings smooth
 * (ships move every tick so rings need to follow).
 */

const SHIP_SIZE = {
  fighter:     { w: 5,  h: 8  },
  cruiser:     { w: 7,  h: 10 },
  bomber:      { w: 8,  h: 7  },
  carrier:     { w: 10, h: 9  },
  dreadnought: { w: 10, h: 14 },
  mothership:  { w: 14, h: 16 },
}

const ORBIT_SPEED_PER_MS = 0.015 * 20 / 1000  // 0.015 rad/tick × 20 ticks/s → rad/ms

export default class ShipRenderer {
  constructor(scene) {
    this.scene      = scene
    this._shipGfx   = scene.add.graphics().setDepth(10)
    this._ringGfx   = scene.add.graphics().setDepth(11)
    this._destGfx   = scene.add.graphics().setDepth(9)

    this._ships   = []   // latest full ship list
    this._prevPos = {}   // { id: {x,y} } at start of current interpolation window
    this._nextPos = {}   // { id: {x,y} } at end of current interpolation window
    this._tickTime = 0   // scene time of the last tick
    this._planetMap = {} // { id: planet } for orbit rendering
  }

  /** Update planet positions for client-side orbit rendering. */
  setPlanets(planets) {
    const m = {}
    for (const p of planets) m[p.id] = p
    this._planetMap = m
  }

  // ── Called each tick — record new target positions ────────────────────────

  updateTargets(ships) {
    const prev = {}
    for (const s of ships) {
      prev[s.id] = this._nextPos[s.id] ?? { x: s.x, y: s.y }
    }
    const next = {}
    for (const s of ships) next[s.id] = { x: s.x, y: s.y }

    this._prevPos = prev
    this._nextPos = next
    this._ships   = ships
    this._tickTime = this.scene.time.now
  }

  // ── Called each frame — draw ships at interpolated positions ──────────────

  drawFrame(alpha, selection, playerFactionId, factionMap) {
    const now = this.scene.time.now
    // Pre-compute symmetric orbit layout
    const orbitPos = this._computeOrbitLayout(now)

    const lerped = this._ships.map(s => {
      // Orbiting ships: symmetric collective layout
      const op = orbitPos[s.id]
      if (op) {
        return { ...s, x: op.x, y: op.y }
      }
      // Non-orbiting: lerp as before
      const p = this._prevPos[s.id]
      const n = this._nextPos[s.id]
      if (!p || !n) return s
      return { ...s, x: p.x + (n.x - p.x) * alpha, y: p.y + (n.y - p.y) * alpha }
    })
    this._drawShips(lerped, playerFactionId, factionMap)
    this._drawSelectionRings(lerped, selection)
    this._drawDestinations(lerped, selection, playerFactionId)
  }

  // ── Legacy immediate draw ─────────────────────────────────────────────────

  draw(ships, selection, playerFactionId, factionMap) {
    this.updateTargets(ships)
    this.drawFrame(1, selection, playerFactionId, factionMap)
  }

  // ── Orbit layout ──────────────────────────────────────────────────────────

  _computeOrbitLayout(now) {
    const positions = {}
    const byPlanet = {}
    for (const s of this._ships) {
      if (s.state === 'orbiting' && s.target_planet) {
        ;(byPlanet[s.target_planet] ??= []).push(s)
      }
    }

    const spinPhase = now * ORBIT_SPEED_PER_MS

    for (const [planetId, group] of Object.entries(byPlanet)) {
      const planet = this._planetMap[planetId]
      if (!planet) continue

      group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

      const ringMap = {}
      for (const s of group) {
        const r = s.orbit_radius || 50
        ;(ringMap[r] ??= []).push(s)
      }

      const sortedRadii = Object.keys(ringMap).map(Number).sort((a, b) => a - b)
      const basePhase = this._hashPlanetPhase(planetId)

      for (let ri = 0; ri < sortedRadii.length; ri++) {
        const radius = sortedRadii[ri]
        const ring = ringMap[radius]
        const count = ring.length
        const step = (2 * Math.PI) / count
        const ringPhase = (ri % 2 === 1) ? step * 0.5 : 0
        const start = basePhase + spinPhase + ringPhase

        for (let i = 0; i < count; i++) {
          const angle = start + i * step
          positions[ring[i].id] = {
            x: planet.x + Math.cos(angle) * radius,
            y: planet.y + Math.sin(angle) * radius,
          }
        }
      }
    }

    return positions
  }

  _hashPlanetPhase(planetId) {
    let h = 0
    for (let i = 0; i < planetId.length; i++) {
      h = (h * 31 + planetId.charCodeAt(i)) >>> 0
    }
    return (h % 360) * Math.PI / 180
  }

  // ── Ships ─────────────────────────────────────────────────────────────────

  _drawShips(ships, playerFactionId, factionMap) {
    const g = this._shipGfx
    g.clear()

    for (const ship of ships) {
      const isPlayer  = ship.owner === playerFactionId
      const isNeutral = ship.owner === 'neutral'
      let colour

      if (isNeutral) {
        colour = 0x3a5060
      } else {
        const fHex = factionMap[ship.owner]?.colour
        if (fHex) {
          colour = Phaser.Display.Color.HexStringToColor(fHex).color
        } else if (isPlayer) {
          colour = 0x00ffff
        } else {
          colour = Phaser.Display.Color.HexStringToColor('#888888').color
        }
      }

      const alpha = isPlayer ? 1.0 : (isNeutral ? 0.45 : 0.7)
      const sz    = SHIP_SIZE[ship.type] ?? { w: 5, h: 8 }

      // Draw attacking ships with a brighter tint
      const drawColour = ship.state === 'attacking' ? 0xff8800 : colour

      g.fillStyle(drawColour, alpha)
      g.fillTriangle(
        ship.x,          ship.y - sz.h,
        ship.x - sz.w,   ship.y + sz.h * 0.5,
        ship.x + sz.w,   ship.y + sz.h * 0.5,
      )

      // Health bar when damaged
      if (ship.max_health > 0 && ship.health < ship.max_health && ship.health > 0) {
        const barW  = sz.w * 2 + 4
        const barX  = ship.x - barW / 2
        const barY  = ship.y + sz.h + 4
        const ratio = ship.health / ship.max_health

        g.fillStyle(0x222222, 0.8)
        g.fillRect(barX, barY, barW, 2)

        const barColour = ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200
        g.fillStyle(barColour, 0.9)
        g.fillRect(barX, barY, barW * ratio, 2)
      }
    }
  }

  // ── Selection rings ───────────────────────────────────────────────────────

  _drawSelectionRings(ships, selection) {
    const g = this._ringGfx
    g.clear()
    if (selection.size === 0) return

    const shipMap = {}
    ships.forEach(s => { shipMap[s.id] = s })

    for (const id of selection) {
      const ship = shipMap[id]
      if (!ship) continue
      const sz = SHIP_SIZE[ship.type] ?? { w: 5, h: 8 }
      const r  = Math.max(sz.w, sz.h) + 5
      g.lineStyle(1.5, 0x00ffff, 0.85)
      g.strokeCircle(ship.x, ship.y, r)
    }
  }

  // ── Destination markers ───────────────────────────────────────────────────

  _drawDestinations(ships, selection, playerFactionId) {
    const g = this._destGfx
    g.clear()
    if (selection.size === 0) return

    const drawn = new Set()
    for (const ship of ships) {
      if (!selection.has(ship.id)) continue
      if (ship.owner !== playerFactionId) continue
      if (ship.state !== 'moving') continue
      if (ship.target_x == null) continue

      const key = `${Math.round(ship.target_x)},${Math.round(ship.target_y)}`
      if (drawn.has(key)) continue
      drawn.add(key)

      const x = ship.target_x
      const y = ship.target_y
      const r = 8

      g.lineStyle(1, 0x00ffff, 0.5)
      g.strokeCircle(x, y, r)
      g.lineStyle(1, 0x00ffff, 0.3)
      g.lineBetween(x - r - 4, y, x + r + 4, y)
      g.lineBetween(x, y - r - 4, x, y + r + 4)
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this._shipGfx.destroy()
    this._ringGfx.destroy()
    this._destGfx.destroy()
  }
}
