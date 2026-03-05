const envHosts = (process.env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

const defaultHosts = ['localhost', '127.0.0.1', 'ftl.muhahomelab.com']

export default {
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: envHosts.length ? envHosts : defaultHosts,
  },
}
