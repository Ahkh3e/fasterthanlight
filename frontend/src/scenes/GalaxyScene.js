import SocketClient   from '../network/SocketClient.js'
import PlanetRenderer from '../render/PlanetRenderer.js'
import ShipRenderer   from '../render/ShipRenderer.js'
import InputHandler   from '../input/InputHandler.js'
import { GALAXY_WIDTH, GALAXY_HEIGHT, ZOOM_MIN, ZOOM_MAX } from '../config.js'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const WS_URL  = import.meta.env.VITE_WS_URL  || 'ws://localhost:8000'

export default class GalaxyScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GalaxyScene' })
    this.socket          = null
    this.gameState       = null
    this.planetRenderers = {}
    this.laneGraphics    = null
    this.shipRenderer    = null
    this.inputHandler    = null
    this.selectedPlanet    = null
    this._selectionInfo    = null
    this._planetDashboard  = null
    this._notifText        = null
    this._notifTimer       = 0
    this._lastTickTime     = 0
    this._factionMapCache  = null
    this._lastHUDUpdate    = 0
    this._lastZoom         = 0
    this._lastDashboardZoom = 0
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  init(data) {
    this.gameId = data.game_id
    this.seed   = data.seed
  }

  // ── Preload ────────────────────────────────────────────────────────────────

  preload() {
    // Reset zoom state when starting a new game
    this._lastZoom = 0
    this._lastDashboardZoom = 0
    this._lastHUDUpdate = 0
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  create() {
    const { width, height } = this.scale

    this._setupCamera()
    this._drawStarfield()
    this._setupTrackpadControls()

    this.laneGraphics = this.add.graphics().setDepth(1)

    this.shipRenderer = new ShipRenderer(this)

    this.inputHandler = new InputHandler(this, (msg) => this.socket?.send(msg))

    this._buildHUD(width, height)

    this._notifText = this.add.text(width / 2, height - 80, '', {
      fontSize: '14px', color: '#00ff88', fontFamily: 'monospace',
      backgroundColor: '#05111e', padding: { x: 10, y: 5 },
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(110).setAlpha(0)

    // _notifText was created after _buildHUD; reposition now so it also gets corrected.
    this._repositionHUD()

    this.events.on('planet-select', (id) => this._onPlanetSelect(id))
    this.events.on('selection-changed', (sel) => this._onSelectionChanged(sel))
    this.input.keyboard.on('keydown-ESC', () => this._onPlanetSelect(null))

    this.socket = new SocketClient(`${WS_URL}/ws/${this.gameId}`)
    this.socket.onOpen    = () => this._setStatus('Connected', '#00ff88')
    this.socket.onClose   = () => this._setStatus('Disconnected', '#ff4444')
    this.socket.onMessage = (msg) => this._handleMessage(msg)
    this.socket.connect()
  }

  // ── Frame update — 60 fps ship interpolation ───────────────────────────────

  update(time) {
    if (!this.gameState || this._lastTickTime === 0) return
    const alpha = Math.min(1, (time - this._lastTickTime) / 50)  // 50ms = 20Hz tick
    this.shipRenderer.drawFrame(
      alpha,
      this.inputHandler.selection,
      this.gameState.player_faction_id,
      this._factionMap(),
    )
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  _setupCamera() {
    this.cameras.main
      .setBounds(-400, -400, GALAXY_WIDTH + 800, GALAXY_HEIGHT + 800)
      .setZoom(0.55)
      .centerOn(GALAXY_WIDTH / 2, GALAXY_HEIGHT / 2)
  }

  // ── Trackpad + mouse wheel controls ───────────────────────────────────────
  //
  //  Two-finger scroll  → pan
  //  Pinch (ctrlKey)    → zoom
  //  No left-drag pan   → left drag is rubber-band select (InputHandler)

  _setupTrackpadControls() {
    const cam = this.cameras.main

    // Use native wheel event so we can read ctrlKey for pinch-to-zoom
    this.game.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        // Pinch-to-zoom
        const zoom = cam.zoom - e.deltaY * 0.008
        cam.zoom = Phaser.Math.Clamp(zoom, ZOOM_MIN, ZOOM_MAX)
        this._repositionHUD()
      } else {
        // Two-finger scroll → pan
        cam.scrollX += e.deltaX / cam.zoom
        cam.scrollY += e.deltaY / cam.zoom
      }
    }, { passive: false })
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  //
  //  TOP-RIGHT:    Title + Seed/ID + [SAVE] [MENU]
  //  TOP-LEFT:     Planet info panel (on click)
  //  BOTTOM-LEFT:  Resources
  //  BOTTOM-RIGHT: Selection info (energy control, ship count)

  _buildHUD(width, height) {
    // ── Top-right: title + controls ─────────────────────────────────────────
    this._hudTitle = this.add.text(width - 16, 14, 'FASTER THAN LIGHT', {
      fontSize: '16px', color: '#00ffff', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(100)

    this._hudSeed = this.add.text(width - 16, 36, `Seed: ${this.seed}  ·  ${this.gameId}`, {
      fontSize: '10px', color: '#334455', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(100)

    this._btnMenu = this._createHUDButton(width - 16,  60, 'MENU', () => this._goToMenu())
    this._btnSave = this._createHUDButton(width - 82,  60, 'SAVE', () => this._saveGame())

    // ── Bottom-left: resources + status ─────────────────────────────────────
    this.resourceText = this.add.text(16, height - 52, '⬡ —  ⚡ —  ✦ —', {
      fontSize: '13px', color: '#aabbcc', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100)

    this.tickText = this.add.text(16, height - 28, 'Connecting...', {
      fontSize: '11px', color: '#334455', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(100)

    // ── Bottom-right: selection panel ────────────────────────────────────────
    this._selectionInfo = this._buildSelectionPanel(width, height)

    // Correct initial positions for current zoom level
    this._repositionHUD()
  }

  // Correct HUD world-positions for the current camera zoom.
  // Throttled to prevent excessive updates during rapid zoom changes.
  _repositionHUD() {
    // Throttle repositioning to max 30fps to prevent performance issues
    const now = performance.now()
    if (now - this._lastHUDUpdate < 33) return // ~30fps max
    this._lastHUDUpdate = now

    const z    = this.cameras.main.zoom
    const invZ = 1 / z
    const { width, height } = this.scale
    
    // Only update if zoom has actually changed significantly
    if (Math.abs(z - this._lastZoom) < 0.01) return
    this._lastZoom = z

    this._hudTitle?.setScale(invZ).setPosition((width - 16) / z, 14 / z)
    this._hudSeed?.setScale(invZ).setPosition((width - 16) / z, 36 / z)
    this._btnMenu?.setScale(invZ).setPosition((width - 16) / z, 60 / z)
    this._btnSave?.setScale(invZ).setPosition((width - 82) / z, 60 / z)
    this.resourceText?.setScale(invZ).setPosition(16 / z, (height - 52) / z)
    this.tickText?.setScale(invZ).setPosition(16 / z, (height - 28) / z)
    this._selectionInfo?.setScale(invZ).setPosition((width - 16) / z, (height - 100) / z)
    
    // Only re-render dashboard if zoom changed significantly
    if (this._planetDashboard && this.selectedPlanet && Math.abs(z - this._lastDashboardZoom) > 0.1) {
      this._lastDashboardZoom = z
      const p = this.gameState?.planets.find(pl => pl.id === this.selectedPlanet)
      if (p) this._openPlanetDashboard(p)
    }
    
    this._notifText?.setScale(invZ).setPosition((width / 2) / z, (height - 80) / z)
  }

  _createHUDButton(x, y, label, onClick) {
    const btn = this.add.text(x, y, `[ ${label} ]`, {
      fontSize: '12px', color: '#778899', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(100).setInteractive({ useHandCursor: true })
    btn.on('pointerover', () => btn.setColor('#00ffff'))
    btn.on('pointerout',  () => btn.setColor('#778899'))
    btn.on('pointerdown', onClick)
    return btn
  }

  _buildSelectionPanel(width, height) {
    const panel = this.add.container(width - 16, height - 100)
      .setScrollFactor(0).setDepth(100)

    const bg = this.add.rectangle(0, 0, 230, 90, 0x050d14, 0.88)
      .setOrigin(1, 0).setStrokeStyle(1, 0x1a3a55, 1)

    const countText = this.add.text(-115, 10, '', {
      fontSize: '12px', color: '#aabbcc', fontFamily: 'monospace',
    }).setOrigin(0.5, 0)

    // Energy buttons: 5 levels
    const energyLabel = this.add.text(-218, 34, 'Energy:', {
      fontSize: '11px', color: '#556677', fontFamily: 'monospace',
    }).setOrigin(0, 0)

    const energyBtns = []
    const levels = [0.2, 0.4, 0.6, 0.8, 1.0]
    levels.forEach((lvl, i) => {
      const btn = this.add.text(-160 + i * 34, 34, `${lvl * 100 | 0}`, {
        fontSize: '11px', color: '#445566', fontFamily: 'monospace',
        backgroundColor: '#0a1a28', padding: { x: 4, y: 2 },
      }).setOrigin(0, 0).setInteractive({ useHandCursor: true })
      btn.on('pointerdown', () => this._setEnergyLevel(lvl))
      btn.on('pointerover', () => btn.setColor('#00ffff'))
      btn.on('pointerout',  () => btn.setColor('#445566'))
      energyBtns.push(btn)
      panel.add(btn)
    })

    const stopBtn = this.add.text(-218, 58, '[ STOP ]', {
      fontSize: '11px', color: '#778899', fontFamily: 'monospace',
    }).setOrigin(0, 0).setInteractive({ useHandCursor: true })
    stopBtn.on('pointerover', () => stopBtn.setColor('#ff8844'))
    stopBtn.on('pointerout',  () => stopBtn.setColor('#778899'))
    stopBtn.on('pointerdown', () => this._stopSelectedShips())

    panel.add([bg, countText, energyLabel, stopBtn])
    panel.setVisible(false)
    panel.countText  = countText
    panel.energyBtns = energyBtns
    return panel
  }

  // ── Message handling ───────────────────────────────────────────────────────

  _handleMessage(msg) {
    if (msg.type === 'state') {
      this.gameState = msg.data
      this.inputHandler.setGameState(this.gameState)
      this._buildGalaxy()
      this._setStatus(`Tick ${msg.data.tick}`, '#00ff88')
    } else if (msg.type === 'tick') {
      if (!this.gameState) return
      this._applyDelta(msg.data)
    }
  }

  _applyDelta(delta) {
    this._factionMapCache = null   // invalidate on every delta
    this.gameState.tick = delta.tick

    // Faction resources
    if (delta.factions) {
      const fMap = this._factionMap()
      delta.factions.forEach(df => { if (fMap[df.id]) Object.assign(fMap[df.id], df) })
      this._updateResourceHUD()
    }

    // Planet ownership changes
    if (delta.planets) {
      const pMap = {}
      this.gameState.planets.forEach(p => { pMap[p.id] = p })
      delta.planets.forEach(dp => {
        const p = pMap[dp.id]
        if (!p) return
        const pid          = this.gameState.player_faction_id
        const ownerChanged = p.owner !== dp.owner
        const wasExplored  = p.explored_by.includes(pid)
        Object.assign(p, dp)
        const nowExplored  = p.explored_by.includes(pid)
        if ((ownerChanged || wasExplored !== nowExplored) && this.planetRenderers[p.id]) {
          this.planetRenderers[p.id].update(p, pid, this._factionMap())
        }
      })
    }

    // Collect destroyed ship IDs from events
    const destroyedIds = new Set()
    if (delta.events) {
      delta.events.forEach(evt => {
        if (evt.type === 'ship_destroyed') destroyedIds.add(evt.ship_id)
      })
    }

    // Ship positions + health
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
        if (ds.vx != null)       { s.vx = ds.vx; s.vy = ds.vy }
      })

      // Remove destroyed ships from local state
      if (destroyedIds.size > 0) {
        this.gameState.ships = this.gameState.ships.filter(s => !destroyedIds.has(s.id))
        this.inputHandler.removeShips(destroyedIds)
      }

      this.shipRenderer.updateTargets(this.gameState.ships)
      this._lastTickTime = this.time.now
    }

    // Handle combat and game events
    if (delta.events && delta.events.length > 0) {
      this._handleGameEvents(delta.events)
    }

    this.tickText.setText(`Tick ${delta.tick}`)

    // Fade out notification
    if (this._notifTimer > 0) {
      this._notifTimer--
      if (this._notifTimer === 0) this._notifText.setAlpha(0)
    }
  }

  _handleGameEvents(events) {
    for (const evt of events) {
      if (evt.type === 'ship_spawned') {
        const sMap = {}
        this.gameState.ships.forEach(s => { sMap[s.id] = s })
        if (!sMap[evt.ship.id]) this.gameState.ships.push(evt.ship)
      } else if (evt.type === 'planet_captured') {
        const pid    = this.gameState.player_faction_id
        const pName  = this.gameState.planets.find(p => p.id === evt.planet_id)?.name ?? evt.planet_id
        if (evt.by === pid) {
          this._showNotification(`Captured ${pName}!`, '#00ff88')
        } else if (evt.from === pid) {
          this._showNotification(`Lost ${pName}!`, '#ff4444')
        }
      } else if (evt.type === 'faction_eliminated') {
        const f = this._factionMap()[evt.faction_id]
        if (f) this._showNotification(`${f.name} eliminated!`, '#ffaa00')
      }
    }
  }

  _showNotification(msg, colour = '#00ff88') {
    this._notifText.setText(msg).setColor(colour).setAlpha(1)
    this._notifTimer = 120   // visible for ~6 seconds at 20Hz
  }

  // ── Galaxy build ───────────────────────────────────────────────────────────

  _buildGalaxy() {
    const { player_faction_id, planets, factions } = this.gameState
    const factionMap = this._factionMap()

    this._drawLanes(planets, player_faction_id)

    planets.forEach(planet => {
      if (this.planetRenderers[planet.id]) {
        this.planetRenderers[planet.id].update(planet, player_faction_id, factionMap)
      } else {
        const pr = new PlanetRenderer(this, planet, player_faction_id).setDepth(5)
        pr.update(planet, player_faction_id, factionMap)
        this.planetRenderers[planet.id] = pr
      }
    })

    // Centre on player home with proper zoom reset
    const pf   = factions.find(f => f.id === player_faction_id)
    const home = pf && planets.find(p => p.id === pf.home_planet)
    if (home) {
      // Reset zoom to default and center on home planet
      this.cameras.main.setZoom(0.55)
      this.cameras.main.centerOn(home.x, home.y)
      // Reset zoom state tracking
      this._lastZoom = 0
      this._lastDashboardZoom = 0
      this._lastHUDUpdate = 0
    }

    this.shipRenderer.draw(
      this.gameState.ships,
      this.inputHandler.selection,
      player_faction_id,
      factionMap,
    )
    this._updateResourceHUD()
  }

  _drawLanes(planets, playerFactionId) {
    this.laneGraphics.clear()
    const pMap  = {}
    planets.forEach(p => { pMap[p.id] = p })
    const drawn = new Set()

    planets.forEach(planet => {
      const aExp = planet.explored_by.some(fid => fid !== 'neutral')
      planet.lanes.forEach(nid => {
        const key = [planet.id, nid].sort().join('|')
        if (drawn.has(key)) return
        drawn.add(key)
        const nb   = pMap[nid]
        if (!nb) return
        const bExp = nb.explored_by.some(fid => fid !== 'neutral')
        const alpha = (aExp || bExp) ? 0.20 : 0.05
        this.laneGraphics.lineStyle(1, 0x3366aa, alpha)
        this.laneGraphics.lineBetween(planet.x, planet.y, nb.x, nb.y)
      })
    })
  }

  // ── Planet dashboard ───────────────────────────────────────────────────────

  _onPlanetSelect(planetId) {
    if (planetId === null) { this._closePlanetDashboard(); this.selectedPlanet = null; return }
    if (!this.gameState) return
    const planet = this.gameState.planets.find(p => p.id === planetId)
    if (!planet) return
    this.selectedPlanet = planetId
    this._openPlanetDashboard(planet)
  }

  _closePlanetDashboard() {
    if (this._planetDashboard) { this._planetDashboard.destroy(); this._planetDashboard = null }
  }

  _openPlanetDashboard(planet) {
    this._closePlanetDashboard()

    const pid      = this.gameState.player_faction_id
    const fMap     = this._factionMap()
    const explored = planet.explored_by.some(fid => fid !== 'neutral')
    const isOwn    = planet.owner === pid
    const ownerName = planet.owner ? (fMap[planet.owner]?.name ?? planet.owner) : 'Neutral'
    const ownerHex  = planet.owner === pid ? '#00ffff' : (fMap[planet.owner]?.colour ?? '#888888')

    const W  = this.scale.width
    const H  = this.scale.height
    const z  = this.cameras.main.zoom
    
    // FIXED: Dashboard should be fixed size overlay, not scale with zoom
    const PW = Math.min(940, W - 40)
    const PH = Math.min(580, H - 40)
    const px = (W - PW) / 2
    const py = (H - PH) / 2

    // Create dashboard container as fixed-size overlay
    const dash = this.add.container(px, py).setScrollFactor(0).setDepth(200)
    // FIXED: Apply inverse scale to counteract camera zoom - makes it appear fixed-size
    dash.setScale(1 / z)

    // Dim overlay — click outside to close
    const overlay = this.add.rectangle(0, 0, W, H, 0x000000, 0.72).setOrigin(0).setInteractive()
    overlay.on('pointerdown', () => this._closePlanetDashboard())
    dash.add(overlay)

    // Panel background
    const bg = this.add.rectangle(0, 0, PW, PH, 0x050f1a, 0.97).setOrigin(0).setStrokeStyle(1, 0x1a4060)
    dash.add(bg)

    // ── Header ───────────────────────────────────────────────────────────────
    const title = this.add.text(PW / 2, 14, explored ? planet.name : '???', {
      fontSize: '18px', color: '#00ffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0)
    dash.add(title)

    const ownerText = this.add.text(16, 16, ownerName, {
      fontSize: '12px', color: ownerHex, fontFamily: 'monospace',
    }).setOrigin(0, 0)
    dash.add(ownerText)

    const closeBtn = this.add.text(PW - 14, 10, '×', {
      fontSize: '22px', color: '#445566', fontFamily: 'monospace',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true })
    closeBtn.on('pointerover', () => closeBtn.setColor('#ff4444'))
    closeBtn.on('pointerout',  () => closeBtn.setColor('#445566'))
    closeBtn.on('pointerdown', () => this._closePlanetDashboard())
    dash.add(closeBtn)

    const hg = this.add.graphics()
    hg.lineStyle(1, 0x1a4060); hg.lineBetween(0, 46, PW, 46)
    dash.add(hg)

    const cTop = 54

    // ── Unexplored: minimal view ──────────────────────────────────────────────
    if (!explored) {
      const msg = planet.owner
        ? `Territory of ${ownerName}\n\nUnexplored — send ships to reveal details`
        : 'Uncharted System\n\nSend ships to explore'
      dash.add(this.add.text(PW / 2, PH / 2, msg, {
        fontSize: '14px', color: '#445566', fontFamily: 'monospace', align: 'center', lineSpacing: 8,
      }).setOrigin(0.5, 0.5))
      this._planetDashboard = dash
      return
    }

    // ── Left column: planet visual ────────────────────────────────────────────
    const LW  = 260
    const LCX = LW / 2
    const visY = cTop + 105
    const VR   = 72
    const RC = { minerals: [0x5588bb, 0x3366aa], energy: [0xccaa33, 0xaa8800], rare: [0x8855bb, 0x6633aa] }
    const [fill, glow] = RC[planet.resource_type] ?? [0x445566, 0x223344]

    const pg = this.add.graphics()
    pg.fillStyle(glow, 0.05); pg.fillCircle(LCX, visY, VR + 30)
    pg.fillStyle(glow, 0.12); pg.fillCircle(LCX, visY, VR + 14)
    pg.fillStyle(fill, 0.92); pg.fillCircle(LCX, visY, VR)
    pg.fillStyle(0x000000, 0.28); pg.fillCircle(LCX - VR * 0.22, visY - VR * 0.12, VR * 0.60)
    pg.fillStyle(0xffffff, 0.06); pg.fillCircle(LCX + VR * 0.28, visY - VR * 0.30, VR * 0.32)
    const orbitingCount = this.gameState.ships.filter(
      s => s.state === 'orbiting' && s.target_planet === planet.id
    ).length
    if (orbitingCount > 0) {
      pg.lineStyle(1, isOwn ? 0x00ffff : 0xffffff, 0.28); pg.strokeCircle(LCX, visY, VR + 20)
      pg.lineStyle(1, isOwn ? 0x00ffff : 0xffffff, 0.10); pg.strokeCircle(LCX, visY, VR + 33)
    }
    if (planet.defense > 0.05) {
      pg.lineStyle(2, 0xff6644, Math.min(planet.defense * 3, 0.75))
      pg.strokeCircle(LCX, visY, VR + 10)
    }
    dash.add(pg)

    const RLBL = { minerals: '▲ Minerals', energy: '⚡ Energy', rare: '✦ Rare' }
    const leftStats = [
      [RLBL[planet.resource_type] ?? planet.resource_type, `${(planet.resource_rate / 20).toFixed(3)}/s`],
      ['Population',  `${planet.population}`],
      ['Defense',     `${Math.round(planet.defense * 100)}%`],
      ['Level',       `${planet.level}  →  ${planet.level} ships / 10s`],
      ['Orbiting',    `${orbitingCount} ship${orbitingCount !== 1 ? 's' : ''}`],
    ]
    leftStats.forEach(([lbl, val], i) => {
      const ly = visY + VR + 22 + i * 18
      dash.add(this.add.text(14, ly, lbl,
        { fontSize: '11px', color: '#3d5666', fontFamily: 'monospace' }))
      dash.add(this.add.text(LW - 8, ly, val,
        { fontSize: '11px', color: '#9ab0be', fontFamily: 'monospace' }).setOrigin(1, 0))
    })

    // Vertical divider
    const vdg = this.add.graphics()
    vdg.lineStyle(1, 0x1a4060); vdg.lineBetween(LW + 10, cTop, LW + 10, PH - 8)
    dash.add(vdg)

    // ── Right column ──────────────────────────────────────────────────────────
    const RX = LW + 26
    const RW = PW - LW - 38
    let   ry = cTop

    const section = (label) => {
      const sg = this.add.graphics()
      sg.lineStyle(1, 0x0f2535); sg.lineBetween(RX, ry + 14, RX + RW - 8, ry + 14)
      dash.add(sg)
      dash.add(this.add.text(RX, ry, label, { fontSize: '10px', color: '#1a5070', fontFamily: 'monospace' }))
      ry += 22
    }

    const row = (key, val, vc = '#9ab0be') => {
      dash.add(this.add.text(RX,       ry, key, { fontSize: '11px', color: '#3d5870', fontFamily: 'monospace' }))
      dash.add(this.add.text(RX + 130, ry, val, { fontSize: '11px', color: vc,        fontFamily: 'monospace' }))
      ry += 17
    }

    // Buildings
    const BLDG_INFO = {
      extractor:        { label: 'Extractor',        desc: '+50% resource income from this planet' },
      shipyard:         { label: 'Shipyard',          desc: 'Unlocks manual ship construction' },
      research_lab:     { label: 'Research Lab',      desc: '+1 RP/tick → unlocks tech tiers 2 & 3' },
      defense_platform: { label: 'Defense Platform',  desc: '+25 combat defense power' },
    }

    section('BUILDINGS')
    if (planet.buildings.length === 0) {
      dash.add(this.add.text(RX, ry, 'None constructed', { fontSize: '11px', color: '#1e2e38', fontFamily: 'monospace' }))
      ry += 17
    } else {
      for (const b of planet.buildings) {
        const info = BLDG_INFO[b] ?? { label: b, desc: '' }
        dash.add(this.add.text(RX,       ry, `● ${info.label}`, { fontSize: '11px', color: '#9ab0be', fontFamily: 'monospace' }))
        dash.add(this.add.text(RX + 155, ry, info.desc,          { fontSize: '10px', color: '#2a4455', fontFamily: 'monospace' }))
        ry += 17
      }
    }
    ry += 6

    // Build queue
    const queue = planet.build_queue ?? []
    section(`BUILD QUEUE  (${queue.length}/2)`)
    if (queue.length === 0) {
      dash.add(this.add.text(RX, ry, 'Empty', { fontSize: '11px', color: '#1e2e38', fontFamily: 'monospace' }))
      ry += 17
    } else {
      for (const item of queue) {
        const name = item.name ?? item.ship_type ?? '?'
        const secs = Math.round(item.ticks_remaining / 20)
        const pct  = Math.max(0, Math.round((1 - item.ticks_remaining / 400) * 12))
        const bar  = `[${'█'.repeat(pct)}${'░'.repeat(12 - pct)}]`
        dash.add(this.add.text(RX, ry, `● ${name.padEnd(10)} ${secs}s  ${bar}`,
          { fontSize: '11px', color: '#7799aa', fontFamily: 'monospace' }))
        ry += 17
      }
    }
    ry += 6

    // Build options (own planet only)
    if (isOwn) {
      const faction = fMap[pid]
      if (!faction) { this._planetDashboard = dash; return }
      const queueFull = queue.length >= 2

      const BLDGS = [
        { name: 'extractor',        label: 'Extractor',    cost: 100 },
        { name: 'shipyard',         label: 'Shipyard',     cost: 200 },
        { name: 'research_lab',     label: 'Lab',          cost: 150 },
        { name: 'defense_platform', label: 'Defense',      cost: 250 },
      ]
      const SHIPS = [
        { name: 'fighter', label: 'Fighter', cost: 50,  tier: 1 },
        { name: 'cruiser', label: 'Cruiser', cost: 150, tier: 2 },
        { name: 'bomber',  label: 'Bomber',  cost: 120, tier: 2 },
      ]

      const makeBtn = (label, canBuild, onClick) => {
        const col = canBuild ? '#7a9ab0' : '#1e2e38'
        const btn = this.add.text(0, 0, `[${label}]`, {
          fontSize: '11px', color: col, fontFamily: 'monospace',
          backgroundColor: '#080f18', padding: { x: 5, y: 3 },
        })
        if (canBuild) {
          btn.setInteractive({ useHandCursor: true })
          btn.on('pointerover', () => btn.setColor('#00ffff'))
          btn.on('pointerout',  () => btn.setColor(col))
          btn.on('pointerdown', () => {
            onClick()
            const fresh = this.gameState.planets.find(p => p.id === planet.id) ?? planet
            this._openPlanetDashboard(fresh)
          })
        }
        return btn
      }

      const layoutBtns = (btns) => {
        let bx = RX
        for (const btn of btns) {
          btn.setPosition(bx, ry)
          dash.add(btn)
          bx += btn.width + 8
          if (bx > RX + RW - 60) { bx = RX; ry += 26 }
        }
        ry += 28
      }

      const availBldgs = BLDGS.filter(b => !planet.buildings.includes(b.name))
      if (availBldgs.length > 0) {
        section('CONSTRUCT')
        layoutBtns(availBldgs.map(b => {
          const can = !queueFull && faction.credits >= b.cost
          return makeBtn(`${b.label}  ${b.cost} Credits`, can, () =>
            this.socket?.send({ type: 'build', planet_id: planet.id, item_type: 'building', item_name: b.name }))
        }))
      }

      if (planet.buildings.includes('shipyard')) {
        section('BUILD SHIPS')
        layoutBtns(SHIPS
          .filter(s => faction.tech_tier >= s.tier)
          .map(s => {
            const can = !queueFull && faction.credits >= s.cost
            return makeBtn(`${s.label}  ${s.cost} Credits`, can, () =>
              this.socket?.send({ type: 'build', planet_id: planet.id, item_type: 'ship', item_name: s.name }))
          }))
      }
    }

    this._planetDashboard = dash
  }

  // ── Selection panel ────────────────────────────────────────────────────────

  _onSelectionChanged(selection) {
    if (!this.gameState || selection.size === 0) {
      this._selectionInfo.setVisible(false)
      return
    }

    const sMap  = {}
    this.gameState.ships.forEach(s => { sMap[s.id] = s })
    const sel   = [...selection].map(id => sMap[id]).filter(Boolean)
    const types = {}
    sel.forEach(s => { types[s.type] = (types[s.type] ?? 0) + 1 })
    const typeStr = Object.entries(types).map(([t, n]) => `${n}× ${t}`).join('  ')

    this._selectionInfo.countText.setText(`${selection.size} selected  ${typeStr}`)
    this._selectionInfo.setVisible(true)
  }

  _setEnergyLevel(level) {
    if (!this.inputHandler.selection.size) return
    this.socket?.send({
      type: 'energy',
      ship_ids: [...this.inputHandler.selection],
      level,
    })
    // Highlight active energy button
    const levels = [0.2, 0.4, 0.6, 0.8, 1.0]
    this._selectionInfo.energyBtns.forEach((btn, i) => {
      btn.setColor(levels[i] === level ? '#00ffff' : '#445566')
    })
  }

  _stopSelectedShips() {
    if (!this.inputHandler.selection.size) return
    this.socket?.send({
      type: 'stop',
      ship_ids: [...this.inputHandler.selection],
    })
  }

  // ── Resource HUD ───────────────────────────────────────────────────────────

  _updateResourceHUD() {
    if (!this.gameState) return
    const player = this._factionMap()[this.gameState.player_faction_id]
    if (!player) return
    this.resourceText.setText(
      `Credits: ${Math.floor(player.credits)}  ` +
      `Storage: ${Math.floor(player.credits)}/${Math.floor(player.storage_capacity)}  ` +
      `RP ${Math.floor(player.research_points)}  T${player.tech_tier}`
    )
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _factionMap() {
    if (!this._factionMapCache) {
      this._factionMapCache = {}
      this.gameState?.factions.forEach(f => { this._factionMapCache[f.id] = f })
    }
    return this._factionMapCache
  }

  _setStatus(msg, colour = '#334455') {
    this.tickText?.setText(msg).setColor(colour)
  }

  _drawStarfield() {
    // World-space stars spread across the galaxy — no camera scroll-factor needed.
    // They scroll naturally with the camera and are unaffected by zoom arithmetic.
    const g = this.add.graphics().setDepth(0)
    let rng = this.seed || 42
    const r = () => { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return Math.abs(rng) / 2147483647 }
    for (let i = 0; i < 500; i++) {
      g.fillStyle(0xffffff, 0.04 + r() * 0.22)
      g.fillRect(r() * GALAXY_WIDTH, r() * GALAXY_HEIGHT, r() < 0.85 ? 1 : 2, r() < 0.85 ? 1 : 2)
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async _saveGame() {
    try {
      const res = await fetch(`${API_URL}/game/${this.gameId}/save`, { method: 'POST' })
      if (!res.ok) throw new Error(res.status)
      const { filename } = await res.json()
      this._setStatus(`Saved: ${filename}`, '#00ff88')
    } catch (err) {
      this._setStatus(`Save failed: ${err.message}`, '#ff4444')
    }
  }

  _goToMenu() {
    this._closePlanetDashboard()
    this.socket?.close()
    this.inputHandler?.destroy()
    this.shipRenderer?.destroy()
    Object.values(this.planetRenderers).forEach(pr => pr.destroy())
    this.planetRenderers = {}
    this.scene.start('MenuScene')
  }

  shutdown() {
    this._closePlanetDashboard()
    this.socket?.close()
    this.inputHandler?.destroy()
    this.shipRenderer?.destroy()
    Object.values(this.planetRenderers).forEach(pr => pr.destroy())
  }
}
