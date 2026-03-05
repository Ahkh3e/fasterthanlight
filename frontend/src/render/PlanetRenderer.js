import { RESOURCE_COLOURS, RESOURCE_LABELS } from '../config.js'

/**
 * Manages the visual representation of a single planet on the galaxy map.
 *
 * Creates and owns:
 *   - body      Circle (resource-type fill)
 *   - ring      Graphics arc (faction ownership colour)
 *   - label     Text (planet name, hidden when unexplored)
 *   - badge     Text (resource symbol + rate)
 *
 * Call update(planetData, playerFactionId) each time server state changes.
 */
export default class PlanetRenderer {
  constructor(scene, planetData, playerFactionId) {
    this.scene    = scene
    this.id       = planetData.id
    this._objects = []

    this._build(planetData, playerFactionId)
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  _build(p, playerFactionId) {
    const explored = p.explored_by.some(fid => fid !== 'neutral')
    const colour   = explored ? RESOURCE_COLOURS[p.resource_type] : 0x223344

    // Body
    this.body = this.scene.add.circle(p.x, p.y, p.radius, colour, explored ? 0.9 : 0.35)
    this.body.setInteractive()
    this._objects.push(this.body)

    // Ownership ring (drawn with Graphics so we can style the stroke)
    this.ring = this.scene.add.graphics()
    this._objects.push(this.ring)

    // Name label
    this.label = this.scene.add.text(p.x, p.y - p.radius - 10, explored ? p.name : '???', {
      fontSize:   '11px',
      color:      '#aabbcc',
      fontFamily: 'monospace',
    }).setOrigin(0.5, 1)
    this._objects.push(this.label)

    // Resource badge (only if explored)
    this.badge = this.scene.add.text(
      p.x, p.y + p.radius + 4,
      explored ? `${RESOURCE_LABELS[p.resource_type]} ${p.resource_rate.toFixed(1)}` : '',
      { fontSize: '10px', color: '#667788', fontFamily: 'monospace' }
    ).setOrigin(0.5, 0)
    this._objects.push(this.badge)

    this._drawRing(p, playerFactionId)
    this._bindEvents(p)
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  update(p, playerFactionId, factionMap) {
    const explored = p.explored_by.some(fid => fid !== 'neutral')
    const colour   = explored ? RESOURCE_COLOURS[p.resource_type] : 0x223344

    this.body.setFillStyle(colour, explored ? 0.9 : 0.35)
    this.label.setText(explored ? p.name : '???')
    this.badge.setText(
      explored ? `${RESOURCE_LABELS[p.resource_type]} ${p.resource_rate.toFixed(1)}` : ''
    )
    this._drawRing(p, playerFactionId, factionMap)
  }

  // ── Ring drawing ───────────────────────────────────────────────────────────

  _drawRing(p, playerFactionId, factionMap) {
    this.ring.clear()
    if (!p.owner) return

    // Resolve faction colour
    let hexColour = '#ffffff'
    if (p.owner === playerFactionId) {
      hexColour = '#00ffff'
    } else if (factionMap && factionMap[p.owner]) {
      hexColour = factionMap[p.owner].colour
    }
    const colour = Phaser.Display.Color.HexStringToColor(hexColour).color

    // Always show ring — dim if unexplored so territory is always visible on the map
    const explored = p.explored_by.some(fid => fid !== 'neutral')
    this.ring.lineStyle(explored ? 3 : 2, colour, explored ? 0.9 : 0.55)
    this.ring.strokeCircle(p.x, p.y, p.radius + 5)
  }

  // ── Interactivity ──────────────────────────────────────────────────────────

  _bindEvents(p) {
    this.body.on('pointerover', () => {
      this.body.setStrokeStyle(2, 0xffffff, 0.6)
      this.scene.events.emit('planet-hover', p.id)
    })
    this.body.on('pointerout', () => {
      this.body.setStrokeStyle()
      this.scene.events.emit('planet-hover', null)
    })
    this.body.on('pointerdown', () => {
      this.scene.events.emit('planet-select', p.id)
    })
  }

  // ── Depth + visibility ─────────────────────────────────────────────────────

  setDepth(d) {
    this._objects.forEach(o => o.setDepth(d))
    return this
  }

  destroy() {
    this._objects.forEach(o => o.destroy())
  }
}
