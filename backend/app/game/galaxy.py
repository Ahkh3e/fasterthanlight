"""Procedural galaxy generator.

generate(seed, planet_count) → (list[Planet], list[Ship], list[Faction])

Same seed always produces the same galaxy.
"""

import math
import random
from collections import deque

from game.config import (
    GALAXY_WIDTH, GALAXY_HEIGHT, MIN_PLANET_SEPARATION, MAX_LANE_LENGTH,
    PLANET_RADIUS_MIN, PLANET_RADIUS_MAX, K_NEAREST_LANES,
    PLANET_ADJ, PLANET_NOUN, FACTION_PREFIX, FACTION_NAME, FACTION_COLOURS,
    ORBIT_OFFSET, SHIP_STATS,
    PLAYER_START_CREDITS, NPC_START_CREDITS,
    AI_DECISION_INTERVAL,
)
from game.state import Planet, Ship, Faction


def generate(seed: int, planet_count: int = 30):
    rng = random.Random(seed)

    planets  = _place_planets(rng, planet_count)
    _build_lanes(planets)
    factions = _create_factions(rng, planet_count)
    _assign_starting_planets(rng, planets, factions)
    _reveal_starting_areas(planets, factions)
    ships    = _create_starting_ships(rng, planets, factions)

    return planets, ships, factions


# ── Planet placement ──────────────────────────────────────────────────────────

def _place_planets(rng: random.Random, count: int) -> list[Planet]:
    margin   = 300
    resource_pool = _weighted_resource_list(rng, count)

    positions: list[tuple[float, float]] = []
    attempts  = 0
    max_attempts = count * 200

    while len(positions) < count and attempts < max_attempts:
        x = rng.uniform(margin, GALAXY_WIDTH  - margin)
        y = rng.uniform(margin, GALAXY_HEIGHT - margin)
        if all(math.dist((x, y), p) >= MIN_PLANET_SEPARATION for p in positions):
            positions.append((x, y))
        attempts += 1

    planets = []
    used_names: set[str] = set()

    for i, (x, y) in enumerate(positions):
        radius   = rng.uniform(PLANET_RADIUS_MIN, PLANET_RADIUS_MAX)
        res_type = resource_pool[i]
        res_rate = rng.uniform(0.5, 3.0)
        pop      = rng.randint(0, 100)
        defense  = round(rng.uniform(0.0, 0.3), 2)
        name     = _unique_name(rng, used_names)
        used_names.add(name)

        planets.append(Planet(
            id=f"p-{i:02d}",
            name=name,
            x=round(x, 1),
            y=round(y, 1),
            radius=round(radius, 1),
            owner=None,
            resource_type=res_type,
            resource_rate=round(res_rate, 2),
            population=pop,
            defense=defense,
            buildings=[],
            build_queue=[],
            level=1,
            explored_by=[],
            lanes=[],
            ships=[],
        ))

    return planets


def _weighted_resource_list(rng: random.Random, count: int) -> list[str]:
    """Return a shuffled list of resource types with weighted distribution."""
    # Use simple distribution: 50% minerals, 30% energy, 20% rare
    items = []
    minerals_count = int(count * 0.5)
    energy_count = int(count * 0.3)
    rare_count = count - minerals_count - energy_count
    
    items.extend(["minerals"] * minerals_count)
    items.extend(["energy"] * energy_count)
    items.extend(["rare"] * rare_count)
    
    rng.shuffle(items)
    return items


def _unique_name(rng: random.Random, used: set[str]) -> str:
    for _ in range(50):
        name = f"{rng.choice(PLANET_ADJ)} {rng.choice(PLANET_NOUN)}"
        if name not in used:
            return name
    return f"Planet-{len(used)}"


# ── Hyperspace lanes ──────────────────────────────────────────────────────────

def _build_lanes(planets: list[Planet]) -> None:
    id_to_planet = {p.id: p for p in planets}

    for planet in planets:
        # Find k nearest neighbours within max lane length
        neighbours = sorted(
            (math.dist((planet.x, planet.y), (other.x, other.y)), other.id)
            for other in planets if other.id != planet.id
        )
        added = 0
        for dist, other_id in neighbours:
            if added >= K_NEAREST_LANES:
                break
            if dist > MAX_LANE_LENGTH:
                continue
            if other_id not in planet.lanes:
                planet.lanes.append(other_id)
            other = id_to_planet[other_id]
            if planet.id not in other.lanes:
                other.lanes.append(planet.id)
            added += 1

    _ensure_connected(planets, id_to_planet)


def _ensure_connected(planets: list[Planet], id_to_planet: dict) -> None:
    """BFS from the first planet; reconnect any isolated components."""
    visited: set[str] = set()
    queue = deque([planets[0].id])

    while queue:
        pid = queue.popleft()
        if pid in visited:
            continue
        visited.add(pid)
        for nid in id_to_planet[pid].lanes:
            if nid not in visited:
                queue.append(nid)

    for planet in planets:
        if planet.id not in visited:
            # Connect to the nearest already-visited planet
            nearest = min(
                (p for p in planets if p.id in visited),
                key=lambda p: math.dist((planet.x, planet.y), (p.x, p.y)),
            )
            if nearest.id not in planet.lanes:
                planet.lanes.append(nearest.id)
            if planet.id not in nearest.lanes:
                nearest.lanes.append(planet.id)
            visited.add(planet.id)


# ── Factions ──────────────────────────────────────────────────────────────────

def _faction_count(planet_count: int) -> int:
    if planet_count <= 25: return 3
    if planet_count <= 35: return 4
    return 5


def _create_factions(rng: random.Random, planet_count: int) -> list[Faction]:
    num_npcs  = _faction_count(planet_count) - 1  # -1 for player
    archetypes = rng.sample(["expansionist", "defensive", "opportunistic",
                              "expansionist", "defensive"], num_npcs)
    used_names: set[str] = set()

    factions: list[Faction] = [
        Faction(
            id="player",
            name="Your Empire",
            archetype="player",
            home_planet="",          # assigned later
            colour="#00ffff",
            credits=PLAYER_START_CREDITS,
        )
    ]

    colour_pool = FACTION_COLOURS.copy()
    rng.shuffle(colour_pool)

    aggression_by_archetype = {
        "expansionist": 0.6, "defensive": 0.2, "opportunistic": 0.3,
    }

    for i in range(num_npcs):
        name = _unique_faction_name(rng, used_names)
        used_names.add(name)
        arch = archetypes[i]
        factions.append(Faction(
            id=f"faction-{i+1}",
            name=name,
            archetype=arch,
            home_planet="",
            colour=colour_pool[i % len(colour_pool)],
            credits=NPC_START_CREDITS,
            aggression=aggression_by_archetype.get(arch, 0.5),
            # Stagger first AI decision so NPCs don't all move at tick 1
            ai_timer=rng.randint(20, AI_DECISION_INTERVAL),
        ))

    return factions


def _unique_faction_name(rng: random.Random, used: set[str]) -> str:
    for _ in range(50):
        name = f"{rng.choice(FACTION_PREFIX)} of {rng.choice(FACTION_NAME)}"
        if name not in used:
            return name
    return f"Faction-{len(used)}"


# ── Starting positions ────────────────────────────────────────────────────────

def _assign_starting_planets(
    rng: random.Random, planets: list[Planet], factions: list[Faction]
) -> None:
    """Spread factions across the galaxy using max-min distance.

    Player gets the best resource-rate planet among a random top-half selection.
    NPCs are placed to maximise distance from each other and the player.
    """
    available = list(planets)

    # Player: pick from the top-half by resource rate, but never a rare planet
    # (rare income is useless early-game — player needs minerals or energy)
    sorted_by_rate = sorted(available, key=lambda p: p.resource_rate, reverse=True)
    top_half = sorted_by_rate[: max(1, len(available) // 2)]
    non_rare = [p for p in top_half if p.resource_type != "rare"]
    candidates = non_rare if non_rare else top_half   # fallback if all are rare
    player_start = rng.choice(candidates)

    player_faction = next(f for f in factions if f.id == "player")
    player_start.owner = "player"
    player_faction.home_planet = player_start.id
    assigned = [player_start]
    remaining = [p for p in available if p is not player_start]

    # NPCs: iteratively pick the planet furthest from all current starts
    npc_factions = [f for f in factions if f.id != "player"]
    for faction in npc_factions:
        best = max(
            remaining,
            key=lambda p: min(math.dist((p.x, p.y), (s.x, s.y)) for s in assigned),
        )
        best.owner = faction.id
        faction.home_planet = best.id
        assigned.append(best)
        remaining.remove(best)


def _reveal_starting_areas(planets: list[Planet], factions: list[Faction]) -> None:
    """Each faction starts with their home planet + immediate lane neighbours revealed.

    The player also starts with all faction home planets visible so they know
    where enemies begin.
    """
    planet_map = {p.id: p for p in planets}
    for faction in factions:
        home = planet_map.get(faction.home_planet)
        if home is None:
            continue
        if faction.id not in home.explored_by:
            home.explored_by.append(faction.id)
        for nid in home.lanes:
            neighbour = planet_map[nid]
            if faction.id not in neighbour.explored_by:
                neighbour.explored_by.append(faction.id)

    # Player sees all faction home planets from game start (intel on enemy positions)
    for faction in factions:
        if faction.id == "player":
            continue
        home = planet_map.get(faction.home_planet)
        if home and "player" not in home.explored_by:
            home.explored_by.append("player")


# ── Starting ships ────────────────────────────────────────────────────────────

def _create_starting_ships(
    rng: random.Random, planets: list[Planet], factions: list[Faction]
) -> list[Ship]:
    ships: list[Ship] = []
    counter = 0

    def spawn(ship_type: str, owner: str, planet: Planet) -> Ship:
        nonlocal counter
        stats       = SHIP_STATS[ship_type]
        angle       = rng.uniform(0, 2 * math.pi)
        orbit_r     = planet.radius + ORBIT_OFFSET
        ship = Ship(
            id=f"s-{counter:04d}",
            type=ship_type,
            owner=owner,
            x=round(planet.x + math.cos(angle) * orbit_r, 2),
            y=round(planet.y + math.sin(angle) * orbit_r, 2),
            health=float(stats["hp"]),
            max_health=float(stats["hp"]),
            state="orbiting",
            target_planet=planet.id,
            orbit_angle=angle,
            orbit_radius=orbit_r,
        )
        planet.ships.append(ship.id)
        counter += 1
        return ship

    planet_map = {p.id: p for p in planets}

    # Faction starting fleets
    for faction in factions:
        home = planet_map[faction.home_planet]
        if faction.id == "player":
            ships += [spawn("fighter", "player", home) for _ in range(4)]
        else:
            ships += [spawn("fighter", faction.id, home) for _ in range(2)]

    # Neutral garrisons on unowned planets (1 fighter per planet)
    for planet in planets:
        if planet.owner is None:
            ships.append(spawn("fighter", "neutral", planet))

    return ships


# ── Save/load round-trip helpers ──────────────────────────────────────────────

def planet_to_dict(p: Planet) -> dict:
    return p.__dict__.copy()


def ship_to_dict(s: Ship) -> dict:
    return s.__dict__.copy()


def faction_to_dict(f: Faction) -> dict:
    d = f.__dict__.copy()
    d.pop("ai_timer", None)   # internal AI state; not persisted to client
    return d
