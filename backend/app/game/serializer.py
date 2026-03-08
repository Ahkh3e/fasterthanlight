from game.state import GameState, Planet, Ship, Faction  # noqa: F401


def serialize_state(state: GameState) -> dict:
    """Full state snapshot — sent on WebSocket connect and written to save files."""
    return {
        "id": state.id,
        "seed": state.seed,
        "dev_mode": state.dev_mode,
        "tick": state.tick,
        "running": state.running,
        "status": state.status,
        "player_faction_id": state.player_faction_id,
        "ship_id_counter": state.ship_id_counter,
        "planets":  [_planet(p)  for p in state.planets],
        "ships":    [_ship(s)    for s in state.ships],
        "factions": [_faction(f) for f in state.factions],
    }


def serialize_delta(state: GameState) -> dict:
    """Partial update pushed each tick.

    Includes: tick counter, status, all ship updates, faction resource totals,
    planet ownership snapshots, and combat events.

    Orbiting ships use a compact format (no x/y — client renders orbit locally).
    Moving/attacking/retreating ships include velocity and target data.
    """
    ship_deltas = [_ship_delta(s) for s in state.ships]

    return {
        "tick":     state.tick,
        "status":   state.status,
        "dev_mode": state.dev_mode,
        "ships":    ship_deltas,
        "factions": [_faction_resources(f) for f in state.factions],
        "planets":  [_planet_delta(p) for p in state.planets],
        "events":   list(state.tick_events),
    }


# ── Full serialisers ──────────────────────────────────────────────────────────

def _planet(p: Planet) -> dict:
    return {
        "id":            p.id,
        "name":          p.name,
        "x":             p.x,
        "y":             p.y,
        "radius":        p.radius,
        "owner":         p.owner,
        "resource_type": p.resource_type,
        "resource_rate": p.resource_rate,
        "population":    p.population,
        "defense":       p.defense,
        "buildings":     p.buildings,
        "build_queue":   p.build_queue,
        "level":         p.level,
        "explored_by":   p.explored_by,
        "lanes":         p.lanes,
        "ships":         p.ships,
    }


def _ship(s: Ship) -> dict:
    return {
        "id":           s.id,
        "type":         s.type,
        "owner":        s.owner,
        "x":            s.x,
        "y":            s.y,
        "vx":           s.vx,
        "vy":           s.vy,
        "health":       s.health,
        "max_health":   s.max_health,
        "state":        s.state,
        "target_planet": s.target_planet,
        "target_ship":  s.target_ship,
        "orbit_angle":  s.orbit_angle,
        "orbit_radius": s.orbit_radius,
        "target_x":     s.target_x,
        "target_y":     s.target_y,
        "fuel":         s.fuel,
        "energy_level": s.energy_level,
        "rogue":        s.rogue,
        "mothership_level": getattr(s, "mothership_level", 1),
        "mothership_mode": getattr(s, "mothership_mode", "orbit"),
        "mothership_upgrades": dict(getattr(s, "mothership_upgrades", {})),
    }


def _faction(f: Faction) -> dict:
    return {
        "id":              f.id,
        "name":            f.name,
        "archetype":       f.archetype,
        "home_planet":     f.home_planet,
        "colour":          f.colour,
        "credits":         round(f.credits, 1),
        "research_points": round(f.research_points, 1),
        "tech_tier":       f.tech_tier,
        "eliminated":      f.eliminated,
        "aggression":      round(f.aggression, 2),
        "storage_capacity": round(f.storage_capacity, 1),
        "fleet_upgrades":  dict(f.fleet_upgrades),
        "kills":           f.kills,
        "deaths":          f.deaths,
        "ships_built":     f.ships_built,
        "ships_built_by_type": dict(f.ships_built_by_type),
        "fleet_cap":       f.fleet_cap,
        # ai_timer is internal; not sent to client
    }


# ── Delta serialisers ─────────────────────────────────────────────────────────

def _ship_delta(s: Ship) -> dict:
    """Minimal ship update for tick deltas.

    Orbiting ships omit x/y (client renders orbit locally) but include
    orbit_radius so the client tracks ring reassignments.
    """
    if s.state == "orbiting":
        d = {
            "id":            s.id,
            "state":         "orbiting",
            "health":        round(s.health, 1),
            "target_planet": s.target_planet,
            "target_ship":   s.target_ship,
            "orbit_radius":  round(s.orbit_radius, 2),
        }
        if s.type == "mothership":
            d["mothership_level"] = getattr(s, "mothership_level", 1)
            d["mothership_mode"] = getattr(s, "mothership_mode", "orbit")
            d["mothership_upgrades"] = dict(getattr(s, "mothership_upgrades", {}))
        return d
    d = {
        "id":            s.id,
        "x":             s.x,
        "y":             s.y,
        "state":         s.state,
        "health":        round(s.health, 1),
        "target_planet": s.target_planet,
        "target_ship":   s.target_ship,
    }
    if s.state in ("moving", "retreating"):
        d["vx"]       = round(s.vx, 2)
        d["vy"]       = round(s.vy, 2)
        d["target_x"] = s.target_x
        d["target_y"] = s.target_y
    if s.type == "mothership":
        d["mothership_level"] = getattr(s, "mothership_level", 1)
        d["mothership_mode"] = getattr(s, "mothership_mode", "orbit")
        d["mothership_upgrades"] = dict(getattr(s, "mothership_upgrades", {}))
    return d


def _planet_delta(p: Planet) -> dict:
    """Minimal planet update — ownership, ships, buildings and queue change during play."""
    return {
        "id":          p.id,
        "owner":       p.owner,
        "defense":     p.defense,
        "level":       p.level,
        "ships":       p.ships,
        "explored_by": p.explored_by,
        "buildings":   p.buildings,
        "build_queue": p.build_queue,
    }


def _faction_resources(f: Faction) -> dict:
    return {
        "id":              f.id,
        "credits":         round(f.credits, 1),
        "research_points": round(f.research_points, 1),
        "tech_tier":       f.tech_tier,
        "eliminated":      f.eliminated,
        "storage_capacity": round(f.storage_capacity, 1),
        "fleet_upgrades":  dict(f.fleet_upgrades),
        "fleet_cap":       f.fleet_cap,
    }
