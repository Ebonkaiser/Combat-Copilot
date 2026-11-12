import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { CampaignService } from '../services/campaign.service';

/**
 * The owner's campaign picker. It is rendered only for the signed-in owner -- a
 * convenience, not a gate: the campaign endpoints refuse anyone else on the server.
 *
 * Picking a campaign while an encounter is in progress asks first, inline (never
 * window.confirm); the parent does the actual switching when this emits.
 */
@Component({
  selector: 'app-campaign-switcher',
  standalone: true,
  template: `
    @if (auth.mode() === 'owner') {
      <div class="switcher">
        <label for="campaign-select" class="switcher-label">Campaign</label>
        <select #picker id="campaign-select" data-testid="campaign-select" (change)="onChange(picker.value)">
          <option value="" [selected]="!campaigns.activeCampaignId()">No campaign (blank encounter)</option>
          @for (campaign of campaigns.campaigns(); track campaign.id) {
            <option [value]="campaign.id" [selected]="campaign.id === campaigns.activeCampaignId()">{{ campaign.name }}</option>
          }
        </select>
      </div>

      @if (pending() !== null) {
        <div class="switch-confirm" role="alertdialog" aria-labelledby="switch-confirm-text" data-testid="switch-confirm">
          <span id="switch-confirm-text">{{ confirmMessage() }}</span>
          <button type="button" class="btn btn-danger btn-sm" data-testid="switch-confirm-yes" (click)="confirm()">Switch</button>
          <button type="button" class="btn btn-secondary btn-sm" data-testid="switch-confirm-no" (click)="cancel()">Keep current</button>
        </div>
      }
    }
  `,
  styleUrl: './campaign-switcher.component.css',
})
export class CampaignSwitcherComponent {
  protected readonly auth = inject(AuthService);
  protected readonly campaigns = inject(CampaignService);

  /** Anyone added, combat started, or the round advanced: switching would throw real work away. */
  readonly encounterInProgress = input(false);
  /** The chosen campaign id, or null for "no campaign". */
  readonly campaignSelected = output<string | null>();

  protected readonly pending = signal<{ id: string | null } | null>(null);
  private readonly picker = viewChild<ElementRef<HTMLSelectElement>>('picker');

  protected onChange(value: string): void {
    const id = value === '' ? null : value;
    // The select always shows the ACTIVE campaign; the parent moves it (via the
    // service) only once a switch has really happened, so a failed or declined
    // switch never leaves the picker lying about where the user is.
    this.showActiveCampaign();
    if (id === this.campaigns.activeCampaignId()) {
      this.pending.set(null);
      return;
    }
    if (this.encounterInProgress()) {
      this.pending.set({ id });
      return;
    }
    this.campaignSelected.emit(id);
  }

  protected confirm(): void {
    const choice = this.pending();
    this.pending.set(null);
    if (choice) {
      this.campaignSelected.emit(choice.id);
    }
  }

  protected cancel(): void {
    this.pending.set(null);
    this.showActiveCampaign();
  }

  protected confirmMessage(): string {
    const choice = this.pending();
    const target = choice?.id ? (this.campaigns.campaignName(choice.id) ?? 'that campaign') : 'a blank encounter';
    return `Switch to ${target}? The encounter in progress will be discarded.`;
  }

  private showActiveCampaign(): void {
    const element = this.picker()?.nativeElement;
    if (element) {
      element.value = this.campaigns.activeCampaignId() ?? '';
    }
  }
}
