# ── Galaxy ────────────────────────────────────────────────────────────────────
GALAXY_WIDTH  = 10000
GALAXY_HEIGHT = 10000
MIN_PLANET_SEPARATION = 250
MAX_LANE_LENGTH = 1000
PLANET_RADIUS_MIN = 20
PLANET_RADIUS_MAX = 45
K_NEAREST_LANES = 3        # connect each planet to its k nearest neighbours
SENSOR_RANGE_DEFAULT = 300
SENSOR_RANGE_SCOUT   = 600

# ── Names ─────────────────────────────────────────────────────────────────────
PLANET_ADJ = [
    "Kelos","Varda","Nyx","Orin","Zeth","Mira","Cyra","Dusk",
    "Aeon","Vex","Sol","Kor","Ara","Lorn","Seph","Titan",
    "Helix","Gael","Pyros","Crux","Nexus","Void","Iron","Storm",
]
PLANET_NOUN = [
    "Prime","Reach","Deep","Edge","Gate","Hold","Mark","Port",
    "Rise","Fall","Core","Drift","Bastion","Fringe","Expanse",
    "Citadel","Passage","Veil","Forge","Shard",
]
FACTION_PREFIX = [
    "Hegemony","Compact","Union","Order","Collective","Empire","Republic",
]
FACTION_NAME = [
    "Kral","Vorryn","Dhess","Orath","Selun","Mynx","Zurai","Brennox","Celth",
]
FACTION_COLOURS = ["#e74c3c","#2ecc71","#f39c12","#9b59b6","#e67e22","#1abc9c","#e84393","#00cec9","#fdcb6e","#6c5ce7"]

# Distinct colours for PvP players (max 6 slots, all visually distinct)
PVP_PLAYER_COLOURS = ["#00ffff","#e74c3c","#2ecc71","#f39c12","#e84393","#6c5ce7"]

# ── Resources ─────────────────────────────────────────────────────────────────
# New unified currency system: Credits
# Replaces the confusing three-currency system (minerals, energy, rare)
CURRENCY_NAME = "Credits"

# Income rates (credits per tick, multiplied by planet.resource_rate 0.5–3.0)
BASE_INCOME_PER_PLANET  = 0.05    # Base income from owning a planet
EXTRACTOR_INCOME_BONUS  = 0.04    # Additional income per extractor building
POPULATION_INCOME_BONUS = 0.001   # Income bonus per population point
LEVEL_INCOME_BONUS      = 0.04    # Extra credits/tick per planet level above 1
TRADE_HUB_INCOME_BONUS  = 0.05    # Extra credits/tick per trade hub building

# Storage system
BASE_STORAGE_CAPACITY = 1000      # Base storage capacity
EXTRACTOR_STORAGE_BONUS = 300     # Additional storage per extractor
SHIPYARD_STORAGE_BONUS = 200      # Additional storage per shipyard
PLANET_STORAGE_BONUS = 100        # Additional storage per owned planet

# Building costs (credits)
BUILDING_COSTS = {
    "extractor":        100,
    "shipyard":         200,
    "research_lab":     150,
    "defense_platform": 250,
    "trade_hub":        350,   # level 2+, +income
    "orbital_cannon":   450,   # level 3+, heavy defense
}

# Building level requirements
BUILDING_LEVEL_REQ = {
    "extractor":        1,
    "shipyard":         1,
    "research_lab":     1,
    "defense_platform": 1,
    "trade_hub":        2,
    "orbital_cannon":   3,
}

# Ship costs (credits)
SHIP_COSTS = {
    "fighter":     50,
    "cruiser":     150,
    "bomber":      120,
    "carrier":     400,
    "dreadnought": 800,
    "mothership":  2500,
}

# Ship tier requirements
SHIP_TIER_REQ = {
    "fighter":     1,
    "cruiser":     2,
    "bomber":      2,
    "carrier":     3,
    "dreadnought": 3,
    "mothership":  3,
}

# Research and tech
RESEARCH_PER_LAB = 0.05
TECH_THRESHOLDS = {2: 500, 3: 2000}
TECH_PLANET_REQ = {2: (5, 2), 3: (10, 3)}  # (planet_count, min_planet_level) to advance

# Starting resources
PLAYER_START_CREDITS = 500.0
NPC_START_CREDITS = 300.0

# ── Planet leveling ───────────────────────────────────────────────────────────
LEVEL_UP_COSTS  = {1: 300, 2: 600, 3: 1200, 4: 2400}   # cost to upgrade from that level
LEVEL_UP_TICKS  = {1: 200, 2: 400, 3:  800, 4: 1600}   # build time in ticks
LEVEL_DEFENSE_BONUS = 0.05   # effective defense bonus per planet level above 1

# ── Fleet tech bonuses (applied at ship spawn) ────────────────────────────────
TECH_BONUSES = {
    1: {"hp": 1.0,  "speed": 1.0,  "damage": 1.0},
    2: {"hp": 1.2,  "speed": 1.1,  "damage": 1.1},
    3: {"hp": 1.5,  "speed": 1.25, "damage": 1.3},
}

# ── Physics ───────────────────────────────────────────────────────────────────
G                      = 500.0
INFLUENCE_RADIUS_FACTOR = 8
ARRIVAL_THRESHOLD       = 20
ORBIT_SPEED             = 0.015   # radians per tick
ORBIT_OFFSET            = 34      # units above planet radius (keeps ships outside orbital structures)
ORBIT_RING_LEVELS       = 3       # fixed ring count (kept for compatibility)
ORBIT_RING_PATTERN      = (8, 12, 16)  # inner→outer capacities before compression
ORBIT_RING_STEP         = 18      # spacing between orbit rings

# ── Ship stats: hp, damage, fire_rate (ticks), speed, sensor_range, fuel_cost ─
SHIP_STATS = {
    "fighter":     dict(hp=50,  damage=8,  fire_rate=15, speed=54.0, sensor=300, fuel=0.003),
    "cruiser":     dict(hp=150, damage=20, fire_rate=20, speed=39.6, sensor=350, fuel=0.004),
    "bomber":      dict(hp=120, damage=45, fire_rate=35, speed=32.4, sensor=300, fuel=0.004),
    "carrier":     dict(hp=300, damage=10, fire_rate=25, speed=25.2, sensor=400, fuel=0.006),
    "dreadnought": dict(hp=600, damage=80, fire_rate=30, speed=18.0, sensor=380, fuel=0.008),
    "mothership":  dict(hp=1000, damage=5,  fire_rate=40, speed=9.6,  sensor=450, fuel=0.010),
}
SHIP_ATTACK_RANGE = {
    "fighter":150, "cruiser":250,
    "bomber":200, "carrier":100, "dreadnought":350,
    "mothership":80,
}

# ── AI ────────────────────────────────────────────────────────────────────────
AI_DECISION_INTERVAL  = 120  # ticks between AI decisions (6 s at 20 Hz)
AUTO_FLEET_INTERVAL   = 800  # ticks between auto-fleet bursts per owned planet (40 s)
MAX_SHIPS_PER_FACTION = 30   # hard cap per faction to keep N² combat loop fast
MOTHERSHIP_SPAWN_INTERVAL = 400  # ticks between mothership fighter spawns (20 s)

# Build times for manually-queued ships (ticks at 20 Hz)
SHIP_BUILD_TICKS = {
    "fighter":     100,   #  5 s
    "cruiser":     200,   # 10 s
    "bomber":      180,   #  9 s
    "carrier":     500,   # 25 s
    "dreadnought": 800,   # 40 s
    "mothership":  1500,  # 75 s
}

# ── Conquest ──────────────────────────────────────────────────────────────────
CONQUEST_RADIUS         = 150   # must be < MIN_PLANET_SEPARATION so ships must travel
CONQUEST_THRESHOLD      = 0.55
CONQUEST_CHECKS_NEEDED  = 5     # consecutive checks needed (was 3)
DOMINANCE_CHECK_INTERVAL = 20   # ticks between checks (was 10)

# ── Win/Loss ──────────────────────────────────────────────────────────────────
WIN_PLANET_FRACTION = 0.80
PRESSURE_GALACTIC_WAR  = 2000
PRESSURE_ARMS_RACE     = 3000
PRESSURE_FINAL_PUSH    = 0.60
