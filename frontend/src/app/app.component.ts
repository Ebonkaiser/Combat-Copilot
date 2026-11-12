import { Component, OnInit, PLATFORM_ID, effect, inject, untracked } from '@angular/core';
import { CommonModule, isPlatformServer } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { of, retry, throwError, timer } from 'rxjs';
import { AuthService } from './services/auth.service';
import { CampaignService } from './services/campaign.service';
import { CombatService } from './services/combat.service';
import { HeaderComponent } from './components/header.component';
import { LoginComponent } from './components/login.component';
import { Combatant, ConditionAction, DamageEntry, DamageEvent, DamageType, EncounterCreate, EncounterState, EntityType } from './models/combat.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, HeaderComponent, LoginComponent],
  template: `
    <app-header
      [encounterInProgress]="encounterInProgress()"
      (signInRequested)="showLogin = true"
      (signOutRequested)="signOut()"
      (campaignSelected)="selectCampaign($event)"
    ></app-header>

    <div *ngIf="auth.sessionExpired()" class="banner-notice" role="status" data-testid="session-expired-banner">
      Your owner session ended, so campaign content is locked.
      <a (click)="showLogin = true" class="banner-link">Sign in again</a>
    </div>

    <div *ngIf="notice" class="banner-notice" role="status" data-testid="notice-banner">
      {{ notice }}
      <a (click)="notice = ''" class="banner-link">Dismiss</a>
    </div>

    <div *ngIf="connectionError" class="banner-error">
      <ng-container *ngIf="connectionErrorDetail; else genericError">{{ connectionErrorDetail }}</ng-container>
      <ng-template #genericError>Could not reach the backend after several retries. It may still be starting up (this can take up to a minute on first boot) -- wait a bit and</ng-template>
      <a (click)="retryConnection()" class="banner-link">try again</a>.
    </div>

    <div class="layout">
      <!-- Column 1: Combat Tracker -->
      <div class="panel">
        <div class="panel-header">
          <h3>Initiative & Health Tracker</h3>
          <div class="toolbar">
            <button (click)="openAddModal()" [disabled]="!combat.encounter()" data-testid="add-combatant-btn" class="btn">Add Combatant</button>
            <ng-container *ngIf="combat.encounter() as enc">
              <button *ngIf="!enc.combat_started" (click)="startCombat()" [disabled]="!canStartCombat()" title="Locks in initiative order and starts tracking rounds/turns." data-testid="start-combat-btn" class="btn">Start Combat</button>
              <button *ngIf="enc.combat_started" (click)="previousTurn()" [disabled]="!canGoToPreviousTurn()" title="Go back to the previous combatant's turn" data-testid="previous-turn-btn" class="btn btn-secondary">Previous Turn</button>
              <button *ngIf="enc.combat_started" (click)="nextTurn()" data-testid="next-turn-btn" class="btn">Next Turn</button>
            </ng-container>
            <button (click)="newEncounter()" class="btn btn-danger">New Encounter</button>
          </div>
        </div>

        <div *ngIf="backendStarting && !connectionError" class="status-starting">
          <div class="status-icon">⏳</div>
          Backend is starting up, hang tight…
        </div>

        <div *ngIf="combat.encounter() as enc">
          <p *ngIf="enc.combat_started"><strong>Round:</strong> {{ enc.round }} | <strong>Turn:</strong> {{ enc.active_turn_index + 1 }}</p>
          <p *ngIf="!enc.combat_started" class="muted">Combat not started -- add combatants, then click <strong>Start Combat</strong> to begin tracking rounds and turns.</p>

          <div *ngIf="enc.combatants.length === 0" class="empty-state" data-testid="empty-state">
            <ng-container *ngIf="inCampaign(); else blankEmptyState">
              No combatants yet. Click <strong>Add Combatant</strong> above and choose characters from <strong>{{ campaigns.campaignName(campaigns.activeCampaignId()) }}</strong>.
            </ng-container>
            <ng-template #blankEmptyState>
              No combatants in this encounter yet. Click <strong>Add Combatant</strong> above to get started.
            </ng-template>
          </div>

          <div *ngFor="let c of enc.combatants; let i = index"
               class="combatant"
               [class.selected]="c.id === selectedTargetId"
               [class.active-turn]="enc.combat_started && i === enc.active_turn_index"
               [class.hovered]="c.id === hoveredId"
               (click)="selectedTargetId = c.id"
               (mouseenter)="hoveredId = c.id"
               (mouseleave)="hoveredId = null">

            <div *ngIf="enc.combat_started && i === enc.active_turn_index" class="badge-active">ACTIVE</div>

            <div class="combatant-row">
              <strong>{{ c.name }} ({{ c.type }})</strong>
              <span>Init: {{ c.initiative }} | AC: {{ c.armor_class }}</span>
            </div>
            <div>HP: {{ c.current_hp }} / {{ c.max_hp }}</div>
            <div class="combatant-weapon">Weapon: {{ c.weapon_equipped }}</div>
            <div class="hp-track">
              <div class="hp-fill"
                   [class.hp-zero]="c.current_hp === 0"
                   [style.width.%]="(c.current_hp / c.max_hp) * 100"></div>
            </div>
            <div>
              <span *ngFor="let cond of c.conditions" class="chip">
                {{ cond }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Column 2: Action Entry & Narrative -->
      <div class="panel">
        <h3>Combat Actions</h3>
        <div class="actions">
          <label>Target: </label>
          <div class="target-display">
            {{ selectedTargetName() || 'None selected' }}
          </div>
          <div class="hint mb-8">Click a combatant on the left to target them.</div>

          <button (click)="openDamageModal()"
                  [disabled]="combat.isStreaming() || !selectedTargetId"
                  [title]="combat.isStreaming() ? 'Narration is streaming — please wait.' : (!selectedTargetId ? 'Select a combatant on the left to target before applying damage.' : '')"
                  data-testid="open-damage-modal-btn"
                  class="btn btn-block">
            Manage Combatant
          </button>
          <div *ngIf="!selectedTargetId" class="hint mt-4">Select a combatant on the left to enable this.</div>
        </div>

        <h3>Copilot Stream</h3>
        <div class="stream pre-wrap">
          {{ combat.narrative() }}
          <span *ngIf="combat.isStreaming()">▌</span>
        </div>
      </div>
    </div>

    <!-- Add Combatant Modal -->
    <div *ngIf="showAddModal" class="modal-overlay">
      <div class="modal">
        <h3>Add Combatant</h3>

        <!-- In a campaign, its characters come from the campaign's own list. Nothing is added automatically. -->
        <ng-container *ngIf="inCampaign()">
          <label for="roster-select">Campaign character: </label>
          <select id="roster-select" data-testid="roster-select" [(ngModel)]="selectedRosterId" (change)="onRosterChange()" class="w-100 mb-4">
            <option value="">-- Custom enemy / NPC --</option>
            <option *ngFor="let character of availableRoster()" [value]="character.id">{{ character.name }} ({{ character.type }})</option>
          </select>
          <div class="hint mb-8" data-testid="roster-hint">{{ rosterHint() }}</div>
        </ng-container>

        <ng-container *ngIf="!selectedRosterId">
          <label>Template: </label>
          <select [(ngModel)]="selectedTemplate" (change)="onTemplateChange()" class="w-100 mb-8" data-testid="combatant-template">
            <option value="">-- Custom --</option>
            <option value="enemy">Enemy</option>
            <option *ngIf="!inCampaign()" value="player">Player</option>
          </select>
        </ng-container>

        <ng-container *ngIf="newCombatant.type !== 'player' && !selectedRosterId">
          <label>Amount: </label>
          <input type="number" [(ngModel)]="addAmount" class="w-100 mb-8" min="1" data-testid="combatant-amount" />
        </ng-container>

        <label>Name: </label>
        <input type="text" [(ngModel)]="newCombatant.name" [disabled]="!!selectedRosterId" class="w-100 mb-8" data-testid="combatant-name" />

        <label>Type: </label>
        <select [(ngModel)]="newCombatant.type" [disabled]="!!selectedRosterId" class="w-100 mb-4" data-testid="combatant-type">
          <option *ngIf="!inCampaign() || selectedRosterId" value="player">Player</option>
          <option value="enemy">Enemy</option>
          <option value="npc">NPC</option>
        </select>
        <div *ngIf="!selectedRosterId" class="hint mb-8" [ngSwitch]="newCombatant.type">
          <span *ngSwitchCase="'player'">Players are added one at a time and have no Faction (Faction is Enemy-only).</span>
          <span *ngSwitchCase="'enemy'">Add multiple identical enemies at once with Amount. Faction is used to pull relevant lore during narration.</span>
          <span *ngSwitchCase="'npc'">Add multiple identical NPCs at once with Amount. NPCs have no Faction field (Enemy-only).</span>
        </div>

        <label>Initiative: </label>
        <input type="number" [(ngModel)]="newCombatant.initiative" class="w-100 mb-8" data-testid="combatant-initiative" />

        <label>Max HP: </label>
        <input type="number" [ngModel]="newCombatant.max_hp" (ngModelChange)="onMaxHpChange($event)" class="w-100 mb-8" data-testid="combatant-max-hp" />

        <!-- A campaign character may start wounded: current HP is editable too (custom combatants start at full health). -->
        <ng-container *ngIf="selectedRosterId">
          <label>Current HP: </label>
          <input type="number" [(ngModel)]="newCombatant.current_hp" min="0" class="w-100 mb-8" data-testid="combatant-current-hp" />
        </ng-container>

        <label>Armor Class: </label>
        <input type="number" [(ngModel)]="newCombatant.armor_class" class="w-100 mb-8" data-testid="combatant-ac" />

        <label *ngIf="newCombatant.type === 'enemy'">Faction: </label>
        <input *ngIf="newCombatant.type === 'enemy'" type="text" [(ngModel)]="newCombatant.faction" [disabled]="!!selectedRosterId" class="w-100 mb-8" data-testid="combatant-faction" />

        <label>Weapon Equipped: </label>
        <input type="text" [(ngModel)]="newCombatant.weapon_equipped" class="w-100 mb-8" data-testid="combatant-weapon" />

        <!-- Why Add is unavailable, so a disabled button is never a mystery. -->
        <div *ngIf="addBlockedReason() as reason" class="hint mb-8" role="status" data-testid="add-blocked-reason">{{ reason }}</div>

        <div class="modal-actions">
          <button (click)="showAddModal = false" class="btn btn-secondary">Cancel</button>
          <button (click)="addCombatant()" [disabled]="!canAddCombatant()" class="btn" data-testid="add-combatant-submit">Add</button>
        </div>
      </div>
    </div>

    <!-- Owner sign-in -->
    <app-login *ngIf="showLogin" (closed)="showLogin = false" (signedIn)="onSignedIn()"></app-login>

    <!-- New Encounter Confirm Modal -->
    <div *ngIf="showNewEncounterConfirm" class="modal-overlay">
      <div class="modal modal-sm">
        <h3>Start a new encounter?</h3>
        <p>This will clear the current session, including combatants and narration.</p>
        <div class="modal-actions">
          <button (click)="cancelNewEncounter()" class="btn btn-secondary">Cancel</button>
          <button (click)="confirmNewEncounter()" class="btn btn-danger">Start New Encounter</button>
        </div>
      </div>
    </div>

    <!-- Damage / Condition Modal -->
    <div *ngIf="showDamageModal && combat.encounter() as enc" class="modal-overlay">
      <div class="modal modal-md">
        <h3>Update {{ selectedTargetName() }}</h3>

        <label>Attacker: </label>
        <select [(ngModel)]="modalAttackerId" (change)="hydrateWeaponFromAttacker()" class="w-100 mb-12">
          <option value="">-- Unspecified --</option>
          <option *ngFor="let c of attackerOptions()" [value]="c.id">{{ c.name }} ({{ c.weapon_equipped }})</option>
        </select>

        <label>Weapon Equipped (by the attacker above): </label>
        <input type="text" [(ngModel)]="modalWeaponInput" [disabled]="!modalAttackerId"
               placeholder="Rapier, Longbow" class="w-100 mb-4" />
        <div class="hint mb-12">
          {{ modalAttackerId ? 'Edits what the selected attacker is wielding.' : 'Select an attacker above to edit their weapon.' }}
        </div>

        <div class="section-title">Damage</div>
        <div *ngFor="let entry of modalDamageEntries; let i = index" class="row">
          <input type="number" [(ngModel)]="entry.amount" min="0" placeholder="Amount" class="w-90" />
          <select [(ngModel)]="entry.damage_type" class="flex-1">
            <option *ngFor="let t of damageTypes" [value]="t">{{ t }}</option>
          </select>
          <button (click)="removeDamageEntryRow(i)" [disabled]="modalDamageEntries.length === 1" class="btn btn-secondary btn-sm">x</button>
        </div>
        <button (click)="addDamageEntryRow()" class="btn btn-secondary btn-sm mb-8">+ Add Damage Type</button>
        <div class="small mb-16">Total: {{ modalTotalDamage() }} damage</div>

        <div class="section-title">Healing</div>
        <input type="number" [(ngModel)]="modalHealingAmount" min="0" placeholder="Amount" class="w-100 mb-4" />
        <div class="hint mb-16">Applies to {{ selectedTargetName() }} regardless of whose turn it is.</div>

        <div class="section-title">Status Condition</div>
        <div class="row">
          <button (click)="modalConditionAction = modalConditionAction === 'add' ? null : 'add'"
                  class="btn-toggle"
                  [class.active]="modalConditionAction === 'add'">
            Add Condition
          </button>
          <button (click)="modalConditionAction = modalConditionAction === 'remove' ? null : 'remove'"
                  class="btn-toggle danger"
                  [class.active]="modalConditionAction === 'remove'">
            Remove Condition
          </button>
        </div>
        <input *ngIf="modalConditionAction" type="text" [(ngModel)]="modalConditionName" placeholder="Stunned, Prone, Poisoned..." class="w-100 mb-16" />

        <div class="section-title">Battle Notes</div>
        <div class="hint mb-6">Context for the AI narration -- terrain, NPC motivations, plot twists, anything that won't fit the structured state.</div>
        <textarea [(ngModel)]="enc.gm_notes" rows="2"
                  placeholder="e.g. The guard captain is secretly sympathetic to the players and will hesitate before landing a killing blow..."
                  class="w-100 mb-4 notes"></textarea>

        <div class="modal-actions">
          <button (click)="closeDamageModal()" class="btn btn-secondary">Cancel</button>
          <button (click)="submitAction()"
                  [disabled]="!canSubmitDamageModal()"
                  class="btn">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  combat = inject(CombatService);
  auth = inject(AuthService);
  campaigns = inject(CampaignService);
  private isServer = isPlatformServer(inject(PLATFORM_ID));

  showLogin = false;
  /** A plain-language heads-up (a lost session, a restored encounter, a failed save). Dismissable. */
  notice = '';

  selectedTargetId = '';

  showDamageModal = false;
  modalAttackerId = '';
  modalWeaponInput = '';
  modalOriginalWeapon = '';
  modalOriginalNotes = '';
  modalDamageEntries: DamageEntry[] = [{ amount: 0, damage_type: 'Slashing' }];
  modalHealingAmount = 0;
  modalConditionName = '';
  modalConditionAction: ConditionAction | null = null;

  showAddModal = false;
  showNewEncounterConfirm = false;
  selectedTemplate = '';
  /** The campaign character picked in "Add Combatant" ('' = a custom enemy/NPC typed in by name). */
  selectedRosterId = '';
  addAmount = 1;
  newCombatant: Partial<Combatant> = this.getEmptyCombatant();
  hoveredId: string | null = null;

  connectionError = false;
  connectionErrorDetail = '';
  backendStarting = true;
  healthPollAttempts = 0;
  maxHealthPollAttempts = 20; // ~40s at 2s intervals -- matches the documented cold-start ceiling

  damageTypes: DamageType[] = [
    'Slashing', 'Piercing', 'Bludgeoning', 'Fire', 'Cold',
    'Lightning', 'Acid', 'Poison', 'Psychic', 'Radiant', 'Necrotic', 'Force'
  ];

  constructor() {
    // A signed-in owner's session ended (an owner-only call answered 401, or a 404 turned out to
    // mean the same): the owner-scoped encounter is no longer reachable, so fall back to an
    // anonymous blank one and ask them to sign in again.
    effect(() => {
      if (this.auth.sessionExpired()) {
        untracked(() => this.handleSessionExpired());
      }
    });
  }

  ngOnInit(): void {
    this.pollHealth();
  }

  pollHealth(): void {
    this.combat.checkHealth().subscribe({
      next: () => {
        this.backendStarting = false;
        this.startSession();
      },
      error: (err: HttpErrorResponse) => {
        this.healthPollAttempts++;

        // A real startup failure (server.py's _require_ready/startup_error)
        // reports status:"error" -- fail fast on that instead of burning
        // the full retry window waiting for something that won't recover.
        const startupFailed = (err.error as { status?: string } | null)?.status === 'error';
        const detail = (err.error as { detail?: string } | null)?.detail;

        if (this.isServer || startupFailed || this.healthPollAttempts >= this.maxHealthPollAttempts) {
          this.backendStarting = false;
          this.connectionError = true;
          this.connectionErrorDetail = startupFailed && detail ? detail : '';
          return;
        }

        timer(2000).subscribe(() => this.pollHealth());
      },
    });
  }

  retryConnection(): void {
    this.connectionError = false;
    this.connectionErrorDetail = '';
    this.backendStarting = true;
    this.healthPollAttempts = 0;
    this.pollHealth();
  }

  /** Who is using the app, then the first encounter: an anonymous blank one, or the owner's remembered campaign. */
  private startSession(): void {
    // The first /auth/me can have failed while a cold backend was still booting: ask again now it is up.
    const known = this.auth.loaded() ? of(true) : this.auth.load();
    known.subscribe(() => {
      if (this.auth.mode() === 'owner') {
        this.startOwnerSession();
      } else {
        this.createFreshEncounter();
      }
    });
  }

  private startOwnerSession(): void {
    this.campaigns.loadCampaigns().subscribe({
      next: () => {
        const remembered = this.campaigns.restorableSelection();
        if (remembered) {
          this.switchToCampaign(remembered);
        } else {
          this.createFreshEncounter();
        }
      },
      error: () => {
        // A 401 means the session ended; the expiry handling already started an anonymous encounter.
        if (!this.auth.sessionExpired()) {
          this.createFreshEncounter();
        }
      },
    });
  }

  /**
   * Registers a new encounter with the server (which assigns its id) and shows it.
   * With a campaign (owner only) it starts from that campaign's roster.
   */
  createFreshEncounter(campaignId: string | null = null, roster: Combatant[] = [], onCreated?: () => void): void {
    const initialEncounter: EncounterCreate = {
      round: 1,
      active_turn_index: 0,
      combatants: roster,
      gm_notes: '',
      combat_started: false,
      campaign_id: campaignId,
    };

    // By the time this runs, pollHealth() has already confirmed the
    // backend is reachable -- this retry is defense-in-depth for a one-off
    // transient blip on this specific call, not the primary cold-start
    // handling (that's pollHealth's job). A 4xx is an answer, not a blip: no retry.
    this.combat
      .createEncounter(initialEncounter)
      .pipe(
        retry({
          count: 10,
          delay: (error: unknown) =>
            error instanceof HttpErrorResponse && error.status >= 400 && error.status < 500
              ? throwError(() => error)
              : timer(2000),
        }),
      )
      .subscribe({
        next: (res) => {
          this.combat.encounter.set(res);
          onCreated?.();
        },
        error: (err) => {
          console.error('Failed to create initial encounter after retries:', err);
          if (err instanceof HttpErrorResponse && err.status >= 400 && err.status < 500) {
            if (err.status !== 401) {
              this.notice = 'Could not start that encounter. Pick the campaign again, or start a blank encounter.';
            }
          } else {
            this.connectionError = true;
          }
        },
      });
  }

  /**
   * Anyone added, combat started, or the round advanced: switching campaigns would throw that work
   * away. (A new encounter starts empty -- nothing is added for you -- so having combatants at all
   * means someone built this table on purpose.)
   */
  encounterInProgress(): boolean {
    const enc = this.combat.encounter();
    return !!enc && (!!enc.combat_started || enc.round > 1 || enc.combatants.length > 0);
  }

  /** An owner working inside a campaign (as opposed to a blank encounter, or anonymous use). */
  inCampaign(): boolean {
    return this.auth.mode() === 'owner' && !!this.campaigns.activeCampaignId();
  }

  /** Campaign characters not yet in the encounter: each can be added once. */
  availableRoster(): Combatant[] {
    const present = new Set(this.combat.encounter()?.combatants.map((c) => c.id) ?? []);
    return this.campaigns.roster().filter((character) => !present.has(character.id));
  }

  rosterHint(): string {
    if (this.selectedRosterId) {
      return 'Name, type and faction come from the campaign. Adjust initiative, HP, AC and weapon for this encounter (the campaign list itself is not changed), then add.';
    }
    if (this.campaigns.roster().length === 0) {
      return 'This campaign lists no characters. Add a custom enemy or NPC below.';
    }
    if (this.availableRoster().length === 0) {
      return 'Every campaign character is already in this encounter. Add a custom enemy or NPC below.';
    }
    return 'Pick a campaign character, or leave this on Custom to add an enemy or NPC by name.';
  }

  /**
   * Why the combatant in the dialog cannot be added right now ('' when it can). The one place that
   * decides what may be added: nothing unnamed, no character that is not in the campaign list, no
   * character twice.
   */
  addBlockedReason(): string {
    if (this.selectedRosterId) {
      const known = this.availableRoster().find((character) => character.id === this.selectedRosterId);
      if (!known) {
        return 'That character is already in this encounter.';
      }
      const maxHp = this.newCombatant.max_hp || known.max_hp;
      const currentHp = this.newCombatant.current_hp;
      if (typeof currentHp === 'number' && (currentHp < 0 || currentHp > maxHp)) {
        return 'Current HP must be between 0 and max HP.';
      }
      return '';
    }
    if (this.inCampaign() && this.newCombatant.type === 'player') {
      return 'In a campaign, player characters are chosen from the campaign list.';
    }
    if (!this.newCombatant.name?.trim()) {
      return 'Enter a name: a combatant without one cannot be added.';
    }
    return '';
  }

  canAddCombatant(): boolean {
    return this.addBlockedReason() === '';
  }

  /** The owner picked a campaign in the header (any needed confirmation has already happened there). */
  selectCampaign(campaignId: string | null): void {
    if (campaignId === null) {
      this.resetUiState();
      this.createFreshEncounter(null, [], () => this.campaigns.select(null));
      return;
    }
    this.switchToCampaign(campaignId);
  }

  /**
   * A new, EMPTY encounter inside a campaign. Nothing from the roster is added for you: the
   * characters become the pick-list in "Add Combatant". Leaves the current encounter alone if the
   * campaign cannot be loaded.
   */
  private switchToCampaign(campaignId: string): void {
    this.campaigns.loadRoster(campaignId).subscribe({
      next: (roster) => {
        this.resetUiState();
        this.createFreshEncounter(campaignId, [], () => {
          this.campaigns.roster.set(roster);
          this.campaigns.select(campaignId);
        });
      },
      error: (err: unknown) => {
        console.error('Failed to load campaign roster:', err);
        if (!(err instanceof HttpErrorResponse && err.status === 401)) {
          this.notice = 'Could not load that campaign. The current encounter is unchanged.';
        }
      },
    });
  }

  signOut(): void {
    this.auth.logout().subscribe({
      next: () => {
        this.campaigns.reset();
        this.resetUiState();
        this.createFreshEncounter();
      },
      error: () => {
        this.notice = 'Could not sign out. Check your connection and try again.';
      },
    });
  }

  onSignedIn(): void {
    this.showLogin = false;
    this.campaigns.loadCampaigns().subscribe({
      next: () => {
        // Restore the last campaign -- but never replace an encounter that is under way.
        const remembered = this.campaigns.restorableSelection();
        if (remembered && !this.encounterInProgress()) {
          this.switchToCampaign(remembered);
        }
      },
      error: () => {
        this.notice = 'You are signed in, but the campaign list could not be loaded.';
      },
    });
  }

  private handleSessionExpired(): void {
    this.campaigns.reset();
    this.resetUiState();
    this.showLogin = true;
    this.createFreshEncounter();
  }

  /**
   * A save or stream answered 404: the encounter is gone for this caller. Either the owner's
   * session ended (a private encounter answers 404, not 401, so it cannot be told from here --
   * ask /auth/me), or an idle anonymous encounter was cleaned up on the server.
   */
  private recoverFromLostEncounter(): void {
    const wasOwner = this.auth.mode() === 'owner';
    this.auth.load().subscribe((answered) => {
      if (wasOwner && answered && this.auth.mode() === 'anonymous') {
        this.auth.markSessionExpired();
        return;
      }
      this.restoreLocalEncounter();
    });
  }

  /** Re-register this page's copy of the encounter under a new server id, so the fight is not lost. */
  private restoreLocalEncounter(): void {
    const local = this.combat.encounter();
    if (!local) return;

    const { encounter_id: _lostId, owner_scoped: _scoped, ...rest } = local;
    this.combat.createEncounter(rest).subscribe({
      next: (restored) => {
        this.combat.encounter.set(restored);
        this.notice = 'This encounter had expired on the server, so it was restored from this page. Please repeat your last action.';
      },
      error: () => {
        this.notice = 'This encounter is no longer on the server and could not be restored. Start a new encounter.';
      },
    });
  }

  private onSaveError(error: unknown, what: string): void {
    console.error(`Failed to ${what}:`, error);
    if (error instanceof HttpErrorResponse) {
      if (error.status === 404) {
        this.recoverFromLostEncounter();
        return;
      }
      if (error.status === 401) {
        return; // the session-expiry interceptor has already taken care of it
      }
    }
    this.notice = `Could not ${what}. Check your connection and try again.`;
  }

  private onStreamFailure(status: number | null): void {
    if (status === 401) {
      this.auth.markSessionExpired();
    } else if (status === 404) {
      this.recoverFromLostEncounter();
    } else {
      this.notice = 'The narration could not be generated. Check your connection and try again.';
    }
  }

  /** Clears the table: selection, open dialogs, half-filled forms and narration. */
  private resetUiState(): void {
    this.selectedTargetId = '';
    this.showDamageModal = false;
    this.showAddModal = false;
    this.selectedRosterId = '';
    this.showNewEncounterConfirm = false;
    this.resetDamageModalState();
    this.combat.narrative.set('');
  }

  newEncounter(): void {
    this.showNewEncounterConfirm = true;
  }

  confirmNewEncounter(): void {
    this.showNewEncounterConfirm = false;

    // Inside a campaign, "new encounter" stays in the campaign (empty again; add characters from its list).
    const campaignId = this.campaigns.activeCampaignId();
    if (this.auth.mode() === 'owner' && campaignId) {
      this.switchToCampaign(campaignId);
      return;
    }

    this.resetUiState();
    this.createFreshEncounter();
  }

  cancelNewEncounter(): void {
    this.showNewEncounterConfirm = false;
  }

  selectedTargetName(): string | undefined {
    return this.combat.encounter()?.combatants.find((c) => c.id === this.selectedTargetId)?.name;
  }

  resetDamageModalState(): void {
    this.modalDamageEntries = [{ amount: 0, damage_type: 'Slashing' }];
    this.modalHealingAmount = 0;
    this.modalConditionName = '';
    this.modalConditionAction = null;
    this.modalWeaponInput = '';
    this.modalOriginalWeapon = '';
  }

  openDamageModal(): void {
    const enc = this.combat.encounter();
    this.resetDamageModalState();

    // Default the attacker to whoever's turn it is, unless that's the target itself.
    const activeCombatant = enc?.combatants[enc.active_turn_index];
    this.modalAttackerId =
      activeCombatant && activeCombatant.id !== this.selectedTargetId ? activeCombatant.id : '';

    this.hydrateWeaponFromAttacker();
    this.modalOriginalNotes = enc?.gm_notes ?? '';

    this.showDamageModal = true;
  }

  closeDamageModal(): void {
    this.showDamageModal = false;
  }

  attackerOptions(): Combatant[] {
    const enc = this.combat.encounter();
    if (!enc) return [];
    return enc.combatants.filter((c) => c.id !== this.selectedTargetId);
  }

  hydrateWeaponFromAttacker(): void {
    const enc = this.combat.encounter();
    const attacker = enc?.combatants.find((c) => c.id === this.modalAttackerId);
    this.modalWeaponInput = attacker?.weapon_equipped ?? '';
    this.modalOriginalWeapon = this.modalWeaponInput;
  }

  addDamageEntryRow(): void {
    this.modalDamageEntries.push({ amount: 0, damage_type: 'Slashing' });
  }

  removeDamageEntryRow(index: number): void {
    if (this.modalDamageEntries.length <= 1) return;
    this.modalDamageEntries.splice(index, 1);
  }

  modalTotalDamage(): number {
    return this.modalDamageEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }

  canSubmitDamageModal(): boolean {
    const enc = this.combat.encounter();
    if (this.combat.isStreaming() || !this.selectedTargetId || !enc) return false;

    const hasDamage = this.modalDamageEntries.some((e) => Number(e.amount) > 0);
    const hasHealing = Number(this.modalHealingAmount) > 0;
    const hasCondition = !!this.modalConditionAction && !!this.modalConditionName.trim();
    const weaponChanged = !!this.modalAttackerId && this.modalWeaponInput.trim() !== this.modalOriginalWeapon;
    const notesChanged = (enc.gm_notes ?? '') !== this.modalOriginalNotes;

    return hasDamage || hasHealing || hasCondition || weaponChanged || notesChanged;
  }

  submitAction(): void {
    const enc = this.combat.encounter();
    if (!enc || !this.canSubmitDamageModal()) return;

    if (this.modalAttackerId) {
      const attacker = enc.combatants.find((c) => c.id === this.modalAttackerId);
      if (attacker) {
        attacker.weapon_equipped = this.modalWeaponInput.trim() || 'Unarmed';
      }
    }

    const hasNarratedAction =
      this.modalDamageEntries.some((e) => Number(e.amount) > 0) ||
      Number(this.modalHealingAmount) > 0 ||
      (!!this.modalConditionAction && !!this.modalConditionName.trim());

    // Weapon equips and Battle Notes edits are silent state changes (same
    // tier as an HP edit) -- always persisted via the plain encounter PUT.
    // The narrated damage/heal/condition stream only fires on top of that
    // when there's actually something to narrate.
    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => {
        this.combat.encounter.set(updatedEnc);

        if (hasNarratedAction) {
          const event: DamageEvent = {
            target_id: this.selectedTargetId,
            attacker_id: this.modalAttackerId || undefined,
            damage_entries: this.modalDamageEntries
              .filter((e) => Number(e.amount) > 0)
              .map((e) => ({ amount: Number(e.amount), damage_type: e.damage_type })),
            healing_amount: Number(this.modalHealingAmount) || 0,
            condition_name: this.modalConditionAction ? this.modalConditionName.trim() : undefined,
            condition_action: this.modalConditionAction ?? undefined,
          };
          this.combat.applyDamageStream(updatedEnc.encounter_id, event, (status) => this.onStreamFailure(status));
        }
      },
      error: (err) => this.onSaveError(err, 'save encounter updates')
    });

    this.showDamageModal = false;
  }

  canStartCombat(): boolean {
    const enc = this.combat.encounter();
    return !!enc && !enc.combat_started && enc.combatants.length > 0;
  }

  startCombat(): void {
    const enc = this.combat.encounter();
    if (!this.canStartCombat() || !enc) return;

    // Locks in initiative order for the fight: highest initiative first,
    // round/turn tracking begins from the top.
    enc.combatants = [...enc.combatants].sort((a, b) => b.initiative - a.initiative);
    enc.active_turn_index = 0;
    enc.round = 1;
    enc.combat_started = true;

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => this.combat.encounter.set(updatedEnc),
      error: (err) => this.onSaveError(err, 'start combat')
    });
  }

  canGoToPreviousTurn(): boolean {
    const enc = this.combat.encounter();
    if (!enc || !enc.combat_started || enc.combatants.length === 0) return false;
    return !(enc.round === 1 && enc.active_turn_index === 0);
  }

  previousTurn(): void {
    const enc = this.combat.encounter();
    if (!this.canGoToPreviousTurn() || !enc) return;

    enc.active_turn_index--;
    if (enc.active_turn_index < 0) {
      enc.active_turn_index = enc.combatants.length - 1;
      enc.round--;
    }

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => this.combat.encounter.set(updatedEnc),
      error: (err) => this.onSaveError(err, 'update encounter')
    });
  }

  nextTurn(): void {
    const enc = this.combat.encounter();
    if (!enc || !enc.combat_started || enc.combatants.length === 0) return;

    enc.active_turn_index++;
    if (enc.active_turn_index >= enc.combatants.length) {
      enc.active_turn_index = 0;
      enc.round++;
    }

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => this.combat.encounter.set(updatedEnc),
      error: (err) => this.onSaveError(err, 'update encounter')
    });
  }

  openAddModal(): void {
    this.selectedTemplate = '';
    this.selectedRosterId = '';
    this.addAmount = 1;
    this.newCombatant = this.getEmptyCombatant();
    this.showAddModal = true;
  }

  /** A campaign character was picked (or cleared): fill the form from the campaign, or start over. */
  onRosterChange(): void {
    const character = this.campaigns.roster().find((c) => c.id === this.selectedRosterId);
    this.selectedTemplate = '';
    this.addAmount = 1;
    if (!character) {
      this.selectedRosterId = '';
      this.newCombatant = this.getEmptyCombatant();
      return;
    }
    this.newCombatant = {
      name: character.name,
      type: character.type,
      armor_class: character.armor_class,
      max_hp: character.max_hp,
      current_hp: character.current_hp,
      faction: character.faction ?? '',
      initiative: character.initiative,
      weapon_equipped: character.weapon_equipped,
    };
  }

  /**
   * Max HP was edited in the dialog. For a campaign character who is at full health, current HP
   * follows it (raising a character's max HP should not leave them wounded); a wounded character's
   * current HP is left alone.
   */
  onMaxHpChange(value: number | null): void {
    const previousMax = this.newCombatant.max_hp;
    this.newCombatant.max_hp = value ?? undefined;
    if (this.selectedRosterId && typeof value === 'number' && this.newCombatant.current_hp === previousMax) {
      this.newCombatant.current_hp = value;
    }
  }

  getEmptyCombatant(): Partial<Combatant> {
    return { name: '', type: 'enemy', armor_class: 10, max_hp: 10, faction: '', initiative: 0, weapon_equipped: 'Unarmed' };
  }

  onTemplateChange(): void {
    if (this.selectedTemplate === 'enemy') {
      this.newCombatant = { name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile', initiative: 0, weapon_equipped: 'Unarmed' };
    } else if (this.selectedTemplate === 'player') {
      this.newCombatant = { name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '', initiative: 0, weapon_equipped: 'Unarmed' };
    } else {
      this.newCombatant = this.getEmptyCombatant();
    }
  }

  addCombatant(): void {
    const enc = this.combat.encounter();
    if (!enc) return;

    // Never an unnamed ("Unknown") combatant, never a campaign player who is not on the campaign
    // list, never the same character twice. The dialog disables Add for all of these; this is the
    // backstop for anything that reaches here another way.
    if (!this.canAddCombatant()) return;

    const known = this.campaigns.roster().find((character) => character.id === this.selectedRosterId);

    const newIds: string[] = [];
    const newCombatants: Combatant[] = [];

    if (known) {
      // A known campaign character: exactly one, under their own id, with the sheet the campaign
      // lists. What a GM legitimately sets per encounter -- initiative, max and current HP, AC,
      // weapon (the campaign file's stats are placeholders they will want to correct) -- is taken
      // from the form; the campaign list itself is never changed.
      const maxHp = this.newCombatant.max_hp || known.max_hp;
      newCombatants.push({
        ...known,
        conditions: [...known.conditions],
        tactical_tags: [...known.tactical_tags],
        resources: { ...known.resources },
        armor_class: this.newCombatant.armor_class || known.armor_class,
        max_hp: maxHp,
        // Starts at the campaign's listed value; an emptied field means full health. (Range-checked above.)
        current_hp: typeof this.newCombatant.current_hp === 'number' ? this.newCombatant.current_hp : maxHp,
        initiative: this.newCombatant.initiative ?? known.initiative,
        weapon_equipped: this.newCombatant.weapon_equipped || known.weapon_equipped,
      });
      newIds.push(known.id);
    } else {
      if (this.newCombatant.type === 'player') {
        this.addAmount = 1;
      }

      const baseName = (this.newCombatant.name ?? '').trim();
      for (let i = 0; i < this.addAmount; i++) {
        const id = this.newCombatant.type + '_' + Math.floor(Math.random() * 1000000);
        const name = this.addAmount > 1 ? `${baseName} ${i + 1}` : baseName;

        const combatant: Combatant = {
          id: id,
          name: name,
          type: (this.newCombatant.type as EntityType) || 'enemy',
          armor_class: this.newCombatant.armor_class || 10,
          max_hp: this.newCombatant.max_hp || 10,
          current_hp: this.newCombatant.max_hp || 10,
          conditions: [],
          tactical_tags: [],
          resources: {},
          faction: this.newCombatant.faction || undefined,
          initiative: this.newCombatant.initiative ?? 0,
          weapon_equipped: this.newCombatant.weapon_equipped || 'Unarmed'
        };

        newCombatants.push(combatant);
        newIds.push(id);
      }
    }

    if (!enc.combat_started) {
      // Setup phase -- no round/turn is in progress yet, so there's no
      // "already acted" segment to protect and no real active combatant
      // to preserve either. Always fully resort by initiative; whoever
      // naturally has the highest initiative lands first.
      enc.combatants = enc.combatants.concat(newCombatants).sort((a, b) => b.initiative - a.initiative);
      enc.active_turn_index = 0;
    } else {
      // Combat in progress -- combatants up through the currently active
      // one have already had (or are having) their turn this round.
      // Splicing new arrivals in there via a full re-sort would
      // retroactively rewrite a round already in progress, and if a
      // high-initiative newcomer landed at an index at or before the
      // active pointer, forward-only turn advancement would skip them
      // entirely until the *next* round. Instead, only insert new arrivals
      // into the not-yet-acted remainder of this round, sorted by
      // initiative within just that remainder, so a high-roller who joins
      // mid-round still gets a turn this round instead of being skipped.
      const alreadyActedOrActive = enc.combatants.slice(0, enc.active_turn_index + 1);
      const notYetActed = enc.combatants.slice(enc.active_turn_index + 1);
      notYetActed.push(...newCombatants);
      notYetActed.sort((a, b) => b.initiative - a.initiative);

      enc.combatants = alreadyActedOrActive.concat(notYetActed);
    }

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => {
        this.combat.encounter.set(updatedEnc);
        this.showAddModal = false;
        if (!this.selectedTargetId && newIds.length > 0) {
          this.selectedTargetId = newIds[newIds.length - 1];
        }
      },
      error: (err) => this.onSaveError(err, 'add combatant')
    });
  }
}
