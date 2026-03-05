import { RESOURCE_COLOURS, RESOURCE_LABELS } from '../config.js'

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

    this.drawPlanetBody(p.x, p.y, r, explored, p.resource_type)

    if (p.owner) {
      this.drawOwnershipRing(p.x, p.y, r, p.owner, explored, zoom)
    }

    // Hide text labels when zoomed out too far (unreadable anyway)
    if (explored && zoom >= 0.18) {
      this.drawLabels(p.x, p.y, r, p.name, p.resource_type, p.resource_rate)
    }
  }

  drawPlanetBody(x, y, radius, explored, resourceType) {
    const colour = explored ? RESOURCE_COLOURS[resourceType] : '#223344'
    const alpha = explored ? 0.9 : 0.35
    
    this.ctx.beginPath()
    this.ctx.arc(x, y, radius, 0, Math.PI * 2)
    this.ctx.fillStyle = colour
    this.ctx.globalAlpha = alpha
    this.ctx.fill()
    this.ctx.globalAlpha = 1.0
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

  destroy() {}
}