from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Planet:
    id: str
    name: str
    x: float
    y: float
    radius: float
    owner: Optional[str]        # faction_id or None (neutral)
    resource_type: str          # "minerals" | "energy" | "rare"
    resource_rate: float        # units per tick
    population: int
    defense: float              # 0.0–1.0 damage reduction for defenders
    buildings: list             # list[str] — building type names present
    build_queue: list           # list[dict] — {type, ticks_remaining}
    level: int                  # 1–5
    explored_by: list           # list[str] — faction IDs that have scouted this planet
    lanes: list                 # list[str] — planet IDs this connects to
    ships: list                 # list[str] — ship IDs currently orbiting
    conquest_checks: int = 0    # consecutive dominance checks (for conquest threshold)


@dataclass
class Faction:
    id: str
    name: str
    archetype: str              # "player" | "expansionist" | "defensive" | "opportunistic"
    home_planet: str
    colour: str
    credits: float = 500.0      # Unified currency replacing minerals/energy/rare
    research_points: float = 0.0
    tech_tier: int = 1
    eliminated: bool = False
    ai_timer: int = 0           # ticks until next AI decision
    aggression: float = 0.5     # 0.0–1.0, scales over time
    
    # Economic tracking
    storage_capacity: float = 1000.0  # Maximum credits that can be stored
    income_history: list = field(default_factory=list)  # Last 60 income values
    expense_history: list = field(default_factory=list)  # Last 60 expense values
    fleet_upgrades: dict = field(default_factory=lambda: {"speed": 0, "health": 0, "damage": 0})
    # PvP stats tracking
    kills: int = 0
    deaths: int = 0
    ships_built: int = 0
    ships_built_by_type: dict = field(default_factory=dict)


@dataclass
class Ship:
    id: str
    type: str
    owner: str
    x: float
    y: float
    vx: float = 0.0
    vy: float = 0.0
    health: float = 0.0
    max_health: float = 0.0
    state: str = "orbiting"     # "orbiting"|"moving"|"attacking"|"retreating"
    target_planet: Optional[str] = None
    target_ship: Optional[str] = None
    orbit_angle: float = 0.0
    orbit_radius: float = 0.0
    target_x: Optional[float] = None   # free-space move destination
    target_y: Optional[float] = None
    fuel: float = 1.0
    energy_level: float = 1.0
    fire_timer: int = 0
    rogue: bool = False
    spawn_timer: int = 0  # mothership: ticks until next fighter spawn
    speed_mult: float = 1.0   # fleet upgrade multiplier (applied at spawn)
    damage_mult: float = 1.0  # fleet upgrade multiplier (applied at spawn)
    mothership_level: int = 1
    mothership_mode: str = "orbit"  # mothership follower behavior: orbit|formation
    mothership_upgrades: dict = field(default_factory=lambda: {"launch_bays": 0, "assembly": 0})


@dataclass
class GameState:
    id: str
    seed: int
    dev_mode: bool = False
    tick: int = 0
    running: bool = True
    status: str = "running"     # "running" | "won" | "lost"
    player_faction_id: str = "player"
    planets: list = field(default_factory=list)     # list[Planet]
    ships: list = field(default_factory=list)       # list[Ship]
    factions: list = field(default_factory=list)    # list[Faction]
    ship_id_counter: int = 0                        # monotonic counter for new ship IDs
    tick_events: list = field(default_factory=list) # cleared each tick; not persisted

    @classmethod
    def create(cls, game_id: str, seed: int, planet_count: int = 120) -> "GameState":
        from game.galaxy import generate
        planets, ships, factions = generate(seed=seed, planet_count=planet_count)
        return cls(
            id=game_id,
            seed=seed,
            planets=planets,
            ships=ships,
            factions=factions,
            ship_id_counter=len(ships),
        )

    @classmethod
    def from_dict(cls, data: dict) -> "GameState":
        ships = [_ship_from_dict(s) for s in data.get("ships", [])]
        return cls(
            id=data["id"],
            seed=data["seed"],
            dev_mode=data.get("dev_mode", False),
            tick=data.get("tick", 0),
            running=data.get("running", True),
            status=data.get("status", "running"),
            player_faction_id=data.get("player_faction_id", "player"),
            planets=[_planet_from_dict(p) for p in data.get("planets", [])],
            ships=ships,
            factions=[_faction_from_dict(f) for f in data.get("factions", [])],
            ship_id_counter=data.get("ship_id_counter", len(ships)),
        )


# ── Deserialisation helpers ───────────────────────────────────────────────────

def _planet_from_dict(d: dict) -> Planet:
    return Planet(
        id=d["id"], name=d["name"], x=d["x"], y=d["y"], radius=d["radius"],
        owner=d.get("owner"), resource_type=d["resource_type"],
        resource_rate=d["resource_rate"], population=d["population"],
        defense=d["defense"], buildings=d.get("buildings", []),
        build_queue=d.get("build_queue", []), level=d.get("level", 1),
        explored_by=d.get("explored_by", []), lanes=d.get("lanes", []),
        ships=d.get("ships", []), conquest_checks=d.get("conquest_checks", 0),
    )


def _faction_from_dict(d: dict) -> Faction:
    # Use saved credits if present; fall back to old 3-resource conversion for legacy saves
    if "credits" in d:
        credits = d["credits"]
    else:
        old_minerals = d.get("minerals", 500.0)
        old_energy = d.get("energy", 0.0)
        old_rare = d.get("rare", 0.0)
        credits = old_minerals * 2.0 + old_energy * 1.5 + old_rare * 0.5
    
    return Faction(
        id=d["id"], name=d["name"], archetype=d["archetype"],
        home_planet=d["home_planet"], colour=d["colour"],
        credits=credits,
        research_points=d.get("research_points", 0.0),
        tech_tier=d.get("tech_tier", 1), eliminated=d.get("eliminated", False),
        ai_timer=d.get("ai_timer", 0), aggression=d.get("aggression", 0.5),
        storage_capacity=d.get("storage_capacity", 1000.0),
        income_history=d.get("income_history", []),
        expense_history=d.get("expense_history", []),
        fleet_upgrades=d.get("fleet_upgrades", {"speed": 0, "health": 0, "damage": 0}),
        kills=d.get("kills", 0),
        deaths=d.get("deaths", 0),
        ships_built=d.get("ships_built", 0),
        ships_built_by_type=d.get("ships_built_by_type", {}),
    )


def _ship_from_dict(d: dict) -> Ship:
    return Ship(
        id=d["id"], type=d["type"], owner=d["owner"],
        x=d["x"], y=d["y"], vx=d.get("vx", 0.0), vy=d.get("vy", 0.0),
        health=d["health"], max_health=d["max_health"],
        state=d.get("state", "orbiting"),
        target_planet=d.get("target_planet"),
        target_ship=d.get("target_ship"),
        orbit_angle=d.get("orbit_angle", 0.0),
        orbit_radius=d.get("orbit_radius", 0.0),
        target_x=d.get("target_x"), target_y=d.get("target_y"),
        fuel=d.get("fuel", 1.0), energy_level=d.get("energy_level", 1.0),
        fire_timer=d.get("fire_timer", 0), rogue=d.get("rogue", False),
        spawn_timer=d.get("spawn_timer", 0),
        speed_mult=d.get("speed_mult", 1.0),
        damage_mult=d.get("damage_mult", 1.0),
        mothership_level=d.get("mothership_level", 1),
        mothership_mode=d.get("mothership_mode", "orbit"),
        mothership_upgrades=d.get("mothership_upgrades", {"launch_bays": 0, "assembly": 0}),
    )
