export type EntityType = 'player' | 'enemy' | 'npc';

export type DamageType =
  | 'Slashing'
  | 'Piercing'
  | 'Bludgeoning'
  | 'Fire'
  | 'Cold'
  | 'Lightning'
  | 'Acid'
  | 'Poison'
  | 'Psychic'
  | 'Radiant'
  | 'Necrotic'
  | 'Force';

export interface Combatant {
  id: string;
  name: string;
  type: EntityType;
  armor_class: number;
  max_hp: number;
  current_hp: number;
  conditions: string[];
  tactical_tags: string[];
  resources: Record<string, number>;
  faction?: string;
}

export interface EncounterState {
  encounter_id: string;
  round: number;
  active_turn_index: number;
  combatants: Combatant[];
}

export interface DamageEvent {
  attacker_id?: string;
  target_id: string;
  damage_amount: number;
  damage_type: DamageType;
  applied_conditions: string[];
}