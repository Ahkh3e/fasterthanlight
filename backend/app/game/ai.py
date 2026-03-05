"""M5 NPC AI: 3 archetypes, 40-tick decision cycle.

Each NPC faction gets a decision call every AI_DECISION_INTERVAL ticks.
Between decisions ships execute their last-issued orders.

Archetypes:
  expansionist  — always push to capture the nearest unowned planet
  defensive     — fortify; scramble when threatened; counter-attack once
  opportunistic — watch for weakened targets; strike when advantaged
"""

import math

from game.config import (
    AI_DECISION_INTERVAL, SHIP_STATS, SHIP_COSTS, BUILDING_COSTS,
    CONQUEST_RADIUS, ORBIT_OFFSET, LEVEL_UP_COSTS, LEVEL_UP_TICKS,
    BUILDING_LEVEL_REQ, SHIP_TIER_REQ, SHIP_BUILD_TICKS,
)
from game.state import GameState, Ship, Planet, Faction


def ai_tick(
    state: GameState, planet_map: dict, ship_map: dict, faction_map: dict
) -> None:
    """Run AI decision cycle for all non-player factions."""
    for faction in state.factions:
        if faction.archetype == "player" or faction.eliminated:
            continue

        faction.ai_timer -= 1
        if faction.ai_timer > 0:
            continue

        faction.ai_timer = AI_DECISION_INTERVAL

        faction_planets = [p for p in state.planets if p.owner == faction.id]
        faction_ships   = [s for s in state.ships   if s.owner == faction.id]

        _decide_production(faction, faction_planets, faction_ships)
        _decide_combat(faction, state, faction_planets, faction_ships, faction_map)


# ── Production ────────────────────────────────────────────────────────────────

def _decide_production(
    faction: Faction, faction_planets: list[Planet], faction_ships: list[Ship]
) -> None:
    for planet in faction_planets:
        if len(planet.build_queue) >= 2:
            continue

        # Prioritise extractor first (income)
        if "extractor" not in planet.buildings:
            cost = BUILDING_COSTS["extractor"]
            if _can_afford(faction, cost):
                _queue_building(faction, planet, "extractor", cost)
                continue

        # Shipyard needed before building ships
        if "shipyard" not in planet.buildings:
            cost = BUILDING_COSTS["shipyard"]
            if _can_afford(faction, cost):
                _queue_building(faction, planet, "shipyard", cost)
                continue

        # Level up if affordable (only if well off with surplus)
        if planet.level < 5 and not any(q.get("type") == "level_up" for q in planet.build_queue):
            lv_cost = LEVEL_UP_COSTS.get(planet.level)
            if lv_cost and faction.credits >= lv_cost * 2:
                _queue_level_up(faction, planet, planet.level)
                continue

        # Queue a ship if shipyard present and tier allows
        if "shipyard" in planet.buildings:
            ship_type = _choose_ship_type(faction)
            cost      = SHIP_COSTS[ship_type]
            if _can_afford(faction, cost):
                _queue_ship(faction, planet, ship_type, cost)


def _can_afford(faction: Faction, cost: float) -> bool:
    return faction.credits >= cost


def _queue_building(faction: Faction, planet: Planet, name: str, cost: float) -> None:
    planet.build_queue.append({
        "type": "building", "name": name, "ticks_remaining": 100,  # Default build time
    })
    faction.credits -= cost


def _queue_ship(faction: Faction, planet: Planet, ship_type: str, cost: float) -> None:
    ticks = SHIP_BUILD_TICKS.get(ship_type, 200)
    planet.build_queue.append({
        "type": "ship", "ship_type": ship_type, "ticks_remaining": ticks, "total_ticks": ticks,
    })
    faction.credits -= cost


def _queue_level_up(faction: Faction, planet: Planet, current_level: int) -> None:
    ticks = LEVEL_UP_TICKS[current_level]
    planet.build_queue.append({
        "type": "level_up", "ticks_remaining": ticks, "total_ticks": ticks,
    })
    faction.credits -= LEVEL_UP_COSTS[current_level]


def _choose_ship_type(faction: Faction) -> str:
    """Return the best ship type this faction can build given its tech tier."""
    tier = faction.tech_tier
    if tier >= 3:
        if faction.archetype == "defensive":
            return "carrier"
        return "bomber"
    elif tier >= 2:
        if faction.archetype == "defensive":
            return "cruiser"
        return "cruiser"
    # tier 1
    return "fighter"


# ── Combat decisions ──────────────────────────────────────────────────────────

def _decide_combat(
    faction:        Faction,
    state:          GameState,
    faction_planets: list[Planet],
    faction_ships:  list[Ship],
    faction_map:    dict,
) -> None:
    idle_ships = [s for s in faction_ships if s.state in ("orbiting", "idle")]

    if faction.archetype == "expansionist":
        _ai_expansionist(faction, state, faction_planets, idle_ships)
    elif faction.archetype == "defensive":
        _ai_defensive(faction, state, faction_planets, idle_ships)
    elif faction.archetype == "opportunistic":
        _ai_opportunistic(faction, state, faction_planets, idle_ships)


# ── Expansionist ──────────────────────────────────────────────────────────────

def _ai_expansionist(
    faction: Faction, state: GameState,
    faction_planets: list[Planet], idle_ships: list[Ship],
) -> None:
    if not idle_ships:
        return

    target = _find_attack_target(faction, state.planets, idle_ships, prefer_neutral=True)
    if not target:
        return

    # Send ⅔ of idle ships; keep ⅓ in garrison
    n = max(1, len(idle_ships) * 2 // 3)
    _send_fleet_to_planet(idle_ships[:n], target)


# ── Defensive ─────────────────────────────────────────────────────────────────

def _ai_defensive(
    faction: Faction, state: GameState,
    faction_planets: list[Planet], idle_ships: list[Ship],
) -> None:
    MIN_GARRISON = 2

    # Ensure minimum garrison on each owned planet
    for planet in faction_planets:
        orbiting = [
            s for s in state.ships
            if s.owner == faction.id
            and s.state == "orbiting"
            and s.target_planet == planet.id
        ]
        if len(orbiting) < MIN_GARRISON and idle_ships:
            ship = idle_ships.pop(0)
            _send_ship_to_planet(ship, planet)

    if not idle_ships:
        return

    # Counter-attack if a planet is under threat
    threatened = _find_threatened_planet(faction, state)
    if not threatened:
        return

    tx, ty = threatened.x, threatened.y
    attackers = [
        s for s in state.ships
        if s.owner != faction.id and s.owner != "neutral"
        and (s.x - tx) ** 2 + (s.y - ty) ** 2 < 250000
    ]
    if not attackers:
        return

    attacker_faction = attackers[0].owner
    target = next(
        (p for p in state.planets if p.owner == attacker_faction),
        None,
    )
    if target:
        n = max(1, len(idle_ships) // 2)
        _send_fleet_to_planet(idle_ships[:n], target)


# ── Opportunistic ─────────────────────────────────────────────────────────────

def _ai_opportunistic(
    faction: Faction, state: GameState,
    faction_planets: list[Planet], idle_ships: list[Ship],
) -> None:
    if not idle_ships:
        return

    target = _find_easy_target(faction, state, idle_ships)
    if target:
        _send_fleet_to_planet(idle_ships, target)


# ── Targeting helpers ─────────────────────────────────────────────────────────

def _find_attack_target(
    faction:       Faction,
    planets:       list[Planet],
    idle_ships:    list[Ship],
    prefer_neutral: bool = False,
) -> Planet | None:
    candidates = [p for p in planets if p.owner != faction.id]
    if not candidates:
        return None

    cx = sum(s.x for s in idle_ships) / len(idle_ships)
    cy = sum(s.y for s in idle_ships) / len(idle_ships)

    def score(p: Planet) -> float:
        dist  = math.dist((cx, cy), (p.x, p.y))
        bonus = 0.0 if (prefer_neutral and p.owner is None) else 800.0
        return dist + bonus

    candidates.sort(key=score)
    return candidates[0]


def _find_easy_target(
    faction: Faction, state: GameState, idle_ships: list[Ship]
) -> Planet | None:
    our_power = sum(SHIP_STATS[s.type]["damage"] for s in idle_ships)
    conquest_r2_sq = (CONQUEST_RADIUS * 2) ** 2

    for planet in state.planets:
        if planet.owner == faction.id:
            continue

        px, py = planet.x, planet.y
        def_power = sum(
            SHIP_STATS[s.type]["damage"]
            for s in state.ships
            if s.owner == planet.owner
            and (s.x - px) ** 2 + (s.y - py) ** 2 < conquest_r2_sq
        ) + planet.defense * 200

        if def_power == 0 or our_power > def_power * 1.5:
            return planet

    return None


def _find_threatened_planet(faction: Faction, state: GameState) -> Planet | None:
    threat_range_sq = 500 * 500
    for planet in state.planets:
        if planet.owner != faction.id:
            continue
        px, py = planet.x, planet.y
        for ship in state.ships:
            if ship.owner != faction.id and ship.owner != "neutral":
                dx = ship.x - px
                dy = ship.y - py
                if dx * dx + dy * dy < threat_range_sq:
                    return planet
    return None


# ── Movement helpers ──────────────────────────────────────────────────────────

def _send_fleet_to_planet(ships: list[Ship], planet: Planet) -> None:
    for ship in ships:
        _send_ship_to_planet(ship, planet)


def _send_ship_to_planet(ship: Ship, planet: Planet) -> None:
    ship.state        = "moving"
    ship.target_planet = planet.id
    ship.target_x     = float(planet.x)
    ship.target_y     = float(planet.y)
    ship.target_ship  = None
