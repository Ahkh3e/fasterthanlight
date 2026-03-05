import { RESOURCE_LABELS } from '../config.js'

/**
 * Manages the visual representation of a single planet on the galaxy map.
 * 
 * This version works with the new canvas-based rendering approach where
 * the game container is isolated and only the game canvas moves/zooms.
 */
export default class PlanetRendererCanvas {
  constructor(canvas, planetData, playerFactionId) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.id = planetData.id
    this.planet = planetData
    this.playerFactionId = playerFactionId
    this.factionMap = {}
    this._spriteCache = new Map()
  }

  update(planetData, playerFactionId, factionMap) {
    this.planet = planetData
    this.playerFactionId = playerFactionId
    this.factionMap = factionMap || {}
  }

  draw(zoom = 1) {
    const p = this.planet
    const explored = p.explored_by.some(fid => fid !== 'neutral')

    // Enforce a minimum screen-pixel size so planets stay visible when zoomed out
    const MIN_SCREEN_PX = 4
    const r = Math.max(p.radius, MIN_SCREEN_PX / zoom)

    this.drawPlanetBody(p, r, explored)

    if (p.owner) {
      this.drawOwnershipRing(p.x, p.y, r, p.owner, explored, zoom)
    }

    // Hide text labels when zoomed out too far (unreadable anyway)
    if (explored && zoom >= 0.18) {
      this.drawLabels(p.x, p.y, r, p.name, p.resource_type, p.resource_rate)
    }
  }

  drawPlanetBody(planet, radius, explored) {
    const sprite = this._getPlanetSprite(planet, radius, explored)
    const half = sprite.width / 2
    this.ctx.imageSmoothingEnabled = false
    this.ctx.drawImage(sprite, Math.round(planet.x - half), Math.round(planet.y - half))
  }

  drawOwnershipRing(x, y, radius, ownerId, explored, zoom = 1) {
    let colour = '#ffffff'
    if (ownerId === this.playerFactionId) {
      colour = '#00ffff'
    } else if (this.factionMap[ownerId]) {
      colour = this.factionMap[ownerId].colour || '#ffffff'
    }

    // Keep ring at least 1.5 screen pixels wide when zoomed out
    const lineWidth = Math.max(explored ? 3 : 2, 1.5 / zoom)
    const alpha = explored ? 0.9 : 0.55
    
    this.ctx.beginPath()
    this.ctx.arc(x, y, radius + 5, 0, Math.PI * 2)
    this.ctx.strokeStyle = colour
    this.ctx.lineWidth = lineWidth
    this.ctx.globalAlpha = alpha
    this.ctx.stroke()
    this.ctx.globalAlpha = 1.0
  }

  drawLabels(x, y, radius, name, resourceType, resourceRate) {
    // Name label
    this.ctx.fillStyle = '#aabbcc'
    this.ctx.font = '11px monospace'
    this.ctx.textAlign = 'center'
    this.ctx.textBaseline = 'bottom'
    this.ctx.fillText(name, x, y - radius - 10)
    
    // Resource badge
    this.ctx.fillStyle = '#667788'
    this.ctx.font = '10px monospace'
    this.ctx.textBaseline = 'top'
    this.ctx.fillText(`${RESOURCE_LABELS[resourceType]} ${resourceRate.toFixed(1)}`, x, y + radius + 4)
  }

  _getPlanetSprite(planet, radius, explored) {
    const r = Math.max(3, Math.round(radius))
    const style = this._planetStyle(planet)
    const key = `${planet.id}|${style.id}|${r}|${explored ? 'e' : 'u'}`
    const cached = this._spriteCache.get(key)
    if (cached) return cached

    const size = r * 2 + 6
    const c = Math.floor(size / 2)
    const sprite = document.createElement('canvas')
    sprite.width = size
    sprite.height = size
    const sctx = sprite.getContext('2d')
    sctx.imageSmoothingEnabled = false

    if (!explored) {
      const dark = '#223344'
      const rim = '#2d4257'
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - c
          const dy = y - c
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > r) continue
          const edge = r - d
          sctx.fillStyle = edge < 1.2 ? rim : dark
          sctx.fillRect(x, y, 1, 1)
        }
      }
      this._spriteCache.set(key, sprite)
      return sprite
    }

    const seed = this._seedFromText(`${planet.id}|${style.id}`)
    const base = style.base
    const highlight = style.highlight || this._mix(base, '#ffffff', 0.30)
    const shadow = style.shadow || this._mix(base, '#000000', 0.36)
    const deepShadow = style.deepShadow || this._mix(base, '#000000', 0.55)

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c
        const dy = y - c
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d > r) continue

        const nx = dx / r
        const ny = dy / r
        const edge = r - d

        let col = base
        const light = (-nx * 0.55) + (-ny * 0.75)
        if (light > 0.35) col = highlight
        else if (light < -0.45) col = deepShadow
        else if (light < -0.15) col = shadow

        col = this._applyStyleDetail(style, col, x, y, c, r, seed)

        if (edge < 1.1) col = this._mix(col, '#ffffff', 0.20)
        sctx.fillStyle = col
        sctx.fillRect(x, y, 1, 1)
      }
    }

    // subtle atmosphere/rim light at upper-left
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c
        const dy = y - c
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < r - 1.2 || d > r + 0.8) continue
        const rimLight = (-dx / r) * 0.7 + (-dy / r) * 0.8
        if (rimLight > 0.2) {
          sctx.fillStyle = this._mix(base, '#ffffff', Math.min(0.45, 0.12 + rimLight * 0.25))
          sctx.fillRect(x, y, 1, 1)
        }
      }
    }

    this._spriteCache.set(key, sprite)
    return sprite
  }

  _planetStyle(planet) {
    const styles = [
      { id: 'sand_crater', base: '#d9b37a', highlight: '#f0d1a3', shadow: '#a47f4f', patchA: '#c79862', patchB: '#b27d4f', mode: 'crater' },
      { id: 'earth_blue', base: '#3f8ed8', highlight: '#8fd0ff', shadow: '#2c5f9b', patchA: '#4caf63', patchB: '#2f7d45', mode: 'continents' },
      { id: 'earth_green', base: '#4ba6da', highlight: '#a6dfff', shadow: '#2f6f9c', patchA: '#56b568', patchB: '#3b8a4c', mode: 'continents' },
      { id: 'moon_gray', base: '#a8b1c0', highlight: '#d7deea', shadow: '#788395', patchA: '#8f99aa', patchB: '#6d778a', mode: 'crater' },
      { id: 'gas_magenta', base: '#c96a9b', highlight: '#e99ac1', shadow: '#8d4b6f', patchA: '#d87faf', patchB: '#ad5d87', mode: 'bands' },
      { id: 'desert_tan', base: '#d2af7f', highlight: '#ecd0a6', shadow: '#9f7d56', patchA: '#c99663', patchB: '#b37f4e', mode: 'dunes' },
      { id: 'stone_block', base: '#9ca8bc', highlight: '#c9d2e1', shadow: '#6d788e', patchA: '#8a96ac', patchB: '#7a879f', mode: 'tiles' },
      { id: 'jupiter_tan', base: '#cfa87b', highlight: '#e8c8a2', shadow: '#9b7450', patchA: '#dcb48a', patchB: '#b38359', mode: 'bands' },
      { id: 'orange_stripe', base: '#d98a62', highlight: '#f0b189', shadow: '#9f5f3f', patchA: '#e89c6f', patchB: '#bd724e', mode: 'bands' },
      { id: 'red_crater', base: '#c8454e', highlight: '#e86c75', shadow: '#8f2e36', patchA: '#dd5b64', patchB: '#a83942', mode: 'crater' },
      { id: 'ice_white', base: '#d6e3f7', highlight: '#f7fbff', shadow: '#9cb0d0', patchA: '#7fd3ef', patchB: '#5bb9dc', mode: 'ice' },
      { id: 'cyan_world', base: '#47b4d7', highlight: '#9de4ff', shadow: '#2d7d9a', patchA: '#5ac16b', patchB: '#399a4f', mode: 'continents' },
    ]
    const idx = this._seedFromText(`${planet.id}|planet_style`) % styles.length
    return styles[idx]
  }

  _applyStyleDetail(style, baseCol, x, y, c, r, seed) {
    const nx = (x - c) / r
    const ny = (y - c) / r
    const cell = Math.max(1, Math.floor(r / 9))
    const gx = Math.floor((x - c) / cell)
    const gy = Math.floor((y - c) / cell)
    const noiseA = this._hash2(gx + 7, gy - 5, seed)
    const noiseB = this._hash2(gx - 13, gy + 17, seed ^ 0x9e3779b9)

    if (style.mode === 'crater') {
      const pit = noiseA > 0.82 && noiseB > 0.45
      const rim = noiseA > 0.76 && noiseA <= 0.82 && noiseB > 0.4
      if (pit) return style.patchB
      if (rim) return style.patchA
      return baseCol
    }

    if (style.mode === 'continents') {
      if (noiseA > 0.64 && noiseB > 0.40) return style.patchA
      if (noiseA > 0.58 && noiseA <= 0.64 && noiseB > 0.36) return style.patchB
      return baseCol
    }

    if (style.mode === 'bands') {
      const lat = (y - c) / Math.max(1, r)
      const stripe = Math.sin(lat * 14 + noiseA * 2.2)
      if (stripe > 0.40) return style.patchA
      if (stripe < -0.45) return style.patchB
      return baseCol
    }

    if (style.mode === 'dunes') {
      const band = Math.sin((ny + nx * 0.35) * 16 + noiseA * 2.5)
      if (band > 0.45) return style.patchA
      if (band < -0.52) return style.patchB
      return baseCol
    }

    if (style.mode === 'tiles') {
      const tx = Math.floor((x - c + r) / Math.max(2, cell + 1))
      const ty = Math.floor((y - c + r) / Math.max(2, cell + 1))
      const mortar = ((tx + ty) % 3 === 0)
      if (mortar) return style.patchB
      if ((tx + ty + Math.floor(noiseA * 3)) % 2 === 0) return style.patchA
      return baseCol
    }

    if (style.mode === 'ice') {
      const crack = Math.abs(Math.sin(nx * 8 - ny * 7 + noiseA * 2.2))
      if (crack > 0.72 && noiseB > 0.35) return style.patchA
      if (crack > 0.82 && noiseB > 0.52) return style.patchB
      return baseCol
    }

    if (noiseA > 0.74) return style.patchA
    if (noiseA < 0.20 && noiseB > 0.5) return style.patchB
    return baseCol
  }

  _seedFromText(text) {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }

  _hash2(x, y, seed) {
    let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
    h = (h ^ (h >>> 13)) >>> 0
    h = Math.imul(h, 1274126177) >>> 0
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
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
    const clean = (hex || '#888888').replace('#', '')
    const full = clean.length === 3
      ? clean.split('').map(ch => ch + ch).join('')
      : clean.padEnd(6, '8').slice(0, 6)
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    }
  }

  destroy() {}
}