import asyncio
import json
import logging
import math
import os
import time
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
from game.config import BUILDING_COSTS, SHIP_COSTS, BUILDING_LEVEL_REQ, LEVEL_UP_COSTS, LEVEL_UP_TICKS, SHIP_BUILD_TICKS, SHIP_TIER_REQ, PLAYER_START_CREDITS, PVP_PLAYER_COLOURS, FLEET_UPGRADES, SHIP_STATS, TECH_BONUSES, MOTHERSHIP_UPGRADES
from game.state import Ship

logger = logging.getLogger("ftl")

app = FastAPI(title="Faster Than Light")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TICK_RATE = int(os.getenv("GAME_TICK_RATE", "20"))
TICK_DIAGNOSTICS = os.getenv("GAME_TICK_DIAGNOSTICS", "0") == "1"
GAME_IDLE_PAUSE_SECONDS = int(os.getenv("GAME_IDLE_PAUSE_SECONDS", "15"))
GAME_IDLE_EXPIRE_SECONDS = int(os.getenv("GAME_IDLE_EXPIRE_SECONDS", "1800"))
GAME_FINISHED_LINGER_SECONDS = int(os.getenv("GAME_FINISHED_LINGER_SECONDS", "120"))  # cleanup finished games after 2 min
LOBBY_EXPIRE_SECONDS = int(os.getenv("LOBBY_EXPIRE_SECONDS", "600"))  # cleanup stale lobbies after 10 min
SAVES_DIR = Path("saves")
SAVES_DIR.mkdir(exist_ok=True)

games:       dict[str, GameState]      = {}
connections: dict[str, list[WebSocket]] = {}
connection_meta: dict[str, dict[int, dict]] = {}
game_created_at: dict[str, float] = {}       # monotonic time when game was created
game_finished_at: dict[str, float] = {}      # monotonic time when game ended (won/lost)

lobbies: dict[str, "Lobby"] = {}
lobby_created_at: dict[str, float] = {}      # monotonic time when lobby was created
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
    dev_start:    bool = False


class LobbyCreateRequest(BaseModel):
    seed: Optional[int] = None
    planet_count: Optional[int] = 120
    max_players: int = 6
    host_name: str = "Host"


class LobbyJoinRequest(BaseModel):
    name: str = "Player"


class LobbyStartRequest(BaseModel):
    host_token: str


def _apply_dev_start(state: GameState) -> None:
    # Dev solo preset: max tech tier + large starting economy for player factions
    for faction in state.factions:
        if faction.archetype != "player":
            continue
        faction.tech_tier = 3
        faction.research_points = max(faction.research_points, 5000.0)
        faction.credits = 10000.0
        faction.storage_capacity = max(faction.storage_capacity, 10000.0)


def _create_game(seed: Optional[int], planet_count: Optional[int], dev_start: bool = False) -> tuple[str, GameState]:
    game_id = str(uuid.uuid4())[:8]
    game_seed = seed if seed is not None else int(uuid.uuid4().int % 1_000_000)
    state = GameState.create(game_id=game_id, seed=game_seed, planet_count=planet_count or 120)
    state.dev_mode = bool(dev_start)
    if dev_start:
        _apply_dev_start(state)
    games[game_id] = state
    connections[game_id] = []
    connection_meta[game_id] = {}
    game_created_at[game_id] = asyncio.get_event_loop().time()
    asyncio.create_task(game_loop(game_id))
    logger.info(f"Game {game_id} created (seed={game_seed}, planets={planet_count or 120}, active_games={len(games)})")
    return game_id, state


def _cleanup_game(game_id: str) -> None:
    """Remove all state associated with a game."""
    games.pop(game_id, None)
    connections.pop(game_id, None)
    connection_meta.pop(game_id, None)
    game_access_tokens.pop(game_id, None)
    game_players_by_token.pop(game_id, None)
    game_created_at.pop(game_id, None)
    game_finished_at.pop(game_id, None)
    logger.info(f"Game {game_id} cleaned up (active_games={len(games)})")


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.post("/game/new")
async def new_game(req: NewGameRequest):
    game_id, state = _create_game(req.seed, req.planet_count, req.dev_start)
    return {
        "game_id": game_id,
        "seed": state.seed,
        "planet_count": len(state.planets),
        "dev_start": req.dev_start,
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
    lobby_created_at[lobby_id] = asyncio.get_event_loop().time()

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

    # Scale planet count by number of players so the map grows with lobby size
    num_players = len(lobby.members)
    scaled_planet_count = 15 * num_players

    game_id, state = _create_game(lobby.seed, scaled_planet_count)
    lobby.status = "started"
    lobby.game_id = game_id

    sorted_members = sorted(lobby.members, key=lambda m: m.slot)
    factions_by_start_order = list(state.factions)
    if len(sorted_members) > len(factions_by_start_order):
        raise HTTPException(status_code=409, detail="Not enough factions for lobby size")

    assigned_faction_ids: set[str] = set()
    for idx, (member, faction) in enumerate(zip(sorted_members, factions_by_start_order)):
        assigned_faction_ids.add(faction.id)
        faction.archetype = "player"
        faction.name = member.name
        faction.ai_timer = 0
        faction.credits = PLAYER_START_CREDITS
        # Assign unique colour per PvP player
        faction.colour = PVP_PLAYER_COLOURS[idx % len(PVP_PLAYER_COLOURS)]

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
    dev_mode = bool(getattr(state, "dev_mode", False))

    msg_type = message.get("type")
    raw_ship_ids = message.get("ship_ids", [])
    ship_ids = set(raw_ship_ids)
    ship_map = {s.id: s for s in state.ships}
    planet_map = {p.id: p for p in state.planets}

    if msg_type == "move":
        target = message.get("target", {})
        ordered_ships = []
        for sid in sorted(raw_ship_ids):
            ship = ship_map.get(sid)
            if ship and ship.owner == actor_faction_id:
                ordered_ships.append(ship)

        if "planet_id" in target:
            planet = planet_map.get(target["planet_id"])
            if planet:
                for ship in ordered_ships:
                    ship.state         = "moving"
                    ship.target_planet = planet.id
                    ship.target_x      = float(planet.x)
                    ship.target_y      = float(planet.y)
                    ship.target_ship   = None
            return
        if "ship_id" in target:
            target_ship = ship_map.get(target["ship_id"])
            if target_ship and target_ship.owner == actor_faction_id and target_ship.type == "mothership":
                for ship in ordered_ships:
                    if ship.id == target_ship.id:
                        continue
                    if ship.type == "mothership":
                        continue  # motherships cannot follow other motherships
                    ship.state         = "moving"
                    ship.target_planet = None
                    ship.target_ship   = target_ship.id
                    ship.target_x      = float(target_ship.x)
                    ship.target_y      = float(target_ship.y)
            return
        elif "x" in target and "y" in target:
            tx = float(target["x"])
            ty = float(target["y"])

            def _formation_offsets(count: int, spacing: float = 26.0) -> list[tuple[float, float]]:
                if count <= 0:
                    return []
                offsets = [(0.0, 0.0)]
                ring = 1
                while len(offsets) < count:
                    slots = max(6 * ring, 1)
                    radius = spacing * ring
                    for i in range(slots):
                        if len(offsets) >= count:
                            break
                        angle = (2.0 * math.pi * i) / slots
                        offsets.append((
                            round(math.cos(angle) * radius, 2),
                            round(math.sin(angle) * radius, 2),
                        ))
                    ring += 1
                return offsets

            offsets = _formation_offsets(len(ordered_ships))
            for idx, ship in enumerate(ordered_ships):
                ox, oy = offsets[idx] if idx < len(offsets) else (0.0, 0.0)
                ship.state         = "moving"
                ship.target_planet = None
                ship.target_x      = tx + ox
                ship.target_y      = ty + oy
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
        if not dev_mode and len(planet.build_queue) >= queue_capacity:
            return
        if item_type == "building":
            cost = BUILDING_COSTS.get(item_name)
            if cost is None or item_name in planet.buildings:
                return
            min_level = BUILDING_LEVEL_REQ.get(item_name, 1)
            if not dev_mode and planet.level < min_level:
                return
            if not dev_mode and faction.credits < cost:
                return
            build_ticks = 0 if dev_mode else 100
            planet.build_queue.append({"type": "building", "name": item_name, "ticks_remaining": build_ticks, "total_ticks": max(1, build_ticks)})
            if not dev_mode:
                faction.credits -= cost
        elif item_type == "ship":
            cost = SHIP_COSTS.get(item_name)
            if cost is None:
                return
            if not dev_mode and "shipyard" not in planet.buildings:
                return
            min_tier = SHIP_TIER_REQ.get(item_name, 1)
            if not dev_mode and faction.tech_tier < min_tier:
                return
            if not dev_mode and faction.credits < cost:
                return
            ticks = 0 if dev_mode else SHIP_BUILD_TICKS.get(item_name, 200)
            planet.build_queue.append({"type": "ship", "ship_type": item_name, "ticks_remaining": ticks, "total_ticks": ticks})
            if not dev_mode:
                faction.credits -= cost
        elif item_type == "level_up":
            if planet.level >= 5:
                return
            cost = LEVEL_UP_COSTS.get(planet.level)
            if cost is None:
                return
            if not dev_mode and faction.credits < cost:
                return
            if not dev_mode and any(q.get("type") == "level_up" for q in planet.build_queue):
                return
            ticks = 0 if dev_mode else LEVEL_UP_TICKS[planet.level]
            planet.build_queue.append({"type": "level_up", "ticks_remaining": ticks, "total_ticks": ticks})
            if not dev_mode:
                faction.credits -= cost

    elif msg_type == "fleet_upgrade":
        upgrade_type = message.get("upgrade_type")  # "speed"|"health"|"damage"
        spec = FLEET_UPGRADES.get(upgrade_type)
        faction = {f.id: f for f in state.factions}.get(actor_faction_id)
        if not spec or not faction:
            return
        current_level = faction.fleet_upgrades.get(upgrade_type, 0)
        if current_level >= spec["max_level"]:
            return
        cost = round(spec["cost_base"] * (spec["cost_scale"] ** current_level))
        if not dev_mode and faction.credits < cost:
            return
        if not dev_mode:
            faction.credits -= cost
        faction.fleet_upgrades[upgrade_type] = current_level + 1

    elif msg_type == "mothership_upgrade":
        ship_id = message.get("ship_id")
        requested_upgrade_type = message.get("upgrade_type")
        mothership = ship_map.get(ship_id)
        faction = {f.id: f for f in state.factions}.get(actor_faction_id)
        if not mothership or mothership.owner != actor_faction_id or mothership.type != "mothership" or not faction:
            return

        alias = {
            "launch_bays": "level",
            "assembly": "shipyard",
        }
        upgrade_type = alias.get(requested_upgrade_type, requested_upgrade_type)
        spec = MOTHERSHIP_UPGRADES.get(upgrade_type)
        if not spec:
            return

        upgrades = getattr(mothership, "mothership_upgrades", None) or {"launch_bays": 0, "assembly": 0, "shipyard": 0}
        if upgrade_type == "level":
            current_level = max(1, int(getattr(mothership, "mothership_level", 1)))
            if current_level >= spec["max_level"]:
                return
            cost = round(spec["cost_base"] * (spec["cost_scale"] ** (current_level - 1)))
            if not dev_mode and faction.credits < cost:
                return
            if not dev_mode:
                faction.credits -= cost
            mothership.mothership_level = current_level + 1
            upgrades["launch_bays"] = max(0, mothership.mothership_level - 1)
            mothership.mothership_upgrades = upgrades
            return

        current = int(upgrades.get("shipyard", upgrades.get("assembly", 0)))
        if current >= spec["max_level"]:
            return
        cost = round(spec["cost_base"] * (spec["cost_scale"] ** current))
        if not dev_mode and faction.credits < cost:
            return
        if not dev_mode:
            faction.credits -= cost
        upgrades["shipyard"] = current + 1
        upgrades["assembly"] = current + 1  # keep backward compatibility with older UI/state
        mothership.mothership_upgrades = upgrades

    elif msg_type == "mothership_buy_fleet":
        ship_id = message.get("ship_id")
        ship_type = message.get("ship_type", "fighter")
        count = max(1, min(8, int(message.get("count", 3))))
        mothership = ship_map.get(ship_id)
        faction = {f.id: f for f in state.factions}.get(actor_faction_id)
        if not mothership or mothership.owner != actor_faction_id or mothership.type != "mothership" or not faction:
            return
        if ship_type not in SHIP_STATS or ship_type == "mothership":
            return

        unit_cost = SHIP_COSTS.get(ship_type)
        if unit_cost is None:
            return
        ms_upgrades = getattr(mothership, "mothership_upgrades", None) or {}
        shipyard_level = int(ms_upgrades.get("shipyard", ms_upgrades.get("assembly", 0)))
        extra_per_level = int(MOTHERSHIP_UPGRADES["shipyard"].get("extra_fleet_per_level", 1))
        total_spawn_count = min(24, count + shipyard_level * extra_per_level)

        total_cost = unit_cost * count
        if not dev_mode and faction.credits < total_cost:
            return
        if not dev_mode:
            faction.credits -= total_cost

        stats = SHIP_STATS[ship_type]
        tier = faction.tech_tier if faction else 1
        bonus = TECH_BONUSES.get(tier, TECH_BONUSES[1])
        fu = faction.fleet_upgrades if faction else {}
        hp_mult = bonus["hp"] * (1.0 + fu.get("health", 0) * FLEET_UPGRADES["health"]["bonus_per_level"])
        hp = round(float(stats["hp"]) * hp_mult, 1)
        speed_mult = round(bonus["speed"] * (1.0 + fu.get("speed", 0) * FLEET_UPGRADES["speed"]["bonus_per_level"]), 4)
        damage_mult = round(bonus["damage"] * (1.0 + fu.get("damage", 0) * FLEET_UPGRADES["damage"]["bonus_per_level"]), 4)
        base_angle = (state.tick % 360) * (math.pi / 180.0)
        existing = sum(1 for s in state.ships if s.state == "orbiting" and s.target_ship == mothership.id)
        mothership_mode = getattr(mothership, "mothership_mode", "orbit")
        for i in range(total_spawn_count):
            idx = existing + i
            ring = idx // 8
            slot = idx % 8
            radius = 36.0 + ring * 12.0
            angle = base_angle + (slot / 8.0) * (2.0 * math.pi)
            state.ship_id_counter += 1
            new_ship = Ship(
                id=f"s-{state.ship_id_counter:04d}",
                type=ship_type,
                owner=actor_faction_id,
                x=round(mothership.x + math.cos(angle) * radius, 2),
                y=round(mothership.y + math.sin(angle) * radius, 2),
                health=hp,
                max_health=hp,
                state="moving" if mothership_mode == "formation" else "orbiting",
                target_planet=None,
                target_ship=mothership.id,
                orbit_angle=angle,
                orbit_radius=radius,
                target_x=float(mothership.x),
                target_y=float(mothership.y),
                speed_mult=speed_mult,
                damage_mult=damage_mult,
            )
            state.ships.append(new_ship)
            faction.ships_built += 1
            faction.ships_built_by_type[ship_type] = faction.ships_built_by_type.get(ship_type, 0) + 1
            state.tick_events.append({
                "type": "ship_spawned",
                "ship": {
                    "id": new_ship.id,
                    "type": new_ship.type,
                    "owner": new_ship.owner,
                    "x": new_ship.x,
                    "y": new_ship.y,
                    "vx": 0.0,
                    "vy": 0.0,
                    "health": new_ship.health,
                    "max_health": new_ship.max_health,
                    "state": new_ship.state,
                    "target_planet": new_ship.target_planet,
                    "target_ship": new_ship.target_ship,
                    "orbit_angle": new_ship.orbit_angle,
                    "orbit_radius": new_ship.orbit_radius,
                    "target_x": None,
                    "target_y": None,
                    "fuel": 1.0,
                    "energy_level": 1.0,
                    "rogue": False,
                    "mothership_level": getattr(new_ship, "mothership_level", 1),
                    "mothership_mode": getattr(new_ship, "mothership_mode", "orbit"),
                    "mothership_upgrades": dict(getattr(new_ship, "mothership_upgrades", {})),
                },
            })

    elif msg_type == "mothership_mode":
        ship_id = message.get("ship_id")
        mode = str(message.get("mode", "orbit")).lower()
        if mode not in ("orbit", "formation"):
            return
        mothership = ship_map.get(ship_id)
        if not mothership or mothership.owner != actor_faction_id or mothership.type != "mothership":
            return
        mothership.mothership_mode = mode

        # Reconfigure existing followers for this mothership based on mode
        followers = [s for s in state.ships if s.owner == actor_faction_id and s.target_ship == mothership.id and s.id != mothership.id]
        for follower in followers:
            if mode == "orbit":
                follower.state = "moving"
                follower.target_planet = None
                follower.target_x = float(mothership.x)
                follower.target_y = float(mothership.y)
            else:
                follower.state = "moving"
                follower.target_planet = None
                follower.target_x = float(mothership.x)
                follower.target_y = float(mothership.y)

    elif msg_type == "mothership_follow":
        mothership_id = message.get("ship_id")
        follower_ids = message.get("follower_ids", [])
        mothership = ship_map.get(mothership_id)
        if not mothership or mothership.owner != actor_faction_id or mothership.type != "mothership":
            return

        mode = getattr(mothership, "mothership_mode", "orbit")
        for sid in follower_ids:
            follower = ship_map.get(sid)
            if not follower or follower.owner != actor_faction_id:
                continue
            if follower.id == mothership.id:
                continue
            if follower.type == "mothership":
                continue  # motherships cannot follow other motherships
            follower.target_planet = None
            follower.target_ship = mothership.id
            follower.state = "moving" if mode in ("orbit", "formation") else "moving"
            follower.target_x = float(mothership.x)
            follower.target_y = float(mothership.y)

    elif msg_type == "mothership_unfollow":
        mothership_id = message.get("ship_id")
        follower_ids = message.get("follower_ids", [])
        mothership = ship_map.get(mothership_id)
        if not mothership or mothership.owner != actor_faction_id or mothership.type != "mothership":
            return

        for sid in follower_ids:
            follower = ship_map.get(sid)
            if not follower or follower.owner != actor_faction_id:
                continue
            if follower.target_ship != mothership.id:
                continue
            follower.target_ship = None
            follower.target_planet = None
            follower.target_x = None
            follower.target_y = None
            follower.vx = 0.0
            follower.vy = 0.0
            follower.state = "idle"

    elif msg_type == "end_game":
        # Player voluntarily ends their session (forfeit / surrender)
        faction_map_local = {f.id: f for f in state.factions}
        faction = faction_map_local.get(actor_faction_id)
        if not faction or faction.eliminated:
            return

        human_factions = [f for f in state.factions if f.archetype == "player"]
        pvp_mode = len(human_factions) > 1

        def _build_pvp_summary():
            """Build per-player stats summary for end-game screen."""
            planet_counts = {}
            for p in state.planets:
                if p.owner:
                    planet_counts[p.owner] = planet_counts.get(p.owner, 0) + 1
            ship_counts = {}
            ship_type_counts = {}
            for s in state.ships:
                if s.owner:
                    ship_counts[s.owner] = ship_counts.get(s.owner, 0) + 1
                    tc = ship_type_counts.setdefault(s.owner, {})
                    tc[s.type] = tc.get(s.type, 0) + 1
            return [{
                "faction_id": f.id,
                "name": f.name,
                "colour": f.colour,
                "kills": f.kills,
                "deaths": f.deaths,
                "ships_alive": ship_counts.get(f.id, 0),
                "ships_by_type": ship_type_counts.get(f.id, {}),
                "ships_built": f.ships_built,
                "ships_built_by_type": dict(f.ships_built_by_type),
                "planets": planet_counts.get(f.id, 0),
                "eliminated": f.eliminated,
            } for f in human_factions]

        # Mark the player as eliminated
        faction.eliminated = True
        state.tick_events.append({
            "type": "faction_eliminated",
            "faction_id": actor_faction_id,
        })

        if pvp_mode:
            # PvP: check if only one human remains → they win
            alive_humans = [f for f in human_factions if not f.eliminated]
            if len(alive_humans) <= 1:
                state.status = "won"
                winner_id = alive_humans[0].id if alive_humans else None
                state.tick_events.append({
                    "type": "game_over",
                    "result": "win",
                    "winner_faction_id": winner_id,
                    "mode": "pvp",
                    "summary": _build_pvp_summary(),
                })
            else:
                # Notify the surrendering player directly
                state.tick_events.append({
                    "type": "game_over",
                    "result": "loss",
                    "winner_faction_id": None,
                    "mode": "pvp",
                    "forfeiter": actor_faction_id,
                    "summary": _build_pvp_summary(),
                })
        else:
            # Solo: immediate loss
            state.status = "lost"
            state.tick_events.append({
                "type": "game_over",
                "result": "loss",
                "winner_faction_id": None,
                "mode": "singleplayer",
            })


# ── Game loop ─────────────────────────────────────────────────────────────────

async def game_loop(game_id: str) -> None:
    tick_interval = 1.0 / TICK_RATE
    loop = asyncio.get_event_loop()
    next_tick_at = loop.time()
    prev_loop_started_at = next_tick_at

    # Diagnostics
    _diag_ticks = 0
    _diag_last  = loop.time()
    _last_connection_seen = loop.time()
    _idle_escalation = 0  # tracks how long idle, for progressive sleep

    while game_id in games:
        tick_start = loop.time()
        loop_interval_ms = (tick_start - prev_loop_started_at) * 1000.0
        prev_loop_started_at = tick_start
        state = games[game_id]

        online_count = len(connections.get(game_id, []))
        if online_count > 0:
            _last_connection_seen = tick_start
            _idle_escalation = 0
        else:
            idle_for = tick_start - _last_connection_seen
            if idle_for >= GAME_IDLE_EXPIRE_SECONDS:
                logger.info(f"Game {game_id} expired after {idle_for:.0f}s idle")
                _cleanup_game(game_id)
                return
            if idle_for >= GAME_IDLE_PAUSE_SECONDS:
                # Progressive sleep: ramp from 0.25s to 2s as idle time grows
                _idle_escalation = min(idle_for - GAME_IDLE_PAUSE_SECONDS, 60.0)
                sleep_time = min(2.0, 0.25 + _idle_escalation * 0.03)
                await asyncio.sleep(sleep_time)
                continue

        # Finished games: stop ticking but keep alive briefly for end-screen
        if state.status in ("won", "lost"):
            if game_id not in game_finished_at:
                game_finished_at[game_id] = tick_start
                logger.info(f"Game {game_id} finished with status '{state.status}'")
                # Broadcast one final delta so clients receive pending game_over events
                if state.tick_events:
                    final_delta = serialize_delta(state)
                    final_payload = json.dumps({
                        "type": "tick",
                        "data": final_delta,
                        "players_online": online_count,
                    })
                    for ws in list(connections.get(game_id, [])):
                        try:
                            await ws.send_text(final_payload)
                        except Exception:
                            pass
                    state.tick_events = []
            finished_for = tick_start - game_finished_at[game_id]
            if finished_for >= GAME_FINISHED_LINGER_SECONDS and online_count == 0:
                logger.info(f"Game {game_id} cleanup after finish + {finished_for:.0f}s linger")
                _cleanup_game(game_id)
                return
            # Don't tick, just keep connection alive for end-screen
            await asyncio.sleep(0.5)
            continue

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

        # AI runs infrequently; skip map rebuilds when not needed
        ai_tick(state, planet_map, ship_map, faction_map)

        delta = serialize_delta(state)
        payload = {
            "type": "tick",
            "data": delta,
            "players_online": online_count,
        }
        dead_connections = []

        active_connections = list(connections.get(game_id, []))
        if active_connections:
            # Encode JSON once; send pre-encoded text to all clients
            payload_text = json.dumps(payload)
            results = await asyncio.gather(
                *(ws.send_text(payload_text) for ws in active_connections),
                return_exceptions=True,
            )
            for ws, result in zip(active_connections, results):
                if isinstance(result, Exception):
                    dead_connections.append(ws)

        for ws in dead_connections:
            if ws in connections.get(game_id, []):
                connections[game_id].remove(ws)

        # ── Diagnostics: log actual tick rate once per second ─────────────────
        work_ms = (loop.time() - tick_start) * 1000.0

        if TICK_DIAGNOSTICS:
            _diag_ticks += 1
            now = loop.time()
            if now - _diag_last >= 1.0:
                lag_ms = max(0.0, (now - next_tick_at) * 1000.0)
                print(
                    f"[game {game_id}] rate: {_diag_ticks}/s  "
                    f"work: {work_ms:.1f}ms  loop: {loop_interval_ms:.1f}ms  lag: {lag_ms:.1f}ms"
                )
                _diag_ticks = 0
                _diag_last  = now

        # Fixed-step scheduler: keep stable cadence and avoid drift.
        next_tick_at += tick_interval
        now = loop.time()
        if next_tick_at < now - tick_interval:
            # If we're more than one tick late, resync to current time.
            next_tick_at = now
        sleep_for = max(0.0, next_tick_at - now)
        await asyncio.sleep(sleep_for)

    connections.pop(game_id, None)
    connection_meta.pop(game_id, None)


# ── Periodic cleanup task ─────────────────────────────────────────────────────

async def _cleanup_stale_lobbies() -> None:
    """Runs every 30s. Removes lobbies that haven't started within LOBBY_EXPIRE_SECONDS."""
    while True:
        await asyncio.sleep(30)
        now = asyncio.get_event_loop().time()
        stale = [
            lid for lid, lobby in lobbies.items()
            if lobby.status == "waiting"
            and now - lobby_created_at.get(lid, now) >= LOBBY_EXPIRE_SECONDS
        ]
        for lid in stale:
            lobbies.pop(lid, None)
            lobby_created_at.pop(lid, None)
            logger.info(f"Lobby {lid} expired (stale)")

        # Also clean up started lobbies whose game no longer exists
        started_stale = [
            lid for lid, lobby in lobbies.items()
            if lobby.status == "started"
            and lobby.game_id
            and lobby.game_id not in games
        ]
        for lid in started_stale:
            lobbies.pop(lid, None)
            lobby_created_at.pop(lid, None)


@app.on_event("startup")
async def _start_cleanup_tasks():
    asyncio.create_task(_cleanup_stale_lobbies())
    logger.info("Session cleanup task started")


# ── Admin / status endpoint ──────────────────────────────────────────────────

@app.get("/admin/status")
async def admin_status():
    """Overview of all active games, connections, and lobbies."""
    now = asyncio.get_event_loop().time()
    game_list = []
    for gid, state in games.items():
        conns = connections.get(gid, [])
        created = game_created_at.get(gid, now)
        finished = game_finished_at.get(gid)
        game_list.append({
            "game_id": gid,
            "tick": state.tick,
            "status": state.status,
            "running": state.running,
            "players_online": len(conns),
            "ships": len(state.ships),
            "planets": len(state.planets),
            "factions_alive": sum(1 for f in state.factions if not f.eliminated),
            "uptime_s": round(now - created, 1),
            "finished_at_s_ago": round(now - finished, 1) if finished else None,
        })

    lobby_list = []
    for lid, lobby in lobbies.items():
        created = lobby_created_at.get(lid, now)
        lobby_list.append({
            "lobby_id": lid,
            "status": lobby.status,
            "players": len(lobby.members),
            "max_players": lobby.max_players,
            "game_id": lobby.game_id,
            "age_s": round(now - created, 1),
        })

    return {
        "active_games": len(games),
        "total_connections": sum(len(c) for c in connections.values()),
        "active_lobbies": len(lobbies),
        "games": game_list,
        "lobbies": lobby_list,
    }