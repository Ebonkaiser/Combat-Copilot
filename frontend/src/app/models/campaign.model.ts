import { Combatant } from './combat.model';

/** GET /campaigns -- names only; the roster and lore never travel with the list. */
export interface Campaign {
  id: string;
  name: string;
  description: string;
}

/** GET /campaigns/:id/roster -- the campaign's characters: a pick-list for "Add Combatant", never auto-added. */
export interface CampaignRoster {
  combatants: Combatant[];
}
