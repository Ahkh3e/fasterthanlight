"""Simulate 2 NPC factions fighting each other.

Tracks: discoveries, fleet generation, conquests, resource flow.
Runs 3 seeds × 60 seconds each, then summarises issues found.
"""

import sys, os, random
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "app"))

from game.state import GameState
from game.physics import physics_tick
from game.simulation import tick as simulation_tick
from game.combat import combat_tick
from game.ai import ai_tick
from game.config import AUTO_FLEET_INTERVAL

TICKS = 1200   # 60 s at 20 Hz

# ── helpers ───────────────────────────────────────────────────────────────────

def flabel(fid, factions):
    if fid is None: return "neutral"
    f = next((f for f in factions if f.id == fid), None)
    return (f.name[:10] if f else fid)

def run_seed(seed):
    state = GameState.create(game_id="sim", seed=seed)

    # Capture starting home-planet info
    pm = {p.id: p for p in state.planets}
    home_info = {}
    for f in state.factions:
        h = pm.get(f.home_planet)
        if h:
            home_info[f.id] = dict(type=h.resource_type, rate=h.resource_rate, pop=h.population)

    log = []  # (tick, event_type, detail)
    explored_sets = {f.id: set(p.id for p in state.planets if f.id in p.explored_by)
                     for f in state.factions}

    for tick in range(1, TICKS + 1):
        state.tick = tick
        state.tick_events = []

        planet_map  = {p.id: p for p in state.planets}
        ship_map    = {s.id: s for s in state.ships}
        faction_map = {f.id: f for f in state.factions}

        physics_tick(state.ships, state.planets, planet_map)
        simulation_tick(state, planet_map, ship_map, faction_map)
        combat_tick(state, planet_map, ship_map, faction_map)
        ai_tick(state, planet_map, ship_map, faction_map)

        # Track new discoveries
        for f in state.factions:
            for p in state.planets:
                if f.id in p.explored_by and p.id not in explored_sets[f.id]:
                    explored_sets[f.id].add(p.id)
                    log.append((tick, "DISCOVER", f"{flabel(f.id, state.factions)} sees {p.id} ({p.resource_type})"))

        # Track spawned ships
        for evt in state.tick_events:
            if evt["type"] == "ship_spawned":
                owner  = evt["ship"]["owner"]
                method = "auto" if (tick % AUTO_FLEET_INTERVAL < 3) else "build"
                log.append((tick, "SPAWN", f"{flabel(owner, state.factions)} spawns {evt['ship']['type']} via {method}"))
            elif evt["type"] == "planet_captured":
                by  = flabel(evt["by"],   state.factions)
                frm = flabel(evt["from"], state.factions)
                pid = evt["planet_id"]
                p   = planet_map.get(pid)
                log.append((tick, "CONQUER", f"{by} takes {pid} from {frm} (type={p.resource_type if p else '?'})"))
            elif evt["type"] == "ship_destroyed":
                log.append((tick, "DEATH", f"ship {evt['ship_id']} destroyed"))
            elif evt["type"] == "faction_eliminated":
                log.append((tick, "ELIM", f"{flabel(evt['faction_id'], state.factions)} eliminated"))

    # Final state
    final_ships   = {f.id: sum(1 for s in state.ships if s.owner == f.id) for f in state.factions}
    final_planets = {f.id: sum(1 for p in state.planets if p.owner == f.id) for f in state.factions}
    final_res     = {f.id: dict(min=round(f.minerals), en=round(f.energy), rare=round(f.rare))
                     for f in state.factions}

    return state, home_info, log, final_ships, final_planets, final_res, explored_sets

# ── run 3 seeds ───────────────────────────────────────────────────────────────

for seed in [42, 77, 123]:
    print(f"\n{'#'*60}")
    print(f"SEED {seed}  —  60 seconds ({TICKS} ticks)")
    print(f"{'#'*60}")

    state, home_info, log, fships, fplanets, fres, exp = run_seed(seed)
    factions = state.factions

    print("\n── STARTING CONDITIONS ─────────────────────────────────")
    for f in factions:
        h = home_info.get(f.id, {})
        ships_at_start = 4 if f.id == "player" else 2
        print(f"  {flabel(f.id,factions):<12} arch={f.archetype:<14} "
              f"home={h.get('type','?'):<8} rate={h.get('rate',0):.2f}  "
              f"starting_ships={ships_at_start}")

    print("\n── RESOURCE INCOME (per second, rate÷20 applied) ───────")
    for f in factions:
        h = home_info.get(f.id, {})
        raw_rate = h.get('rate', 0)
        rate_sec = raw_rate / 20.0      # actual income per second
        min_in = rate_sec if h.get('type') == 'minerals' else 0
        en_in  = rate_sec if h.get('type') == 'energy'   else 0
        print(f"  {flabel(f.id,factions):<12} min_income={min_in:.3f}/s  en_income={en_in:.3f}/s  "
              f"(raw_rate={raw_rate:.2f}/tick → {rate_sec:.3f}/tick after ÷20)")

    print("\n── DISCOVERIES ─────────────────────────────────────────")
    disc_events = [(t, d) for t,etype,d in log if etype == "DISCOVER"]
    by_time = {}
    for t, d in disc_events:
        bucket = (t // 200) * 10  # 10s buckets
        by_time.setdefault(bucket, []).append(d)
    for bucket in sorted(by_time):
        print(f"  {bucket:>3}s: {len(by_time[bucket])} planets discovered")
        for d in by_time[bucket][:3]:
            print(f"       {d}")
        if len(by_time[bucket]) > 3:
            print(f"       ... +{len(by_time[bucket])-3} more")
    total_disc = {f.id: len(s) for f.id, s in exp.items()}
    for f in factions:
        print(f"  {flabel(f.id,factions):<12} total known planets: {total_disc.get(f.id,0)}/30")

    print("\n── FLEET GENERATION ────────────────────────────────────")
    spawns = [(t, d) for t,etype,d in log if etype == "SPAWN"]
    by_owner = {}
    for t, d in spawns:
        owner = d.split()[0]
        by_owner.setdefault(owner, {"auto": 0, "build": 0})
        if "auto" in d:
            by_owner[owner]["auto"] += 1
        else:
            by_owner[owner]["build"] += 1
    for owner, counts in by_owner.items():
        total = counts["auto"] + counts["build"]
        print(f"  {owner:<12}  total_spawned={total}  auto={counts['auto']}  build={counts['build']}")

    print("\n── CONQUESTS ───────────────────────────────────────────")
    conquests = [(t, d) for t,etype,d in log if etype == "CONQUER"]
    if conquests:
        for t, d in conquests:
            print(f"  t={t:>5} ({t//20:>2}s)  {d}")
    else:
        print("  none")

    print("\n── COMBAT ──────────────────────────────────────────────")
    deaths = sum(1 for _,etype,_ in log if etype == "DEATH")
    elims  = [(t,d) for t,etype,d in log if etype == "ELIM"]
    print(f"  ship_deaths: {deaths}")
    for t,d in elims:
        print(f"  t={t:>5} ({t//20:>2}s)  {d}")

    print("\n── FINAL STATE (60s) ───────────────────────────────────")
    for f in factions:
        fid = f.id
        r = fres[fid]
        print(f"  {flabel(fid,factions):<12}  planets={fplanets.get(fid,0)}  ships={fships.get(fid,0)}"
              f"  min={r['min']:>5}  en={r['en']:>5}  rare={r['rare']:>4}")

    print("\n── ISSUES DETECTED ─────────────────────────────────────")
    issues = []
    # Check resource overflow
    for f in factions:
        r = fres[f.id]
        h = home_info.get(f.id, {})
        if r['min'] > 500:
            issues.append(f"  OVERFLOW: {flabel(f.id,factions)} has {r['min']} minerals (home={h.get('type')}@{h.get('rate',0):.2f}/tick = {h.get('rate',0)*20:.0f}/sec)")
        if r['en'] > 500:
            issues.append(f"  OVERFLOW: {flabel(f.id,factions)} has {r['en']} energy (home={h.get('type')}@{h.get('rate',0):.2f}/tick = {h.get('rate',0)*20:.0f}/sec)")
    # Check if player is weaker than NPCs
    player_ships = fships.get("player", 0)
    npc_ships_avg = sum(v for k,v in fships.items() if k != "player") / max(1, len(factions)-1)
    if player_ships < npc_ships_avg * 0.7:
        issues.append(f"  BALANCE: player has {player_ships} ships vs NPC avg {npc_ships_avg:.1f}")
    # Check if no conquests happened
    if not conquests:
        issues.append("  STALE: no territory changed hands — AI not attacking effectively")
    for i in issues:
        print(i)
    if not issues:
        print("  none detected")
