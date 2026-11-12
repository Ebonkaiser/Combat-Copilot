import { Component, inject, input, output } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { CampaignSwitcherComponent } from './campaign-switcher.component';

/** App title, who-is-using-it badge, sign in/out, and (owner only) the campaign switcher. */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CampaignSwitcherComponent],
  template: `
    <header class="app-header">
      <div class="app-header-title">
        <h2>GM Assistant — AI Combat Copilot</h2>
        <p class="page-subtitle">Track initiative and HP, then apply damage to get AI-narrated combat play-by-play.</p>
      </div>

      <!-- Hidden until the server has said who this is, so an owner never sees a flash of "Anonymous". -->
      @if (auth.loaded()) {
        <div class="app-header-controls">
          <span class="mode-badge" [class.owner]="auth.mode() === 'owner'" data-testid="mode-badge" [title]="auth.email() ?? ''">
            {{ auth.mode() === 'owner' ? 'Owner' : 'Anonymous' }}
          </span>

          @if (auth.mode() === 'owner') {
            <app-campaign-switcher
              [encounterInProgress]="encounterInProgress()"
              (campaignSelected)="campaignSelected.emit($event)"
            />
            <button type="button" class="btn btn-secondary btn-sm" data-testid="sign-out-btn" (click)="signOutRequested.emit()">Sign out</button>
          } @else if (auth.ownerLoginEnabled()) {
            <button type="button" class="btn btn-secondary btn-sm" data-testid="sign-in-btn" (click)="signInRequested.emit()">Owner sign in</button>
          }
        </div>
      }
    </header>
  `,
  styleUrl: './header.component.css',
})
export class HeaderComponent {
  protected readonly auth = inject(AuthService);

  readonly encounterInProgress = input(false);
  readonly signInRequested = output<void>();
  readonly signOutRequested = output<void>();
  readonly campaignSelected = output<string | null>();
}
