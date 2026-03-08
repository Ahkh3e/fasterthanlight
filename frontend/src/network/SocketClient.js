export default class SocketClient {
  constructor(url, { watchdogMs = 5000 } = {}) {
    this.url = url
    this.ws = null
    this.onMessage = () => {}
    this.onOpen = () => {}
    this.onClose = () => {}
    this.outbox = []
    this._reconnectDelay = 1000
    this._reconnectTimer = null
    this._watchdogTimer = null
    this._watchdogMs = watchdogMs
    this._destroyed = false
  }

  connect() {
    this._destroyed = false
    this._doConnect()
  }

  _doConnect() {
    if (this._destroyed) return

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this._reconnectDelay = 1000 // reset backoff on successful connect
      for (const payload of this.outbox) this.ws.send(payload)
      this.outbox = []
      this._resetWatchdog()
      this.onOpen()
    }

    this.ws.onclose = (event) => {
      this._clearWatchdog()
      this.onClose(event)
      if (!this._destroyed) this._scheduleReconnect()
    }

    this.ws.onerror = (err) => console.error('[Socket] error', err)

    this.ws.onmessage = (event) => {
      this._resetWatchdog()
      try {
        this.onMessage(JSON.parse(event.data))
      } catch (e) {
        console.error('[Socket] failed to parse message', e)
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._destroyed) return
    const delay = this._reconnectDelay
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._doConnect()
    }, delay)
  }

  _resetWatchdog() {
    this._clearWatchdog()
    if (this._watchdogMs <= 0) return
    this._watchdogTimer = setTimeout(() => {
      console.warn('[Socket] watchdog: no message in', this._watchdogMs, 'ms — forcing reconnect')
      this.ws?.close()
    }, this._watchdogMs)
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer)
      this._watchdogTimer = null
    }
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
      return true
    }
    // Cap outbox size so stale commands don't flood on reconnect
    if (this.outbox.length < 20) this.outbox.push(JSON.stringify(data))
    return false
  }

  close() {
    this._destroyed = true
    this._clearWatchdog()
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.outbox = []
  }
}
