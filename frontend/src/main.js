import SocketClient from './network/SocketClient.js'
import PlanetRendererCanvas from './render/PlanetRendererCanvas.js'
import ShipRendererCanvas from './render/ShipRendererCanvas.js'
import InputHandlerCanvas from './input/InputHandlerCanvas.js'
import { GALAXY_WIDTH, GALAXY_HEIGHT, ZOOM_MIN, ZOOM_MAX } from './config.js'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'

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
    this.pendingPlayerFactionId = null
    
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
    this.panInterval = null
    this.zoomInterval = null
    this.currentZoomDirection = null
    
    // Move target markers
    this.moveTargets = []

    // Dashboard state: track last-rendered planet state to avoid unnecessary rebuilds
    this._dashboardSig = null
    this._lastConstructCredits = null

    // Lane path cache (Path2D, rebuilt on tick not every frame)
    this.exploredLanePath   = null
    this.unexploredLanePath = null
    this.laneDirty          = true

    // Multi-selection box state
    this.isDrawingBox = false
    this.boxStartX = 0
    this.boxStartY = 0
    this.boxCurrentX = 0
    this.boxCurrentY = 0
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
      }
    })

    // Prevent context menu on right click
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
    })

    // Wheel for zoom
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        // Pinch-to-zoom
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * zoomFactor))
        this.applyTransform()
      } else {
        // Pan with wheel
        this.panY += e.deltaY
        this.applyTransform()
      }
    }, { passive: false })

    // Keyboard controls
    const keys = {}
    let panInterval = null
    
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

      // F — move selected ships to cursor position
      if (key === 'f') {
        this.handleMoveCommand({ clientX: this.currentMouseX ?? 0, clientY: this.currentMouseY ?? 0 })
      }
      
      // WASD panning
      keys[key] = true
      
      if (['w', 'a', 's', 'd'].includes(key)) {
        if (!panInterval) {
          panInterval = setInterval(() => {
            let moved = false
            
            if (keys['w']) { this.panY += 10; moved = true }  // W moves up
            if (keys['s']) { this.panY -= 10; moved = true }  // S moves down
            if (keys['a']) { this.panX += 10; moved = true }  // A moves left
            if (keys['d']) { this.panX -= 10; moved = true }  // D moves right
            
            if (moved) this.applyTransform()
          }, 16) // ~60fps smooth panning
        }
      }
    })
    
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase()
      
      if ((key === 'c' || key === 'v') && zoomInterval) {
        clearInterval(zoomInterval)
        zoomInterval = null
        currentZoomDirection = null
      }
      
      keys[key] = false
      
      if (['w', 'a', 's', 'd'].includes(key)) {
        const anyWASDPressed = ['w', 'a', 's', 'd'].some(k => keys[k])
        if (!anyWASDPressed && panInterval) {
          clearInterval(panInterval)
          panInterval = null
        }
      }
    })
  }

  setupUI() {
    // Initialize HUD elements
    this.updateHUD()
    this.updateConnectionHUD()
    this.setupLobbyUI()
    
    // Setup dashboard
    this.setupDashboard()
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

  renderLobbyStatus(status, players = []) {
    const statusEl = document.getElementById('lobby-status')
    const rosterEl = document.getElementById('lobby-roster')
    const codeEl = document.getElementById('lobby-code-display')
    const startBtn = document.getElementById('lobby-start-btn')
    const copyBtn = document.getElementById('lobby-copy-btn')

    if (statusEl) statusEl.textContent = status
    if (rosterEl) {
      rosterEl.textContent = players.length
        ? `Players Joined:\n${players.map(p => `${p.slot}. ${p.name}${p.is_host ? ' (Host)' : ''}`).join('\n')}`
        : 'No players yet.'
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
    } catch {
      this.renderLobbyStatus(`Copy failed. Code: ${this.lobbyId}`)
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
    const SHIP_TICKS = { fighter: 100, cruiser: 200, bomber: 180, carrier: 500, dreadnought: 800 }
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
    // Show start screen; game begins when player clicks New Game
    const ss = document.getElementById('start-screen')
    if (ss) ss.style.display = 'flex'
  }

  launchNewGame() {
    document.getElementById('start-screen')?.style.setProperty('display', 'none')
    document.getElementById('gameover-screen')?.style.setProperty('display', 'none')
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
      this.beginLobbyPolling()
      this.renderLobbyStatus(`Lobby created. Share code ${this.lobbyId}`, data.lobby.players || [])
    } catch (error) {
      this.showNotification(`Failed to host lobby: ${error.message}`, '#ff4444')
    }
  }

  async joinLobby() {
    try {
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
      this.beginLobbyPolling()
      this.renderLobbyStatus('Joined lobby. Waiting for host to start.', data.lobby.players || [])
    } catch (error) {
      this.showNotification(`Failed to join lobby: ${error.message}`, '#ff4444')
    }
  }

  async startLobbyMatch() {
    if (!this.lobbyId || !this.lobbyToken || !this.lobbyIsHost) return
    try {
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
    this.renderLobbyStatus('Idle. Host or join a lobby.')
  }

  leaveLobby() {
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
    this.connectionOnline = false
    this.playersOnline = 0
    this.updateConnectionHUD()

    const wsUrl = token ? `${WS_URL}/ws/${gameId}?token=${encodeURIComponent(token)}` : `${WS_URL}/ws/${gameId}`
    this.socket = new SocketClient(wsUrl)
    this.socket.onOpen = () => {
      this.connectionOnline = true
      this.updateConnectionHUD()
      this.updateHUD()
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

      // Hide start screen once game is live
      const ss = document.getElementById('start-screen')
      if (ss) ss.style.display = 'none'

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
        s.x = ds.x; s.y = ds.y; s.state = ds.state
        if (ds.health != null) s.health = ds.health
        if ('target_planet' in ds) s.target_planet = ds.target_planet
        if (ds.target_x != null) { s.target_x = ds.target_x; s.target_y = ds.target_y }
        if (ds.vx != null) { s.vx = ds.vx; s.vy = ds.vy }
      })

      // Remove destroyed ships
      if (delta.events) {
        const destroyedIds = new Set()
        delta.events.forEach(evt => {
          if (evt.type === 'ship_destroyed') destroyedIds.add(evt.ship_id)
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
        } else if (evt.from === pid) {
          this.showNotification(`Lost ${pName}!`, '#ff4444')
        }
      } else if (evt.type === 'faction_eliminated') {
        const f = this.getFactionMap()[evt.faction_id]
        if (f) this.showNotification(`${f.name} eliminated!`, '#ffaa00')
      } else if (evt.type === 'game_over') {
        this.showGameOverScreen(evt.result)
      }
    }
  }

  showGameOverScreen(result) {
    const screen = document.getElementById('gameover-screen')
    const title = document.getElementById('gameover-title')
    const subtitle = document.getElementById('gameover-subtitle')
    const stats = document.getElementById('gameover-stats')
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
    this.planetRenderers = {}
    this.selectedPlanet = null
    this.selectedShips = new Set()
    this.clearLobbyState()
    this.startGame()  // shows start screen
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

    const render = () => {
      // FPS counter
      fpsFrames++
      const now2 = performance.now()
      if (now2 - fpsLast >= 1000) {
        const fps = Math.round(fpsFrames * 1000 / (now2 - fpsLast))
        if (fpsDisplay) fpsDisplay.textContent = fps
        console.log(`FPS: ${fps}`)
        fpsFrames = 0
        fpsLast = now2
      }

      if (this.gameState) {
        // Clear canvas with transparent background
        this.ctx.clearRect(0, 0, this.width, this.height)
        
        // Apply transform to context for rendering
        this.ctx.save()
        this.ctx.translate(this.panX, this.panY)
        this.ctx.scale(this.zoom, this.zoom)
        
        // Draw lanes (Path2D cache rebuilt only on tick, not every frame)
        if (this.laneDirty) this._rebuildLanePaths(this.gameState.planets)
        this.ctx.lineWidth = Math.max(1, 1.5 / this.zoom)
        this.ctx.strokeStyle = 'rgba(51,102,170,0.20)'
        this.ctx.stroke(this.exploredLanePath)
        this.ctx.strokeStyle = 'rgba(51,102,170,0.05)'
        this.ctx.stroke(this.unexploredLanePath)
        
        // Draw planets
        Object.values(this.planetRenderers).forEach(renderer => {
          renderer.draw(this.zoom)
        })
        
        // Draw ships (interpolated between server ticks)
        if (this.shipRenderer) {
          this.shipRenderer.draw(this.selectedShips)
        }
        
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

    // Add ships to selection (toggle behavior)
    shipsInBox.forEach(ship => {
      if (this.selectedShips.has(ship.id)) {
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
window.setEnergy = (level) => window.gameApp?.setEnergy(level)
window.stopShips = () => window.gameApp?.stopShips()
window.hostLobby = () => window.gameApp?.hostLobby()
window.joinLobby = () => window.gameApp?.joinLobby()
window.startLobbyMatch = () => window.gameApp?.startLobbyMatch()
window.leaveLobby = () => window.gameApp?.leaveLobby()
window.copyLobbyCode = () => window.gameApp?.copyLobbyCode()

// Start the game when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, checking for canvas...')
  console.log('Canvas element:', document.getElementById('game-canvas'))
  console.log('All canvas elements:', document.querySelectorAll('canvas'))
  console.log('Body exists:', document.body)
  console.log('Game container exists:', document.getElementById('game-container'))
  
  window.gameApp = new GameApp()
})
