import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Campaign, CampaignRoster } from '../models/campaign.model';
import { Combatant } from '../models/combat.model';

const LAST_CAMPAIGN_KEY = 'combat-copilot.last-campaign';

/** The owner's campaigns. Every call here is owner-only on the server (401 otherwise). */
@Injectable({ providedIn: 'root' })
export class CampaignService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  readonly campaigns = signal<Campaign[]>([]);
  readonly activeCampaignId = signal<string | null>(null);
  /**
   * The active campaign's characters: a pick-list for "Add Combatant". Nothing in it is
   * ever added to an encounter on its own.
   */
  readonly roster = signal<Combatant[]>([]);

  loadCampaigns(): Observable<Campaign[]> {
    return this.http
      .get<Campaign[]>(`${this.baseUrl}/campaigns`)
      .pipe(tap((campaigns) => this.campaigns.set(campaigns)));
  }

  loadRoster(campaignId: string): Observable<Combatant[]> {
    return this.http
      .get<CampaignRoster>(`${this.baseUrl}/campaigns/${encodeURIComponent(campaignId)}/roster`)
      .pipe(map((roster) => roster.combatants));
  }

  /**
   * Marks the campaign the current encounter belongs to (null: none) and remembers it for next time.
   * Leaving the campaign also drops its pick-list.
   */
  select(campaignId: string | null): void {
    this.activeCampaignId.set(campaignId);
    if (campaignId === null) {
      this.roster.set([]);
    }
    try {
      if (campaignId) {
        localStorage.setItem(LAST_CAMPAIGN_KEY, campaignId);
      } else {
        localStorage.removeItem(LAST_CAMPAIGN_KEY);
      }
    } catch {
      // Storage can be unavailable (private window, blocked site data): a remembered
      // selection is a convenience, never something the app depends on.
    }
  }

  /** The remembered campaign, but only if it is still one the server offers. */
  restorableSelection(): string | null {
    try {
      const remembered = localStorage.getItem(LAST_CAMPAIGN_KEY);
      return remembered && this.campaigns().some((campaign) => campaign.id === remembered) ? remembered : null;
    } catch {
      return null;
    }
  }

  campaignName(campaignId: string | null): string | undefined {
    return this.campaigns().find((campaign) => campaign.id === campaignId)?.name;
  }

  /** Forget everything held in memory (sign-out, expired session). The remembered choice stays in the browser. */
  reset(): void {
    this.campaigns.set([]);
    this.activeCampaignId.set(null);
    this.roster.set([]);
  }
}
