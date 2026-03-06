"""Simulation tick: orbital kinematics, resource harvesting, fuel recovery,
build queues, auto-fleet generation, and tech tier advancement.

Runs after physics_tick each game loop iteration.
Physics (moving/idle ships) is handled by physics.py.
This file handles ships in stable orbit and economy.
"""

import math

from game.config import (
    ORBIT_SPEED, BASE_INCOME_PER_PLANET, EXTRACTOR_INCOME_BONUS, POPULATION_INCOME_BONUS,
    LEVEL_INCOME_BONUS, TRADE_HUB_INCOME_BONUS,
    BASE_STORAGE_CAPACITY, EXTRACTOR_STORAGE_BONUS, SHIPYARD_STORAGE_BONUS, PLANET_STORAGE_BONUS,
    RESEARCH_PER_LAB, TECH_THRESHOLDS, TECH_PLANET_REQ, SHIP_STATS, AUTO_FLEET_INTERVAL,
    BUILDING_COSTS, SHIP_COSTS, LEVEL_UP_TICKS, TECH_BONUSES,
    MOTHERSHIP_SPAWN_INTERVAL, FLEET_UPGRADES,
)
from game.state import GameState, Planet, Ship, Faction
from game.orbits import (
    orbit_layout_for_index,
    orbit_phase_for_planet,
    orbit_radius_for_ring,
    orbit_ring_for_index,
)


def tick(state: GameState, planet_map: dict, ship_map: dict, faction_map: dict) -> None:
    """Run one simulation tick. Mutates state in place."""
    _update_orbits(state.ships, planet_map, state.tick)
    _recover_fuel(state.ships, planet_map)
    # Sensors only need ~1 Hz precision — skip 19 of every 20 ticks
    if state.tick % 20 == 0:
        _update_sensors(state.ships, state.planets)
    _recompute_planet_ships(state.planets, state.ships, planet_map)
    _harvest_resources(state.factions, state.planets, faction_map, state.dev_mode)
    _process_build_queues(state, planet_map, faction_map)
    _auto_fleet(state, faction_map)
    _mothership_spawn(state, faction_map)
    _advance_tech(state.factions, state.planets)


# ── Orbits ─────────────────────────────────────────────────────────────────────

def _update_orbits(ships: list[Ship], planet_map: dict, tick: int) -> None:
    by_planet: dict[str, list[Ship]] = {}
    by_anchor: dict[str, list[Ship]] = {}
    ship_map = {s.id: s for s in ships}
    for ship in ships:
        if ship.state == "orbiting" and ship.target_planet:
            by_planet.setdefault(ship.target_planet, []).append(ship)
        elif ship.state == "orbiting" and ship.target_ship:
            by_anchor.setdefault(ship.target_ship, []).append(ship)

    for planet_id, orbiting in by_planet.items():
        planet = planet_map.get(planet_id)
        if planet is None:
            continue

        ordered = sorted(orbiting, key=lambda s: s.id)
        rings: dict[int, list[Ship]] = {}
        for idx, ship in enumerate(ordered):
            ring_idx = orbit_ring_for_index(idx)
            rings.setdefault(ring_idx, []).append(ship)

        spin_phase = tick * ORBIT_SPEED
        base_phase = orbit_phase_for_planet(planet.id)

        for ring_idx, ring_ships in rings.items():
            count = len(ring_ships)
            if count <= 0:
                continue

            radius = orbit_radius_for_ring(planet, ring_idx)
            step = 2 * math.pi / count
            ring_phase = (step * 0.5) if (ring_idx % 2 == 1) else 0.0
            start = (base_phase + spin_phase + ring_phase) % (2 * math.pi)

            for i, ship in enumerate(ring_ships):
                angle = (start + i * step) % (2 * math.pi)
                ship.orbit_radius = radius
                ship.orbit_angle = angle
                ship.x = round(planet.x + math.cos(angle) * radius, 2)
                ship.y = round(planet.y + math.sin(angle) * radius, 2)

    # Orbit around mothership anchors
    for anchor_id, orbiting in by_anchor.items():
        anchor = ship_map.get(anchor_id)
        if anchor is None or anchor.health <= 0:
            continue

        ordered = sorted(orbiting, key=lambda s: s.id)
        count = len(ordered)
        if count <= 0:
            continue

        rings: dict[int, list[Ship]] = {}
        for idx, ship in enumerate(ordered):
            ring_idx = idx // 8
            rings.setdefault(ring_idx, []).append(ship)

        spin_phase = tick * ORBIT_SPEED * 1.2
        for ring_idx, ring_ships in rings.items():
            n = len(ring_ships)
            if n <= 0:
                continue
            radius = 36.0 + ring_idx * 12.0
            step = 2 * math.pi / n
            start = spin_phase + (ring_idx * 0.33)
            for i, ship in enumerate(ring_ships):
                angle = (start + i * step) % (2 * math.pi)
                ship.orbit_radius = radius
                ship.orbit_angle = angle
                ship.x = round(anchor.x + math.cos(angle) * radius, 2)
                ship.y = round(anchor.y + math.sin(angle) * radius, 2)


# ── Sensor sweep ───────────────────────────────────────────────────────────────

def _update_sensors(ships: list[Ship], planets: list[Planet]) -> None:
    """Any ship within its sensor range of a planet reveals that planet to its faction."""
    _stats = SHIP_STATS
    for ship in ships:
        stats = _stats.get(ship.type)
        if stats is None:
            continue
        sensor = stats.get("sensor", 0)
        if sensor == 0:
            continue
        sensor_sq = sensor * sensor
        ship_owner = ship.owner
        ship_x, ship_y = ship.x, ship.y
        for planet in planets:
            if ship_owner in planet.explored_by:
                continue
            dx = planet.x - ship_x
            dy = planet.y - ship_y
            if dx * dx + dy * dy <= sensor_sq:
                planet.explored_by.append(ship_owner)


# ── Fuel recovery ──────────────────────────────────────────────────────────────

def _recover_fuel(ships: list[Ship], planet_map: dict) -> None:
    for ship in ships:
        if ship.state != "orbiting":
            continue
        if ship.fuel < 1.0:
            ship.fuel = round(min(1.0, ship.fuel + 0.01), 4)
        # Repair at friendly planet (1% max HP per tick)
        if ship.health < ship.max_health and ship.max_health > 0:
            planet = planet_map.get(ship.target_planet)
            if planet and planet.owner == ship.owner:
                ship.health = round(min(ship.max_health, ship.health + ship.max_health * 0.01), 2)


# ── Planet ship list (recomputed from authoritative state) ─────────────────────

def _recompute_planet_ships(
    planets: list[Planet], ships: list[Ship], planet_map: dict
) -> None:
    for planet in planets:
        planet.ships = []
    for ship in ships:
        if ship.state == "orbiting" and ship.target_planet:
            planet = planet_map.get(ship.target_planet)
            if planet:
                planet.ships.append(ship.id)


# ── Resource harvesting ────────────────────────────────────────────────────────

def _harvest_resources(
    factions: list[Faction], planets: list[Planet], faction_map: dict, dev_mode: bool = False
) -> None:
    # Single pass: accumulate income and infrastructure totals per faction
    totals: dict[str, dict] = {}
    for planet in planets:
        if planet.owner is None:
            continue
        faction = faction_map.get(planet.owner)
        if faction is None:
            continue

        extractors  = planet.buildings.count("extractor")
        trade_hubs  = planet.buildings.count("trade_hub")
        income = (BASE_INCOME_PER_PLANET
                  + (planet.level - 1) * LEVEL_INCOME_BONUS
                  + extractors  * EXTRACTOR_INCOME_BONUS
                  + trade_hubs  * TRADE_HUB_INCOME_BONUS
                  + planet.population * POPULATION_INCOME_BONUS) * planet.resource_rate
        faction.credits += income
        faction.research_points += planet.buildings.count("research_lab") * RESEARCH_PER_LAB

        t = totals.setdefault(planet.owner, {"extractors": 0, "shipyards": 0, "planets": 0})
        t["extractors"] += extractors
        t["shipyards"]  += planet.buildings.count("shipyard")
        t["planets"]    += 1

    # Update storage capacity once per faction (O(factions) not O(planets²))
    for fid, t in totals.items():
        faction = faction_map.get(fid)
        if faction is None:
            continue
        faction.storage_capacity = (
            BASE_STORAGE_CAPACITY
            + t["extractors"] * EXTRACTOR_STORAGE_BONUS
            + t["shipyards"]  * SHIPYARD_STORAGE_BONUS
            + t["planets"]    * PLANET_STORAGE_BONUS
        )
        if not dev_mode:
            faction.credits = min(faction.credits, faction.storage_capacity)


# ── Ship spawning helper ───────────────────────────────────────────────────────

def _spawn_ship(state: GameState, planet: Planet, ship_type: str, owner: str,
                faction=None) -> None:
    """Create a ship in orbit around planet and emit a ship_spawned event.

    Applies TECH_BONUSES HP multiplier based on faction.tech_tier.
    """
    stats = SHIP_STATS.get(ship_type)
    if not stats:
        return
    tier   = faction.tech_tier if faction else 1
    bonus  = TECH_BONUSES.get(tier, TECH_BONUSES[1])
    # Apply fleet upgrade bonuses on top of tech bonuses
    fu = faction.fleet_upgrades if faction else {}
    hp_mult = bonus["hp"] * (1.0 + fu.get("health", 0) * FLEET_UPGRADES["health"]["bonus_per_level"])
    hp     = round(float(stats["hp"]) * hp_mult, 1)
    speed_mult = bonus["speed"] * (1.0 + fu.get("speed", 0) * FLEET_UPGRADES["speed"]["bonus_per_level"])
    damage_mult = bonus["damage"] * (1.0 + fu.get("damage", 0) * FLEET_UPGRADES["damage"]["bonus_per_level"])
    # Use planet.ships length (maintained by _recompute_planet_ships) instead
    # of iterating all ships to count orbiting at this planet
    orbiting_here = len(planet.ships)
    orbit_r, angle = orbit_layout_for_index(planet, orbiting_here)
    state.ship_id_counter += 1
    new_ship = Ship(
        id=f"s-{state.ship_id_counter:04d}",
        type=ship_type,
        owner=owner,
        x=round(planet.x + math.cos(angle) * orbit_r, 2),
        y=round(planet.y + math.sin(angle) * orbit_r, 2),
        health=hp,
        max_health=hp,
        state="orbiting",
        target_planet=planet.id,
        orbit_angle=angle,
        orbit_radius=orbit_r,
        speed_mult=round(speed_mult, 4),
        damage_mult=round(damage_mult, 4),
    )
    state.ships.append(new_ship)
    planet.ships.append(new_ship.id)
    # Track build stats
    if faction:
        faction.ships_built += 1
        faction.ships_built_by_type[ship_type] = faction.ships_built_by_type.get(ship_type, 0) + 1
    state.tick_events.append({
        "type": "ship_spawned",
        "ship": {
            "id":            new_ship.id,
            "type":          new_ship.type,
            "owner":         new_ship.owner,
            "x":             new_ship.x,
            "y":             new_ship.y,
            "vx":            0.0,
            "vy":            0.0,
            "health":        new_ship.health,
            "max_health":    new_ship.max_health,
            "state":         new_ship.state,
            "target_planet": new_ship.target_planet,
            "target_ship":   None,
            "orbit_angle":   new_ship.orbit_angle,
            "orbit_radius":  new_ship.orbit_radius,
            "target_x":      None,
            "target_y":      None,
            "fuel":          new_ship.fuel,
            "energy_level":  new_ship.energy_level,
            "rogue":         False,
        },
    })


# ── Build queues ───────────────────────────────────────────────────────────────

def _process_build_queues(state: GameState, planet_map: dict, faction_map: dict) -> None:
    """Tick down build queues; complete buildings and spawn ships when done."""
    dev_mode = bool(getattr(state, "dev_mode", False))
    for planet in state.planets:
        if not planet.build_queue:
            continue

        while planet.build_queue:
            item = planet.build_queue[0]
            item["ticks_remaining"] = item.get("ticks_remaining", 0) - 1

            if item["ticks_remaining"] > 0:
                break

            planet.build_queue.pop(0)

            if item["type"] == "building":
                name = item["name"]
                if name not in planet.buildings:
                    planet.buildings.append(name)

            elif item["type"] == "ship":
                ship_type = item.get("ship_type", "fighter")
                if planet.owner is not None and SHIP_STATS.get(ship_type):
                    faction = faction_map.get(planet.owner)
                    _spawn_ship(state, planet, ship_type, planet.owner, faction=faction)

            elif item["type"] == "level_up":
                if planet.level < 5:
                    planet.level += 1

            if not dev_mode:
                break


# ── Auto-fleet generation ──────────────────────────────────────────────────────

def _auto_fleet(state: GameState, faction_map: dict) -> None:
    """Each owned planet spawns a burst of ships every AUTO_FLEET_INTERVAL ticks.

    Burst size scales with planet level:  level 1 → 1,  level 2 → 2, etc.
    Spawns are staggered across planets to avoid a single massive simultaneous batch.
    Ships are distributed evenly around the orbit so they don't stack on one spot.
    """
    for i, planet in enumerate(state.planets):
        if planet.owner is None:
            continue
        faction = faction_map.get(planet.owner)
        if faction is None or faction.eliminated:
            continue
        # Stagger: planet i fires when (tick + i) % interval == 0
        if (state.tick + i) % AUTO_FLEET_INTERVAL != 0:
            continue

        # Skip if this planet already has ships queued (NPCs don't get both free + queued)
        if faction.archetype != "player" and planet.build_queue:
            continue

        count = planet.level
        ship_type = "fighter"  # auto-fleet always spawns basic fighters

        for _ in range(count):
            _spawn_ship(state, planet, ship_type, planet.owner, faction=faction)


# ── Mothership fighter spawning ─────────────────────────────────────────────

def _mothership_spawn(state: GameState, faction_map: dict) -> None:
    """Motherships periodically spawn fighters near themselves.

    Spawn count scales with mothership_level (min 1).
    """
    fighter_stats = SHIP_STATS.get("fighter")
    if not fighter_stats:
        return

    new_ships: list[Ship] = []
    for ship in state.ships:
        if ship.type != "mothership" or ship.health <= 0:
            continue
        ship.spawn_timer += 1
        if ship.spawn_timer < MOTHERSHIP_SPAWN_INTERVAL:
            continue
        ship.spawn_timer = 0

        faction = faction_map.get(ship.owner)
        tier   = faction.tech_tier if faction else 1
        bonus  = TECH_BONUSES.get(tier, TECH_BONUSES[1])
        fu = faction.fleet_upgrades if faction else {}
        hp_mult = bonus["hp"] * (1.0 + fu.get("health", 0) * FLEET_UPGRADES["health"]["bonus_per_level"])
        hp     = round(float(fighter_stats["hp"]) * hp_mult, 1)
        spd_m  = round(bonus["speed"] * (1.0 + fu.get("speed", 0) * FLEET_UPGRADES["speed"]["bonus_per_level"]), 4)
        dmg_m  = round(bonus["damage"] * (1.0 + fu.get("damage", 0) * FLEET_UPGRADES["damage"]["bonus_per_level"]), 4)

        spawn_count = max(1, int(getattr(ship, "mothership_level", 1)))
        base_index = len(new_ships)
        mode = getattr(ship, "mothership_mode", "orbit")
        for local_index in range(spawn_count):
            # Spawn fighters in a ring around the mothership
            idx = base_index + local_index
            angle = (idx * 2.399)  # golden angle for spacing
            offset = 30.0
            state.ship_id_counter += 1
            new_ship = Ship(
                id=f"s-{state.ship_id_counter:04d}",
                type="fighter",
                owner=ship.owner,
                x=round(ship.x + math.cos(angle) * offset, 2),
                y=round(ship.y + math.sin(angle) * offset, 2),
                health=hp,
                max_health=hp,
                state="moving" if mode == "formation" else "orbiting",
                target_planet=None,
                target_ship=ship.id,
                target_x=float(ship.x),
                target_y=float(ship.y),
                orbit_angle=angle,
                orbit_radius=36.0,
                speed_mult=spd_m,
                damage_mult=dmg_m,
            )
            new_ships.append(new_ship)
            state.tick_events.append({
                "type": "ship_spawned",
                "ship": {
                    "id":            new_ship.id,
                    "type":          new_ship.type,
                    "owner":         new_ship.owner,
                    "x":             new_ship.x,
                    "y":             new_ship.y,
                    "vx":            0.0,
                    "vy":            0.0,
                    "health":        new_ship.health,
                    "max_health":    new_ship.max_health,
                    "state":         new_ship.state,
                    "target_planet": new_ship.target_planet,
                    "target_ship":   new_ship.target_ship,
                    "orbit_angle":   new_ship.orbit_angle,
                    "orbit_radius":  new_ship.orbit_radius,
                    "target_x":      new_ship.target_x,
                    "target_y":      new_ship.target_y,
                    "fuel":          new_ship.fuel,
                    "energy_level":  new_ship.energy_level,
                    "rogue":         False,
                },
            })

    state.ships.extend(new_ships)


# ── Tech tier advancement ──────────────────────────────────────────────────────

def _advance_tech(factions: list[Faction], planets: list[Planet]) -> None:
    # Count planets per faction at each level
    level_counts: dict[str, dict[int, int]] = {}  # faction_id -> {min_level: count}
    for p in planets:
        if p.owner:
            fc = level_counts.setdefault(p.owner, {})
            for lv in range(1, p.level + 1):
                fc[lv] = fc.get(lv, 0) + 1
    for faction in factions:
        fc = level_counts.get(faction.id, {})
        for tier, threshold in sorted(TECH_THRESHOLDS.items()):
            req = TECH_PLANET_REQ.get(tier)
            if req is None:
                planets_ok = True
            else:
                need_count, need_level = req
                planets_ok = fc.get(need_level, 0) >= need_count
            if faction.tech_tier < tier and faction.research_points >= threshold and planets_ok:
                faction.tech_tier = tier
