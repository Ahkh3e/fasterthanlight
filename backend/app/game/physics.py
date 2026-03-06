"""M4 physics: gravity + thrust + Verlet integration.

Each tick, ships in 'moving' or 'idle' state are simulated here.
Orbiting ships are handled kinematically by simulation.py (no physics).

Movement model (game-feel friendly):
  - Moving ships: velocity is set directly toward target each tick at ship speed.
    No gravity — ships are thrusting and travel predictably to their destination.
  - Idle ships: damping applied until ship stops; gravity still acts.
"""

import math

from game.config import (
    G, INFLUENCE_RADIUS_FACTOR, ARRIVAL_THRESHOLD,
    ORBIT_OFFSET, ORBIT_RING_LEVELS, ORBIT_RING_STEP,
    SHIP_STATS, GALAXY_WIDTH, GALAXY_HEIGHT,
)
from game.state import Ship, Planet
from game.orbits import orbit_layout_for_index

DT = 0.05   # seconds per tick at 20 Hz

SWARM_SEP_RADIUS = 32.0   # ships push apart within this distance
SWARM_SEP_WEIGHT = 0.7    # steering weight for separation
SWARM_ALIGN_RADIUS = 160.0
SWARM_ALIGN_WEIGHT = 0.40
SWARM_COH_RADIUS = 200.0
SWARM_COH_WEIGHT = 0.28
SWARM_GOAL_WEIGHT = 1.0

# Spatial grid for O(n) swarm lookups instead of O(n²)
SWARM_GRID_SIZE = 200.0          # cell size ≥ largest interaction radius
SWARM_GRID_INV  = 1.0 / SWARM_GRID_SIZE
MAX_SWARM_NEIGHBORS = 16         # cap neighbours to avoid chaotic forces in large blobs


def _build_swarm_grid(ships: list[Ship]) -> dict[tuple[int, int], list[Ship]]:
    """Bucket moving ships into a spatial grid for fast neighbour queries."""
    grid: dict[tuple[int, int], list[Ship]] = {}
    inv = SWARM_GRID_INV
    for s in ships:
        key = (int(s.x * inv), int(s.y * inv))
        grid.setdefault(key, []).append(s)
    return grid


def _nearby_swarm(grid: dict[tuple[int, int], list[Ship]], ship: Ship) -> list[Ship]:
    """Return ships in the 3×3 neighbourhood of *ship*'s grid cell."""
    inv = SWARM_GRID_INV
    cx = int(ship.x * inv)
    cy = int(ship.y * inv)
    result: list[Ship] = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            cell = grid.get((cx + dx, cy + dy))
            if cell:
                result.extend(cell)
    return result


def physics_tick(ships: list[Ship], planets: list[Planet], planet_map: dict) -> None:
    # Pre-partition moving/retreating ships by owner for swarm behaviour
    moving_by_owner: dict[str, list[Ship]] = {}
    for s in ships:
        if s.state in ("moving", "retreating"):
            moving_by_owner.setdefault(s.owner, []).append(s)

    # Build one spatial grid per owner for O(k) neighbour queries instead of O(n²)
    swarm_grids: dict[str, dict[tuple[int, int], list[Ship]]] = {}
    for owner, ms in moving_by_owner.items():
        if len(ms) > 1:
            swarm_grids[owner] = _build_swarm_grid(ms)

    for ship in ships:
        if ship.state == "orbiting":
            continue    # kinematics handled elsewhere

        if ship.state == "idle":
            _tick_idle(ship, planets, planet_map, ships)
        elif ship.state in ("moving", "retreating"):
            grid = swarm_grids.get(ship.owner)
            nearby = _nearby_swarm(grid, ship) if grid else moving_by_owner.get(ship.owner)
            _tick_moving(ship, planets, planet_map, nearby, ships)
        # "attacking" movement handled in combat.py (needs ship_map)


# ── State handlers ────────────────────────────────────────────────────────────

def _tick_idle(ship: Ship, planets: list[Planet], planet_map: dict,
               ships: list[Ship]) -> None:
    gx, gy = _gravity(ship, planets)
    ship.vx = ship.vx * 0.90 + gx * DT
    ship.vy = ship.vy * 0.90 + gy * DT
    ship.x = round(ship.x + ship.vx * DT, 2)
    ship.y = round(ship.y + ship.vy * DT, 2)
    _clamp_bounds(ship)
    _check_planet_proximity(ship, planets, ships)


def _tick_moving(ship: Ship, planets: list[Planet], planet_map: dict,
                 moving_ships: list[Ship] | None = None,
                 ships: list[Ship] | None = None) -> None:
    if ship.target_x is None:
        ship.state = "idle"
        return

    # Dynamic follow target: if moving toward a ship, refresh target point each tick
    formation_follow = False
    if ship.target_ship and not ship.target_planet and ships:
        anchor = next((s for s in ships if s.id == ship.target_ship and s.health > 0), None)
        if anchor:
            if anchor.type == "mothership" and getattr(anchor, "mothership_mode", "orbit") == "formation":
                formation_follow = True
                followers = sorted(
                    [s for s in ships if s.target_ship == anchor.id and s.owner == anchor.owner and s.id != anchor.id],
                    key=lambda s: s.id,
                )
                try:
                    idx = followers.index(ship)
                except ValueError:
                    idx = 0
                col_count = 3
                row = idx // col_count
                col = idx % col_count
                lane = (col - (col_count - 1) / 2.0)
                behind = 70.0 + row * 28.0
                side = lane * 26.0
                avx = anchor.vx if abs(anchor.vx) > 1e-3 or abs(anchor.vy) > 1e-3 else 0.0
                avy = anchor.vy if abs(anchor.vx) > 1e-3 or abs(anchor.vy) > 1e-3 else -1.0
                amag = math.sqrt(avx * avx + avy * avy)
                if amag <= 1e-6:
                    avx, avy, amag = 0.0, -1.0, 1.0
                fx, fy = avx / amag, avy / amag
                lx, ly = -fy, fx
                ship.target_x = float(anchor.x - fx * behind + lx * side)
                ship.target_y = float(anchor.y - fy * behind + ly * side)
            else:
                ship.target_x = float(anchor.x)
                ship.target_y = float(anchor.y)
        else:
            ship.target_ship = None

    dx = ship.target_x - ship.x
    dy = ship.target_y - ship.y
    dist = math.sqrt(dx * dx + dy * dy)
    if dist <= 1e-6:
        ship.state = "idle"
        return

    # For planet-bound moves, stop at the orbit circle rather than the planet centre.
    # This prevents ships from visually crashing into the planet body.
    if ship.target_planet:
        planet = planet_map.get(ship.target_planet)
        if planet:
            max_ring_offset = ORBIT_OFFSET + (max(1, ORBIT_RING_LEVELS) - 1) * ORBIT_RING_STEP
            arrival = planet.radius + max_ring_offset
        else:
            arrival = ARRIVAL_THRESHOLD
    elif ship.target_ship:
        arrival = 42.0
    else:
        arrival = ARRIVAL_THRESHOLD

    if dist < arrival:
        if formation_follow:
            ship.vx = 0.0
            ship.vy = 0.0
            return
        _handle_arrival(ship, planet_map, ships or [])
        return

    # Direct velocity toward target at ship speed.
    # No gravity for thrusting ships — G is strong enough near planets that it
    # would overpower thrust and throw ships off course instead of perturbing them.
    speed   = SHIP_STATS[ship.type]["speed"] * ship.energy_level * getattr(ship, 'speed_mult', 1.0)
    goal_x = dx / dist
    goal_y = dy / dist

    sep_x = sep_y = 0.0
    align_x = align_y = 0.0
    coh_x = coh_y = 0.0
    align_n = 0
    coh_n = 0
    _max_neighbors = MAX_SWARM_NEIGHBORS
    neighbor_count = 0

    if moving_ships:
        for other in moving_ships:
            if other.id == ship.id:
                continue
            if neighbor_count >= _max_neighbors:
                break

            odx = ship.x - other.x
            ody = ship.y - other.y
            d2  = odx * odx + ody * ody

            if 0 < d2 < SWARM_SEP_RADIUS * SWARM_SEP_RADIUS:
                d        = math.sqrt(d2)
                strength = (SWARM_SEP_RADIUS - d) / SWARM_SEP_RADIUS
                sep_x   += (odx / d) * strength
                sep_y   += (ody / d) * strength

            if d2 < SWARM_ALIGN_RADIUS * SWARM_ALIGN_RADIUS:
                ov_mag = math.sqrt(other.vx * other.vx + other.vy * other.vy)
                if ov_mag > 1e-6:
                    align_x += other.vx / ov_mag
                    align_y += other.vy / ov_mag
                    align_n += 1

            if d2 < SWARM_COH_RADIUS * SWARM_COH_RADIUS:
                coh_x += other.x
                coh_y += other.y
                coh_n += 1
                neighbor_count += 1

    if align_n > 0:
        align_x /= align_n
        align_y /= align_n

    if coh_n > 0:
        coh_x = (coh_x / coh_n) - ship.x
        coh_y = (coh_y / coh_n) - ship.y
        coh_mag = math.sqrt(coh_x * coh_x + coh_y * coh_y)
        if coh_mag > 1e-6:
            coh_x /= coh_mag
            coh_y /= coh_mag
        else:
            coh_x = 0.0
            coh_y = 0.0

    steer_x = (
        goal_x * SWARM_GOAL_WEIGHT
        + sep_x * SWARM_SEP_WEIGHT
        + align_x * SWARM_ALIGN_WEIGHT
        + coh_x * SWARM_COH_WEIGHT
    )
    steer_y = (
        goal_y * SWARM_GOAL_WEIGHT
        + sep_y * SWARM_SEP_WEIGHT
        + align_y * SWARM_ALIGN_WEIGHT
        + coh_y * SWARM_COH_WEIGHT
    )

    steer_mag = math.sqrt(steer_x * steer_x + steer_y * steer_y)
    if steer_mag > 1e-6:
        vx = (steer_x / steer_mag) * speed
        vy = (steer_y / steer_mag) * speed
    else:
        vx = goal_x * speed
        vy = goal_y * speed

    ship.vx = vx
    ship.vy = vy
    ship.x = round(ship.x + ship.vx * DT, 2)
    ship.y = round(ship.y + ship.vy * DT, 2)
    _clamp_bounds(ship)

    # Fuel consumption while thrusting
    fuel_rate = SHIP_STATS[ship.type]["fuel"] * ship.energy_level
    ship.fuel = round(max(0.0, ship.fuel - fuel_rate), 4)


# ── Gravity ───────────────────────────────────────────────────────────────────

def _gravity(ship: Ship, planets: list[Planet]) -> tuple[float, float]:
    ax, ay = 0.0, 0.0
    _sqrt = math.sqrt
    _inf_factor_sq = INFLUENCE_RADIUS_FACTOR * INFLUENCE_RADIUS_FACTOR
    ship_x, ship_y = ship.x, ship.y
    for planet in planets:
        dx = planet.x - ship_x
        dy = planet.y - ship_y
        dist_sq = dx * dx + dy * dy
        if dist_sq < 1:
            continue
        # Squared-distance check avoids sqrt for distant planets
        inf_r_sq = planet.radius * planet.radius * _inf_factor_sq
        if dist_sq < inf_r_sq:
            dist  = _sqrt(dist_sq)
            mass  = planet.radius * 50.0
            force = G * mass / dist_sq
            ax   += force * (dx / dist)
            ay   += force * (dy / dist)
    return ax, ay


# ── Arrival ───────────────────────────────────────────────────────────────────

def _handle_arrival(ship: Ship, planet_map: dict, ships: list[Ship]) -> None:
    if ship.target_planet:
        planet = planet_map.get(ship.target_planet)
        if planet:
            orbiting_here = sum(
                1 for s in ships
                if s.id != ship.id and s.state == "orbiting" and s.target_planet == planet.id
            )
            orbit_radius, orbit_angle = orbit_layout_for_index(planet, orbiting_here)
            ship.state       = "orbiting"
            ship.orbit_radius = orbit_radius
            ship.orbit_angle  = orbit_angle
            # Snap to exact orbit circle
            ship.x  = round(planet.x + math.cos(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.y  = round(planet.y + math.sin(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.vx = 0.0
            ship.vy = 0.0
            return
    if ship.target_ship:
        anchor = next((s for s in ships if s.id == ship.target_ship and s.health > 0), None)
        if anchor:
            orbiting_here = sum(
                1 for s in ships
                if s.id != ship.id and s.state == "orbiting" and s.target_ship == anchor.id
            )
            ring = orbiting_here // 8
            slot = orbiting_here % 8
            ship.orbit_radius = 36.0 + ring * 12.0
            ship.orbit_angle = (slot / 8.0) * (2.0 * math.pi)
            ship.state = "orbiting"
            ship.target_planet = None
            ship.target_ship = anchor.id
            ship.x = round(anchor.x + math.cos(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.y = round(anchor.y + math.sin(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.vx = 0.0
            ship.vy = 0.0
            return
    # Free-space arrival — transition to idle drift
    ship.state      = "idle"
    ship.target_ship = None
    ship.target_x   = None
    ship.target_y   = None


def _check_planet_proximity(ship: Ship, planets: list[Planet], ships: list[Ship]) -> None:
    """Capture idle/drifting ships that wander onto a planet surface."""
    # Precompute constant offset outside the loop
    max_ring_offset = ORBIT_OFFSET + (max(1, ORBIT_RING_LEVELS) - 1) * ORBIT_RING_STEP
    ship_x, ship_y = ship.x, ship.y
    for planet in planets:
        dx   = planet.x - ship_x
        dy   = planet.y - ship_y
        threshold = planet.radius + max_ring_offset + ARRIVAL_THRESHOLD
        if dx * dx + dy * dy < threshold * threshold:
            orbiting_here = sum(
                1 for s in ships
                if s.id != ship.id and s.state == "orbiting" and s.target_planet == planet.id
            )
            orbit_radius, orbit_angle = orbit_layout_for_index(planet, orbiting_here)
            ship.state        = "orbiting"
            ship.target_planet = planet.id
            ship.orbit_radius  = orbit_radius
            ship.orbit_angle   = orbit_angle
            ship.x  = round(planet.x + math.cos(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.y  = round(planet.y + math.sin(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.vx = 0.0
            ship.vy = 0.0
            return


# ── Utilities ─────────────────────────────────────────────────────────────────

def _clamp_bounds(ship: Ship) -> None:
    ship.x = max(0.0, min(float(GALAXY_WIDTH),  ship.x))
    ship.y = max(0.0, min(float(GALAXY_HEIGHT), ship.y))
