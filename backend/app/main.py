import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from game.state import GameState
from game.serializer import serialize_state, serialize_delta
from game.physics import physics_tick
from game.simulation import tick as simulation_tick
from game.combat import combat_tick
from game.ai import ai_tick
from game.config import BUILDING_COSTS, SHIP_COSTS, BUILDING_LEVEL_REQ, LEVEL_UP_COSTS, LEVEL_UP_TICKS, SHIP_BUILD_TICKS, PLAYER_START_CREDITS

app = FastAPI(title="Faster Than Light")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TICK_RATE = int(os.getenv("GAME_TICK_RATE", "20"))
TICK_DIAGNOSTICS = os.getenv("GAME_TICK_DIAGNOSTICS", "0") == "1"
SAVES_DIR = Path("saves")
SAVES_DIR.mkdir(exist_ok=True)

games:       dict[str, GameState]      = {}
connections: dict[str, list[WebSocket]] = {}
connection_meta: dict[str, dict[int, dict]] = {}

lobbies: dict[str, "Lobby"] = {}
game_access_tokens: dict[str, set[str]] = {}
game_players_by_token: dict[str, dict[str, dict]] = {}


@dataclass
class LobbyMember:
    token: str
    name: str
    slot: int
    is_host: bool = False


@dataclass
class Lobby:
    id: str
    max_players: int
    seed: int
    planet_count: int
    status: str = "waiting"   # waiting | started
    game_id: Optional[str] = None
    members: list[LobbyMember] = field(default_factory=list)

    def host(self) -> Optional[LobbyMember]:
        return next((m for m in self.members if m.is_host), None)

    def to_dict(self) -> dict:
        return {
            "lobby_id": self.id,
            "max_players": self.max_players,
            "player_count": len(self.members),
            "status": self.status,
            "game_id": self.game_id,
            "players": [
                {
                    "name": m.name,
                    "slot": m.slot,
                    "is_host": m.is_host,
                }
                for m in sorted(self.members, key=lambda x: x.slot)
            ],
        }


# ── Request models ────────────────────────────────────────────────────────────

class NewGameRequest(BaseModel):
    seed:         Optional[int] = None
    planet_count: Optional[int] = 120


class LobbyCreateRequest(BaseModel):
    seed: Optional[int] = None
    planet_count: Optional[int] = 120
    max_players: int = 6
    host_name: str = "Host"


class LobbyJoinRequest(BaseModel):
    name: str = "Player"


class LobbyStartRequest(BaseModel):
    host_token: str


def _create_game(seed: Optional[int], planet_count: Optional[int]) -> tuple[str, GameState]:
    game_id = str(uuid.uuid4())[:8]
    game_seed = seed if seed is not None else int(uuid.uuid4().int % 1_000_000)
    state = GameState.create(game_id=game_id, seed=game_seed, planet_count=planet_count or 120)
    games[game_id] = state
    connections[game_id] = []
    connection_meta[game_id] = {}
    asyncio.create_task(game_loop(game_id))
    return game_id, state


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.post("/game/new")
async def new_game(req: NewGameRequest):
    game_id, state = _create_game(req.seed, req.planet_count)
    return {
        "game_id": game_id,
        "seed": state.seed,
        "planet_count": len(state.planets),
    }


@app.post("/lobby/create")
async def create_lobby(req: LobbyCreateRequest):
    max_players = max(2, min(6, int(req.max_players)))
    lobby_id = str(uuid.uuid4())[:6].upper()
    host_token = uuid.uuid4().hex
    host_name = (req.host_name or "Host").strip()[:20] or "Host"
    seed = req.seed if req.seed is not None else int(uuid.uuid4().int % 1_000_000)

    lobby = Lobby(
        id=lobby_id,
        max_players=max_players,
        seed=seed,
        planet_count=req.planet_count or 120,
        members=[LobbyMember(token=host_token, name=host_name, slot=1, is_host=True)],
    )
    lobbies[lobby_id] = lobby

    return {
        "lobby": lobby.to_dict(),
        "your_token": host_token,
    }


@app.get("/lobby/{lobby_id}")
async def get_lobby(lobby_id: str):
    lobby = lobbies.get(lobby_id.upper())
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return {"lobby": lobby.to_dict()}


@app.post("/lobby/{lobby_id}/join")
async def join_lobby(lobby_id: str, req: LobbyJoinRequest):
    lobby = lobbies.get(lobby_id.upper())
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if lobby.status != "waiting":
        raise HTTPException(status_code=409, detail="Lobby already started")
    if len(lobby.members) >= lobby.max_players:
        raise HTTPException(status_code=409, detail="Lobby is full")

    token = uuid.uuid4().hex
    used_slots = {m.slot for m in lobby.members}
    slot = next((s for s in range(1, lobby.max_players + 1) if s not in used_slots), len(lobby.members) + 1)
    player_name = (req.name or "Player").strip()[:20] or f"Player{slot}"
    lobby.members.append(LobbyMember(token=token, name=player_name, slot=slot, is_host=False))

    return {
        "lobby": lobby.to_dict(),
        "your_token": token,
    }


@app.post("/lobby/{lobby_id}/start")
async def start_lobby(lobby_id: str, req: LobbyStartRequest):
    lobby = lobbies.get(lobby_id.upper())
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    host = lobby.host()
    if not host or req.host_token != host.token:
        raise HTTPException(status_code=403, detail="Only host can start")
    if lobby.status != "waiting":
        raise HTTPException(status_code=409, detail="Lobby already started")

    game_id, state = _create_game(lobby.seed, lobby.planet_count)
    lobby.status = "started"
    lobby.game_id = game_id

    sorted_members = sorted(lobby.members, key=lambda m: m.slot)
    factions_by_start_order = list(state.factions)
    if len(sorted_members) > len(factions_by_start_order):
        raise HTTPException(status_code=409, detail="Not enough factions for lobby size")

    assigned_faction_ids: set[str] = set()
    for member, faction in zip(sorted_members, factions_by_start_order):
        assigned_faction_ids.add(faction.id)
        faction.archetype = "player"
        faction.name = member.name
        faction.ai_timer = 0
        faction.credits = PLAYER_START_CREDITS

    for faction in state.factions:
        if faction.id not in assigned_faction_ids:
            faction.eliminated = True

    for planet in state.planets:
        if planet.owner and planet.owner not in assigned_faction_ids:
            planet.owner = None
            planet.buildings = []
            planet.build_queue = []
            planet.level = 1
        planet.explored_by = [fid for fid in planet.explored_by if fid == "neutral" or fid in assigned_faction_ids]

    state.ships = [s for s in state.ships if s.owner in assigned_faction_ids]
    state.ship_id_counter = len(state.ships)

    state.player_faction_id = factions_by_start_order[0].id

    game_access_tokens[game_id] = {m.token for m in lobby.members}
    game_players_by_token[game_id] = {
        m.token: {
            "name": m.name,
            "slot": m.slot,
            "faction_id": faction.id,
        }
        for m, faction in zip(sorted_members, factions_by_start_order)
    }

    return {
        "lobby": lobby.to_dict(),
        "game": {
            "game_id": game_id,
            "seed": state.seed,
            "planet_count": len(state.planets),
        },
    }


@app.get("/game/{game_id}/state")
async def get_state(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return serialize_state(games[game_id])


@app.post("/game/{game_id}/save")
async def save_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    state     = games[game_id]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename  = f"{game_id}_{timestamp}.json"
    (SAVES_DIR / filename).write_text(json.dumps(serialize_state(state), indent=2))
    return {"filename": filename, "saved_at": timestamp}


@app.get("/game/saves")
async def list_saves():
    saves = []
    for f in sorted(SAVES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text())
            saves.append({
                "filename": f.name,
                "game_id":  data.get("id"),
                "tick":     data.get("tick"),
                "seed":     data.get("seed"),
                "saved_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })
        except Exception:
            continue
    return saves


@app.post("/game/load/{filename}")
async def load_game(filename: str):
    path = SAVES_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Save file not found")
    state    = GameState.from_dict(json.loads(path.read_text()))
    new_id   = str(uuid.uuid4())[:8]
    state.id = new_id
    state.running = True
    games[new_id]       = state
    connections[new_id] = []
    connection_meta[new_id] = {}
    asyncio.create_task(game_loop(new_id))
    return {"game_id": new_id, "seed": state.seed, "tick": state.tick}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/{game_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str):
    if game_id not in games:
        await websocket.close(code=4004, reason="Game not found")
        return

    token = websocket.query_params.get("token")
    allowed_tokens = game_access_tokens.get(game_id)
    if allowed_tokens is not None and token not in allowed_tokens:
        await websocket.close(code=4401, reason="Unauthorized")
        return

    player_info = {}
    if token and game_players_by_token.get(game_id):
        player_info = game_players_by_token[game_id].get(token, {})

    await websocket.accept()
    connections[game_id].append(websocket)
    connection_meta.setdefault(game_id, {})[id(websocket)] = {
        "token": token,
        "name": player_info.get("name", "Guest"),
        "slot": player_info.get("slot"),
        "faction_id": player_info.get("faction_id", games[game_id].player_faction_id),
    }
    try:
        actor_info = connection_meta[game_id][id(websocket)]
        await websocket.send_json({
            "type": "welcome",
            "data": {
                "connected": True,
                "players_online": len(connections.get(game_id, [])),
                "you": actor_info,
            },
        })
        state_snapshot = serialize_state(games[game_id])
        state_snapshot["player_faction_id"] = actor_info.get("faction_id", games[game_id].player_faction_id)
        await websocket.send_json({"type": "state", "data": state_snapshot})
        async for message in websocket.iter_json():
            actor_faction_id = connection_meta.get(game_id, {}).get(id(websocket), {}).get("faction_id", games[game_id].player_faction_id)
            await handle_input(game_id, message, actor_faction_id)
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in connections.get(game_id, []):
            connections[game_id].remove(websocket)
        if id(websocket) in connection_meta.get(game_id, {}):
            connection_meta[game_id].pop(id(websocket), None)


# ── Input handling ────────────────────────────────────────────────────────────

async def handle_input(game_id: str, message: dict, actor_faction_id: str) -> None:
    state = games.get(game_id)
    if not state:
        return

    msg_type = message.get("type")
    ship_ids = set(message.get("ship_ids", []))
    ship_map = {s.id: s for s in state.ships}
    planet_map = {p.id: p for p in state.planets}

    if msg_type == "move":
        target = message.get("target", {})
        for sid in ship_ids:
            ship = ship_map.get(sid)
            if not ship or ship.owner != actor_faction_id:
                continue
            if "planet_id" in target:
                planet = planet_map.get(target["planet_id"])
                if planet:
                    ship.state         = "moving"
                    ship.target_planet = planet.id
                    ship.target_x      = float(planet.x)
                    ship.target_y      = float(planet.y)
                    ship.target_ship   = None
            elif "x" in target and "y" in target:
                ship.state         = "moving"
                ship.target_planet = None
                ship.target_x      = float(target["x"])
                ship.target_y      = float(target["y"])
                ship.target_ship   = None

    elif msg_type == "energy":
        level = max(0.1, min(1.0, float(message.get("level", 1.0))))
        for sid in ship_ids:
            ship = ship_map.get(sid)
            if ship and ship.owner == actor_faction_id:
                ship.energy_level = level

    elif msg_type == "stop":
        for sid in ship_ids:
            ship = ship_map.get(sid)
            if ship and ship.owner == actor_faction_id:
                ship.state     = "idle"
                ship.target_x  = None
                ship.target_y  = None
                ship.target_planet = None

    elif msg_type == "build":
        planet_id = message.get("planet_id")
        item_type = message.get("item_type")   # "building" or "ship"
        item_name = message.get("item_name")
        planet    = planet_map.get(planet_id)
        faction   = {f.id: f for f in state.factions}.get(actor_faction_id)
        if not planet or planet.owner != actor_faction_id or not faction:
            return
        queue_capacity = 2 + max(0, planet.level - 1)
        if len(planet.build_queue) >= queue_capacity:
            return
        if item_type == "building":
            cost = BUILDING_COSTS.get(item_name)
            if cost is None or item_name in planet.buildings:
                return
            min_level = BUILDING_LEVEL_REQ.get(item_name, 1)
            if planet.level < min_level:
                return
            if faction.credits < cost:
                return
            planet.build_queue.append({"type": "building", "name": item_name, "ticks_remaining": 100})
            faction.credits -= cost
        elif item_type == "ship":
            cost = SHIP_COSTS.get(item_name)
            if cost is None or "shipyard" not in planet.buildings:
                return
            if faction.credits < cost:
                return
            ticks = SHIP_BUILD_TICKS.get(item_name, 200)
            planet.build_queue.append({"type": "ship", "ship_type": item_name, "ticks_remaining": ticks, "total_ticks": ticks})
            faction.credits -= cost
        elif item_type == "level_up":
            if planet.level >= 5:
                return
            cost = LEVEL_UP_COSTS.get(planet.level)
            if cost is None or faction.credits < cost:
                return
            if any(q.get("type") == "level_up" for q in planet.build_queue):
                return
            ticks = LEVEL_UP_TICKS[planet.level]
            planet.build_queue.append({"type": "level_up", "ticks_remaining": ticks, "total_ticks": ticks})
            faction.credits -= cost


# ── Game loop ─────────────────────────────────────────────────────────────────

async def game_loop(game_id: str) -> None:
    tick_interval = 1.0 / TICK_RATE
    loop = asyncio.get_event_loop()

    # Diagnostics
    _diag_ticks = 0
    _diag_last  = loop.time()

    while game_id in games:
        tick_start = loop.time()
        state = games[game_id]

        if not state.running:
            await asyncio.sleep(tick_interval)
            continue

        state.tick       += 1
        state.tick_events = []   # clear per-tick events

        planet_map  = {p.id: p for p in state.planets}
        ship_map    = {s.id: s for s in state.ships}
        faction_map = {f.id: f for f in state.factions}

        physics_tick(state.ships, state.planets, planet_map)
        simulation_tick(state, planet_map, ship_map, faction_map)
        combat_tick(state, planet_map, ship_map, faction_map)
        ai_tick(state, planet_map, ship_map, faction_map)

        delta = serialize_delta(state)
        payload = {
            "type": "tick",
            "data": delta,
            "players_online": len(connections.get(game_id, [])),
        }
        dead_connections = []

        active_connections = list(connections.get(game_id, []))
        if active_connections:
            results = await asyncio.gather(
                *(ws.send_json(payload) for ws in active_connections),
                return_exceptions=True,
            )
            for ws, result in zip(active_connections, results):
                if isinstance(result, Exception):
                    dead_connections.append(ws)

        for ws in dead_connections:
            if ws in connections.get(game_id, []):
                connections[game_id].remove(ws)

        # ── Diagnostics: log actual tick rate once per second ─────────────────
        if TICK_DIAGNOSTICS:
            _diag_ticks += 1
            now = loop.time()
            if now - _diag_last >= 1.0:
                elapsed_ms = (now - tick_start) * 1000
                print(f"[game {game_id}] tick rate: {_diag_ticks}/s  last tick: {elapsed_ms:.1f}ms")
                _diag_ticks = 0
                _diag_last  = now

        # Sleep only for the remaining time in the tick window
        elapsed   = loop.time() - tick_start
        sleep_for = max(0.0, tick_interval - elapsed)
        await asyncio.sleep(sleep_for)

    connections.pop(game_id, None)
    connection_meta.pop(game_id, None)
