import math

from game.config import ORBIT_OFFSET, ORBIT_RING_LEVELS, ORBIT_RING_STEP, ORBIT_RING_PATTERN
from game.state import Planet


def _phase_for_planet(planet_id: str) -> float:
    h = 0
    for ch in planet_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return (h % 360) * math.pi / 180.0


def orbit_phase_for_planet(planet_id: str) -> float:
    return _phase_for_planet(planet_id)


def _pattern() -> tuple[int, ...]:
    levels = max(1, ORBIT_RING_LEVELS)
    p = tuple(ORBIT_RING_PATTERN[:levels])
    if not p:
        return (1,)
    return p


def _shell_for_index(index: int) -> tuple[int, int, int, int]:
    pattern = _pattern()
    cycle = sum(pattern)
    compression = index // cycle
    within = index % cycle

    acc = 0
    ring_idx = 0
    slot_in_shell = 0
    base_slots = pattern[0]
    for i, cap in enumerate(pattern):
        if within < acc + cap:
            ring_idx = i
            slot_in_shell = within - acc
            base_slots = cap
            break
        acc += cap

    return ring_idx, slot_in_shell, base_slots, compression


def orbit_ring_for_index(index: int) -> int:
    ring_idx, _, _, _ = _shell_for_index(index)
    return ring_idx


def orbit_radius_for_ring(planet: Planet, ring_idx: int) -> float:
    return planet.radius + ORBIT_OFFSET + ring_idx * ORBIT_RING_STEP


def orbit_layout_for_index(planet: Planet, index: int) -> tuple[float, float]:
    ring_idx, slot_in_shell, base_slots, compression = _shell_for_index(index)
    layers = compression + 1
    total_slots = base_slots * layers
    slot = slot_in_shell * layers + compression

    step = 2 * math.pi / total_slots
    shared_phase = _phase_for_planet(planet.id)
    # Keep ring-to-ring symmetry by using a deterministic half-step interleave
    # on odd rings, while preserving equal spacing within each ring.
    ring_phase = (step * 0.5) if (ring_idx % 2 == 1) else 0.0
    angle = (shared_phase + ring_phase + slot * step) % (2 * math.pi)

    radius = orbit_radius_for_ring(planet, ring_idx)
    return radius, angle
