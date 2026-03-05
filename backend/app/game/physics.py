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


def physics_tick(ships: list[Ship], planets: list[Planet], planet_map: dict) -> None:
    moving = [s for s in ships if s.state in ("moving", "retreating")]
    for ship in ships:
        if ship.state == "orbiting":
            continue    # kinematics handled elsewhere

        if ship.state == "idle":
            _tick_idle(ship, planets, planet_map, ships)
        elif ship.state in ("moving", "retreating"):
            _tick_moving(ship, planets, planet_map, moving, ships)
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
    else:
        arrival = ARRIVAL_THRESHOLD

    if dist < arrival:
        _handle_arrival(ship, planet_map, ships or [])
        return

    # Direct velocity toward target at ship speed.
    # No gravity for thrusting ships — G is strong enough near planets that it
    # would overpower thrust and throw ships off course instead of perturbing them.
    speed   = SHIP_STATS[ship.type]["speed"] * ship.energy_level
    goal_x = dx / dist
    goal_y = dy / dist

    sep_x = sep_y = 0.0
    align_x = align_y = 0.0
    coh_x = coh_y = 0.0
    align_n = 0
    coh_n = 0

    if moving_ships:
        for other in moving_ships:
            if other.id == ship.id:
                continue
            if other.owner != ship.owner:
                continue

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
    for planet in planets:
        dx = planet.x - ship.x
        dy = planet.y - ship.y
        dist_sq = dx * dx + dy * dy
        if dist_sq < 1:
            continue
        dist = math.sqrt(dist_sq)
        influence_r = planet.radius * INFLUENCE_RADIUS_FACTOR
        if dist < influence_r:
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
    # Free-space arrival — transition to idle drift
    ship.state      = "idle"
    ship.target_x   = None
    ship.target_y   = None


def _check_planet_proximity(ship: Ship, planets: list[Planet], ships: list[Ship]) -> None:
    """Capture idle/drifting ships that wander onto a planet surface."""
    for planet in planets:
        dx   = planet.x - ship.x
        dy   = planet.y - ship.y
        dist = math.sqrt(dx * dx + dy * dy)
        max_ring_offset = ORBIT_OFFSET + (max(1, ORBIT_RING_LEVELS) - 1) * ORBIT_RING_STEP
        if dist < planet.radius + max_ring_offset + ARRIVAL_THRESHOLD:
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
