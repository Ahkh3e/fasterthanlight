"""Improved currency model for the game.

This replaces the confusing three-currency system (minerals, energy, rare) 
with a single, more intuitive resource: Credits.

The new system provides:
- Clear resource flow visualization
- Storage limits to create meaningful decisions
- Simple, intuitive resource usage
- Better tracking and feedback
"""

from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class ResourceFlow:
    """Tracks resource income and expenses for a single tick."""
    income: float = 0.0
    expenses: float = 0.0
    storage_used: float = 0.0
    storage_capacity: float = 0.0
    
    @property
    def net_change(self) -> float:
        return self.income - self.expenses
    
    @property
    def storage_percentage(self) -> float:
        if self.storage_capacity <= 0:
            return 0.0
        return min(100.0, (self.storage_used / self.storage_capacity) * 100)


class CurrencyManager:
    """Manages resource flow, storage, and economic feedback for a faction."""
    
    # Resource costs for buildings and ships
    BUILDING_COSTS = {
        "extractor": 100,
        "shipyard": 200,
        "research_lab": 150,
        "defense_platform": 250,
    }
    
    SHIP_COSTS = {
        "fighter": 50,
        "cruiser": 150,
        "bomber": 120,
        "carrier": 400,
        "dreadnought": 800,
    }
    
    # Income rates
    BASE_INCOME = 0.5  # Credits per tick per owned planet
    EXTRACTOR_BONUS = 0.3  # Additional income per extractor
    POPULATION_BONUS = 0.01  # Income multiplier per population point
    
    # Storage system
    BASE_STORAGE = 1000
    EXTRACTOR_STORAGE = 300  # Additional storage per extractor
    SHIPYARD_STORAGE = 200   # Additional storage per shipyard
    
    def __init__(self, faction_id: str):
        self.faction_id = faction_id
        self.current_flow = ResourceFlow()
        self.last_flow = ResourceFlow()
        self.income_history: List[float] = []
        self.expense_history: List[float] = []
        
    def calculate_storage_capacity(self, planet_count: int, extractors: int, shipyards: int) -> float:
        """Calculate total storage capacity based on infrastructure."""
        return (self.BASE_STORAGE + 
                (extractors * self.EXTRACTOR_STORAGE) + 
                (shipyards * self.SHIPYARD_STORAGE) +
                (planet_count * 100))  # Base storage per planet
    
    def calculate_income(self, planets: List[dict]) -> float:
        """Calculate total income from all owned planets."""
        income = 0.0
        
        for planet in planets:
            if planet.get("owner") != self.faction_id:
                continue
                
            # Base income from planet
            income += self.BASE_INCOME
            
            # Extractor bonus
            extractors = planet.get("buildings", []).count("extractor")
            income += extractors * self.EXTRACTOR_BONUS
            
            # Population bonus
            population = planet.get("population", 0)
            income += population * self.POPULATION_BONUS
            
        return income
    
    def calculate_expenses(self, build_queues: List[dict]) -> float:
        """Calculate total expenses from all build queues."""
        expenses = 0.0
        
        for queue in build_queues:
            if queue["type"] == "building":
                cost = self.BUILDING_COSTS.get(queue["name"], 0)
                expenses += cost
            elif queue["type"] == "ship":
                cost = self.SHIP_COSTS.get(queue["ship_type"], 0)
                expenses += cost
                
        return expenses
    
    def update_flow(self, planets: List[dict], build_queues: List[dict]) -> ResourceFlow:
        """Update resource flow for this tick."""
        self.last_flow = self.current_flow
        
        income = self.calculate_income(planets)
        expenses = self.calculate_expenses(build_queues)
        
        # Calculate storage
        planet_count = sum(1 for p in planets if p.get("owner") == self.faction_id)
        extractors = sum(p.get("buildings", []).count("extractor") for p in planets if p.get("owner") == self.faction_id)
        shipyards = sum(p.get("buildings", []).count("shipyard") for p in planets if p.get("owner") == self.faction_id)
        
        storage_capacity = self.calculate_storage_capacity(planet_count, extractors, shipyards)
        
        self.current_flow = ResourceFlow(
            income=income,
            expenses=expenses,
            storage_used=0.0,  # This will be updated by the main simulation
            storage_capacity=storage_capacity
        )
        
        # Update history (keep last 60 entries ~ 3 seconds)
        self.income_history.append(income)
        self.expense_history.append(expenses)
        
        if len(self.income_history) > 60:
            self.income_history.pop(0)
            self.expense_history.pop(0)
            
        return self.current_flow
    
    def get_economic_status(self) -> Dict[str, any]:
        """Get comprehensive economic status for UI display."""
        avg_income = sum(self.income_history) / len(self.income_history) if self.income_history else 0.0
        avg_expenses = sum(self.expense_history) / len(self.expense_history) if self.expense_history else 0.0
        
        return {
            "current_income": self.current_flow.income,
            "current_expenses": self.current_flow.expenses,
            "net_flow": self.current_flow.net_change,
            "storage_used": self.current_flow.storage_used,
            "storage_capacity": self.current_flow.storage_capacity,
            "storage_percentage": self.current_flow.storage_percentage,
            "average_income": avg_income,
            "average_expenses": avg_expenses,
            "trend": "profit" if avg_income > avg_expenses else "loss" if avg_income < avg_expenses else "break_even",
            "can_afford_next": self.current_flow.storage_used + self.current_flow.expenses <= self.current_flow.storage_capacity
        }


class EconomicAdvisor:
    """Provides economic advice and warnings to the player."""
    
    STORAGE_WARNING_THRESHOLD = 80.0  # Warn when storage is 80% full
    INCOME_DECLINE_THRESHOLD = 0.8    # Warn if income drops below 80% of average
    
    def __init__(self):
        self.warnings = []
        
    def analyze_economy(self, currency_manager: CurrencyManager) -> List[str]:
        """Analyze economy and return list of warnings/advice."""
        self.warnings = []
        
        status = currency_manager.get_economic_status()
        
        # Storage warning
        if status["storage_percentage"] >= self.STORAGE_WARNING_THRESHOLD:
            self.warnings.append(f"Storage at {status['storage_percentage']:.1f}% - Consider building more extractors")
        
        # Income decline warning
        if status["average_income"] > 0 and status["current_income"] < status["average_income"] * self.INCOME_DECLINE_THRESHOLD:
            decline_pct = ((status["average_income"] - status["current_income"]) / status["average_income"]) * 100
            self.warnings.append(f"Income declining by {decline_pct:.1f}% - Check your planets")
        
        # Expense warning
        if status["current_expenses"] > status["current_income"] * 1.5:
            self.warnings.append("High expenses - Consider pausing construction")
        
        # Growth advice
        if status["trend"] == "profit" and status["storage_percentage"] < 50:
            self.warnings.append("Strong economy - Consider expanding")
        
        return self.warnings


# Currency conversion functions for backward compatibility
def credits_to_minerals(credits: float) -> float:
    """Convert credits to old mineral system for compatibility."""
    return credits * 2.0

def credits_to_energy(credits: float) -> float:
    """Convert credits to old energy system for compatibility."""
    return credits * 1.5

def credits_to_rare(credits: float) -> float:
    """Convert credits to old rare system for compatibility."""
    return credits * 0.5