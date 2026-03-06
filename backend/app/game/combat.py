"""M5 combat: engagement detection, damage resolution, conquest, retreats.

Runs after simulation_tick each game loop iteration.

Flow per tick:
  1. Move attacking ships toward their targets
  2. Detect new engagements (ships within attack range of enemies)
  3. Resolve fire: decrement timers, apply damage, emit events
  4. Defense platforms fire at attackers
  5. Check retreats (ships below 25% HP)
  6. Check conquest (every DOMINANCE_CHECK_INTERVAL ticks)
  7. Remove destroyed ships
  8. Check faction elimination
  9. Scale aggression (every 500 ticks)
"""

import math

from game.config import (
    SHIP_ATTACK_RANGE, SHIP_STATS,
    CONQUEST_RADIUS, CONQUEST_THRESHOLD, CONQUEST_CHECKS_NEEDED,
    DOMINANCE_CHECK_INTERVAL, ORBIT_OFFSET, GALAXY_WIDTH, GALAXY_HEIGHT,
    LEVEL_DEFENSE_BONUS, WIN_PLANET_FRACTION,
)
from game.state import GameState, Ship, Planet

DT = 0.05   # must match physics.py

RETREAT_HP_THRESHOLD    = 0.25
RETREAT_SEARCH_RANGE    = 2000
DEFENSE_PLATFORM_DAMAGE = 15
DEFENSE_PLATFORM_RANGE  = 300
ORBITAL_CANNON_DAMAGE   = 30
ORBITAL_CANNON_RANGE    = 500
DEFENSE_PLATFORM_TICKS  = 20   # ticks between platform shots

# Spatial grid for O(n) engagement detection instead of O(n²)
ENGAGE_GRID_SIZE = 500.0          # cell size ≥ largest attack range (dreadnought=350)
ENGAGE_GRID_INV  = 1.0 / ENGAGE_GRID_SIZE


def combat_tick(
    state: GameState, planet_map: dict, ship_map: dict, faction_map: dict
) -> None:
    """Run one combat tick. Mutates state in place. Appends to state.tick_events."""
    _move_attackers(state.ships, ship_map)
    _update_engagements(state.ships, ship_map)
    _resolve_combat(state, ship_map, planet_map, faction_map)
    _defense_platforms_fire(state, planet_map, faction_map)
    _handle_retreats(state.ships, state.planets)

    if state.tick % DOMINANCE_CHECK_INTERVAL == 0:
        _check_conquest(state, planet_map, faction_map)

    _remove_destroyed(state, ship_map)
    _check_elimination(state, planet_map)

    if state.tick % 500 == 0:
        for f in state.factions:
            if not f.eliminated and f.archetype != "player":
                f.aggression = min(1.0, f.aggression + 0.05)


# ── Engagement detection ───────────────────────────────────────────────────────

def _update_engagements(ships: list[Ship], ship_map: dict) -> None:
    """Transition idle/orbiting ships within attack range of enemies to attacking.

    Moving ships acquire a combat target but keep moving toward their destination
    (return fire without interrupting the movement order).

    Uses a spatial grid so each ship only checks nearby cells — O(n) instead of O(n²).
    """
    # Build spatial grid of candidate targets (exclude retreating)
    inv = ENGAGE_GRID_INV
    grid: dict[tuple[int, int], list[Ship]] = {}
    for s in ships:
        if s.state != "retreating":
            key = (int(s.x * inv), int(s.y * inv))
            grid.setdefault(key, []).append(s)

    _attack_range = SHIP_ATTACK_RANGE
    for ship in ships:
        ship_state = ship.state
        if ship_state not in ("orbiting", "idle", "moving"):
            continue   # don't interrupt retreating/attacking ships
        attack_range = _attack_range.get(ship.type, 0)
        if attack_range == 0:
            continue

        # Moving ships: skip re-targeting if already tracking a live enemy
        if ship_state == "moving" and ship.target_ship:
            t = ship_map.get(ship.target_ship)
            if t and t.health > 0:
                continue

        attack_range_sq = attack_range * attack_range
        ship_x, ship_y = ship.x, ship.y
        ship_owner = ship.owner

        # Query 3×3 neighbourhood in grid
        cx = int(ship_x * inv)
        cy = int(ship_y * inv)
        found = False
        for gx in (cx - 1, cx, cx + 1):
            if found:
                break
            for gy in (cy - 1, cy, cy + 1):
                cell = grid.get((gx, gy))
                if not cell:
                    continue
                for other in cell:
                    if other.owner == ship_owner or other.id == ship.id:
                        continue
                    if other.state == "retreating":
                        continue

                    dx = other.x - ship_x
                    dy = other.y - ship_y

                    if dx * dx + dy * dy <= attack_range_sq:
                        ship.target_ship = other.id
                        if ship_state != "moving":
                            ship.state       = "attacking"
                            ship.target_planet = None
                            ship.target_x    = None
                            ship.target_y    = None
                        found = True
                        break


# ── Attacking ship movement ────────────────────────────────────────────────────

def _move_attackers(ships: list[Ship], ship_map: dict) -> None:
    """Move attacking ships toward their targets."""
    for ship in ships:
        if ship.state != "attacking":
            continue

        target = ship_map.get(ship.target_ship)
        if not target or target.health <= 0:
            ship.state       = "idle"
            ship.target_ship = None
            continue

        dx   = target.x - ship.x
        dy   = target.y - ship.y
        dist_sq = dx * dx + dy * dy

        attack_range = SHIP_ATTACK_RANGE.get(ship.type, 150)
        engage_dist_sq = (attack_range * 0.8) ** 2

        if dist_sq > engage_dist_sq and dist_sq > 1:
            dist    = math.sqrt(dist_sq)
            speed   = SHIP_STATS[ship.type]["speed"] * ship.energy_level * getattr(ship, 'speed_mult', 1.0)
            ship.vx = speed * (dx / dist)
            ship.vy = speed * (dy / dist)
            ship.x  = round(ship.x + ship.vx * DT, 2)
            ship.y  = round(ship.y + ship.vy * DT, 2)
            ship.x  = max(0.0, min(float(GALAXY_WIDTH),  ship.x))
            ship.y  = max(0.0, min(float(GALAXY_HEIGHT), ship.y))


# ── Damage resolution ─────────────────────────────────────────────────────────

def _resolve_combat(state: GameState, ship_map: dict, planet_map: dict, faction_map: dict) -> None:
    for ship in state.ships:
        # Fire if fully in combat mode, or if moving and has acquired a return-fire target
        if ship.state not in ("attacking", "moving"):
            continue
        if not ship.target_ship:
            continue

        fire_rate = SHIP_STATS[ship.type].get("fire_rate", 0)
        if fire_rate == 0:
            continue   # unarmed

        ship.fire_timer -= 1
        if ship.fire_timer > 0:
            continue

        ship.fire_timer = fire_rate

        target = ship_map.get(ship.target_ship)
        if not target or target.health <= 0:
            ship.target_ship = None
            if ship.state == "attacking":
                ship.state = "idle"
            continue   # moving ships keep moving; attacking ships idle

        # Follower mode reuses target_ship for allied mothership anchors.
        # Never fire on allied targets.
        if target.owner == ship.owner:
            if ship.state == "attacking":
                ship.target_ship = None
                ship.state = "idle"
            continue

        damage = float(SHIP_STATS[ship.type]["damage"]) * getattr(ship, 'damage_mult', 1.0)

        # Defense bonus if target orbits its own planet (base defense + level bonus)
        defense_bonus = 0.0
        if target.state == "orbiting" and target.target_planet:
            planet = planet_map.get(target.target_planet)
            if planet and planet.owner == target.owner:
                defense_bonus = planet.defense + (planet.level - 1) * LEVEL_DEFENSE_BONUS

        effective = round(damage * (1.0 - defense_bonus), 2)
        target.health = round(target.health - effective, 2)

        state.tick_events.append({
            "type":   "shot",
            "from":   ship.id,
            "to":     target.id,
            "damage": effective,
        })

        if target.health <= 0:
            target.health = 0
            # Track kill/death stats
            killer_faction = faction_map.get(ship.owner)
            victim_faction = faction_map.get(target.owner)
            if killer_faction:
                killer_faction.kills += 1
            if victim_faction:
                victim_faction.deaths += 1
            state.tick_events.append({
                "type":      "ship_destroyed",
                "ship_id":   target.id,
                "killer_id": ship.id,
            })


# ── Defense platforms ─────────────────────────────────────────────────────────

def _defense_platforms_fire(state: GameState, planet_map: dict, faction_map: dict) -> None:
    if state.tick % DEFENSE_PLATFORM_TICKS != 0:
        return

    all_ships = state.ships
    plat_range_sq = DEFENSE_PLATFORM_RANGE * DEFENSE_PLATFORM_RANGE
    cannon_range_sq = ORBITAL_CANNON_RANGE * ORBITAL_CANNON_RANGE

    for planet in state.planets:
        if planet.owner is None:
            continue
        buildings = planet.buildings
        platforms = buildings.count("defense_platform")
        cannons   = buildings.count("orbital_cannon")
        if platforms == 0 and cannons == 0:
            continue

        max_range_sq = cannon_range_sq if cannons > 0 else plat_range_sq
        px, py = planet.x, planet.y
        planet_owner = planet.owner

        # Single pass: find nearest enemy within range (replaces list comp + min)
        best_target = None
        best_dist_sq = max_range_sq

        for s in all_ships:
            if s.owner == planet_owner:
                continue
            dx = s.x - px
            dy = s.y - py
            d2 = dx * dx + dy * dy
            if d2 < best_dist_sq:
                best_dist_sq = d2
                best_target = s

        if best_target is None:
            continue

        # Platforms only fire if target is within platform range
        plat_dmg   = platforms * DEFENSE_PLATFORM_DAMAGE if best_dist_sq < plat_range_sq else 0
        cannon_dmg = cannons   * ORBITAL_CANNON_DAMAGE
        total_dmg  = plat_dmg + cannon_dmg

        if total_dmg == 0:
            continue

        best_target.health = round(best_target.health - total_dmg, 2)

        state.tick_events.append({
            "type":   "shot",
            "from":   f"platform-{planet.id}",
            "to":     best_target.id,
            "damage": total_dmg,
        })

        if best_target.health <= 0:
            best_target.health = 0
            # Track death stats for platform kills
            victim_faction = faction_map.get(best_target.owner)
            if victim_faction:
                victim_faction.deaths += 1
            state.tick_events.append({
                "type":      "ship_destroyed",
                "ship_id":   best_target.id,
                "killer_id": f"platform-{planet.id}",
            })


# ── Retreat ───────────────────────────────────────────────────────────────────

def _handle_retreats(ships: list[Ship], planets: list[Planet]) -> None:
    retreat_range_sq = RETREAT_SEARCH_RANGE * RETREAT_SEARCH_RANGE
    # Pre-group friendly planets by owner (O(planets) once)
    planets_by_owner: dict[str | None, list[Planet]] = {}
    for p in planets:
        if p.owner is not None:
            planets_by_owner.setdefault(p.owner, []).append(p)

    for ship in ships:
        if ship.state in ("retreating", "orbiting") or ship.health <= 0:
            continue
        if ship.max_health <= 0:
            continue

        hp_ratio = ship.health / ship.max_health
        if hp_ratio > RETREAT_HP_THRESHOLD:
            continue

        friendly = planets_by_owner.get(ship.owner)
        if not friendly:
            continue   # no safe harbour — keep fighting

        ship_x, ship_y = ship.x, ship.y
        nearest = None
        nearest_dist_sq = float('inf')
        for p in friendly:
            dx = ship_x - p.x
            dy = ship_y - p.y
            d2 = dx * dx + dy * dy
            if d2 < nearest_dist_sq:
                nearest_dist_sq = d2
                nearest = p

        if nearest_dist_sq > retreat_range_sq:
            continue   # too far — keep fighting

        ship.state        = "retreating"
        ship.target_ship  = None
        ship.target_x     = float(nearest.x)
        ship.target_y     = float(nearest.y)
        ship.target_planet = nearest.id
        ship.energy_level = 1.0   # retreat at max thrust


# ── Conquest ──────────────────────────────────────────────────────────────────

def _check_conquest(
    state: GameState, planet_map: dict, faction_map: dict
) -> None:
    conquest_r_sq = CONQUEST_RADIUS * CONQUEST_RADIUS
    all_ships = state.ships
    _stats = SHIP_STATS

    for planet in state.planets:
        px, py = planet.x, planet.y
        planet_id = planet.id
        planet_owner = planet.owner

        # Single pass: accumulate per-faction power near this planet
        faction_power: dict[str, float] = {}
        for ship in all_ships:
            if ship.owner == "neutral":
                continue
            if ship.state == "orbiting" and ship.target_planet and ship.target_planet != planet_id:
                continue
            dx = ship.x - px
            dy = ship.y - py
            if dx * dx + dy * dy >= conquest_r_sq:
                continue
            hp_ratio = ship.health / ship.max_health if ship.max_health > 0 else 0.0
            power = hp_ratio * _stats.get(ship.type, {}).get("damage", 0)
            faction_power[ship.owner] = faction_power.get(ship.owner, 0.0) + power

        # Separate defense (planet owner) from attackers
        defense_power = faction_power.pop(planet_owner, 0.0)

        # Check if any attackers remain
        if not faction_power:
            if planet.conquest_checks > 0:
                planet.conquest_checks = 0
            continue

        # Add structural defense
        level_bonus   = (planet.level - 1) * LEVEL_DEFENSE_BONUS
        effective_def = planet.defense + level_bonus
        platforms     = planet.buildings.count("defense_platform")
        cannons       = planet.buildings.count("orbital_cannon")
        defense_power += effective_def * 5 + platforms * 25 + cannons * 50

        # Find the dominant attacker
        best_attacker  = None
        best_dominance = 0.0
        for att, att_power in faction_power.items():
            total = att_power + defense_power
            dom = att_power / total if total > 0 else 0.0
            if dom > best_dominance:
                best_dominance = dom
                best_attacker  = att

        if best_dominance >= CONQUEST_THRESHOLD:
            planet.conquest_checks += 1
            if planet.conquest_checks >= CONQUEST_CHECKS_NEEDED:
                _capture_planet(planet, best_attacker, state, faction_map)
        else:
            planet.conquest_checks = 0


def _capture_planet(
    planet: Planet, new_owner: str, state: GameState, faction_map: dict
) -> None:
    old_owner = planet.owner
    captured_planet_id = planet.id

    retreat_targets: list[Planet] = []
    if old_owner not in (None,):
        retreat_targets = [p for p in state.planets if p.owner == old_owner and p.id != captured_planet_id]

    planet.owner            = new_owner
    planet.conquest_checks  = 0
    planet.defense          = 0.1   # just conquered
    planet.buildings        = []
    planet.build_queue      = []
    planet.level            = 1
    if new_owner not in planet.explored_by:
        planet.explored_by.append(new_owner)

    # Destroy neutral garrison; send faction defenders into retreat
    for ship in state.ships:
        if ship.owner != old_owner and not (old_owner is None and ship.owner == "neutral"):
            continue
        if old_owner is None:
            # Neutral garrison — destroy on capture
            if ship.target_planet == captured_planet_id:
                ship.health = 0
                state.tick_events.append({
                    "type":      "ship_destroyed",
                    "ship_id":   ship.id,
                    "killer_id": new_owner,
                })
        else:
            # Only faction ships assigned to this conquered planet retreat.
            # Keep all other fleets/orders untouched.
            if ship.target_planet != captured_planet_id:
                continue
            if retreat_targets:
                nearest = min(retreat_targets, key=lambda p: math.dist((ship.x, ship.y), (p.x, p.y)))
                ship.state        = "retreating"
                ship.target_ship  = None
                ship.target_x     = float(nearest.x)
                ship.target_y     = float(nearest.y)
                ship.target_planet = nearest.id
                ship.energy_level = 1.0

    state.tick_events.append({
        "type":      "planet_captured",
        "planet_id": planet.id,
        "by":        new_owner,
        "from":      old_owner,
    })

    # Spawn a garrison fighter immediately so the planet looks active
    if new_owner not in ("neutral",):
        stats = SHIP_STATS.get("fighter", {})
        if stats:
            state.ship_id_counter += 1
            orbit_r  = planet.radius + ORBIT_OFFSET
            new_ship = Ship(
                id=f"s-{state.ship_id_counter:04d}",
                type="fighter", owner=new_owner,
                x=round(planet.x + orbit_r, 2), y=round(planet.y, 2),
                health=float(stats["hp"]), max_health=float(stats["hp"]),
                state="orbiting", target_planet=planet.id,
                orbit_angle=0.0, orbit_radius=orbit_r,
            )
            state.ships.append(new_ship)
            planet.ships.append(new_ship.id)
            state.tick_events.append({
                "type": "ship_spawned",
                "ship": {
                    "id": new_ship.id, "type": new_ship.type, "owner": new_ship.owner,
                    "x": new_ship.x, "y": new_ship.y, "vx": 0.0, "vy": 0.0,
                    "health": new_ship.health, "max_health": new_ship.max_health,
                    "state": new_ship.state, "target_planet": new_ship.target_planet,
                    "target_ship": None, "orbit_angle": new_ship.orbit_angle,
                    "orbit_radius": new_ship.orbit_radius, "target_x": None,
                    "target_y": None, "fuel": 1.0, "energy_level": 1.0, "rogue": False,
                },
            })


# ── Cleanup ───────────────────────────────────────────────────────────────────

def _remove_destroyed(state: GameState, ship_map: dict) -> None:
    dead_ids = {s.id for s in state.ships if s.health <= 0}
    if not dead_ids:
        return

    state.ships = [s for s in state.ships if s.id not in dead_ids]

    for dead_id in dead_ids:
        ship_map.pop(dead_id, None)

    for planet in state.planets:
        planet.ships = [sid for sid in planet.ships if sid not in dead_ids]


def _check_elimination(state: GameState, planet_map: dict) -> None:
    if state.status != "running":
        return

    faction_planets: dict[str, int] = {f.id: 0 for f in state.factions}
    faction_ships: dict[str, int] = {f.id: 0 for f in state.factions}

    for planet in state.planets:
        if planet.owner in faction_planets:
            faction_planets[planet.owner] += 1

    for ship in state.ships:
        if ship.owner in faction_ships and ship.health > 0:
            faction_ships[ship.owner] += 1

    # Eliminate factions with no remaining assets (no planets and no ships)
    for faction in state.factions:
        if faction.eliminated:
            continue
        if faction_planets.get(faction.id, 0) == 0 and faction_ships.get(faction.id, 0) == 0:
            faction.eliminated = True
            state.tick_events.append({
                "type": "faction_eliminated",
                "faction_id": faction.id,
            })

    # PvP mode: if multiple human factions exist, last remaining human wins
    human_factions = [f for f in state.factions if f.archetype == "player"]
    pvp_mode = len(human_factions) > 1
    if pvp_mode:
        alive_humans = [f for f in human_factions if not f.eliminated]
        if len(alive_humans) <= 1:
            state.status = "won"
            winner_id = alive_humans[0].id if alive_humans else None
            # Build per-player summary
            ship_type_counts: dict[str, dict[str, int]] = {}
            for s in state.ships:
                if s.owner:
                    tc = ship_type_counts.setdefault(s.owner, {})
                    tc[s.type] = tc.get(s.type, 0) + 1
            summary = [{
                "faction_id": f.id,
                "name": f.name,
                "colour": f.colour,
                "kills": f.kills,
                "deaths": f.deaths,
                "ships_alive": faction_ships.get(f.id, 0),
                "ships_by_type": ship_type_counts.get(f.id, {}),
                "ships_built": f.ships_built,
                "ships_built_by_type": dict(f.ships_built_by_type),
                "planets": faction_planets.get(f.id, 0),
                "eliminated": f.eliminated,
            } for f in human_factions]
            state.tick_events.append({
                "type": "game_over",
                "result": "win",
                "winner_faction_id": winner_id,
                "mode": "pvp",
                "summary": summary,
            })
        return

    # Single-player mode: preserve existing win/lose semantics
    total_planets = len(state.planets)
    player_faction = next((f for f in state.factions if f.archetype == "player"), None)
    if not player_faction:
        return

    player_planets = faction_planets.get(player_faction.id, 0)
    if player_planets == 0:
        state.status = "lost"
        state.tick_events.append({
            "type": "game_over",
            "result": "loss",
            "winner_faction_id": None,
            "mode": "singleplayer",
        })
    elif total_planets > 0 and player_planets / total_planets >= WIN_PLANET_FRACTION:
        state.status = "won"
        state.tick_events.append({
            "type": "game_over",
            "result": "win",
            "winner_faction_id": player_faction.id,
            "mode": "singleplayer",
        })
