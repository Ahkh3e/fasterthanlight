const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export default class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' })
  }

  create() {
    const { width, height } = this.scale

    this._drawStarfield()

    // Title
    this.add.text(width / 2, height / 3 - 20, 'FASTER THAN LIGHT', {
      fontSize: '52px',
      color: '#00ffff',
      fontFamily: 'monospace',
      stroke: '#003344',
      strokeThickness: 4,
    }).setOrigin(0.5)

    this.add.text(width / 2, height / 3 + 40, 'REAL-TIME STRATEGY · PROCEDURAL GALAXY', {
      fontSize: '14px',
      color: '#336677',
      fontFamily: 'monospace',
      letterSpacing: 4,
    }).setOrigin(0.5)

    // Buttons
    this._createButton(width / 2, height / 2 + 20, 'NEW GAME', () => this._newGame())
    this._createButton(width / 2, height / 2 + 80, 'LOAD GAME', () => this._showSaves())

    // Status line
    this.statusText = this.add.text(width / 2, height - 30, '', {
      fontSize: '13px',
      color: '#556677',
      fontFamily: 'monospace',
    }).setOrigin(0.5)
  }

  _createButton(x, y, label, onClick) {
    const btn = this.add.text(x, y, `[ ${label} ]`, {
      fontSize: '22px',
      color: '#aabbcc',
      fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true })

    btn.on('pointerover', () => btn.setColor('#00ffff'))
    btn.on('pointerout', () => btn.setColor('#aabbcc'))
    btn.on('pointerdown', onClick)
    return btn
  }

  _drawStarfield() {
    const { width, height } = this.scale
    const g = this.add.graphics()
    for (let i = 0; i < 250; i++) {
      const x = Math.random() * width
      const y = Math.random() * height
      const size = Math.random() < 0.85 ? 1 : 2
      g.fillStyle(0xffffff, 0.2 + Math.random() * 0.6)
      g.fillRect(x, y, size, size)
    }
  }

  async _newGame() {
    this.statusText.setText('Connecting to server...')
    try {
      const res = await fetch(`${API_URL}/game/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planet_count: 120 }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const { game_id, seed } = await res.json()
      this.scene.start('GalaxyScene', { game_id, seed })
    } catch (err) {
      this.statusText.setText(`Error: ${err.message}`)
    }
  }

  async _showSaves() {
    this.statusText.setText('Fetching saves...')
    try {
      const res = await fetch(`${API_URL}/game/saves`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const saves = await res.json()

      if (saves.length === 0) {
        this.statusText.setText('No saves found. Start a new game.')
        return
      }

      // Show a simple save picker overlay
      this._renderSavePicker(saves)
    } catch (err) {
      this.statusText.setText(`Error: ${err.message}`)
    }
  }

  _renderSavePicker(saves) {
    const { width, height } = this.scale

    // Dim background
    const overlay = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.75)

    this.add.text(width / 2, height / 4, 'SELECT SAVE', {
      fontSize: '24px',
      color: '#00ffff',
      fontFamily: 'monospace',
    }).setOrigin(0.5)

    saves.slice(0, 6).forEach((save, i) => {
      const label = `Seed ${save.seed}  Tick ${save.tick}  ${save.saved_at.slice(0, 16)}`
      const btn = this.add.text(width / 2, height / 4 + 60 + i * 40, label, {
        fontSize: '14px',
        color: '#aabbcc',
        fontFamily: 'monospace',
      }).setOrigin(0.5).setInteractive({ useHandCursor: true })

      btn.on('pointerover', () => btn.setColor('#00ffff'))
      btn.on('pointerout', () => btn.setColor('#aabbcc'))
      btn.on('pointerdown', () => this._loadSave(save.filename))
    })
  }

  async _loadSave(filename) {
    this.statusText.setText(`Loading ${filename}...`)
    try {
      const res = await fetch(`${API_URL}/game/load/${filename}`, { method: 'POST' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const { game_id, seed } = await res.json()
      this.scene.start('GalaxyScene', { game_id, seed })
    } catch (err) {
      this.statusText.setText(`Error: ${err.message}`)
    }
  }
}
