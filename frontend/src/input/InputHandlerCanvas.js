/**
 * Handles input events for the new canvas-based architecture.
 * 
 * This version works with the new overlay-based UI system where:
 * - The game container is isolated and only the game canvas moves/zooms
 * - UI elements (HUD, dashboard, crosshair) are fixed overlays
 * - Input events are handled at the canvas level for game interactions
 */
export default class InputHandlerCanvas {
  constructor(canvas, gameApp) {
    this.canvas = canvas
    this.gameApp = gameApp
    
    // State
    this.isDragging = false
    this.lastMouseX = 0
    this.lastMouseY = 0
    this.selectedPlanet = null
    this.selectedShips = new Set()
    
    // Bind events
    this.bindEvents()
  }

  bindEvents() {
    // Mouse events for panning
    this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this))
    document.addEventListener('mousemove', this.handleMouseMove.bind(this))
    document.addEventListener('mouseup', this.handleMouseUp.bind(this))

    // Wheel events for zoom
    this.canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false })

    // Keyboard events
    window.addEventListener('keydown', this.handleKeyDown.bind(this))
    window.addEventListener('keyup', this.handleKeyUp.bind(this))

    // Custom events from renderers
    window.addEventListener('planet-hover', this.handlePlanetHover.bind(this))
    window.addEventListener('planet-select', this.handlePlanetSelect.bind(this))
  }

  handleMouseDown(e) {
    if (e.target === this.canvas) {
      this.isDragging = true
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
      this.canvas.style.cursor = 'grabbing'
    }
  }

  handleMouseMove(e) {
    if (this.isDragging) {
      const dx = e.clientX - this.lastMouseX
      const dy = e.clientY - this.lastMouseY
      this.gameApp.panX += dx
      this.gameApp.panY += dy
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
      this.gameApp.applyTransform()
    }
  }

  handleMouseUp() {
    this.isDragging = false
    this.canvas.style.cursor = 'default'
  }

  handleWheel(e) {
    e.preventDefault()
    if (e.ctrlKey) {
      // Pinch-to-zoom
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      this.gameApp.zoom = Math.max(0.25, Math.min(2.5, this.gameApp.zoom * zoomFactor))
      this.gameApp.applyTransform()
    } else {
      // Pan with wheel
      this.gameApp.panY += e.deltaY
      this.gameApp.applyTransform()
    }
  }

  handleKeyDown(e) {
    const key = e.key.toLowerCase()
    
    // Enhanced zoom controls with K/L (screen center zoom with constant speed)
    if (key === 'k' || key === 'l') {
      e.preventDefault() // Prevent browser zoom
      
      if (!this.gameApp.zoomInterval) {
        this.gameApp.currentZoomDirection = (key === 'k') ? 'out' : 'in'
        this.gameApp.updateSmoothZoom() // Immediate response
        
        // Start smooth zoom interval
        this.gameApp.zoomInterval = setInterval(() => this.gameApp.updateSmoothZoom(), 16) // ~60fps
      }
    }
    
    // Spacebar reset
    if (e.key === ' ') {
      this.gameApp.resetView()
    }
    
    // WASD panning
    if (['w', 'a', 's', 'd'].includes(key)) {
      e.preventDefault()
      this.gameApp.keys[key] = true
      
      if (!this.gameApp.panInterval) {
        this.gameApp.panInterval = setInterval(() => {
          let moved = false
          
          if (this.gameApp.keys['w']) { this.gameApp.panY += 10; moved = true }  // W moves up
          if (this.gameApp.keys['s']) { this.gameApp.panY -= 10; moved = true }  // S moves down
          if (this.gameApp.keys['a']) { this.gameApp.panX += 10; moved = true }  // A moves left
          if (this.gameApp.keys['d']) { this.gameApp.panX -= 10; moved = true }  // D moves right
          
          if (moved) this.gameApp.applyTransform()
        }, 16) // ~60fps smooth panning
      }
    }
  }

  handleKeyUp(e) {
    const key = e.key.toLowerCase()
    
    if ((key === 'k' || key === 'l') && this.gameApp.zoomInterval) {
      clearInterval(this.gameApp.zoomInterval)
      this.gameApp.zoomInterval = null
      this.gameApp.currentZoomDirection = null
    }
    
    if (['w', 'a', 's', 'd'].includes(key)) {
      this.gameApp.keys[key] = false
      const anyWASDPressed = ['w', 'a', 's', 'd'].some(k => this.gameApp.keys[k])
      if (!anyWASDPressed && this.gameApp.panInterval) {
        clearInterval(this.gameApp.panInterval)
        this.gameApp.panInterval = null
      }
    }
  }

  handlePlanetHover(e) {
    // Handle planet hover events
    const planetId = e.detail.planetId
    if (planetId) {
      // Show hover effect or tooltip
      this.gameApp.updateHUD()
    }
  }

  handlePlanetSelect(e) {
    // Handle planet selection events
    const planetId = e.detail.planetId
    this.selectedPlanet = planetId
    this.gameApp.selectedPlanet = planetId
    
    // Open dashboard if planet is selected
    if (planetId) {
      const planet = this.gameApp.gameState?.planets?.find(p => p.id === planetId)
      if (planet) {
        this.gameApp.openDashboard(planet)
      }
    } else {
      this.gameApp.closeDashboard()
    }
    
    this.gameApp.updateHUD()
  }

  // Helper method to handle ship selection
  handleShipSelection(x, y) {
    if (!this.gameApp.gameState || !this.gameApp.gameState.ships) return

    const ships = this.gameApp.gameState.ships
    const selected = []

    for (const ship of ships) {
      const distance = Math.sqrt(Math.pow(x - ship.x, 2) + Math.pow(y - ship.y, 2))
      if (distance <= 10) { // 10px selection radius
        selected.push(ship.id)
      }
    }

    this.selectedShips = new Set(selected)
    this.gameApp.selectedShips = this.selectedShips
    this.gameApp.updateHUD()
  }

  // Handle click on empty space (deselect)
  handleEmptyClick() {
    this.selectedPlanet = null
    this.selectedShips = new Set()
    this.gameApp.selectedPlanet = null
    this.gameApp.selectedShips = new Set()
    this.gameApp.closeDashboard()
    this.gameApp.updateHUD()
  }

  destroy() {
    // Remove event listeners
    this.canvas.removeEventListener('mousedown', this.handleMouseDown)
    document.removeEventListener('mousemove', this.handleMouseMove)
    document.removeEventListener('mouseup', this.handleMouseUp)
    this.canvas.removeEventListener('wheel', this.handleWheel)
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('planet-hover', this.handlePlanetHover)
    window.removeEventListener('planet-select', this.handlePlanetSelect)
  }
}