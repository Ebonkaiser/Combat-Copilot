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
  initiative: number;
  weapon_equipped: string;
}

export interface EncounterState {
  encounter_id: string;
  round: number;
  active_turn_index: number;
  combatants: Combatant[];
  gm_notes?: string;
  combat_started?: boolean;
  /** Set by the server: the campaign whose private lore narration may use (owner only). */
  campaign_id?: string | null;
  /** Set by the server: true for a campaign encounter, which only the signed-in owner can reach. */
  owner_scoped?: boolean;
}

/**
 * Body of POST /encounters. The server assigns the id (a supplied one is ignored)
 * and only honours campaign_id for a signed-in owner.
 */
export type EncounterCreate = Omit<EncounterState, 'encounter_id' | 'owner_scoped'> & {
  encounter_id?: string;
};

export type ConditionAction = 'add' | 'remove';

export interface DamageEntry {
  amount: number;
  damage_type: DamageType;
}

export interface DamageEvent {
  attacker_id?: string;
  target_id: string;
  damage_entries: DamageEntry[];
  healing_amount?: number;
  condition_name?: string;
  condition_action?: ConditionAction;
}