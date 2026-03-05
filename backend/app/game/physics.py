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
    ORBIT_OFFSET, SHIP_STATS, GALAXY_WIDTH, GALAXY_HEIGHT,
)
from game.state import Ship, Planet

DT = 0.05   # seconds per tick at 20 Hz

SWARM_SEP_RADIUS = 32.0   # ships push apart within this distance
SWARM_SEP_WEIGHT = 0.7    # steering weight for separation


def physics_tick(ships: list[Ship], planets: list[Planet], planet_map: dict) -> None:
    moving = [s for s in ships if s.state in ("moving", "retreating")]
    for ship in ships:
        if ship.state == "orbiting":
            continue    # kinematics handled elsewhere

        if ship.state == "idle":
            _tick_idle(ship, planets, planet_map)
        elif ship.state in ("moving", "retreating"):
            _tick_moving(ship, planets, planet_map, moving)
        # "attacking" movement handled in combat.py (needs ship_map)


# ── State handlers ────────────────────────────────────────────────────────────

def _tick_idle(ship: Ship, planets: list[Planet], planet_map: dict) -> None:
    gx, gy = _gravity(ship, planets)
    ship.vx = ship.vx * 0.90 + gx * DT
    ship.vy = ship.vy * 0.90 + gy * DT
    ship.x = round(ship.x + ship.vx * DT, 2)
    ship.y = round(ship.y + ship.vy * DT, 2)
    _clamp_bounds(ship)
    _check_planet_proximity(ship, planets)


def _tick_moving(ship: Ship, planets: list[Planet], planet_map: dict,
                 moving_ships: list[Ship] | None = None) -> None:
    if ship.target_x is None:
        ship.state = "idle"
        return

    dx = ship.target_x - ship.x
    dy = ship.target_y - ship.y
    dist = math.sqrt(dx * dx + dy * dy)

    # For planet-bound moves, stop at the orbit circle rather than the planet centre.
    # This prevents ships from visually crashing into the planet body.
    if ship.target_planet:
        planet = planet_map.get(ship.target_planet)
        arrival = (planet.radius + ORBIT_OFFSET) if planet else ARRIVAL_THRESHOLD
    else:
        arrival = ARRIVAL_THRESHOLD

    if dist < arrival:
        _handle_arrival(ship, planet_map)
        return

    # Direct velocity toward target at ship speed.
    # No gravity for thrusting ships — G is strong enough near planets that it
    # would overpower thrust and throw ships off course instead of perturbing them.
    speed   = SHIP_STATS[ship.type]["speed"] * ship.energy_level
    vx = speed * (dx / dist)
    vy = speed * (dy / dist)

    # Swarm separation: steer away from nearby moving ships to form loose cloud formations
    if moving_ships:
        sep_x = sep_y = 0.0
        for other in moving_ships:
            if other.id == ship.id:
                continue
            odx = ship.x - other.x
            ody = ship.y - other.y
            d2  = odx * odx + ody * ody
            if 0 < d2 < SWARM_SEP_RADIUS * SWARM_SEP_RADIUS:
                d        = math.sqrt(d2)
                strength = (SWARM_SEP_RADIUS - d) / SWARM_SEP_RADIUS
                sep_x   += (odx / d) * strength
                sep_y   += (ody / d) * strength
        if sep_x or sep_y:
            vx += sep_x * SWARM_SEP_WEIGHT * speed
            vy += sep_y * SWARM_SEP_WEIGHT * speed
            mag = math.sqrt(vx * vx + vy * vy)
            if mag > 0:
                vx = vx / mag * speed
                vy = vy / mag * speed

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

def _handle_arrival(ship: Ship, planet_map: dict) -> None:
    if ship.target_planet:
        planet = planet_map.get(ship.target_planet)
        if planet:
            ship.state       = "orbiting"
            ship.orbit_radius = planet.radius + ORBIT_OFFSET
            ship.orbit_angle  = math.atan2(ship.y - planet.y, ship.x - planet.x)
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


def _check_planet_proximity(ship: Ship, planets: list[Planet]) -> None:
    """Capture idle/drifting ships that wander onto a planet surface."""
    for planet in planets:
        dx   = planet.x - ship.x
        dy   = planet.y - ship.y
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < planet.radius + ORBIT_OFFSET + ARRIVAL_THRESHOLD:
            ship.state        = "orbiting"
            ship.target_planet = planet.id
            ship.orbit_radius  = planet.radius + ORBIT_OFFSET
            ship.orbit_angle   = math.atan2(ship.y - planet.y, ship.x - planet.x)
            ship.x  = round(planet.x + math.cos(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.y  = round(planet.y + math.sin(ship.orbit_angle) * ship.orbit_radius, 2)
            ship.vx = 0.0
            ship.vy = 0.0
            return


# ── Utilities ─────────────────────────────────────────────────────────────────

def _clamp_bounds(ship: Ship) -> None:
    ship.x = max(0.0, min(float(GALAXY_WIDTH),  ship.x))
    ship.y = max(0.0, min(float(GALAXY_HEIGHT), ship.y))
