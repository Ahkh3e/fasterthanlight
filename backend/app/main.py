import asyncio
import json
import os
import uuid
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
from game.config import BUILDING_COSTS, SHIP_COSTS, BUILDING_LEVEL_REQ, LEVEL_UP_COSTS, LEVEL_UP_TICKS, SHIP_BUILD_TICKS

app = FastAPI(title="Faster Than Light")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TICK_RATE = int(os.getenv("GAME_TICK_RATE", "20"))
SAVES_DIR = Path("saves")
SAVES_DIR.mkdir(exist_ok=True)

games:       dict[str, GameState]      = {}
connections: dict[str, list[WebSocket]] = {}


# ── Request models ────────────────────────────────────────────────────────────

class NewGameRequest(BaseModel):
    seed:         Optional[int] = None
    planet_count: Optional[int] = 120


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.post("/game/new")
async def new_game(req: NewGameRequest):
    game_id = str(uuid.uuid4())[:8]
    seed    = req.seed if req.seed is not None else int(uuid.uuid4().int % 1_000_000)
    state   = GameState.create(game_id=game_id, seed=seed, planet_count=req.planet_count or 120)
    games[game_id]       = state
    connections[game_id] = []
    asyncio.create_task(game_loop(game_id))
    return {
        "game_id": game_id,
        "seed": state.seed,
        "planet_count": len(state.planets),
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
    asyncio.create_task(game_loop(new_id))
    return {"game_id": new_id, "seed": state.seed, "tick": state.tick}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/{game_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str):
    if game_id not in games:
        await websocket.close(code=4004, reason="Game not found")
        return

    await websocket.accept()
    connections[game_id].append(websocket)
    try:
        await websocket.send_json({"type": "state", "data": serialize_state(games[game_id])})
        async for message in websocket.iter_json():
            await handle_input(game_id, message)
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in connections.get(game_id, []):
            connections[game_id].remove(websocket)


# ── Input handling ────────────────────────────────────────────────────────────

async def handle_input(game_id: str, message: dict) -> None:
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
            if not ship or ship.owner != "player":
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
            if ship and ship.owner == "player":
                ship.energy_level = level

    elif msg_type == "stop":
        for sid in ship_ids:
            ship = ship_map.get(sid)
            if ship and ship.owner == "player":
                ship.state     = "idle"
                ship.target_x  = None
                ship.target_y  = None
                ship.target_planet = None

    elif msg_type == "build":
        planet_id = message.get("planet_id")
        item_type = message.get("item_type")   # "building" or "ship"
        item_name = message.get("item_name")
        planet    = planet_map.get(planet_id)
        faction   = {f.id: f for f in state.factions}.get("player")
        if not planet or planet.owner != "player" or not faction:
            return
        if len(planet.build_queue) >= 2:
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

        delta             = serialize_delta(state)
        dead_connections  = []

        for ws in connections.get(game_id, []):
            try:
                await ws.send_json({"type": "tick", "data": delta})
            except Exception:
                dead_connections.append(ws)

        for ws in dead_connections:
            if ws in connections.get(game_id, []):
                connections[game_id].remove(ws)

        # ── Diagnostics: log actual tick rate once per second ─────────────────
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
