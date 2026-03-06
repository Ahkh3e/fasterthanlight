// Must stay in sync with backend/app/game/config.py
export const GALAXY_WIDTH  = 10000
export const GALAXY_HEIGHT = 10000

export const RESOURCE_COLOURS = {
  minerals: '#4a9eff',   // steel blue
  energy:   '#ffcc00',   // amber
  rare:     '#b06bff',   // purple
}

export const RESOURCE_LABELS = {
  minerals: '⬡',
  energy:   '⚡',
  rare:     '✦',
}

export const SHIP_COLOURS = {
  fighter:     0xffffff,
  cruiser:     0x44aaff,
  bomber:      0xff8844,
  carrier:     0xaaffaa,
  dreadnought: 0xff4444,
}

// Zoom limits for the galaxy map camera
export const ZOOM_MIN = 0.07
export const ZOOM_MAX = 2.5
export const ZOOM_STEP = 0.001

// Dev menu toggle (set true to show Dev Solo sandbox button on home screen)
export const DEV_MENU_ENABLED = true

// Ship types
export const SHIP_TYPES = ['fighter', 'cruiser', 'bomber', 'carrier', 'dreadnought']
