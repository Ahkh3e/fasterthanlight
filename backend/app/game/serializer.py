from game.state import GameState, Planet, Ship, Faction  # noqa: F401


def serialize_state(state: GameState) -> dict:
    """Full state snapshot — sent on WebSocket connect and written to save files."""
    return {
        "id": state.id,
        "seed": state.seed,
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

    Includes: tick counter, status, ship updates (only moving/changing ships
    are sent each tick; orbiting ships are sent once per second to save bandwidth),
    faction resource totals, planet ownership snapshots, and combat events.
    """
    # Always send ships that are actively changing state
    # Orbiting/idle ships only need periodic sync (~1 Hz)
    full_sync = (state.tick % 20 == 0)
    if full_sync:
        ship_deltas = [_ship_delta(s) for s in state.ships]
    else:
        ship_deltas = [
            _ship_delta(s) for s in state.ships
            if s.state in ("moving", "attacking", "retreating", "idle")
        ]

    return {
        "tick":     state.tick,
        "status":   state.status,
        "ships":    ship_deltas,
        "ships_partial": not full_sync,
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
        # ai_timer is internal; not sent to client
    }


# ── Delta serialisers ─────────────────────────────────────────────────────────

def _ship_delta(s: Ship) -> dict:
    """Minimal ship update for tick deltas — position, state, health, movement info."""
    d = {
        "id":            s.id,
        "x":             s.x,
        "y":             s.y,
        "state":         s.state,
        "health":        round(s.health, 1),
        "target_planet": s.target_planet,   # kept in sync so planet-click selection works
    }
    if s.state in ("moving", "retreating"):
        d["vx"]       = round(s.vx, 2)
        d["vy"]       = round(s.vy, 2)
        d["target_x"] = s.target_x
        d["target_y"] = s.target_y
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
    }
