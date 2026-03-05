export default class SocketClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.onMessage = () => {}
    this.onOpen = () => {}
    this.onClose = () => {}
  }

  connect() {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => this.onOpen()
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
    }
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}
