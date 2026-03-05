/**
 * InputHandler — manages ship selection and command issuance.
 *
 * Selection model:
 *   - Left-click on a player ship  → select it (replace selection)
 *   - Shift + left-click on a ship → toggle in/out of selection
 *   - Left-drag (> 6px)            → rubber-band select all player ships in rect
 *   - Left-click empty space       → deselect all
 *   - Right-click                  → move selected ships to cursor / orbit planet
 *   - ESC                          → deselect all
 *
 * Sends input events to the server via sendCommand(msg).
 */
export default class InputHandler {
  constructor(scene, sendCommand) {
    this.scene       = scene
    this.sendCommand = sendCommand

    this._gameState  = null
    this._selection  = new Set()     // ship IDs
    this._dragStart  = null          // {screenX, screenY} when drag began
    this._dragging   = false
    this.rubberBand  = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 }

    // World-space graphics (no setScrollFactor override) so draw commands in
    // world coordinates render exactly where the camera shows them.
    this._selectionGraphics = scene.add.graphics().setDepth(20)
    this._setup()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setGameState(gs) { this._gameState = gs }

  get selection() { return this._selection }

  clearSelection() {
    this._selection = new Set()
    this.scene.events.emit('selection-changed', this._selection)
  }

  /** Remove destroyed ship IDs from selection (called after combat). */
  removeShips(destroyedIds) {
    let changed = false
    for (const id of destroyedIds) {
      if (this._selection.delete(id)) changed = true
    }
    if (changed) this.scene.events.emit('selection-changed', this._selection)
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _setup() {
    const scene = this.scene

    scene.input.on('pointerdown', (ptr) => {
      if (ptr.leftButtonDown()) this._onLeftDown(ptr)
    })

    scene.input.on('pointermove', (ptr) => {
      if (!ptr.isDown) return
      this._onDragMove(ptr)
    })

    scene.input.on('pointerup', (ptr) => {
      this._onPointerUp(ptr)
    })

    scene.input.keyboard.on('keydown-ESC', () => this.clearSelection())

    // F — move selected ships to current cursor position / planet under cursor
    scene.input.keyboard.on('keydown-F', () => this._onMoveKey())
  }

  // ── Left-button down ───────────────────────────────────────────────────────

  _onLeftDown(ptr) {
    this._dragStart = { screenX: ptr.x, screenY: ptr.y }
    this._dragging  = false
  }

  // ── Drag ──────────────────────────────────────────────────────────────────

  _onDragMove(ptr) {
    if (!this._dragStart) return
    const dx = ptr.x - this._dragStart.screenX
    const dy = ptr.y - this._dragStart.screenY
    if (!this._dragging && Math.hypot(dx, dy) > 6) {
      this._dragging = true
    }
    if (this._dragging) {
      this.rubberBand = {
        active: true,
        x1: this._dragStart.screenX,
        y1: this._dragStart.screenY,
        x2: ptr.x,
        y2: ptr.y,
      }
      this._drawRubberBand()
    }
  }

  // ── Pointer up ────────────────────────────────────────────────────────────

  _onPointerUp(ptr) {
    if (!this._dragStart) return

    if (this._dragging) {
      this._finishRubberBand(ptr)
    } else {
      this._handleLeftClick(ptr)
    }

    this._dragStart = null
    this._dragging  = false
    this.rubberBand = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 }
    this._selectionGraphics.clear()
  }

  // ── Click on map ──────────────────────────────────────────────────────────

  _handleLeftClick(ptr) {
    if (!this._gameState) return
    const world           = this._worldPos(ptr)
    const playerFactionId = this._gameState.player_faction_id
    const shift           = ptr.event.shiftKey

    // 1. Direct ship click — find nearest player ship within click radius
    const clickRadius = 20 / this.scene.cameras.main.zoom
    let best = null, bestDist = Infinity

    for (const ship of this._gameState.ships) {
      if (ship.owner !== playerFactionId) continue
      const d = Math.hypot(ship.x - world.x, ship.y - world.y)
      if (d < clickRadius && d < bestDist) { best = ship; bestDist = d }
    }

    if (best) {
      if (shift) {
        if (this._selection.has(best.id)) this._selection.delete(best.id)
        else                              this._selection.add(best.id)
      } else {
        this._selection = new Set([best.id])
      }
      this.scene.events.emit('selection-changed', this._selection)
      return
    }

    // 2. Planet click — select all player ships currently orbiting it
    const clickedPlanet = this._gameState.planets.find(p => {
      return Math.hypot(p.x - world.x, p.y - world.y) < p.radius + 12
    })

    if (clickedPlanet) {
      const orbiters = this._gameState.ships.filter(s =>
        s.owner === playerFactionId
        && s.state === 'orbiting'
        && s.target_planet === clickedPlanet.id
      )
      if (orbiters.length > 0) {
        if (shift) {
          orbiters.forEach(s => this._selection.add(s.id))
        } else {
          this._selection = new Set(orbiters.map(s => s.id))
        }
        this.scene.events.emit('selection-changed', this._selection)
        return
      }
    }

    // 3. Clicked empty space — deselect + close planet panel
    this._selection = new Set()
    this.scene.events.emit('selection-changed', this._selection)
    if (!clickedPlanet) {
      this.scene.events.emit('planet-select', null)
    }
  }

  // ── Rubber band finish ────────────────────────────────────────────────────

  _finishRubberBand(ptr) {
    if (!this._gameState) return
    const cam = this.scene.cameras.main

    // Convert screen corners to world coords
    const w1 = this._worldPos({ x: this._dragStart.screenX, y: this._dragStart.screenY })
    const w2 = this._worldPos({ x: ptr.x, y: ptr.y })

    const minX = Math.min(w1.x, w2.x)
    const maxX = Math.max(w1.x, w2.x)
    const minY = Math.min(w1.y, w2.y)
    const maxY = Math.max(w1.y, w2.y)

    const playerFactionId = this._gameState.player_faction_id
    const ids = new Set()
    for (const ship of this._gameState.ships) {
      if (ship.owner !== playerFactionId) continue
      if (ship.x >= minX && ship.x <= maxX && ship.y >= minY && ship.y <= maxY) {
        ids.add(ship.id)
      }
    }
    this._selection = ids
    this.scene.events.emit('selection-changed', this._selection)
  }

  // ── F key → move command at cursor ───────────────────────────────────────

  _onMoveKey() {
    if (this._selection.size === 0) return
    if (!this._gameState?.player_faction_id) return

    const ptr    = this.scene.input.activePointer
    const world  = this._worldPos(ptr)
    const shipIds = [...this._selection]

    // If cursor is over a planet, send to that planet; otherwise send to world coords
    const planets = this._gameState?.planets ?? []
    const targetPlanet = planets.find(p =>
      Math.hypot(p.x - world.x, p.y - world.y) < p.radius + 16
    )

    if (targetPlanet) {
      this.sendCommand({
        type: 'move',
        ship_ids: shipIds,
        target: { planet_id: targetPlanet.id },
      })
    } else {
      this.sendCommand({
        type: 'move',
        ship_ids: shipIds,
        target: { x: Math.round(world.x), y: Math.round(world.y) },
      })
    }
  }

  // ── Rubber band draw ──────────────────────────────────────────────────────

  _drawRubberBand() {
    // Convert screen-pixel corners to world coords — same transform used by
    // _finishRubberBand, so the visual box perfectly matches the selection region.
    const w1 = this._worldPos({ x: this.rubberBand.x1, y: this.rubberBand.y1 })
    const w2 = this._worldPos({ x: this.rubberBand.x2, y: this.rubberBand.y2 })
    const rx = Math.min(w1.x, w2.x)
    const ry = Math.min(w1.y, w2.y)
    const rw = Math.abs(w2.x - w1.x)
    const rh = Math.abs(w2.y - w1.y)
    const z  = this.scene.cameras.main.zoom
    const g  = this._selectionGraphics
    g.clear()
    g.lineStyle(1 / z, 0x00ffff, 0.6)   // 1 screen-pixel line regardless of zoom
    g.strokeRect(rx, ry, rw, rh)
    g.fillStyle(0x00ffff, 0.06)
    g.fillRect(rx, ry, rw, rh)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _worldPos(ptr) {
    return this.scene.cameras.main.getWorldPoint(ptr.x, ptr.y)
  }

  destroy() {
    this._selectionGraphics.destroy()
  }
}
