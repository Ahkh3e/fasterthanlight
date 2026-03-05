# fasterthanlight

Run locally or expose safely over the internet without port forwarding by using Cloudflare Tunnel.

## Cloudflare Tunnel (No Port Forwarding)

### 1) Create a tunnel in Cloudflare
- Open Cloudflare Zero Trust dashboard.
- Create a tunnel and copy the tunnel token.
- Add public hostnames:
	- `ftl.yourdomain.com` -> `http://frontend:5173`
	- `ftl-api.yourdomain.com` -> `http://backend:8000`

### 2) Configure environment
- Copy `.env.example` to `.env`.
- Set:
	- `CF_TUNNEL_TOKEN`
	- `VITE_API_URL=https://ftl-api.yourdomain.com`
	- `VITE_WS_URL=wss://ftl-api.yourdomain.com`

### 3) Start stack with tunnel profile
```bash
docker compose --profile tunnel up -d --build
```

### 4) Open the game
- Open `https://ftl.yourdomain.com`

## Security Notes
- No router port forwarding is required.
- Compose maps backend/frontend only to `127.0.0.1`, so they are not exposed to your LAN.
- Internet access is through Cloudflare's outbound tunnel connection only.

## Local only (without tunnel)
```bash
docker compose up -d --build
```

Then open `http://localhost:5173`.

### Performance note
- Backend per-second tick logging is disabled by default for smoother runtime.
- To enable diagnostics temporarily, set `GAME_TICK_DIAGNOSTICS=1` for backend.

## Multiplayer Lobby (up to 6)

- Use the start screen to host or join a lobby.
- Host flow:
	- Enter player name.
	- Click `HOST LOBBY (MAX 6)`.
	- Share lobby code shown on screen.
	- Click `START MATCH` when ready.
- Join flow:
	- Enter player name.
	- Enter lobby code.
	- Click `JOIN LOBBY` and wait for host to start.

### Connection HUD
- Top-right panel now shows:
	- `Conn` (`ONLINE`/`OFFLINE`)
	- `Online` (current websocket clients in match)
	- `Endpoint` (configured API/tunnel host)