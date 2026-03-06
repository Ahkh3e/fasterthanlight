export default class SocketClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.onMessage = () => {}
    this.onOpen = () => {}
    this.onClose = () => {}
    this.outbox = []
  }

  connect() {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      if (this.outbox.length > 0) {
        for (const payload of this.outbox) {
          this.ws.send(payload)
        }
        this.outbox = []
      }
      this.onOpen()
    }
    this.ws.onclose = () => this.onClose()
    this.ws.onerror = (err) => console.error('[Socket] error', err)

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        this.onMessage(msg)
      } catch (e) {
        console.error('[Socket] failed to parse message', e)
      }
    }
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
      return true
    }
    this.outbox.push(JSON.stringify(data))
    return false
  }

  close() {
    this.ws?.close()
    this.ws = null
    this.outbox = []
  }
}
