import SocketClient from './network/SocketClient.js'
import PlanetRendererCanvas from './render/PlanetRendererCanvas.js'
import ShipRendererCanvas from './render/ShipRendererCanvas.js'
import InputHandlerCanvas from './input/InputHandlerCanvas.js'
import AudioManager from './audio/AudioManager.js'
import { GALAXY_WIDTH, GALAXY_HEIGHT, ZOOM_MIN, ZOOM_MAX } from './config.js'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'
const SESSION_STORAGE_KEY = 'ftl_session_v1'

const hostLabelFromUrl = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '')
  }
}

class GameApp {
  constructor() {
    this.gameState = null
    this.planetRenderers = {}
    this.laneGraphics = null
    this.shipRenderer = null
    this.inputHandler = null
    this.selectedPlanet = null
    this.selectedShips = new Set()
    this.audio = new AudioManager()
    this.gameId = null
    this.seed = null
    this.connectionOnline = false
    this.playersOnline = 0
    this.endpointLabel = hostLabelFromUrl(API_URL)

    // Lobby state
    this.lobbyId = null
    this.lobbyToken = null
    this.lobbyIsHost = false
    this.lobbyPollInterval = null
    this.lobbyPlayers = []
    this.pendingPlayerFactionId = null

    this.tutorialStepIndex = 0
    this.tutorialAnimRaf = null
    this.tutorialAnimStart = 0
    this.tutorialCanvas = null
    this.tutorialCtx = null
    this.tutorialSteps = [
      {
        title: 'Camera & Basic Controls',
        text: 'Move around the galaxy and issue commands quickly. Most actions are click-driven, with keyboard shortcuts for speed.',
        demoCaption: 'Camera panning, zoom pulses, and move command markers',
        bullets: [
          'Pan with WASD or by dragging left mouse.',
          'Zoom with scroll wheel, C (out), or V (in).',
          'Left-click selects a planet or ship.',
          'Press Space to refocus your view on your key area.',
          'Use this as your baseline before issuing fleet commands.',
        ],
      },
      {
        title: 'Ship Selection & Movement',
        text: 'This is the core micro loop: select, group, and reposition fleets with fast commands.',
        demoCaption: 'Drag-box selection, move target marker, and formation travel',
        bullets: [
          'Single-select: left-click a ship to inspect or command one unit.',
          'Multi-select: hold Shift/Ctrl and drag a box to capture nearby ships.',
          'Issue move: right-click destination to send the entire selection.',
          'Quick command: press F to send currently selected ships to your cursor.',
          'Use short chained moves to dodge fire and keep fleet spacing tight.',
        ],
      },
      {
        title: 'Resources & HUD',
        text: 'Your empire runs on Credits and Research Points. Keep an eye on HUD values to avoid stalling production.',
        demoCaption: 'Credits and research bars rise as your empire develops',
        bullets: [
          'Cr is your currency for ships, buildings, and upgrades.',
          'RP unlocks higher tech tiers over time.',
          'Income/s reflects current credit flow from owned planets.',
          'Faction panel (top-left) shows each faction\'s planets and fleets.',
          'Selection panel (bottom-right) lists selected ship counts by type.',
        ],
      },
      {
        title: 'Planets & Dashboard',
        text: 'Planets are your production and defense hubs. Open the dashboard to manage each one.',
        demoCaption: 'Planet is selected and dashboard stats update live',
        bullets: [
          'Select a planet to inspect ownership, level, population, and defense.',
          'Press Q or click dashboard controls to queue level ups and production.',
          'Higher-level planets unlock stronger economy and construction options.',
          'Build queue has limited slots, so prioritize upgrades for key worlds.',
          'Use defensive worlds on chokepoints and economic worlds in safer lanes.',
        ],
      },
      {
        title: 'Ships & Combat Roles',
        text: 'Different ship types fill different battlefield jobs. Build mixed fleets for better outcomes.',
        demoCaption: 'Fleet formation, projectile fire, and impact bursts',
        bullets: [
          'Fighter: cheap and fast skirmisher.',
          'Cruiser/Bomber: strong mid-tier damage dealers.',
          'Carrier: launches support pressure over time.',
          'Dreadnought: expensive heavy frontline unit.',
          'Mothership: top-tier anchor unit; support it with escorts.',
        ],
      },
      {
        title: 'Buildings & Economy',
        text: 'Buildings specialize planets for income, research, production, and defense.',
        demoCaption: 'Building slots fill and economy output scales upward',
        bullets: [
          'Extractor and Trade Hub improve credit generation.',
          'Research Lab increases RP gain toward next tiers.',
          'Shipyard improves military production flow.',
          'Defense Platform and Orbital Cannon help hold territory.',
          'Balance eco planets with frontline military planets.',
        ],
      },
      {
        title: 'Tech Tiers & Fleet Upgrades',
        text: 'The Tier panel tracks unlock progress and lets you buy permanent faction-wide fleet perks.',
        demoCaption: 'Tier progression and fleet perk levels increasing over time',
        bullets: [
          'Open Tier Progress from the HUD to see RP + planet level requirements.',
          'Tier 2 and 3 unlock stronger ships and strategic options.',
          'Fleet upgrades: Speed, Health, Damage (stack across the match).',
          'Upgrade costs scale per level, so buy with timing in mind.',
          'Use upgrades to match your strategy: rush, sustain, or burst.',
        ],
      },
      {
        title: 'PvP Lobby & Match Flow',
        text: 'Use the home menu lobby tools to host or join multiplayer games quickly.',
        demoCaption: 'Host/share code, players join, and match starts sequence',
        bullets: [
          'Enter your player name first.',
          'Host creates a lobby code; use Copy for sharing.',
          'Joiners can paste the code with the Paste button and click Join.',
          'Host starts match once players are ready.',
          'At game end, summary screen shows planets, kills/deaths, and ship stats.',
        ],
      },
    ]
    
    // Game state
    this.zoom = 1.0
    this.panX = 0
    this.panY = 0
    this.canvas = null
    this.ctx = null
    this.width = 0
    this.height = 0
    
    // Animation state
    this.lastTickTime = 0
    this.lastFrameTime = 0
    
    // Input state (for InputHandlerCanvas)
    this.keys = {}
    this.zoomInterval = null
    this.currentZoomDirection = null
    
    // Move target markers
    this.moveTargets = []
    this.combatFx = []

    // Dashboard state: track last-rendered planet state to avoid unnecessary rebuilds
    this._dashboardSig = null
    this._lastConstructCredits = null

    // Lane path cache (Path2D, rebuilt on tick not every frame)
    this.exploredLanePath   = null
    this.unexploredLanePath = null
    this.laneDirty          = true

    // Starfield background (offscreen, generated once)
    this._starCanvas = null

    // Multi-selection box state
    this.isDrawingBox = false
    this.boxStartX = 0
    this.boxStartY = 0
    this.boxCurrentX = 0
    this.boxCurrentY = 0
    this.boxSelectionUnion = false
    this.lastBoxX = undefined
    this.lastBoxY = undefined
    this.lastBoxW = 0
    this.lastBoxH = 0
    
    this.init()
  }

  init() {
    this.setupCanvas()
    this.setupInput()
    this.setupUI()
    this.startGame()
    this.startRenderLoop()
  }

  setupCanvas() {
    console.log('Setting up canvas...')
    this.canvas = document.getElementById('game-canvas')
    console.log('Canvas found:', this.canvas)
    
    if (!this.canvas) {
      console.error('Canvas element not found!')
      console.error('Available elements:', document.querySelectorAll('*').length)
      console.error('All canvas elements:', document.querySelectorAll('canvas'))
      throw new Error('Game canvas not found in DOM')
    }
    
    this.ctx = this.canvas.getContext('2d')
    console.log('Canvas context created successfully')
    
    // Set canvas size to match container
    this.resizeCanvas()
    window.addEventListener('resize', () => this.resizeCanvas())
    
    // Initial transform
    this.applyTransform()

    // Generate starfield background
    this._generateStarfield()
  }

  _generateStarfield() {
    const SW = 1024, SH = 1024
    const c = document.createElement('canvas')
    c.width = SW; c.height = SH
    const g = c.getContext('2d')
    g.fillStyle = '#0b0d12'
    g.fillRect(0, 0, SW, SH)

    // Seeded PRNG (simple LCG)
    let s = 42
    const rand = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff }

    // Layer 1: faint tiny stars (many)
    for (let i = 0; i < 600; i++) {
      const x = rand() * SW, y = rand() * SH
      const brightness = 40 + rand() * 50 | 0
      g.fillStyle = `rgb(${brightness},${brightness},${brightness + 15 | 0})`
      g.fillRect(x, y, 1, 1)
    }

    // Layer 2: medium stars
    for (let i = 0; i < 150; i++) {
      const x = rand() * SW, y = rand() * SH
      const brightness = 80 + rand() * 80 | 0
      const r = brightness, gr = brightness + (rand() * 10 | 0), b = brightness + (rand() * 30 | 0)
      g.fillStyle = `rgb(${r},${gr},${b})`
      const sz = 1 + (rand() > 0.7 ? 1 : 0)
      g.fillRect(x, y, sz, sz)
    }

    // Layer 3: bright stars (few, with glow)
    for (let i = 0; i < 30; i++) {
      const x = rand() * SW, y = rand() * SH
      const brightness = 180 + rand() * 75 | 0
      // Subtle colour hue variation
      const hue = rand()
      let r = brightness, gr = brightness, b = brightness
      if (hue < 0.15) { r = Math.min(255, brightness + 30); gr = brightness - 20; b = brightness - 20 }       // warm
      else if (hue < 0.3) { r = brightness - 20; gr = brightness - 10; b = Math.min(255, brightness + 40) }   // cool
      // Glow
      const grd = g.createRadialGradient(x, y, 0, x, y, 3)
      grd.addColorStop(0, `rgba(${r},${gr},${b},0.9)`)
      grd.addColorStop(1, `rgba(${r},${gr},${b},0)`)
      g.fillStyle = grd
      g.fillRect(x - 3, y - 3, 6, 6)
      // Core
      g.fillStyle = `rgb(${r},${gr},${b})`
      g.fillRect(x, y, 2, 2)
    }

    this._starCanvas = c

    // Apply as CSS tiled background — zero per-frame cost (GPU compositor)
    const dataUrl = c.toDataURL('image/png')
    const container = document.getElementById('game-container')
    if (container) {
      container.style.background = `#0b0d12 url(${dataUrl}) repeat`
    }
  }

  resizeCanvas() {
    const container = document.getElementById('game-container')
    this.width = container.clientWidth
    this.height = container.clientHeight
    
    this.canvas.width = this.width
    this.canvas.height = this.height
    
    // Ensure canvas can display the full galaxy when zoomed out
    // The galaxy is 4000x4000 units, so we need to make sure the canvas
    // can show the entire map when zoomed out to fit
    this.applyTransform()
  }

  applyTransform() {
    // Don't apply transform to canvas element - handle it in rendering context only
    // This prevents coordinate system misalignment issues
    
    // (zoom/pos display removed with controls panel)
  }

  setupInput() {
    // Mouse controls for panning
    let isDragging = false
    let lastMouseX = 0
    let lastMouseY = 0
    let mouseDownX = 0
    let mouseDownY = 0
    let didDrag = false

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // Left click
        mouseDownX = e.clientX
        mouseDownY = e.clientY
        didDrag = false

        if (e.ctrlKey || e.shiftKey) {
          // Start drawing selection box
          this.isDrawingBox = true
          this.boxSelectionUnion = !!e.shiftKey
          const rect = this.canvas.getBoundingClientRect()
          this.boxStartX = e.clientX - rect.left
          this.boxStartY = e.clientY - rect.top
          this.boxCurrentX = this.boxStartX
          this.boxCurrentY = this.boxStartY
        } else {
          // Start panning (or plain click — determined on mouseup)
          isDragging = true
          lastMouseX = e.clientX
          lastMouseY = e.clientY
        }
      } else if (e.button === 2) { // Right click
        this.handleMoveCommand(e)
      }
    })

    document.addEventListener('mousemove', (e) => {
      this.currentMouseX = e.clientX
      this.currentMouseY = e.clientY
      const rect = this.canvas.getBoundingClientRect()
      this.canvasMouseX = e.clientX - rect.left
      this.canvasMouseY = e.clientY - rect.top
      if (isDragging) {
        if (Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY) > 5) didDrag = true
        const dx = e.clientX - lastMouseX
        const dy = e.clientY - lastMouseY
        this.panX += dx
        this.panY += dy
        lastMouseX = e.clientX
        lastMouseY = e.clientY
        this.applyTransform()
      } else if (this.isDrawingBox) {
        // Update box coords — render loop draws it
        const rect = this.canvas.getBoundingClientRect()
        this.boxCurrentX = e.clientX - rect.left
        this.boxCurrentY = e.clientY - rect.top
      }
    })

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0 && isDragging) {
        isDragging = false
        if (!didDrag) this.handleSelection(e)  // plain click → select/deselect
      } else if (this.isDrawingBox) {
        this.completeSelectionBox()
        this.isDrawingBox = false
        this.boxSelectionUnion = false
      }
    })

    // Prevent context menu on right click
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
    })

    // Wheel for zoom (always zoom, centered on mouse position)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1

      // Zoom toward mouse position for natural feel
      const rect = this.canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      // World coords at mouse before zoom
      const worldX = (mouseX - this.panX) / this.zoom
      const worldY = (mouseY - this.panY) / this.zoom

      this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * zoomFactor))

      // Adjust pan so world coords at mouse position stay fixed
      this.panX = mouseX - worldX * this.zoom
      this.panY = mouseY - worldY * this.zoom

      this.applyTransform()
    }, { passive: false })

    // Keyboard controls
    const keys = this.keys
    
    // Enhanced zoom controls with C/V (screen center zoom with constant speed)
    let zoomInterval = null
    let currentZoomDirection = null
    
    const updateSmoothZoom = () => {
      if (!currentZoomDirection) return
      
      // Get screen center coordinates
      const screenCenterX = window.innerWidth / 2
      const screenCenterY = window.innerHeight / 2
      
      // Calculate current world coordinates at screen center
      const worldCenterX = (screenCenterX - this.panX) / this.zoom
      const worldCenterY = (screenCenterY - this.panY) / this.zoom
      
      // Apply zoom with constant speed (no ramping)
      let newZoom = this.zoom
      if (currentZoomDirection === 'out') {
        newZoom = Math.max(ZOOM_MIN, this.zoom * 0.98) // Slightly faster zoom out
      } else if (currentZoomDirection === 'in') {
        newZoom = Math.min(ZOOM_MAX, this.zoom * 1.02) // Slightly faster zoom in
      }
      
      // Calculate new pan to keep the same world coordinates at screen center
      const newPanX = screenCenterX - (worldCenterX * newZoom)
      const newPanY = screenCenterY - (worldCenterY * newZoom)
      
      this.zoom = newZoom
      this.panX = newPanX
      this.panY = newPanY
      
      this.applyTransform()
    }
    
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase()
      
      if (key === 'c' || key === 'v') {
        e.preventDefault() // Prevent browser zoom
        
        if (!zoomInterval) {
          currentZoomDirection = (key === 'c') ? 'out' : 'in'
          updateSmoothZoom() // Immediate response
          
          // Start smooth zoom interval
          zoomInterval = setInterval(updateSmoothZoom, 16) // ~60fps
        }
      }
      
      // Spacebar reset
      if (e.key === ' ') {
        this.focusOnLastPlanet()
      }

      // Escape — close dashboard
      if (e.key === 'Escape') {
        const tutorial = document.getElementById('tutorial-overlay')
        if (tutorial && tutorial.style.display !== 'none') {
          this.closeTutorial()
          return
        }
        const dash = document.getElementById('dashboard')
        if (dash && dash.style.display !== 'none') {
          this.closeDashboard()
        }
      }

      // F — move selected ships to cursor position
      if (key === 'f') {
        this.handleMoveCommand({ clientX: this.currentMouseX ?? 0, clientY: this.currentMouseY ?? 0 })
      }
      
      // WASD panning — just track key state; movement applied in render loop
      keys[key] = true
    })
    
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase()
      
      if ((key === 'c' || key === 'v') && zoomInterval) {
        clearInterval(zoomInterval)
        zoomInterval = null
        currentZoomDirection = null
      }
      
      keys[key] = false
    })
  }

  setupUI() {
    // Initialize HUD elements
    this.updateHUD()
    this.updateConnectionHUD()
    this.setupLobbyUI()
    this.setupTutorialUI()

    const unlockAudio = () => this.audio.unlock()
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    window.addEventListener('keydown', unlockAudio, { once: true })
    this.updateAudioButtons()
    this.updateVolumeUI()
    
    // Setup dashboard
    this.setupDashboard()
  }

  setupTutorialUI() {
    this.tutorialCanvas = document.getElementById('tutorial-demo-canvas')
    this.tutorialCtx = this.tutorialCanvas?.getContext('2d') || null
    this.renderTutorialStep()
  }

  handleTutorialBackdrop(evt) {
    if (evt?.target?.id === 'tutorial-overlay') this.closeTutorial()
  }

  openTutorial() {
    const overlay = document.getElementById('tutorial-overlay')
    if (!overlay) return
    this.tutorialStepIndex = 0
    this.renderTutorialStep()
    overlay.style.display = 'flex'
    this._startTutorialAnimation()
    this.audio.playSfx('click')
  }

  closeTutorial() {
    const overlay = document.getElementById('tutorial-overlay')
    if (!overlay) return
    overlay.style.display = 'none'
    this._stopTutorialAnimation()
  }

  prevTutorialStep() {
    if (this.tutorialStepIndex <= 0) return
    this.tutorialStepIndex -= 1
    this.renderTutorialStep()
    this.audio.playSfx('click')
  }

  nextTutorialStep() {
    if (this.tutorialStepIndex >= this.tutorialSteps.length - 1) {
      this.closeTutorial()
      this.audio.playSfx('click')
      return
    }
    this.tutorialStepIndex += 1
    this.renderTutorialStep()
    this.audio.playSfx('click')
  }

  renderTutorialStep() {
    const titleEl = document.getElementById('tutorial-title')
    const textEl = document.getElementById('tutorial-text')
    const listEl = document.getElementById('tutorial-list')
    const indexEl = document.getElementById('tutorial-step-index')
    const fillEl = document.getElementById('tutorial-progress-fill')
    const capEl = document.getElementById('tutorial-demo-caption')
    const prevBtn = document.getElementById('tutorial-prev')
    const nextBtn = document.getElementById('tutorial-next')
    if (!titleEl || !textEl || !listEl || !indexEl || !fillEl || !prevBtn || !nextBtn) return

    const total = this.tutorialSteps.length
    const idx = Math.max(0, Math.min(this.tutorialStepIndex, total - 1))
    const step = this.tutorialSteps[idx]
    this.tutorialStepIndex = idx

    titleEl.textContent = step.title
    textEl.textContent = step.text
    if (capEl) capEl.textContent = step.demoCaption || 'Interactive visual preview'
    listEl.innerHTML = step.bullets.map(item => `<li>${item}</li>`).join('')
    indexEl.textContent = `Step ${idx + 1} / ${total}`
    fillEl.style.width = `${Math.round(((idx + 1) / total) * 100)}%`
    prevBtn.disabled = idx === 0
    nextBtn.textContent = idx === total - 1 ? 'Finish' : 'Next'
  }

  _startTutorialAnimation() {
    if (this.tutorialAnimRaf) return
    this.tutorialAnimStart = performance.now()
    const loop = (now) => {
      this._renderTutorialDemo(now)
      this.tutorialAnimRaf = requestAnimationFrame(loop)
    }
    this.tutorialAnimRaf = requestAnimationFrame(loop)
  }

  _stopTutorialAnimation() {
    if (!this.tutorialAnimRaf) return
    cancelAnimationFrame(this.tutorialAnimRaf)
    this.tutorialAnimRaf = null
  }

  _renderTutorialDemo(now) {
    const overlay = document.getElementById('tutorial-overlay')
    if (!overlay || overlay.style.display === 'none') return
    const c = this.tutorialCanvas
    const g = this.tutorialCtx
    if (!c || !g) return

    const t = (now - this.tutorialAnimStart) / 1000
    const w = c.width
    const h = c.height

    g.fillStyle = '#060d16'
    g.fillRect(0, 0, w, h)

    for (let i = 0; i < 60; i++) {
      const x = (i * 137 % w + t * 12 * (1 + (i % 3))) % w
      const y = (i * 71) % h
      g.fillStyle = i % 7 === 0 ? 'rgba(180,210,255,0.9)' : 'rgba(100,140,180,0.6)'
      g.fillRect(x, y, 1, 1)
    }

    const scene = this.tutorialStepIndex
    if (scene === 0) this._drawTutorialSceneControls(g, w, h, t)
    else if (scene === 1) this._drawTutorialSceneSelection(g, w, h, t)
    else if (scene === 2) this._drawTutorialSceneResources(g, w, h, t)
    else if (scene === 3) this._drawTutorialScenePlanet(g, w, h, t)
    else if (scene === 4) this._drawTutorialSceneCombat(g, w, h, t)
    else if (scene === 5) this._drawTutorialSceneBuildings(g, w, h, t)
    else if (scene === 6) this._drawTutorialSceneTiers(g, w, h, t)
    else this._drawTutorialSceneLobby(g, w, h, t)
  }

  _drawTutorialPlanet(g, x, y, r, core = '#2fd4ff', ring = 'rgba(122,231,255,0.35)') {
    g.beginPath()
    g.arc(x, y, r + 5, 0, Math.PI * 2)
    g.strokeStyle = ring
    g.lineWidth = 2
    g.stroke()
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fillStyle = core
    g.fill()
  }

  _drawTutorialShip(g, x, y, color = '#9fe7ff', size = 6) {
    g.beginPath()
    g.moveTo(x + size, y)
    g.lineTo(x - size, y - size * 0.7)
    g.lineTo(x - size * 0.6, y)
    g.lineTo(x - size, y + size * 0.7)
    g.closePath()
    g.fillStyle = color
    g.fill()
  }

  _drawTutorialSceneControls(g, w, h, t) {
    const cx = w * 0.5 + Math.sin(t * 0.8) * 35
    const cy = h * 0.5 + Math.cos(t * 0.7) * 18
    this._drawTutorialPlanet(g, cx, cy, 20, '#27c8ef')

    const zoomPulse = 1 + Math.sin(t * 2.2) * 0.18
    g.strokeStyle = 'rgba(244,207,116,0.8)'
    g.lineWidth = 2
    g.strokeRect(cx - 50 * zoomPulse, cy - 34 * zoomPulse, 100 * zoomPulse, 68 * zoomPulse)

    const shipX = 120 + (t * 70 % 440)
    const shipY = 50 + Math.sin(t * 2) * 10
    this._drawTutorialShip(g, shipX, shipY, '#8bf0b2')

    g.beginPath()
    g.setLineDash([6, 5])
    g.moveTo(shipX, shipY)
    g.lineTo(cx + 90, cy + 30)
    g.strokeStyle = 'rgba(111,232,255,0.7)'
    g.stroke()
    g.setLineDash([])

    g.fillStyle = '#f4cf74'
    g.beginPath()
    g.arc(cx + 90, cy + 30, 4 + Math.sin(t * 8) * 1.3, 0, Math.PI * 2)
    g.fill()
  }

  _drawTutorialSceneSelection(g, w, h, t) {
    const baseX = 170
    const baseY = 72
    const spacing = 38
    const ships = []
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        ships.push({
          x: baseX + col * spacing + Math.sin(t * 1.2 + col + row) * 2,
          y: baseY + row * spacing + Math.cos(t * 1.4 + col * 0.4) * 2,
        })
      }
    }

    for (const s of ships) this._drawTutorialShip(g, s.x, s.y, '#8bf0b2', 6)

    const selectPulse = 0.75 + (Math.sin(t * 3.5) + 1) * 0.15
    g.strokeStyle = `rgba(122,231,255,${selectPulse})`
    g.lineWidth = 2
    g.strokeRect(130, 44, 150, 92)

    g.fillStyle = '#6ea7c5'
    g.font = '11px Courier New'
    g.fillText('Shift/Ctrl + Drag = Box Select', 112, 160)

    const targetX = 560 + Math.sin(t * 0.9) * 25
    const targetY = 110 + Math.cos(t * 0.7) * 18
    g.beginPath()
    g.arc(targetX, targetY, 8 + Math.sin(t * 6) * 1.2, 0, Math.PI * 2)
    g.strokeStyle = '#f4cf74'
    g.stroke()

    g.beginPath()
    g.setLineDash([5, 5])
    g.moveTo(250, 90)
    g.lineTo(targetX, targetY)
    g.strokeStyle = 'rgba(244,207,116,0.85)'
    g.stroke()
    g.setLineDash([])

    const progress = (Math.sin(t * 1.2) + 1) * 0.5
    for (let i = 0; i < ships.length; i++) {
      const sx = ships[i].x
      const sy = ships[i].y
      const tx = targetX - 28 + (i % 3) * 24
      const ty = targetY - 20 + Math.floor(i / 3) * 20
      const mx = sx + (tx - sx) * progress
      const my = sy + (ty - sy) * progress
      this._drawTutorialShip(g, mx, my, '#7ae7ff', 5)
    }
  }

  _drawTutorialSceneResources(g, w, h, t) {
    const cr = Math.min(1, (Math.sin(t * 1.1) + 1) * 0.5 * 0.9 + 0.1)
    const rp = Math.min(1, (Math.sin(t * 0.9 + 1.1) + 1) * 0.5 * 0.75 + 0.2)
    const fleet = Math.min(1, (Math.sin(t * 0.7 + 2.1) + 1) * 0.5 * 0.7 + 0.25)
    const bar = (x, y, label, pct, col) => {
      g.fillStyle = '#112336'
      g.fillRect(x, y, 280, 20)
      g.fillStyle = col
      g.fillRect(x, y, 280 * pct, 20)
      g.strokeStyle = '#2a4c6d'
      g.strokeRect(x, y, 280, 20)
      g.fillStyle = '#b5d6e6'
      g.font = '12px Courier New'
      g.fillText(`${label} ${Math.round(pct * 100)}%`, x + 8, y + 14)
    }
    bar(60, 55, 'Credits', cr, '#00e8cc')
    bar(60, 92, 'Research', rp, '#a78bfa')
    bar(60, 129, 'Fleet Power', fleet, '#fbbf24')

    const pulse = 0.4 + (Math.sin(t * 4) + 1) * 0.3
    g.fillStyle = `rgba(0,232,204,${pulse})`
    g.fillRect(370, 65, 180, 48)
    g.fillStyle = '#0b1a26'
    g.font = 'bold 13px Courier New'
    g.fillText('+ Income Tick', 388, 92)
  }

  _drawTutorialScenePlanet(g, w, h, t) {
    this._drawTutorialPlanet(g, 180, 110, 32, '#35d6ff')
    this._drawTutorialPlanet(g, 330, 78, 22, '#5ad28c')
    this._drawTutorialPlanet(g, 420, 148, 18, '#f4cf74')

    const pulse = 0.5 + (Math.sin(t * 3) + 1) * 0.25
    g.strokeStyle = `rgba(111,232,255,${pulse})`
    g.lineWidth = 3
    g.strokeRect(146, 76, 68, 68)

    g.fillStyle = 'rgba(12,26,43,0.94)'
    g.fillRect(500, 38, 220, 144)
    g.strokeStyle = '#2f5f80'
    g.strokeRect(500, 38, 220, 144)
    g.fillStyle = '#7ae7ff'
    g.font = 'bold 12px Courier New'
    g.fillText('PLANET DASHBOARD', 512, 58)
    g.fillStyle = '#9fc5d8'
    g.font = '11px Courier New'
    g.fillText('Income: +12.4/s', 512, 82)
    g.fillText('Population: 64', 512, 101)
    g.fillText(`Level: ${2 + Math.floor((Math.sin(t) + 1) * 1.4)}`, 512, 120)
    g.fillText('Queue: Shipyard, Level Up', 512, 139)
    g.fillText('Defense: 78%', 512, 158)
  }

  _drawTutorialSceneCombat(g, w, h, t) {
    const leftBase = 120
    const rightBase = 620
    for (let i = 0; i < 4; i++) {
      this._drawTutorialShip(g, leftBase + i * 34 + Math.sin(t * 2 + i) * 6, 80 + i * 24, '#76f7d2', 6)
      this._drawTutorialShip(g, rightBase - i * 34 - Math.cos(t * 2 + i) * 6, 80 + i * 24, '#ff9fa9', 6)
    }

    for (let i = 0; i < 5; i++) {
      const p = (t * 1.6 + i * 0.2) % 1
      const x = 190 + p * 420
      const y = 90 + i * 22
      g.fillStyle = '#ffd58a'
      g.fillRect(x, y, 8, 2)
    }

    const boom = (Math.sin(t * 5) + 1) * 0.5
    g.beginPath()
    g.arc(390, 112, 10 + boom * 14, 0, Math.PI * 2)
    g.fillStyle = `rgba(255,180,100,${0.25 + boom * 0.4})`
    g.fill()

    g.fillStyle = '#b6d6ea'
    g.font = '11px Courier New'
    g.fillText('Mixed fleet > single-unit spam', 270, 194)
  }

  _drawTutorialSceneBuildings(g, w, h, t) {
    this._drawTutorialPlanet(g, 160, 110, 30, '#27c8ef')
    const labels = ['Extractor', 'Trade Hub', 'Research Lab', 'Shipyard', 'Defense']
    for (let i = 0; i < labels.length; i++) {
      const x = 280 + (i % 2) * 190
      const y = 42 + Math.floor(i / 2) * 56
      const active = ((t * 1.2 + i * 0.5) % 3) > 1
      g.fillStyle = active ? 'rgba(76,170,102,0.7)' : 'rgba(21,43,62,0.86)'
      g.fillRect(x, y, 166, 40)
      g.strokeStyle = active ? '#70d18a' : '#355a77'
      g.strokeRect(x, y, 166, 40)
      g.fillStyle = '#b7d8ea'
      g.font = '11px Courier New'
      g.fillText(labels[i], x + 10, y + 24)
    }

    const income = 20 + Math.round((Math.sin(t * 1.5) + 1) * 18)
    g.fillStyle = '#f4cf74'
    g.font = 'bold 12px Courier New'
    g.fillText(`Planet Income: +${income}/s`, 36, 190)
  }

  _drawTutorialSceneTiers(g, w, h, t) {
    g.fillStyle = 'rgba(11,22,33,0.94)'
    g.fillRect(70, 30, 620, 160)
    g.strokeStyle = '#335974'
    g.strokeRect(70, 30, 620, 160)

    const tierPct = Math.min(1, (Math.sin(t * 0.9) + 1) * 0.5 * 0.9 + 0.05)
    g.fillStyle = '#112336'
    g.fillRect(110, 56, 360, 16)
    g.fillStyle = '#a78bfa'
    g.fillRect(110, 56, 360 * tierPct, 16)
    g.fillStyle = '#9fc5d8'
    g.font = '11px Courier New'
    g.fillText(`Research to next tier: ${Math.round(tierPct * 2000)} / 2000`, 110, 49)

    const upLv = Math.floor((t * 1.1) % 6)
    const drawUpgrade = (y, name, col) => {
      g.fillStyle = '#0e1d2d'
      g.fillRect(110, y, 420, 26)
      g.strokeStyle = '#2f5f80'
      g.strokeRect(110, y, 420, 26)
      g.fillStyle = '#b7d7ea'
      g.fillText(name, 122, y + 17)
      for (let i = 0; i < 5; i++) {
        g.fillStyle = i < upLv ? col : '#22394f'
        g.fillRect(332 + i * 18, y + 7, 12, 12)
      }
    }
    drawUpgrade(92, 'Speed Upgrade', '#53d2ff')
    drawUpgrade(123, 'Health Upgrade', '#62f0ab')
    drawUpgrade(154, 'Damage Upgrade', '#ff9fa9')
  }

  _drawTutorialSceneLobby(g, w, h, t) {
    g.fillStyle = 'rgba(10,21,33,0.94)'
    g.fillRect(74, 30, 640, 160)
    g.strokeStyle = '#315b78'
    g.strokeRect(74, 30, 640, 160)

    const codeFlash = ((Math.sin(t * 2.6) + 1) * 0.5)
    g.fillStyle = `rgba(122,231,255,${0.3 + codeFlash * 0.5})`
    g.fillRect(98, 50, 220, 28)
    g.fillStyle = '#052033'
    g.font = 'bold 15px Courier New'
    g.fillText('LOBBY B7Q9P2', 111, 69)

    const players = ['Host', 'Nova', 'Orion', 'Valkyrie']
    for (let i = 0; i < players.length; i++) {
      const y = 92 + i * 22
      g.fillStyle = 'rgba(20,40,58,0.9)'
      g.fillRect(98, y, 280, 18)
      g.fillStyle = '#b6d6ea'
      g.font = '11px Courier New'
      g.fillText(`${i + 1}. ${players[i]}${i === 0 ? ' (Host)' : ''}`, 107, y + 13)
    }

    const state = Math.floor((t * 0.8) % 3)
    const status = state === 0 ? 'Waiting for players...' : state === 1 ? 'Players ready. Starting...' : 'Match launched!'
    g.fillStyle = '#f4cf74'
    g.font = '12px Courier New'
    g.fillText(status, 420, 106)
    g.fillStyle = '#7ae7ff'
    g.fillText('Paste code → Join → Host starts', 420, 132)
  }

  updateAudioButtons() {
    const sfxBtn = document.getElementById('btn-sfx-toggle')
    const musicBtn = document.getElementById('btn-music-toggle')
    const sfxMuted = this.audio.isSfxMuted()
    const musicMuted = this.audio.isMusicMuted()

    if (sfxBtn) {
      sfxBtn.textContent = sfxMuted ? 'SFX OFF' : 'SFX ON'
      sfxBtn.style.color = sfxMuted ? '#ff7a7a' : '#7ae7ff'
      sfxBtn.style.borderColor = sfxMuted ? '#8a4040' : '#2f5f80'
    }
    if (musicBtn) {
      musicBtn.textContent = musicMuted ? 'MUSIC OFF' : 'MUSIC ON'
      musicBtn.style.color = musicMuted ? '#ff7a7a' : '#7ae7ff'
      musicBtn.style.borderColor = musicMuted ? '#8a4040' : '#2f5f80'
    }
  }

  updateVolumeUI() {
    const sfxPct = Math.round(this.audio.getSfxVolume() * 100)
    const musicPct = Math.round(this.audio.getMusicVolume() * 100)

    // In-game HUD sliders
    const sfxSlider = document.getElementById('sfx-volume')
    const musicSlider = document.getElementById('music-volume')
    const sfxValue = document.getElementById('sfx-volume-value')
    const musicValue = document.getElementById('music-volume-value')
    if (sfxSlider) sfxSlider.value = String(sfxPct)
    if (musicSlider) musicSlider.value = String(musicPct)
    if (sfxValue) sfxValue.textContent = `${sfxPct}%`
    if (musicValue) musicValue.textContent = `${musicPct}%`

    // Menu sliders (keep in sync)
    const menuSfx = document.getElementById('menu-sfx-volume')
    const menuMusic = document.getElementById('menu-music-volume')
    const menuSfxVal = document.getElementById('menu-sfx-value')
    const menuMusicVal = document.getElementById('menu-music-value')
    if (menuSfx) menuSfx.value = String(sfxPct)
    if (menuMusic) menuMusic.value = String(musicPct)
    if (menuSfxVal) menuSfxVal.textContent = `${sfxPct}%`
    if (menuMusicVal) menuMusicVal.textContent = `${musicPct}%`
  }

  toggleSfxMute() {
    this.audio.setSfxMuted(!this.audio.isSfxMuted())
    this.updateAudioButtons()
    this.updateVolumeUI()
  }

  toggleMusicMute() {
    this.audio.setMusicMuted(!this.audio.isMusicMuted())
    this.updateAudioButtons()
    this.updateVolumeUI()
  }

  setSfxVolume(value) {
    this.audio.setSfxVolume(Number(value) / 100)
    this.updateVolumeUI()
  }

  setMusicVolume(value) {
    this.audio.setMusicVolume(Number(value) / 100)
    this.updateVolumeUI()
  }

  updateConnectionHUD() {
    const conn = document.getElementById('hud-conn')
    const ep = document.getElementById('hud-endpoint')
    const on = document.getElementById('hud-online')
    if (conn) conn.textContent = this.connectionOnline ? 'ONLINE' : 'OFFLINE'
    if (conn) conn.style.color = this.connectionOnline ? '#00e8cc' : '#ff6f78'
    if (ep) ep.textContent = this.endpointLabel
    if (on) on.textContent = `${this.playersOnline}`
  }

  setupLobbyUI() {
    const nameInput = document.getElementById('lobby-player-name')
    if (nameInput) {
      const saved = localStorage.getItem('ftl_player_name')
      if (saved) nameInput.value = saved
      nameInput.addEventListener('change', () => {
        localStorage.setItem('ftl_player_name', nameInput.value.trim() || 'Player')
      })
    }
    this.renderLobbyStatus('Idle. Host or join a lobby.')
  }

  renderLobbyStatus(status, players = null) {
    const statusEl = document.getElementById('lobby-status')
    const rosterEl = document.getElementById('lobby-roster')
    const codeEl = document.getElementById('lobby-code-display')
    const startBtn = document.getElementById('lobby-start-btn')
    const copyBtn = document.getElementById('lobby-copy-btn')
    if (players != null) this.lobbyPlayers = players
    const rosterPlayers = this.lobbyPlayers || []

    if (statusEl) statusEl.textContent = status
    if (rosterEl) {
      const esc = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

      rosterEl.innerHTML = rosterPlayers.length
        ? rosterPlayers.map(p => `
            <div class="lobby-player-row">
              <span class="lobby-player-slot">${esc(p.slot)}</span>
              <span class="lobby-player-name" title="${esc(p.name)}">${esc(p.name)}</span>
              ${p.is_host ? '<span class="lobby-player-host">HOST</span>' : ''}
            </div>
          `).join('')
        : '<div class="lobby-roster-empty">No players yet.</div>'
    }
    if (codeEl) codeEl.textContent = this.lobbyId ? `Lobby ${this.lobbyId}` : 'No active lobby'
    if (startBtn) startBtn.style.display = this.lobbyIsHost && this.lobbyId ? 'inline-block' : 'none'
    if (copyBtn) copyBtn.style.display = this.lobbyId ? 'inline-block' : 'none'
  }

  async copyLobbyCode() {
    if (!this.lobbyId) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this.lobbyId)
      } else {
        const temp = document.createElement('input')
        temp.value = this.lobbyId
        document.body.appendChild(temp)
        temp.select()
        document.execCommand('copy')
        temp.remove()
      }
      this.renderLobbyStatus(`Code copied: ${this.lobbyId}`)
      this.audio.playSfx('click')
    } catch {
      this.renderLobbyStatus(`Copy failed. Code: ${this.lobbyId}`)
    }
  }

  async pasteLobbyCode() {
    const codeInput = document.getElementById('lobby-code-input')
    if (!codeInput) return
    try {
      this.audio.playSfx('click')
      if (!navigator.clipboard?.readText) {
        this.showNotification('Clipboard read unavailable in this browser', '#ff4444')
        return
      }
      const raw = await navigator.clipboard.readText()
      const cleaned = (raw || '').replace(/\s+/g, '').toUpperCase().slice(0, 6)
      if (!cleaned) {
        this.showNotification('Clipboard is empty', '#ff4444')
        return
      }
      codeInput.value = cleaned
      this.renderLobbyStatus(`Pasted code: ${cleaned}`)
    } catch {
      this.showNotification('Clipboard permission denied', '#ff4444')
    }
  }

  // ── Income helper (mirrors backend formula × 20 ticks/s) ──────────────────
  _calcPlanetIncome(planet) {
    const extractors = (planet.buildings ?? []).filter(b => b === 'extractor').length
    const tradeHubs  = (planet.buildings ?? []).filter(b => b === 'trade_hub').length
    return (
      0.10
      + (planet.level - 1) * 0.08
      + extractors * 0.08
      + tradeHubs  * 0.10
      + (planet.population ?? 0) * 0.002
    ) * (planet.resource_rate ?? 1.0) * 20
  }

  updateHUD() {
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val }
    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : Math.floor(n)
    if (this.gameState) {
      const player = this.gameState.factions.find(f => f.id === this.gameState.player_faction_id)
      if (player) {
        set('hud-credits', fmt(player.credits))
        // Only compute income delta once per tick (avoid double-call flicker)
        if (this._incomeCalcTick !== this.gameState.tick) {
          this._incomeCalcTick = this.gameState.tick
          this._incomeRate = player._lastCredits != null
            ? (player.credits - player._lastCredits) * 20
            : 0
          player._lastCredits = player.credits
        }
        set('hud-income', `+${(this._incomeRate ?? 0).toFixed(1)}/s`)
        set('hud-rp', Math.floor(player.research_points))
        set('hud-tier', player.tech_tier)
        set('hud-tick', this.gameState.tick)
      }
    }

    // Refresh tier progress if dropdown is visible
    const tierDD = document.getElementById('tier-dropdown')
    if (tierDD && tierDD.style.display !== 'none') window._updateTierProgress?.()
    
    // Update selection info
    if (this.selectedShips.size > 0) {
      const sMap = {}
      this.gameState?.ships.forEach(s => { sMap[s.id] = s })
      const sel = [...this.selectedShips].map(id => sMap[id]).filter(Boolean)
      const types = {}
      sel.forEach(s => { types[s.type] = (types[s.type] ?? 0) + 1 })
      const typeStr = Object.entries(types).map(([t, n]) => `${n}× ${t}`).join('  ')
      document.getElementById('hud-selection').textContent = `${this.selectedShips.size} selected  ${typeStr}`
      document.querySelector('.bottom-right').style.display = 'block'
    } else {
      document.getElementById('hud-selection').textContent = 'No selection'
      document.querySelector('.bottom-right').style.display = 'none'
    }

    this.updateFactionStatus()
  }

  updateFactionStatus() {
    const el = document.getElementById('faction-rows')
    const panel = document.getElementById('faction-status')
    if (!el || !this.gameState) return

    panel.style.display = 'block'

    const { planets, ships, factions, player_faction_id } = this.gameState
    const totalPlanets = planets.length

    const planetCount = {}
    const shipCount = {}
    planets.forEach(p => { if (p.owner) planetCount[p.owner] = (planetCount[p.owner] ?? 0) + 1 })
    ships.forEach(s => { if (s.owner) shipCount[s.owner] = (shipCount[s.owner] ?? 0) + 1 })

    const sorted = [...factions].sort((a, b) => {
      if (a.id === player_faction_id) return -1
      if (b.id === player_faction_id) return 1
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1
      return (planetCount[b.id] ?? 0) - (planetCount[a.id] ?? 0)
    })

    el.innerHTML = sorted.map(f => {
      const pc  = planetCount[f.id] ?? 0
      const sc  = shipCount[f.id] ?? 0
      const pct = totalPlanets > 0 ? Math.round(pc / totalPlanets * 100) : 0
      const isPlayer = f.id === player_faction_id
      const dim = f.eliminated
      const col = f.colour ?? '#888'
      const nameCol = isPlayer ? '#00e8cc' : (dim ? '#2a3a44' : '#b0c8d0')
      const statCol = dim ? '#2a3a44' : '#4a7080'
      const barCol  = dim ? '#1a2a30' : (isPlayer ? '#00e8cc' : col)
      return `
        <div style="padding:3px 0;${dim ? 'opacity:0.35;' : ''}">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:9px;height:9px;border-radius:50%;background:${col};flex-shrink:0;display:inline-block;${isPlayer ? `box-shadow:0 0 6px ${col};` : ''}"></span>
            <span style="color:${nameCol};font-size:12px;font-weight:${isPlayer ? 700 : 500};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
            <span style="color:${statCol};font-size:11px;min-width:18px;text-align:right;">${pc}</span>
            <span style="color:${dim ? '#2a3a44' : '#c09830'};font-size:11px;min-width:32px;text-align:right;">${pct}%</span>
            <span style="color:${dim ? '#2a3a44' : '#4a9080'};font-size:11px;min-width:34px;text-align:right;">${sc} ▲</span>
          </div>
          <div style="height:2px;background:#0d1820;border-radius:1px;margin:4px 0 1px 17px;">
            <div style="width:${pct}%;height:100%;background:${barCol};border-radius:1px;opacity:${dim ? 0.2 : 0.65};"></div>
          </div>
        </div>`
    }).join('')
  }

  setupDashboard() {
    // Dashboard is already in HTML, just need to handle interactions
    const dashboard = document.getElementById('dashboard')
    
    // Close button
    dashboard.addEventListener('click', (e) => {
      if (e.target.closest('.dashboard-close')) {
        this.closeDashboard()
      }
    })
    
    // Dim overlay click to close
    dashboard.addEventListener('click', (e) => {
      if (e.target === dashboard) {
        this.closeDashboard()
      }
    })
  }

  openDashboard(planet) {
    if (!planet) return

    // Close tier dropdown to avoid overlap
    const tierDD = document.getElementById('tier-dropdown')
    if (tierDD) tierDD.style.display = 'none'

    // Track signature so applyDelta knows the current render state
    this._dashboardSig = `${planet.owner}|${planet.level}|${planet.buildings.join(',')}|${(planet.build_queue ?? []).map(q => q.name ?? q.ship_type ?? 'level_up').join(',')}`

    const dashboard = document.getElementById('dashboard')
    const pid = this.gameState.player_faction_id
    const fMap = {}
    this.gameState.factions.forEach(f => { fMap[f.id] = f })

    const explored = planet.explored_by.some(fid => fid !== 'neutral')
    const ownerName = planet.owner ? (fMap[planet.owner]?.name ?? planet.owner) : 'Neutral'
    const ownerHex = planet.owner === pid ? '#00ffff' : (fMap[planet.owner]?.colour ?? '#888888')

    document.getElementById('dashboard-title').textContent = explored ? planet.name : '???'
    document.getElementById('dashboard-owner').textContent = ownerName
    document.getElementById('dashboard-owner').style.color = ownerHex

    const incomePerS = this._calcPlanetIncome(planet)
    const resLabelEl = document.getElementById('dashboard-resource-label')
    if (resLabelEl) resLabelEl.textContent = `Credits (x${(planet.resource_rate ?? 1).toFixed(1)})`
    document.getElementById('dashboard-minerals').textContent = incomePerS.toFixed(1)
    document.getElementById('dashboard-population').textContent = planet.population
    const levelDefBonus = (planet.level - 1) * 0.05
    document.getElementById('dashboard-defense').textContent = Math.round((planet.defense + levelDefBonus) * 100)
    document.getElementById('dashboard-level').textContent = planet.level
    document.getElementById('dashboard-ships').textContent = planet.level
    document.getElementById('dashboard-orbiting').textContent = this.gameState.ships.filter(
      s => s.state === 'orbiting' && s.target_planet === planet.id
    ).length

    // Buildings with per-building descriptions
    const BLDG_DESC = {
      extractor: '+income & storage', shipyard: 'enables ships',
      research_lab: '+1 RP/tick', defense_platform: 'auto-fires dmg15',
      trade_hub: '+0.5/tick income', orbital_cannon: 'auto-fires dmg30',
    }
    const BLDG_LABEL = {
      extractor: 'Extractor', shipyard: 'Shipyard', research_lab: 'Lab',
      defense_platform: 'Defense', trade_hub: 'Trade Hub', orbital_cannon: 'Orb.Cannon',
    }
    document.getElementById('dashboard-buildings').textContent = planet.buildings.length === 0
      ? 'None'
      : planet.buildings.map(b => `${BLDG_LABEL[b] ?? b} (${BLDG_DESC[b] ?? ''})`).join('  ·  ')

    // Build queue with correct progress bar
    this._tickDashboardQueue(planet)

    // Construction buttons
    this.updateConstructionButtons(planet)

    dashboard.style.display = 'block'
  }

  closeDashboard() {
    document.getElementById('dashboard').style.display = 'none'
  }

  updateConstructionButtons(planet) {
    const container = document.getElementById('dashboard-construction')
    container.innerHTML = ''

    const pid = this.gameState.player_faction_id
    if (planet.owner !== pid) return

    const faction = this.gameState.factions.find(f => f.id === pid)
    if (!faction) return

    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n

    // Current resources header
    const resDiv = document.createElement('div')
    resDiv.id = 'dashboard-construct-resources'
    resDiv.style.cssText = 'font-size:11px;margin-bottom:10px;'
    resDiv.textContent = `Cr ${fmt(Math.floor(faction.credits))}  RP ${Math.floor(faction.research_points)}  T${faction.tech_tier}  Lvl ${planet.level}`
    container.appendChild(resDiv)

    const queueCapacity = 2 + Math.max(0, (planet.level ?? 1) - 1)
    const queueFull = (planet.build_queue ?? []).length >= queueCapacity

    const queueCapEl = document.getElementById('dashboard-queue-cap')
    if (queueCapEl) queueCapEl.textContent = queueCapacity

    const LEVEL_UP_COSTS = { 1: 300, 2: 600, 3: 1200, 4: 2400 }
    const LEVEL_UP_TICKS_TABLE = { 1: 200, 2: 400, 3: 800, 4: 1600 }

    const BLDGS = [
      { name: 'extractor',        label: 'Extractor',     credits: 100, lvl: 1, desc: '+income & storage' },
      { name: 'shipyard',         label: 'Shipyard',      credits: 200, lvl: 1, desc: 'enables ship production' },
      { name: 'research_lab',     label: 'Research Lab',  credits: 150, lvl: 1, desc: '+1 RP/tick · T2@500 T3@2000' },
      { name: 'defense_platform', label: 'Defense Plat.', credits: 250, lvl: 1, desc: 'auto-fires dmg 15 · range 300' },
      { name: 'trade_hub',        label: 'Trade Hub',     credits: 350, lvl: 2, desc: '+0.5/tick income' },
      { name: 'orbital_cannon',   label: 'Orb. Cannon',   credits: 450, lvl: 3, desc: 'auto-fires dmg 30 · range 500' },
    ]
    const SHIPS = [
      { name: 'fighter',     label: 'Fighter',      credits:  50, tier: 1, desc: 'HP:50 DMG:8 SPD:30 · 5s' },
      { name: 'cruiser',     label: 'Cruiser',      credits: 150, tier: 2, desc: 'HP:150 DMG:20 SPD:22 · 10s' },
      { name: 'bomber',      label: 'Bomber',       credits: 120, tier: 2, desc: 'HP:120 DMG:45 SPD:18 · 9s' },
      { name: 'carrier',     label: 'Carrier',      credits: 400, tier: 3, desc: 'HP:300 DMG:10 SPD:14 · 25s' },
      { name: 'dreadnought', label: 'Dreadnought',  credits: 800, tier: 3, desc: 'HP:600 DMG:80 SPD:10 · 40s' },
      { name: 'mothership',  label: 'Mothership',   credits: 2500, tier: 3, desc: 'HP:1000 spawns fighters · 75s' },
    ]

    const makeBtn = (label, cost, desc, canBuild, onClick, hint = '') => {
      const btn = document.createElement('button')
      btn.className = `dash-pixel-btn ${canBuild ? 'enabled' : 'disabled'}`
      btn.style.cssText = `cursor:${canBuild ? 'pointer' : 'default'};opacity:${canBuild ? '1' : '0.55'};min-width:110px;`
      const hintHtml = hint ? `<div class="dash-btn-hint">${hint}</div>` : ''
      btn.innerHTML = `<div class="dash-btn-title">${label}</div><div class="dash-btn-cost">${cost}</div><div class="dash-btn-desc">${desc}</div>${hintHtml}`
      if (canBuild) btn.addEventListener('click', onClick)
      return btn
    }

    // ── Level Up button ──────────────────────────────────────────────────────
    if (planet.level < 5) {
      const lvCost  = LEVEL_UP_COSTS[planet.level]
      const lvTicks = LEVEL_UP_TICKS_TABLE[planet.level]
      const alreadyQueued = (planet.build_queue ?? []).some(q => q.type === 'level_up')
      const can = !queueFull && !alreadyQueued && faction.credits >= lvCost
      const hint = alreadyQueued ? 'already queued' : ''
      container.appendChild(makeBtn(
        `⬆ Level ${planet.level} → ${planet.level + 1}`,
        `💰${lvCost}  ~${Math.round(lvTicks / 20)}s`,
        `+${(0.08 * (planet.resource_rate ?? 1) * 20).toFixed(1)}/s income · +5% defense`,
        can,
        () => this.socket?.send({ type: 'build', planet_id: planet.id, item_type: 'level_up' }),
        hint
      ))
    }

    // ── Buildings ────────────────────────────────────────────────────────────
    BLDGS.filter(b => !planet.buildings.includes(b.name)).forEach(b => {
      const levelOk = planet.level >= b.lvl
      const hint    = !levelOk ? `needs Level ${b.lvl}` : ''
      const can     = levelOk && !queueFull && faction.credits >= b.credits
      container.appendChild(makeBtn(b.label, `💰${b.credits}`, b.desc, can, () =>
        this.socket?.send({ type: 'build', planet_id: planet.id, item_type: 'building', item_name: b.name }),
        hint
      ))
    })

    // ── Ships ────────────────────────────────────────────────────────────────
    if (planet.buildings.includes('shipyard')) {
      SHIPS.forEach(s => {
        const tierOk = faction.tech_tier >= s.tier
        const hint   = !tierOk ? `needs Tier ${s.tier}` : ''
        const can    = tierOk && !queueFull && faction.credits >= s.credits
        container.appendChild(makeBtn(s.label, `💰${s.credits}`, s.desc, can, () =>
          this.socket?.send({ type: 'build', planet_id: planet.id, item_type: 'ship', item_name: s.name }),
          hint
        ))
      })
    }
  }

  _queueItemTotalTicks(item) {
    if (item.total_ticks) return item.total_ticks
    const BUILDING_TICKS = { extractor: 100, shipyard: 150, research_lab: 200, defense_platform: 120 }
    const SHIP_TICKS = { fighter: 100, cruiser: 200, bomber: 180, carrier: 500, dreadnought: 800, mothership: 1500 }
    if (item.type === 'building') return BUILDING_TICKS[item.name] ?? 100
    if (item.type === 'ship')     return SHIP_TICKS[item.ship_type] ?? 400
    if (item.type === 'level_up') return 400  // fallback; normally total_ticks is set
    return 400
  }

  _tickDashboardQueue(planet) {
    // Refresh live stats (no DOM rebuild)
    const mineralEl = document.getElementById('dashboard-minerals')
    if (mineralEl) mineralEl.textContent = this._calcPlanetIncome(planet).toFixed(1)

    const pid = this.gameState?.player_faction_id
    const faction = this.gameState?.factions.find(f => f.id === pid)
    if (faction) {
      const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : Math.floor(n)
      const resEl = document.getElementById('dashboard-construct-resources')
      if (resEl) resEl.textContent = `Cr ${fmt(faction.credits)}  RP ${Math.floor(faction.research_points)}  T${faction.tech_tier}  Lvl ${planet.level}`

      // Rebuild construction buttons when credits cross a purchase threshold
      const bucket = Math.floor(faction.credits / 50)
      if (bucket !== this._lastConstructCredits) {
        this._lastConstructCredits = bucket
        this.updateConstructionButtons(planet)
      }
    }

    const queue = planet.build_queue ?? []
    document.getElementById('dashboard-queue-count').textContent = queue.length
    const queueCapacity = 2 + Math.max(0, (planet.level ?? 1) - 1)
    const queueCapEl = document.getElementById('dashboard-queue-cap')
    if (queueCapEl) queueCapEl.textContent = queueCapacity
    const el = document.getElementById('dashboard-queue')
    if (!el) return
    if (queue.length === 0) { el.textContent = 'Empty'; return }
    el.textContent = queue.map(item => {
      let name
      if      (item.type === 'level_up') name = 'Level Up'
      else if (item.type === 'building') name = item.name ?? '?'
      else                               name = item.ship_type ?? '?'
      const total = this._queueItemTotalTicks(item)
      const secs  = Math.round(item.ticks_remaining / 20)
      const pct   = Math.max(0, Math.round((1 - item.ticks_remaining / total) * 12))
      return `● ${name}  ${secs}s  [${'█'.repeat(pct)}${'░'.repeat(12 - pct)}]`
    }).join('  ')
  }

  startGame() {
    // Show start screen; may auto-resume a saved lobby/game session
    const ss = document.getElementById('start-screen')
    if (ss) ss.style.display = 'flex'
    this._showMenuStars(true)
    this.audio.playMusic('menu')
    this.tryResumeSession()
  }

  _showMenuStars(visible) {
    const mc = document.getElementById('menu-stars')
    if (!mc) return
    if (visible) {
      mc.style.display = 'block'
      this._renderMenuStars(mc)
    } else {
      mc.style.display = 'none'
    }
  }

  _renderMenuStars(canvas) {
    if (!this._starCanvas) return
    // Use CSS background on the menu-stars canvas instead of drawImage tiling
    canvas.style.background = `#0b0d12 url(${this._starCanvas.toDataURL('image/png')}) repeat`
  }

  persistSession() {
    const payload = {
      lobbyId: this.lobbyId,
      lobbyToken: this.lobbyToken,
      lobbyIsHost: this.lobbyIsHost,
      gameId: this.gameId,
      savedAt: Date.now(),
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  }

  clearPersistedSession() {
    localStorage.removeItem(SESSION_STORAGE_KEY)
  }

  async tryResumeSession() {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return

    try {
      const saved = JSON.parse(raw)
      if (!saved || (!saved.lobbyId && !saved.gameId)) return

      this.lobbyId = saved.lobbyId || null
      this.lobbyToken = saved.lobbyToken || null
      this.lobbyIsHost = !!saved.lobbyIsHost
      this.gameId = saved.gameId || null

      if (this.gameId) {
        this.renderLobbyStatus('Reconnecting to active match...')
        await this.connectToGame(this.gameId, this.lobbyToken)
        return
      }

      if (this.lobbyId && this.lobbyToken) {
        this.renderLobbyStatus(`Reconnected to lobby ${this.lobbyId}`)
        this.beginLobbyPolling()
      }
    } catch {
      this.clearPersistedSession()
    }
  }

  launchNewGame() {
    this.audio.playSfx('click')
    this.closeTutorial()
    document.getElementById('start-screen')?.style.setProperty('display', 'none')
    document.getElementById('gameover-screen')?.style.setProperty('display', 'none')
    this._showMenuStars(false)
    this.clearLobbyState()
    this.startNewGame()
  }

  openLoadMenu() {
    // Not implemented
  }

  getPlayerName() {
    const value = document.getElementById('lobby-player-name')?.value?.trim()
    return value || localStorage.getItem('ftl_player_name') || 'Player'
  }

  async hostLobby() {
    try {
      this.audio.playSfx('click')
      const name = this.getPlayerName()
      localStorage.setItem('ftl_player_name', name)
      const response = await fetch(`${API_URL}/lobby/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host_name: name, max_players: 6, planet_count: 120 }),
      })
      if (!response.ok) throw new Error(`Create lobby failed: ${response.status}`)
      const data = await response.json()
      this.lobbyId = data.lobby.lobby_id
      this.lobbyToken = data.your_token
      this.lobbyIsHost = true
      this.gameId = null
      this.persistSession()
      this.beginLobbyPolling()
      this.renderLobbyStatus(`Lobby created. Share code ${this.lobbyId}`, data.lobby.players || [])
      this.audio.playSfx('lobby')
    } catch (error) {
      this.showNotification(`Failed to host lobby: ${error.message}`, '#ff4444')
    }
  }

  async joinLobby() {
    try {
      this.audio.playSfx('click')
      const code = (document.getElementById('lobby-code-input')?.value || '').trim().toUpperCase()
      if (!code) {
        this.showNotification('Enter lobby code', '#ff4444')
        return
      }
      const name = this.getPlayerName()
      localStorage.setItem('ftl_player_name', name)
      const response = await fetch(`${API_URL}/lobby/${code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error(`Join lobby failed: ${response.status}`)
      const data = await response.json()
      this.lobbyId = data.lobby.lobby_id
      this.lobbyToken = data.your_token
      this.lobbyIsHost = false
      this.gameId = null
      this.persistSession()
      this.beginLobbyPolling()
      this.renderLobbyStatus('Joined lobby. Waiting for host to start.', data.lobby.players || [])
      this.audio.playSfx('lobby')
    } catch (error) {
      this.showNotification(`Failed to join lobby: ${error.message}`, '#ff4444')
    }
  }

  async startLobbyMatch() {
    if (!this.lobbyId || !this.lobbyToken || !this.lobbyIsHost) return
    try {
      this.audio.playSfx('click')
      const response = await fetch(`${API_URL}/lobby/${this.lobbyId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host_token: this.lobbyToken }),
      })
      if (!response.ok) throw new Error(`Start lobby failed: ${response.status}`)
      const data = await response.json()
      await this.connectToGame(data.game.game_id, this.lobbyToken)
    } catch (error) {
      this.showNotification(`Failed to start lobby: ${error.message}`, '#ff4444')
    }
  }

  beginLobbyPolling() {
    if (!this.lobbyId) return
    if (this.lobbyPollInterval) clearInterval(this.lobbyPollInterval)
    const poll = async () => {
      if (!this.lobbyId) return
      try {
        const response = await fetch(`${API_URL}/lobby/${this.lobbyId}`)
        if (!response.ok) throw new Error(`Lobby poll failed: ${response.status}`)
        const data = await response.json()
        const lobby = data.lobby
        this.renderLobbyStatus(`${lobby.status.toUpperCase()} · ${lobby.player_count}/${lobby.max_players}`, lobby.players || [])
        if (lobby.status === 'started' && lobby.game_id) {
          clearInterval(this.lobbyPollInterval)
          this.lobbyPollInterval = null
          await this.connectToGame(lobby.game_id, this.lobbyToken)
        }
      } catch (error) {
        this.renderLobbyStatus(`Lobby error: ${error.message}`)
      }
    }
    poll()
    this.lobbyPollInterval = setInterval(poll, 2000)
  }

  clearLobbyState() {
    if (this.lobbyPollInterval) {
      clearInterval(this.lobbyPollInterval)
      this.lobbyPollInterval = null
    }
    this.lobbyId = null
    this.lobbyToken = null
    this.lobbyIsHost = false
    this.lobbyPlayers = []
    if (!this.gameState) {
      this.gameId = null
      this.clearPersistedSession()
    } else {
      this.persistSession()
    }
    this.renderLobbyStatus('Idle. Host or join a lobby.')
  }

  leaveLobby() {
    this.audio.playSfx('click')
    this.clearLobbyState()
  }

  async startNewGame() {
    try {
      const response = await fetch(`${API_URL}/game/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: null,
          planet_count: 120
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to create game: ${response.status}`)
      }

      const gameData = await response.json()
      await this.connectToGame(gameData.game_id)
      
    } catch (error) {
      console.error('Error starting new game:', error)
      this.showNotification(`Failed to start game: ${error.message}`, '#ff4444')
    }
  }

  async connectToGame(gameId, token = null) {
    if (!gameId) return
    if (this.lobbyPollInterval) {
      clearInterval(this.lobbyPollInterval)
      this.lobbyPollInterval = null
    }
    this.socket?.close()
    this.gameId = gameId
    this.persistSession()
    this.connectionOnline = false
    this.playersOnline = 0
    this.updateConnectionHUD()

    const wsUrl = token ? `${WS_URL}/ws/${gameId}?token=${encodeURIComponent(token)}` : `${WS_URL}/ws/${gameId}`
    this.socket = new SocketClient(wsUrl)
    this.socket.onOpen = () => {
      this.connectionOnline = true
      this.updateConnectionHUD()
      this.updateHUD()
      this.audio.playMusic('game')
    }
    this.socket.onClose = () => {
      this.connectionOnline = false
      this.playersOnline = 0
      this.updateConnectionHUD()
    }
    this.socket.onMessage = (msg) => this.handleMessage(msg)
    this.socket.connect()
  }

  handleMessage(msg) {
    if (msg.type === 'welcome') {
      this.connectionOnline = !!msg.data?.connected
      this.playersOnline = Number(msg.data?.players_online ?? 0)
      this.pendingPlayerFactionId = msg.data?.you?.faction_id ?? null
      if (this.gameState && this.pendingPlayerFactionId) {
        this.gameState.player_faction_id = this.pendingPlayerFactionId
      }
      this.updateConnectionHUD()
      return
    }
    if (msg.type === 'state') {
      this.gameState = msg.data
      if (this.pendingPlayerFactionId) {
        this.gameState.player_faction_id = this.pendingPlayerFactionId
      }
      this.gameId = msg.data.id          // serializer uses 'id' not 'game_id'
      this.seed = msg.data.seed
      this.persistSession()

      // Hide start screen once game is live
      this.closeTutorial()
      const ss = document.getElementById('start-screen')
      if (ss) ss.style.display = 'none'
      this._showMenuStars(false)

      // Update HUD with game info
      const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val }
      set('hud-seed', this.seed)
      set('hud-gameid', this.gameId ?? '--')
      
      this.buildGalaxy()
      this.updateHUD()
    } else if (msg.type === 'tick') {
      if (!this.gameState) return
      if (msg.players_online != null) {
        this.playersOnline = Number(msg.players_online)
        this.updateConnectionHUD()
      }
      this.applyDelta(msg.data)
    }
  }

  applyDelta(delta) {
    this.gameState.tick = delta.tick

    // Update faction resources
    if (delta.factions) {
      const fMap = {}
      this.gameState.factions.forEach(f => { fMap[f.id] = f })
      delta.factions.forEach(df => {
        if (fMap[df.id]) Object.assign(fMap[df.id], df)
      })
      this.updateHUD()
    }

    // Update planets
    if (delta.planets) {
      const pMap = {}
      this.gameState.planets.forEach(p => { pMap[p.id] = p })
      delta.planets.forEach(dp => {
        const p = pMap[dp.id]
        if (!p) return
        Object.assign(p, dp)
        if (this.planetRenderers[p.id]) {
          this.planetRenderers[p.id].update(p, this.gameState.player_faction_id, this.getFactionMap())
        }
      })
      this.laneDirty = true  // exploration state may have changed

      // Refresh dashboard only when structural state changes — not every tick
      if (this.selectedPlanet && document.getElementById('dashboard').style.display !== 'none') {
        const sel = this.gameState.planets.find(p => p.id === this.selectedPlanet)
        if (sel) {
          const sig = `${sel.owner}|${sel.level}|${sel.buildings.join(',')}|${(sel.build_queue ?? []).map(q => q.name ?? q.ship_type ?? 'level_up').join(',')}`
          if (sig !== this._dashboardSig) {
            this._dashboardSig = sig
            this.openDashboard(sel)
          } else {
            this._tickDashboardQueue(sel)
          }
        }
      }
    }

    // Update ships
    if (delta.ships) {
      const sMap = {}
      this.gameState.ships.forEach(s => { sMap[s.id] = s })
      delta.ships.forEach(ds => {
        const s = sMap[ds.id]
        if (!s) return
        s.state = ds.state
        if (ds.health != null) s.health = ds.health
        if ('target_planet' in ds) s.target_planet = ds.target_planet
        // Orbiting ships: only update orbit_radius (client renders position locally)
        if (ds.orbit_radius != null) s.orbit_radius = ds.orbit_radius
        // Non-orbiting ships: update position and movement data
        if (ds.x != null) { s.x = ds.x; s.y = ds.y }
        if (ds.target_x != null) { s.target_x = ds.target_x; s.target_y = ds.target_y }
        if (ds.vx != null) { s.vx = ds.vx; s.vy = ds.vy }
      })

      // Remove destroyed ships
      if (delta.events) {
        const destroyedIds = new Set()
        delta.events.forEach(evt => {
          if (evt.type === 'ship_destroyed') {
            destroyedIds.add(evt.ship_id)
          }
        })
        if (destroyedIds.size > 0) {
          this.gameState.ships = this.gameState.ships.filter(s => !destroyedIds.has(s.id))
          this.selectedShips = new Set([...this.selectedShips].filter(id => !destroyedIds.has(id)))
        }
      }

      // Feed new positions to ship renderer for smooth interpolation
      this.shipRenderer?.onTick(this.gameState.ships, performance.now(), this.gameState.player_faction_id, this.getFactionMap())

      this.updateHUD()
      this.lastTickTime = performance.now()
    }

    // Handle events
    if (delta.events && delta.events.length > 0) {
      this.handleGameEvents(delta.events)
    }
  }

  handleGameEvents(events) {
    for (const evt of events) {
      if (evt.type === 'ship_spawned') {
        const sMap = {}
        this.gameState.ships.forEach(s => { sMap[s.id] = s })
        if (!sMap[evt.ship.id]) this.gameState.ships.push(evt.ship)
      } else if (evt.type === 'planet_captured') {
        const pid = this.gameState.player_faction_id
        const pName = this.gameState.planets.find(p => p.id === evt.planet_id)?.name ?? evt.planet_id
        if (evt.by === pid) {
          this.showNotification(`Captured ${pName}!`, '#00ff88')
          this.audio.playSfx('captured', 0.85)
        } else if (evt.from === pid) {
          this.showNotification(`Lost ${pName}!`, '#ff4444')
          this.audio.playSfx('captured', 0.85)
        }
      } else if (evt.type === 'faction_eliminated') {
        const f = this.getFactionMap()[evt.faction_id]
        if (f) this.showNotification(`${f.name} eliminated!`, '#ffaa00')
        this.audio.playSfx('eliminated', 0.9)
      } else if (evt.type === 'shot') {
        this._emitShotFx(evt)
        const hitPos = this._combatEntityPos(evt.to)
        const vol = hitPos ? this._getSfxVolumeAt(hitPos.x, hitPos.y, 220) : 0
        if (vol > 0.02) this.audio.playSfx('shot', 0.65 * vol)
      } else if (evt.type === 'ship_destroyed') {
        const boomPos = this._combatEntityPos(evt.ship_id)
        this._emitExplosionFx(evt.ship_id)
        const vol = boomPos ? this._getSfxVolumeAt(boomPos.x, boomPos.y, 260) : 0
        if (vol > 0.02) this.audio.playSfx('explosion', 0.8 * vol)
      } else if (evt.type === 'game_over') {
        let resolved = evt.result
        if (evt.mode === 'pvp' && evt.winner_faction_id) {
          resolved = evt.winner_faction_id === this.gameState.player_faction_id ? 'win' : 'loss'
        }
        this.audio.playSfx('game_over', 0.95)
        this.showGameOverScreen(resolved, evt)
      }
    }
  }

  _emitShotFx(evt) {
    const from = this._combatEntityPos(evt.from)
    const to = this._combatEntityPos(evt.to)
    if (!from || !to) return
    const now = performance.now()
    this.combatFx.push({
      kind: 'laser',
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      start: now,
      life: 120,
      color: '#ffb347',
    })
    this.combatFx.push({
      kind: 'impact',
      x: to.x,
      y: to.y,
      start: now,
      life: 180,
      color: '#ffd27a',
    })
  }

  _emitExplosionFx(shipId) {
    const pos = this._combatEntityPos(shipId)
    if (!pos) return
    this.combatFx.push({
      kind: 'explosion',
      x: pos.x,
      y: pos.y,
      start: performance.now(),
      life: 420,
      color: '#ff7a5c',
    })
  }

  _combatEntityPos(entityId) {
    if (!entityId || !this.gameState) return null
    const ship = this.gameState.ships.find(s => s.id === entityId)
    if (ship) return { x: ship.x, y: ship.y }
    if (entityId.startsWith('platform-')) {
      const planetId = entityId.slice('platform-'.length)
      const planet = this.gameState.planets.find(p => p.id === planetId)
      if (planet) return { x: planet.x, y: planet.y }
    }
    return null
  }

  _getViewBoundsWorld() {
    if (!this.zoom || !this.width || !this.height) return null
    return {
      minX: (-this.panX) / this.zoom,
      minY: (-this.panY) / this.zoom,
      maxX: (this.width - this.panX) / this.zoom,
      maxY: (this.height - this.panY) / this.zoom,
    }
  }

  _getSfxVolumeAt(x, y, edgeMargin = 200) {
    const b = this._getViewBoundsWorld()
    if (!b) return 0

    if (
      x < b.minX - edgeMargin ||
      x > b.maxX + edgeMargin ||
      y < b.minY - edgeMargin ||
      y > b.maxY + edgeMargin
    ) {
      return 0
    }

    const cx = (b.minX + b.maxX) * 0.5
    const cy = (b.minY + b.maxY) * 0.5
    const dist = Math.hypot(x - cx, y - cy)
    const halfDiag = Math.hypot((b.maxX - b.minX) * 0.5, (b.maxY - b.minY) * 0.5)
    if (halfDiag <= 0) return 0

    const t = Math.max(0, Math.min(1, dist / (halfDiag * 1.1)))
    return 1 - t
  }

  _drawCombatFx() {
    if (!this.combatFx.length) return
    const now = performance.now()
    this.combatFx = this.combatFx.filter(fx => now - fx.start <= fx.life)

    for (const fx of this.combatFx) {
      const t = (now - fx.start) / fx.life
      const alpha = Math.max(0, 1 - t)

      if (fx.kind === 'laser') {
        this.ctx.globalAlpha = alpha * 0.9
        this.ctx.strokeStyle = fx.color
        this.ctx.lineWidth = Math.max(1.2, 2 / this.zoom)
        this.ctx.beginPath()
        this.ctx.moveTo(fx.fromX, fx.fromY)
        this.ctx.lineTo(fx.toX, fx.toY)
        this.ctx.stroke()
      } else if (fx.kind === 'impact') {
        const r = (3 + t * 10) / this.zoom
        this.ctx.globalAlpha = alpha * 0.8
        this.ctx.strokeStyle = fx.color
        this.ctx.lineWidth = Math.max(1, 1.5 / this.zoom)
        this.ctx.beginPath()
        this.ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2)
        this.ctx.stroke()
      } else if (fx.kind === 'explosion') {
        const r = (6 + t * 26) / this.zoom
        this.ctx.globalAlpha = alpha * 0.7
        this.ctx.fillStyle = fx.color
        this.ctx.beginPath()
        this.ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2)
        this.ctx.fill()
      }
    }

    this.ctx.globalAlpha = 1
  }

  showGameOverScreen(result, evt = {}) {
    const screen = document.getElementById('gameover-screen')
    const title = document.getElementById('gameover-title')
    const subtitle = document.getElementById('gameover-subtitle')
    const stats = document.getElementById('gameover-stats')
    const summaryEl = document.getElementById('gameover-summary')
    if (!screen) return

    const { planets, ships, tick } = this.gameState ?? {}
    const pid = this.gameState?.player_faction_id
    const playerPlanets = planets?.filter(p => p.owner === pid).length ?? 0
    const totalPlanets  = planets?.length ?? 0
    const playerShips   = ships?.filter(s => s.owner === pid).length ?? 0
    const mins = Math.floor((tick ?? 0) / (20 * 60))
    const secs = Math.floor(((tick ?? 0) / 20) % 60).toString().padStart(2, '0')

    if (result === 'win') {
      title.textContent = 'VICTORY'
      title.style.color = '#00e8cc'
      title.style.textShadow = '0 0 60px rgba(0,232,204,0.45)'
      subtitle.textContent = 'Galaxy Conquered'
    } else {
      title.textContent = 'DEFEAT'
      title.style.color = '#ff4444'
      title.style.textShadow = '0 0 60px rgba(255,68,68,0.45)'
      subtitle.textContent = 'Your empire has fallen'
    }
    stats.textContent = `${playerPlanets} / ${totalPlanets} planets  ·  ${playerShips} ships  ·  ${mins}m ${secs}s`

    // Build PvP summary table if available
    if (summaryEl) {
      const summary = evt.summary
      if (summary && summary.length) {
        const shipTypes = ['fighter','cruiser','bomber','carrier','dreadnought','mothership']
        const shortNames = { fighter:'FT', cruiser:'CR', bomber:'BM', carrier:'CA', dreadnought:'DN', mothership:'MS' }
        let html = '<table>'
        html += '<tr><th>Player</th><th>Kills</th><th>Deaths</th><th>Ships Built</th><th>Types Built</th><th>Planets</th></tr>'
        for (const p of summary) {
          const isWinner = evt.winner_faction_id && p.faction_id === evt.winner_faction_id
          const rowClass = isWinner ? ' class="winner"' : ''
          const dotStyle = `background:${p.colour || '#888'}`
          const typeParts = []
          for (const t of shipTypes) {
            const cnt = (p.ships_built_by_type && p.ships_built_by_type[t]) || 0
            if (cnt > 0) typeParts.push(`${shortNames[t]}:${cnt}`)
          }
          const typesStr = typeParts.length ? typeParts.join(' ') : '-'
          html += `<tr${rowClass}>`
          html += `<td><span class="player-dot" style="${dotStyle}"></span>${p.name || p.faction_id}${isWinner ? ' ★' : ''}</td>`
          html += `<td>${p.kills ?? 0}</td>`
          html += `<td>${p.deaths ?? 0}</td>`
          html += `<td>${p.ships_built ?? 0}</td>`
          html += `<td style="font-size:10px;letter-spacing:0">${typesStr}</td>`
          html += `<td>${p.planets ?? 0}</td>`
          html += '</tr>'
        }
        html += '</table>'
        summaryEl.innerHTML = html
      } else {
        summaryEl.innerHTML = ''
      }
    }

    screen.style.display = 'flex'
  }

  showNotification(msg, colour = '#00ff88') {
    // Simple console log for now, could add visual notification later
    console.log(msg)
  }

  buildGalaxy() {
    const { player_faction_id, planets, factions } = this.gameState
    const factionMap = this.getFactionMap()

    this.laneDirty = true

    planets.forEach(planet => {
      if (this.planetRenderers[planet.id]) {
        this.planetRenderers[planet.id].update(planet, player_faction_id, factionMap)
      } else {
        const pr = new PlanetRendererCanvas(this.canvas, planet, player_faction_id)
        pr.update(planet, player_faction_id, factionMap)
        this.planetRenderers[planet.id] = pr
      }
    })

    // Initialize ship renderer
    if (!this.shipRenderer) {
      this.shipRenderer = new ShipRendererCanvas(this.canvas)
    }
    this.shipRenderer.setPlanets(this.gameState.planets)
    this.shipRenderer.onTick(this.gameState.ships, performance.now(), player_faction_id, factionMap)

    // Center on player home
    const pf = factions.find(f => f.id === player_faction_id)
    const home = pf && planets.find(p => p.id === pf.home_planet)
    if (home) {
      this.resetView()
      this.centerOn(home.x, home.y)
    }

    this.updateHUD()
  }

  _rebuildLanePaths(planets) {
    const pMap = {}
    planets.forEach(p => { pMap[p.id] = p })
    const drawn = new Set()

    const exp = new Path2D()
    const unexp = new Path2D()

    for (const planet of planets) {
      const aExp = planet.explored_by.some(fid => fid !== 'neutral')
      for (const nid of planet.lanes) {
        const key = [planet.id, nid].sort().join('|')
        if (drawn.has(key)) continue
        drawn.add(key)
        const nb = pMap[nid]
        if (!nb) continue
        const bExp = nb.explored_by.some(fid => fid !== 'neutral')
        const path = (aExp || bExp) ? exp : unexp
        path.moveTo(planet.x, planet.y)
        path.lineTo(nb.x, nb.y)
      }
    }

    this.exploredLanePath   = exp
    this.unexploredLanePath = unexp
    this.laneDirty          = false
  }

  getFactionMap() {
    const map = {}
    this.gameState?.factions.forEach(f => { map[f.id] = f })
    return map
  }

  // Control functions
  panLeft() { this.panX += 50; this.applyTransform() }
  panRight() { this.panX -= 50; this.applyTransform() }
  panUp() { this.panY += 50; this.applyTransform() }
  panDown() { this.panY -= 50; this.applyTransform() }
  
  zoomIn() {
    this.zoom = Math.min(ZOOM_MAX, this.zoom * 1.2)
    this.applyTransform()
  }
  
  zoomOut() {
    this.zoom = Math.max(ZOOM_MIN, this.zoom / 1.2)
    this.applyTransform()
  }
  
  resetView() {
    this.zoom = 1.0
    this.panX = 0
    this.panY = 0
    this.applyTransform()
  }

  focusOnLastPlanet() {
    if (!this.gameState) return
    const planets = this.gameState.planets
    // Prefer last selected planet, then home planet
    let target = this.selectedPlanet
      ? planets.find(p => p.id === this.selectedPlanet)
      : null
    if (!target) {
      const pf = this.gameState.factions.find(f => f.id === this.gameState.player_faction_id)
      target = pf && planets.find(p => p.id === pf.home_planet)
    }
    if (!target) return
    this.zoom = 1.0
    this.centerOn(target.x, target.y)
  }

  fitToScreen() {
    if (!this.gameState) return

    // Calculate the bounds of all planets
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    
    this.gameState.planets.forEach(p => {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    })

    // Add some padding
    const padding = 200
    minX -= padding
    minY -= padding
    maxX += padding
    maxY += padding

    const galaxyWidth = maxX - minX
    const galaxyHeight = maxY - minY
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    // Calculate zoom to fit the galaxy in the viewport
    const viewportWidth = this.width
    const viewportHeight = this.height
    
    const zoomX = viewportWidth / galaxyWidth
    const zoomY = viewportHeight / galaxyHeight
    const newZoom = Math.min(zoomX, zoomY) * 0.9 // 90% of viewport to add some margin

    // Center the galaxy
    const screenCenterX = viewportWidth / 2
    const screenCenterY = viewportHeight / 2
    
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom))
    this.panX = screenCenterX - (centerX * this.zoom)
    this.panY = screenCenterY - (centerY * this.zoom)
    
    this.applyTransform()
  }

  centerOn(x, y) {
    // Center the view on world coordinates x, y
    const screenCenterX = window.innerWidth / 2
    const screenCenterY = window.innerHeight / 2
    this.panX = screenCenterX - (x * this.zoom)
    this.panY = screenCenterY - (y * this.zoom)
    this.applyTransform()
  }

  // Dashboard functions
  toggleDashboard() {
    const dashboard = document.getElementById('dashboard')
    if (dashboard.style.display === 'none' || !dashboard.style.display) {
      // Open dashboard for selected planet
      if (this.selectedPlanet) {
        const planet = this.gameState.planets.find(p => p.id === this.selectedPlanet)
        if (planet) this.openDashboard(planet)
      }
    } else {
      this.closeDashboard()
    }
  }

  saveGame() {
    if (!this.gameId) return
    fetch(`${API_URL}/game/${this.gameId}/save`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        this.showNotification(`Saved: ${data.filename}`, '#00ff88')
      })
      .catch(err => {
        this.showNotification(`Save failed: ${err.message}`, '#ff4444')
      })
  }

  goToMenu() {
    this.closeDashboard()
    document.getElementById('gameover-screen')?.style.setProperty('display', 'none')
    this.socket?.close()
    this.connectionOnline = false
    this.playersOnline = 0
    this.updateConnectionHUD()
    this.gameState = null
    this.gameId = null
    this.planetRenderers = {}
    this.selectedPlanet = null
    this.selectedShips = new Set()
    this.clearLobbyState()
    this.clearPersistedSession()
    this.audio.playMusic('menu')
    this.startGame()  // shows start screen
  }

  endGame() {
    if (!this.socket || !this.gameState) return
    const ok = confirm('Are you sure you want to end this game? This will count as a surrender.')
    if (!ok) return
    this.audio.playSfx('click')
    this.socket.send({ type: 'end_game' })
  }

  // Selection functions
  setEnergy(level) {
    if (this.selectedShips.size === 0) return
    this.socket?.send({
      type: 'energy',
      ship_ids: [...this.selectedShips],
      level,
    })
  }

  stopShips() {
    if (this.selectedShips.size === 0) return
    this.socket?.send({
      type: 'stop',
      ship_ids: [...this.selectedShips],
    })
  }

  // Render loop
  startRenderLoop() {
    let fpsFrames = 0
    let fpsLast = performance.now()
    let fpsDisplay = document.getElementById('fps-display')

    let lastRenderTime = performance.now()

    const render = () => {
      // FPS counter
      fpsFrames++
      const now2 = performance.now()
      const dt = Math.min(now2 - lastRenderTime, 50)  // cap at 50ms to avoid jumps
      lastRenderTime = now2
      if (now2 - fpsLast >= 1000) {
        const fps = Math.round(fpsFrames * 1000 / (now2 - fpsLast))
        if (fpsDisplay) fpsDisplay.textContent = fps
        fpsFrames = 0
        fpsLast = now2
      }

      // WASD panning — driven by rAF for smooth, jank-free movement
      const panSpeed = 600 // pixels per second at zoom 1
      const panDelta = panSpeed * (dt / 1000)
      const k = this.keys || {}
      if (k['w'] || k['a'] || k['s'] || k['d']) {
        if (k['w']) this.panY += panDelta
        if (k['s']) this.panY -= panDelta
        if (k['a']) this.panX += panDelta
        if (k['d']) this.panX -= panDelta
      }

      if (this.gameState) {
        // Clear canvas (CSS background shows through)
        this.ctx.clearRect(0, 0, this.width, this.height)
        
        // Apply transform to context for rendering
        this.ctx.save()
        this.ctx.translate(this.panX, this.panY)
        this.ctx.scale(this.zoom, this.zoom)

        const viewBounds = {
          minX: (-this.panX) / this.zoom,
          minY: (-this.panY) / this.zoom,
          maxX: (this.width - this.panX) / this.zoom,
          maxY: (this.height - this.panY) / this.zoom,
        }
        
        // Draw lanes (Path2D cache rebuilt only on tick, not every frame)
        if (this.laneDirty) this._rebuildLanePaths(this.gameState.planets)
        this.ctx.lineWidth = Math.max(1, 1.5 / this.zoom)
        this.ctx.strokeStyle = 'rgba(51,102,170,0.20)'
        this.ctx.stroke(this.exploredLanePath)
        this.ctx.strokeStyle = 'rgba(51,102,170,0.05)'
        this.ctx.stroke(this.unexploredLanePath)
        
        // Draw planets
        Object.values(this.planetRenderers).forEach(renderer => {
          const planet = renderer.planet
          if (!planet) return
          const margin = Math.max(120, (planet.radius || 20) + 40)
          if (
            planet.x < viewBounds.minX - margin ||
            planet.x > viewBounds.maxX + margin ||
            planet.y < viewBounds.minY - margin ||
            planet.y > viewBounds.maxY + margin
          ) return
          renderer.draw(this.zoom)
        })
        
        // Draw ships (interpolated between server ticks)
        if (this.shipRenderer) {
          this.shipRenderer.draw(this.selectedShips, viewBounds)
        }

        // Draw combat effects (laser shots, impacts, explosions)
        this._drawCombatFx()
        
        // Draw move target markers (world space, fade over 1.5s)
        const now = performance.now()
        this.moveTargets = this.moveTargets.filter(mt => now - mt.t < 1500)
        for (const mt of this.moveTargets) {
          const alpha = 1 - (now - mt.t) / 1500
          const pulse = 1 + Math.sin(now / 150) * 0.25
          const r = 9 * pulse
          this.ctx.globalAlpha = alpha * 0.85
          this.ctx.strokeStyle = '#00ffff'
          this.ctx.lineWidth = 1
          this.ctx.beginPath()
          this.ctx.arc(mt.x, mt.y, r, 0, Math.PI * 2)
          this.ctx.stroke()
          this.ctx.beginPath()
          this.ctx.moveTo(mt.x - r - 5, mt.y); this.ctx.lineTo(mt.x + r + 5, mt.y)
          this.ctx.moveTo(mt.x, mt.y - r - 5); this.ctx.lineTo(mt.x, mt.y + r + 5)
          this.ctx.stroke()
          this.ctx.globalAlpha = 1.0
        }

        // Restore transform
        this.ctx.restore()

        // Draw drone-view cursor reticle in screen space
        if (this.canvasMouseX != null) {
          const cx = this.canvasMouseX
          const cy = this.canvasMouseY
          const r   = 10   // inner ring radius
          const bk  = 6    // bracket arm length
          const bkO = 3    // bracket offset from ring edge
          const col = 'rgba(0,232,204,0.85)'

          this.ctx.strokeStyle = col
          this.ctx.lineWidth = 1.5

          // Inner ring
          this.ctx.beginPath()
          this.ctx.arc(cx, cy, r, 0, Math.PI * 2)
          this.ctx.stroke()

          // Center dot
          this.ctx.fillStyle = col
          this.ctx.beginPath()
          this.ctx.arc(cx, cy, 1.5, 0, Math.PI * 2)
          this.ctx.fill()

          // Corner brackets (4 corners)
          this.ctx.lineWidth = 1.5
          const off = r + bkO
          const corners = [
            [-1, -1], [1, -1], [1, 1], [-1, 1]
          ]
          corners.forEach(([sx, sy]) => {
            const bx = cx + sx * off
            const by = cy + sy * off
            this.ctx.beginPath()
            this.ctx.moveTo(bx, by)
            this.ctx.lineTo(bx + sx * bk, by)
            this.ctx.moveTo(bx, by)
            this.ctx.lineTo(bx, by + sy * bk)
            this.ctx.stroke()
          })
        }

        // Draw selection box in screen space (after world transform is restored)
        if (this.isDrawingBox) {
          const bx = Math.min(this.boxStartX, this.boxCurrentX)
          const by = Math.min(this.boxStartY, this.boxCurrentY)
          const bw = Math.abs(this.boxCurrentX - this.boxStartX)
          const bh = Math.abs(this.boxCurrentY - this.boxStartY)
          this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)'
          this.ctx.lineWidth = 1.5
          this.ctx.setLineDash([5, 5])
          this.ctx.strokeRect(bx, by, bw, bh)
          this.ctx.fillStyle = 'rgba(0, 255, 255, 0.06)'
          this.ctx.fillRect(bx, by, bw, bh)
          this.ctx.setLineDash([])
        }
      }

      requestAnimationFrame(render)
    }
    
    requestAnimationFrame(render)
  }

  // Smooth zoom method for InputHandlerCanvas
  updateSmoothZoom() {
    if (!this.currentZoomDirection) return
    
    // Get screen center coordinates
    const screenCenterX = window.innerWidth / 2
    const screenCenterY = window.innerHeight / 2
    
    // Calculate current world coordinates at screen center
    const worldCenterX = (screenCenterX - this.panX) / this.zoom
    const worldCenterY = (screenCenterY - this.panY) / this.zoom
    
    // Apply zoom with constant speed (no ramping)
    let newZoom = this.zoom
    if (this.currentZoomDirection === 'out') {
      newZoom = Math.max(ZOOM_MIN, this.zoom * 0.98) // Slightly faster zoom out
    } else if (this.currentZoomDirection === 'in') {
      newZoom = Math.min(ZOOM_MAX, this.zoom * 1.02) // Slightly faster zoom in
    }
    
    // Calculate new pan to keep the same world coordinates at screen center
    const newPanX = screenCenterX - (worldCenterX * newZoom)
    const newPanY = screenCenterY - (worldCenterY * newZoom)
    
    this.zoom = newZoom
    this.panX = newPanX
    this.panY = newPanY
    
    this.applyTransform()
  }

  // Selection and command handling
  handleSelection(e) {
    if (!this.gameState) return

    const rect = this.canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    // Convert screen coordinates to world coordinates
    const worldX = (mouseX - this.panX) / this.zoom
    const worldY = (mouseY - this.panY) / this.zoom

    // Check if clicking on a planet
    const clickedPlanet = this.gameState.planets.find(p => {
      const dist = Math.sqrt(Math.pow(worldX - p.x, 2) + Math.pow(worldY - p.y, 2))
      return dist <= p.radius + 10
    })

    if (clickedPlanet) {
      this.selectedPlanet = clickedPlanet.id
      this.selectedShips.clear()
      this.updateHUD()
      this.openDashboard(clickedPlanet)
      return
    }

    // Check if clicking on a ship
    const clickedShip = this.gameState.ships.find(s => {
      const dist = Math.sqrt(Math.pow(worldX - s.x, 2) + Math.pow(worldY - s.y, 2))
      return dist <= 10 // 10px selection radius
    })

    if (clickedShip) {
      if (clickedShip.owner !== this.gameState.player_faction_id) return
      // Toggle ship selection
      if (this.selectedShips.has(clickedShip.id)) {
        this.selectedShips.delete(clickedShip.id)
      } else {
        this.selectedShips.add(clickedShip.id)
      }
      this.selectedPlanet = null
      this.updateHUD()
      return
    }

    // Clicked empty space - clear selection
    this.selectedPlanet = null
    this.selectedShips.clear()
    this.updateHUD()
    this.closeDashboard()
  }

  handleMoveCommand(e) {
    if (!this.gameState || this.selectedShips.size === 0) return

    const rect = this.canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    // Convert screen coordinates to world coordinates
    const worldX = (mouseX - this.panX) / this.zoom
    const worldY = (mouseY - this.panY) / this.zoom

    // Check if clicking on a planet
    const targetPlanet = this.gameState.planets.find(p => {
      const dist = Math.sqrt(Math.pow(worldX - p.x, 2) + Math.pow(worldY - p.y, 2))
      return dist <= p.radius + 20
    })

    if (targetPlanet) {
      this.socket?.send({
        type: 'move',
        ship_ids: [...this.selectedShips],
        target: { planet_id: targetPlanet.id }
      })
      this.moveTargets.push({ x: targetPlanet.x, y: targetPlanet.y, t: performance.now() })
    } else {
      this.socket?.send({
        type: 'move',
        ship_ids: [...this.selectedShips],
        target: { x: worldX, y: worldY }
      })
      this.moveTargets.push({ x: worldX, y: worldY, t: performance.now() })
    }
  }

  // Multi-selection box methods
  drawSelectionBox() {
    // Only draw the selection box on top of existing content
    // Don't clear the canvas or redraw the game state
    
    // Draw selection box on top
    const x = Math.min(this.boxStartX, this.boxCurrentX)
    const y = Math.min(this.boxStartY, this.boxCurrentY)
    const w = Math.abs(this.boxCurrentX - this.boxStartX)
    const h = Math.abs(this.boxCurrentY - this.boxStartY)
    
    // Clear only the area where the box was previously drawn
    // This is more efficient than clearing the entire canvas
    if (this.lastBoxX !== undefined) {
      this.ctx.clearRect(this.lastBoxX, this.lastBoxY, this.lastBoxW, this.lastBoxH)
    }
    
    this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)'
    this.ctx.lineWidth = 2
    this.ctx.setLineDash([5, 5])
    this.ctx.strokeRect(x, y, w, h)
    this.ctx.setLineDash([])
    
    // Store current box dimensions for next clear
    this.lastBoxX = x
    this.lastBoxY = y
    this.lastBoxW = w
    this.lastBoxH = h
  }

  clearSelectionBox() {
    // Clear only the selection box area
    if (this.lastBoxX !== undefined) {
      this.ctx.clearRect(this.lastBoxX, this.lastBoxY, this.lastBoxW, this.lastBoxH)
      this.lastBoxX = undefined
    }
  }

  completeSelectionBox() {
    if (!this.gameState) return

    const x1 = Math.min(this.boxStartX, this.boxCurrentX)
    const y1 = Math.min(this.boxStartY, this.boxCurrentY)
    const x2 = Math.max(this.boxStartX, this.boxCurrentX)
    const y2 = Math.max(this.boxStartY, this.boxCurrentY)

    // Convert screen coordinates to world coordinates
    const worldX1 = (x1 - this.panX) / this.zoom
    const worldY1 = (y1 - this.panY) / this.zoom
    const worldX2 = (x2 - this.panX) / this.zoom
    const worldY2 = (y2 - this.panY) / this.zoom

    // Find ships within the selection box
    const shipsInBox = this.gameState.ships.filter(s => {
          return s.owner === this.gameState.player_faction_id &&
            s.x >= worldX1 && s.x <= worldX2 && 
             s.y >= worldY1 && s.y <= worldY2
    })

    // Shift-drag: additive union only. Ctrl-drag: keep existing toggle behavior.
    shipsInBox.forEach(ship => {
      if (this.boxSelectionUnion) {
        this.selectedShips.add(ship.id)
      } else if (this.selectedShips.has(ship.id)) {
        this.selectedShips.delete(ship.id)
      } else {
        this.selectedShips.add(ship.id)
      }
    })

    // Clear planet selection when using box selection
    this.selectedPlanet = null
    this.updateHUD()
  }
}

// Global functions for HTML buttons
window.panLeft = () => window.gameApp?.panLeft()
window.panRight = () => window.gameApp?.panRight()
window.panUp = () => window.gameApp?.panUp()
window.panDown = () => window.gameApp?.panDown()
window.zoomIn = () => window.gameApp?.zoomIn()
window.zoomOut = () => window.gameApp?.zoomOut()
window.resetView = () => window.gameApp?.focusOnLastPlanet()
window.toggleDashboard = () => window.gameApp?.toggleDashboard()
window.goToMenu = () => window.gameApp?.goToMenu()
window.endGame = () => window.gameApp?.endGame()
window.toggleTierInfo = () => {
  const dd = document.getElementById('tier-dropdown')
  if (dd) {
    const opening = dd.style.display === 'none'
    if (opening) {
      // Close dashboard if open to avoid overlap
      const dash = document.getElementById('dashboard')
      if (dash && dash.style.display !== 'none') window.gameApp?.closeDashboard()
    }
    dd.style.display = opening ? 'block' : 'none'
    if (opening) window._updateTierProgress?.()
  }
}
window._updateTierProgress = () => {
  const el = document.getElementById('tier-progress')
  const gs = window.gameApp?.gameState
  if (!el || !gs) { if (el) el.innerHTML = '<span style="color:#4a7080;font-size:10px;">No game data</span>'; return }
  const pid = gs.player_faction_id
  const faction = gs.factions?.find(f => f.id === pid)
  if (!faction) return
  const tier = faction.tech_tier || 1
  const rp = Math.floor(faction.research_points || 0)
  // Count planets at each level
  let owned = 0, lv2 = 0, lv3 = 0
  for (const p of gs.planets || []) {
    if (p.owner === pid) {
      owned++
      if ((p.level || 1) >= 2) lv2++
      if ((p.level || 1) >= 3) lv3++
    }
  }
  const bar = (val, max, color) => {
    const pct = Math.min(100, Math.round(val / max * 100))
    return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
      + `<div style="flex:1;height:6px;background:#0d1820;border-radius:3px;">`
      + `<div style="width:${pct}%;height:100%;background:${color};border-radius:3px;"></div></div>`
      + `<span style="min-width:40px;text-align:right;font-size:10px;color:#7ae7ff;">${val}/${max}</span></div>`
  }
  let html = `<div style="color:#7ae7ff;font-size:12px;margin-bottom:6px;">Current: <span style="color:#fbbf24;font-weight:700;">Tier ${tier}</span> &nbsp;·&nbsp; RP: <span style="color:#a78bfa;">${rp}</span> &nbsp;·&nbsp; Planets: <span style="color:#00e8cc;">${owned}</span></div>`
  if (tier < 2) {
    html += `<div style="color:#e2e8f0;font-size:11px;font-weight:600;margin:6px 0 2px;">→ Tier 2</div>`
    html += `<span style="color:#a5d8ff;font-size:10px;">RP</span>` + bar(rp, 500, '#a78bfa')
    html += `<span style="color:#a5d8ff;font-size:10px;">Lv2+ Planets</span>` + bar(lv2, 5, '#2ecc71')
  } else if (tier < 3) {
    html += `<div style="color:#e2e8f0;font-size:11px;font-weight:600;margin:6px 0 2px;">→ Tier 3</div>`
    html += `<span style="color:#a5d8ff;font-size:10px;">RP</span>` + bar(rp, 2000, '#a78bfa')
    html += `<span style="color:#a5d8ff;font-size:10px;">Lv3+ Planets</span>` + bar(lv3, 10, '#2ecc71')
  } else {
    html += `<div style="color:#4aaa66;font-size:11px;margin-top:4px;">✓ Max tier reached</div>`
  }
  el.innerHTML = html

  // Fleet upgrades
  const fuEl = document.getElementById('fleet-upgrades')
  if (!fuEl) return
  const fu = faction.fleet_upgrades || { speed: 0, health: 0, damage: 0 }
  const UPGRADES = [
    { key: 'speed',  label: 'Thruster Boost', icon: '⚡', desc: '+8% ship speed/lv', base: 200, scale: 1.8, max: 5 },
    { key: 'health', label: 'Hull Plating',   icon: '🛡', desc: '+10% ship HP/lv',   base: 250, scale: 1.8, max: 5 },
    { key: 'damage', label: 'Weapon Systems', icon: '🗡', desc: '+8% ship damage/lv', base: 300, scale: 1.8, max: 5 },
  ]
  const credits = faction.credits || 0
  fuEl.innerHTML = UPGRADES.map(u => {
    const lv = fu[u.key] || 0
    const maxed = lv >= u.max
    const cost = maxed ? 0 : Math.round(u.base * Math.pow(u.scale, lv))
    const canBuy = !maxed && credits >= cost
    const dots = Array.from({length: u.max}, (_, i) => `<span style="display:inline-block;width:8px;height:8px;margin:0 1px;border:1px solid #3a5060;background:${i < lv ? '#fbbf24' : '#0d1820'};"></span>`).join('')
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border:1px solid ${canBuy ? '#3a6080' : '#1a2a3a'};background:${canBuy ? 'rgba(26,50,70,0.6)' : 'rgba(10,18,28,0.6)'};">
      <span style="font-size:14px;min-width:18px;">${u.icon}</span>
      <div style="flex:1;">
        <div style="color:${maxed ? '#4aaa66' : '#a5d8ff'};font-size:10px;font-weight:600;">${u.label} ${maxed ? '(MAX)' : `Lv${lv}`}</div>
        <div style="font-size:9px;color:#4a7080;">${u.desc}</div>
        <div style="margin-top:2px;">${dots}</div>
      </div>
      ${maxed ? '' : `<button onclick="window._buyFleetUpgrade('${u.key}')" style="padding:4px 8px;font-size:10px;min-width:60px;opacity:${canBuy ? 1 : 0.4};pointer-events:${canBuy ? 'auto' : 'none'};" ${canBuy ? '' : 'disabled'}>💰${cost}</button>`}
    </div>`
  }).join('')
}
window.setEnergy = (level) => window.gameApp?.setEnergy(level)
window.stopShips = () => window.gameApp?.stopShips()
window._buyFleetUpgrade = (type) => {
  window.gameApp?.socket?.send({ type: 'fleet_upgrade', upgrade_type: type })
}
window.hostLobby = () => window.gameApp?.hostLobby()
window.joinLobby = () => window.gameApp?.joinLobby()
window.startLobbyMatch = () => window.gameApp?.startLobbyMatch()
window.leaveLobby = () => window.gameApp?.leaveLobby()
window.copyLobbyCode = () => window.gameApp?.copyLobbyCode()
window.pasteLobbyCode = () => window.gameApp?.pasteLobbyCode()
window.openTutorial = () => window.gameApp?.openTutorial()
window.closeTutorial = () => window.gameApp?.closeTutorial()
window.nextTutorialStep = () => window.gameApp?.nextTutorialStep()
window.prevTutorialStep = () => window.gameApp?.prevTutorialStep()
window.toggleSfxMute = () => window.gameApp?.toggleSfxMute()
window.toggleMusicMute = () => window.gameApp?.toggleMusicMute()
window.setSfxVolume = (value) => window.gameApp?.setSfxVolume(value)
window.setMusicVolume = (value) => window.gameApp?.setMusicVolume(value)

// Start the game when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, checking for canvas...')
  console.log('Canvas element:', document.getElementById('game-canvas'))
  console.log('All canvas elements:', document.querySelectorAll('canvas'))
  console.log('Body exists:', document.body)
  console.log('Game container exists:', document.getElementById('game-container'))
  
  window.gameApp = new GameApp()
})
