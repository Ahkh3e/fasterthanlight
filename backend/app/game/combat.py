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


def combat_tick(
    state: GameState, planet_map: dict, ship_map: dict, faction_map: dict
) -> None:
    """Run one combat tick. Mutates state in place. Appends to state.tick_events."""
    _move_attackers(state.ships, ship_map)
    _update_engagements(state.ships, ship_map)
    _resolve_combat(state, ship_map, planet_map)
    _defense_platforms_fire(state, planet_map)
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
    """
    for ship in ships:
        if ship.state not in ("orbiting", "idle", "moving"):
            continue   # don't interrupt retreating/attacking ships
        attack_range = SHIP_ATTACK_RANGE.get(ship.type, 0)
        if attack_range == 0:
            continue

        # Moving ships: skip re-targeting if already tracking a live enemy
        if ship.state == "moving" and ship.target_ship:
            t = ship_map.get(ship.target_ship)
            if t and t.health > 0:
                continue

        for other in ships:
            if other.id == ship.id or other.owner == ship.owner:
                continue
            if other.state == "retreating":
                continue   # don't chase retreating ships

            dx   = other.x - ship.x
            dy   = other.y - ship.y
            dist = math.sqrt(dx * dx + dy * dy)

            if dist <= attack_range:
                ship.target_ship = other.id
                if ship.state != "moving":
                    # Full combat mode: stop and fight
                    ship.state       = "attacking"
                    ship.target_planet = None
                    ship.target_x    = None
                    ship.target_y    = None
                # moving ships: keep target_x/y/target_planet so they continue traveling
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
        dist = math.sqrt(dx * dx + dy * dy)

        attack_range = SHIP_ATTACK_RANGE.get(ship.type, 150)

        if dist > attack_range * 0.8 and dist > 1:
            speed   = SHIP_STATS[ship.type]["speed"] * ship.energy_level
            ship.vx = speed * (dx / dist)
            ship.vy = speed * (dy / dist)
            ship.x  = round(ship.x + ship.vx * DT, 2)
            ship.y  = round(ship.y + ship.vy * DT, 2)
            ship.x  = max(0.0, min(float(GALAXY_WIDTH),  ship.x))
            ship.y  = max(0.0, min(float(GALAXY_HEIGHT), ship.y))


# ── Damage resolution ─────────────────────────────────────────────────────────

def _resolve_combat(state: GameState, ship_map: dict, planet_map: dict) -> None:
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

        damage = float(SHIP_STATS[ship.type]["damage"])

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
            state.tick_events.append({
                "type":      "ship_destroyed",
                "ship_id":   target.id,
                "killer_id": ship.id,
            })


# ── Defense platforms ─────────────────────────────────────────────────────────

def _defense_platforms_fire(state: GameState, planet_map: dict) -> None:
    if state.tick % DEFENSE_PLATFORM_TICKS != 0:
        return

    for planet in state.planets:
        if planet.owner is None:
            continue
        platforms = planet.buildings.count("defense_platform")
        cannons   = planet.buildings.count("orbital_cannon")
        if platforms == 0 and cannons == 0:
            continue

        # Platforms fire at enemies within their range; cannons have longer range
        max_range = ORBITAL_CANNON_RANGE if cannons > 0 else DEFENSE_PLATFORM_RANGE

        attackers = [
            s for s in state.ships
            if s.owner != planet.owner
            and math.sqrt((s.x - planet.x) ** 2 + (s.y - planet.y) ** 2) < max_range
        ]
        if not attackers:
            continue

        target     = min(attackers, key=lambda s: math.sqrt((s.x - planet.x) ** 2 + (s.y - planet.y) ** 2))
        dist_sq    = (target.x - planet.x) ** 2 + (target.y - planet.y) ** 2

        # Platforms only fire if target is within platform range
        plat_dmg   = platforms * DEFENSE_PLATFORM_DAMAGE if dist_sq < DEFENSE_PLATFORM_RANGE ** 2 else 0
        cannon_dmg = cannons   * ORBITAL_CANNON_DAMAGE
        total_dmg  = plat_dmg + cannon_dmg

        if total_dmg == 0:
            continue

        target.health = round(target.health - total_dmg, 2)

        state.tick_events.append({
            "type":   "shot",
            "from":   f"platform-{planet.id}",
            "to":     target.id,
            "damage": total_dmg,
        })

        if target.health <= 0:
            target.health = 0
            state.tick_events.append({
                "type":      "ship_destroyed",
                "ship_id":   target.id,
                "killer_id": f"platform-{planet.id}",
            })


# ── Retreat ───────────────────────────────────────────────────────────────────

def _handle_retreats(ships: list[Ship], planets: list[Planet]) -> None:
    for ship in ships:
        if ship.state in ("retreating", "orbiting") or ship.health <= 0:
            continue
        if ship.max_health <= 0:
            continue

        hp_ratio = ship.health / ship.max_health
        if hp_ratio > RETREAT_HP_THRESHOLD:
            continue

        friendly = [p for p in planets if p.owner == ship.owner]
        if not friendly:
            continue   # no safe harbour — keep fighting

        nearest = min(friendly, key=lambda p: math.dist((ship.x, ship.y), (p.x, p.y)))
        if math.dist((ship.x, ship.y), (nearest.x, nearest.y)) > RETREAT_SEARCH_RANGE:
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
    for planet in state.planets:
        # Find attacker factions within conquest radius
        attacker_factions: set[str] = set()
        for ship in state.ships:
            if ship.owner == planet.owner or ship.owner == "neutral":
                continue
            # Ships orbiting a different planet don't count (prevents home-planet
            # garrison from auto-conquering nearby neutral planets)
            if ship.state == "orbiting" and ship.target_planet and ship.target_planet != planet.id:
                continue
            if math.dist((ship.x, ship.y), (planet.x, planet.y)) < CONQUEST_RADIUS:
                attacker_factions.add(ship.owner)

        if not attacker_factions:
            if planet.conquest_checks > 0:
                planet.conquest_checks = 0
            continue

        best_attacker  = None
        best_dominance = 0.0

        for att in attacker_factions:
            dom = _compute_dominance(planet, att, state.ships)
            if dom > best_dominance:
                best_dominance = dom
                best_attacker  = att

        if best_dominance >= CONQUEST_THRESHOLD:
            planet.conquest_checks += 1
            if planet.conquest_checks >= CONQUEST_CHECKS_NEEDED:
                _capture_planet(planet, best_attacker, state, faction_map)
        else:
            planet.conquest_checks = 0


def _compute_dominance(planet: Planet, attacking_faction: str, ships: list[Ship]) -> float:
    attack_power  = 0.0
    defense_power = 0.0

    for ship in ships:
        if math.dist((ship.x, ship.y), (planet.x, planet.y)) >= CONQUEST_RADIUS:
            continue
        # Ships orbiting a different planet don't count
        if ship.state == "orbiting" and ship.target_planet and ship.target_planet != planet.id:
            continue
        hp_ratio = ship.health / ship.max_health if ship.max_health > 0 else 0.0
        power    = hp_ratio * SHIP_STATS.get(ship.type, {}).get("damage", 0)
        if ship.owner == attacking_faction:
            attack_power  += power
        elif ship.owner == planet.owner:
            defense_power += power

    # Structures and level bonuses add to defensive power
    level_bonus     = (planet.level - 1) * LEVEL_DEFENSE_BONUS
    effective_def   = planet.defense + level_bonus
    platforms       = planet.buildings.count("defense_platform")
    cannons         = planet.buildings.count("orbital_cannon")
    defense_power  += effective_def * 5 + platforms * 25 + cannons * 50

    total = attack_power + defense_power
    return 0.0 if total == 0 else attack_power / total


def _capture_planet(
    planet: Planet, new_owner: str, state: GameState, faction_map: dict
) -> None:
    old_owner = planet.owner

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
            if ship.target_planet == planet.id:
                ship.health = 0
                state.tick_events.append({
                    "type":      "ship_destroyed",
                    "ship_id":   ship.id,
                    "killer_id": new_owner,
                })
        else:
            # Faction ships at this planet retreat
            friendly = [p for p in state.planets if p.owner == old_owner and p.id != planet.id]
            if friendly:
                nearest = min(friendly, key=lambda p: math.dist((ship.x, ship.y), (p.x, p.y)))
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
    planet_owners = {p.owner for p in state.planets if p.owner}
    total_planets = len(state.planets)
    for faction in state.factions:
        if faction.eliminated:
            continue
        if faction.archetype == "player":
            player_planets = sum(1 for p in state.planets if p.owner == faction.id)
            if player_planets == 0:
                state.status = "lost"
                state.tick_events.append({"type": "game_over", "result": "loss"})
            elif total_planets > 0 and player_planets / total_planets >= WIN_PLANET_FRACTION:
                state.status = "won"
                state.tick_events.append({"type": "game_over", "result": "win"})
        else:
            if faction.id not in planet_owners:
                faction.eliminated = True
                state.tick_events.append({
                    "type":       "faction_eliminated",
                    "faction_id": faction.id,
                })
