const AUDIO_SETTINGS_KEY = 'ftl_audio_settings_v1'

export default class AudioManager {
  constructor() {
    this.unlocked = false
    this.muted = false
    this.musicVolume = 0.45
    this.sfxVolume = 0.75
    this.currentMusic = null
    this.currentMusicName = null
    this.pendingMusic = null

    this.lastPlayedAt = {}
    this.activeSfx = {}

    this.music = {
      menu: this._createMusic('/audio/music/menu.mp3'),
      game: this._createMusic('/audio/music/gameplay.mp3'),
      battle: this._createMusic('/audio/music/battle.mp3'),
    }

    this.sfxDefs = {
      click: { path: '/audio/sfx/ui_click.mp3', cooldownMs: 70, maxConcurrent: 2 },
      lobby: { path: '/audio/sfx/lobby_join.mp3', cooldownMs: 200, maxConcurrent: 2 },
      shot: { path: '/audio/sfx/laser_shot.mp3', cooldownMs: 80, maxConcurrent: 4 },
      explosion: { path: '/audio/sfx/explosion.mp3', cooldownMs: 120, maxConcurrent: 3 },
      captured: { path: '/audio/sfx/planet_capture.mp3', cooldownMs: 240, maxConcurrent: 2 },
      eliminated: { path: '/audio/sfx/faction_eliminated.mp3', cooldownMs: 300, maxConcurrent: 1 },
      game_over: { path: '/audio/sfx/game_over.mp3', cooldownMs: 800, maxConcurrent: 1 },
    }

    this._loadSettings()
    this._applyMusicVolume()
  }

  unlock() {
    if (this.unlocked) return
    this.unlocked = true
    if (this.pendingMusic) {
      const pending = this.pendingMusic
      this.pendingMusic = null
      this.playMusic(pending)
    }
  }

  playMusic(name) {
    if (!name || this.currentMusicName === name) return
    if (this.muted) return
    if (!this.unlocked) {
      this.pendingMusic = name
      return
    }

    const track = this.music[name]
    if (!track) return

    if (this.currentMusic) {
      this.currentMusic.pause()
      this.currentMusic.currentTime = 0
    }

    this.currentMusic = track
    this.currentMusicName = name
    this._applyMusicVolume()
    this.currentMusic.play().catch(() => {})
  }

  stopMusic() {
    if (!this.currentMusic) return
    this.currentMusic.pause()
    this.currentMusic.currentTime = 0
    this.currentMusic = null
    this.currentMusicName = null
  }

  playSfx(name, volumeMul = 1) {
    if (!name || this.muted || !this.unlocked) return
    const def = this.sfxDefs[name]
    if (!def) return

    const now = performance.now()
    const last = this.lastPlayedAt[name] ?? 0
    if (now - last < def.cooldownMs) return

    const active = this.activeSfx[name] ?? 0
    if (active >= def.maxConcurrent) return

    this.lastPlayedAt[name] = now
    this.activeSfx[name] = active + 1

    const a = new Audio(def.path)
    a.volume = Math.max(0, Math.min(1, this.sfxVolume * volumeMul))
    a.preload = 'auto'
    a.onended = () => { this.activeSfx[name] = Math.max(0, (this.activeSfx[name] ?? 1) - 1) }
    a.onerror = () => { this.activeSfx[name] = Math.max(0, (this.activeSfx[name] ?? 1) - 1) }
    a.play().catch(() => { this.activeSfx[name] = Math.max(0, (this.activeSfx[name] ?? 1) - 1) })
  }

  setMuted(value) {
    this.muted = !!value
    if (this.muted) {
      this.stopMusic()
    } else if (this.currentMusicName) {
      this.playMusic(this.currentMusicName)
    }
    this._saveSettings()
  }

  _createMusic(path) {
    const audio = new Audio(path)
    audio.loop = true
    audio.preload = 'auto'
    return audio
  }

  _applyMusicVolume() {
    Object.values(this.music).forEach(track => {
      track.volume = this.muted ? 0 : this.musicVolume
    })
  }

  _loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || '{}')
      if (typeof data.muted === 'boolean') this.muted = data.muted
      if (typeof data.musicVolume === 'number') this.musicVolume = data.musicVolume
      if (typeof data.sfxVolume === 'number') this.sfxVolume = data.sfxVolume
    } catch {}
  }

  _saveSettings() {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({
      muted: this.muted,
      musicVolume: this.musicVolume,
      sfxVolume: this.sfxVolume,
    }))
  }
}
