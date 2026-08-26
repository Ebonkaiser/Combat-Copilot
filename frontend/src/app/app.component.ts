import { Component, OnInit, PLATFORM_ID, inject } from '@angular/core';
import { CommonModule, isPlatformServer } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { retry, timer } from 'rxjs';
import { CombatService } from './services/combat.service';
import { Combatant, DamageEvent, DamageType, EncounterState, EntityType } from './models/combat.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div style="padding: 16px 20px 0; font-family: monospace;">
      <h2 style="margin: 0;">GM Assistant — AI Combat Copilot</h2>
      <p style="margin: 4px 0 0; color: #888; font-size: 13px;">Track initiative and HP, then apply damage to get AI-narrated combat play-by-play.</p>
    </div>

    <div *ngIf="connectionError" style="background: #dc2626; color: white; padding: 10px 20px; font-family: monospace;">
      <ng-container *ngIf="connectionErrorDetail; else genericError">{{ connectionErrorDetail }}</ng-container>
      <ng-template #genericError>Could not reach the backend after several retries. It may still be starting up (this can take up to a minute on first boot) -- wait a bit and</ng-template>
      <a (click)="retryConnection()" style="color: white; text-decoration: underline; cursor: pointer;">try again</a>.
    </div>

    <div style="display: flex; gap: 20px; padding: 20px; font-family: monospace;">
      <!-- Column 1: Combat Tracker -->
      <div style="flex: 1; border: 1px solid #444; padding: 15px; border-radius: 6px; position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h3>Initiative & Health Tracker</h3>
          <div>
            <button (click)="openAddModal()" [disabled]="!combat.encounter()" data-testid="add-combatant-btn" style="padding: 6px; margin-right: 8px; background: #10b981; color: white; border: none; cursor: pointer;">Add Combatant</button>
            <button (click)="nextTurn()" style="padding: 6px; margin-right: 8px; background: #f59e0b; color: white; border: none; cursor: pointer;">Next Turn</button>
            <button (click)="newEncounter()" style="padding: 6px; background: #dc2626; color: white; border: none; cursor: pointer;">New Encounter</button>
          </div>
        </div>

        <div *ngIf="backendStarting && !connectionError" style="padding: 30px; text-align: center; color: #888;">
          <div style="font-size: 24px; margin-bottom: 8px;">⏳</div>
          Backend is starting up, hang tight…
        </div>

        <div *ngIf="combat.encounter() as enc">
          <p><strong>Round:</strong> {{ enc.round }} | <strong>Turn:</strong> {{ enc.active_turn_index + 1 }}</p>

          <div *ngIf="enc.combatants.length === 0" style="padding: 20px; text-align: center; color: #888;">
            No combatants in this encounter yet. Click <strong>Add Combatant</strong> above to get started.
          </div>

          <div *ngFor="let c of enc.combatants; let i = index"
               [style.border]="c.id === selectedTargetId ? '2px solid gold' : (i === enc.active_turn_index ? '2px solid #3b82f6' : (c.id === hoveredId ? '1px solid #888' : '1px solid #ccc'))"
               (click)="selectedTargetId = c.id"
               (mouseenter)="hoveredId = c.id"
               (mouseleave)="hoveredId = null"
               style="padding: 10px; margin-bottom: 10px; cursor: pointer; border-radius: 4px; position: relative;">

            <div *ngIf="i === enc.active_turn_index" style="position: absolute; top: 10px; right: 10px; font-size: 10px; background: #3b82f6; color: white; padding: 2px 4px; border-radius: 4px;">ACTIVE</div>

            <div style="display: flex; justify-content: space-between;">
              <strong>{{ c.name }} ({{ c.type }})</strong>
              <span>Init: {{ c.initiative }} | AC: {{ c.armor_class }}</span>
            </div>
            <div>HP: {{ c.current_hp }} / {{ c.max_hp }}</div>
            <div style="color: #888; font-size: 12px;">Weapon: {{ c.weapon_equipped }}</div>
            <div style="background: #eee; width: 100%; height: 8px; margin: 4px 0;">
              <div [style.width.%]="(c.current_hp / c.max_hp) * 100"
                   [style.background]="c.current_hp === 0 ? 'red' : 'green'"
                   style="height: 100%;"></div>
            </div>
            <div>
              <span *ngFor="let cond of c.conditions"
                    style="background: crimson; color: white; padding: 2px 4px; font-size: 10px; margin-right: 4px; border-radius: 2px;">
                {{ cond }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Column 2: Action Entry & Narrative -->
      <div style="flex: 1; border: 1px solid #444; padding: 15px; border-radius: 6px;">
        <h3>Manual Damage Entry</h3>
        <div style="margin-bottom: 15px;">
          <label>Target: </label>
          <div style="width: 100%; margin-bottom: 4px; padding: 6px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #444; border-radius: 4px; box-sizing: border-box;">
            {{ selectedTargetName() || 'None selected' }}
          </div>
          <div style="font-size: 11px; color: #888; margin-bottom: 8px;">Click a combatant on the left to target them.</div>

          <label>Weapon Equipped: </label>
          <div style="display: flex; gap: 8px; margin-bottom: 12px;">
            <input type="text" [(ngModel)]="weaponInput" placeholder="Rapier, Longbow" style="flex: 1;" />
            <button (click)="equipWeapon()"
                    [disabled]="!selectedTargetId || !weaponInput"
                    style="padding: 6px 10px; background: #6d28d9; color: white; border: none; cursor: pointer;">
              Equip
            </button>
          </div>

          <label>Damage Amount: </label>
          <input type="number" [(ngModel)]="damageAmount" style="width: 100%; margin-bottom: 8px;" />

          <label>Damage Type: </label>
          <select [(ngModel)]="selectedType" style="width: 100%; margin-bottom: 8px;">
            <option *ngFor="let t of damageTypes" [value]="t">{{ t }}</option>
          </select>

          <label>Apply Condition: </label>
          <input type="text" [(ngModel)]="conditionInput" placeholder="Bleed, Stunned" style="width: 100%; margin-bottom: 12px;" />

          <button (click)="submitAction()"
                  [disabled]="combat.isStreaming() || !selectedTargetId"
                  [title]="combat.isStreaming() ? 'Narration is streaming — please wait.' : (!selectedTargetId ? 'Select a combatant on the left to target before applying damage.' : '')"
                  style="width: 100%; padding: 8px; background: #2563eb; color: white; border: none; cursor: pointer;">
            Apply Damage & Stream Narration
          </button>
          <div *ngIf="!selectedTargetId" style="font-size: 11px; color: #888; margin-top: 4px;">Select a combatant on the left to enable this.</div>
        </div>

        <h3>Copilot Stream</h3>
        <div style="min-height: 150px; background: #1e1e1e; color: #d4d4d4; padding: 10px; border-radius: 4px; white-space: pre-wrap;">
          {{ combat.narrative() }}
          <span *ngIf="combat.isStreaming()">▌</span>
        </div>
      </div>
    </div>

    <!-- Add Combatant Modal -->
    <div *ngIf="showAddModal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;">
      <div style="background: white; padding: 20px; border-radius: 8px; width: 400px; font-family: monospace;">
        <h3 style="margin-top: 0; color: black;">Add Combatant</h3>

        <label style="color: black;">Template: </label>
        <select [(ngModel)]="selectedTemplate" (change)="onTemplateChange()" style="width: 100%; margin-bottom: 8px;">
          <option value="">-- Custom --</option>
          <option value="enemy">Enemy</option>
          <option value="player">Player</option>
        </select>

        <ng-container *ngIf="newCombatant.type !== 'player'">
          <label style="color: black;">Amount: </label>
          <input type="number" [(ngModel)]="addAmount" style="width: 100%; margin-bottom: 8px;" min="1" />
        </ng-container>

        <label style="color: black;">Name: </label>
        <input type="text" [(ngModel)]="newCombatant.name" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Type: </label>
        <select [(ngModel)]="newCombatant.type" style="width: 100%; margin-bottom: 4px;">
          <option value="player">Player</option>
          <option value="enemy">Enemy</option>
          <option value="npc">NPC</option>
        </select>
        <div style="font-size: 11px; color: #666; margin-bottom: 8px;" [ngSwitch]="newCombatant.type">
          <span *ngSwitchCase="'player'">Players are added one at a time and have no Faction (Faction is Enemy-only).</span>
          <span *ngSwitchCase="'enemy'">Add multiple identical enemies at once with Amount. Faction is used to pull relevant lore during narration.</span>
          <span *ngSwitchCase="'npc'">Add multiple identical NPCs at once with Amount. NPCs have no Faction field (Enemy-only).</span>
        </div>

        <label style="color: black;">Initiative: </label>
        <input type="number" [(ngModel)]="newCombatant.initiative" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Max HP: </label>
        <input type="number" [(ngModel)]="newCombatant.max_hp" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Armor Class: </label>
        <input type="number" [(ngModel)]="newCombatant.armor_class" style="width: 100%; margin-bottom: 8px;" />

        <label *ngIf="newCombatant.type === 'enemy'" style="color: black;">Faction: </label>
        <input *ngIf="newCombatant.type === 'enemy'" type="text" [(ngModel)]="newCombatant.faction" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Weapon Equipped: </label>
        <input type="text" [(ngModel)]="newCombatant.weapon_equipped" style="width: 100%; margin-bottom: 8px;" />

        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
          <button (click)="showAddModal = false" style="padding: 6px 12px; cursor: pointer; color: black;">Cancel</button>
          <button (click)="addCombatant()" style="padding: 6px 12px; background: #10b981; color: white; border: none; cursor: pointer;">Add</button>
        </div>
      </div>
    </div>

    <!-- New Encounter Confirm Modal -->
    <div *ngIf="showNewEncounterConfirm" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;">
      <div style="background: white; padding: 20px; border-radius: 8px; width: 360px; font-family: monospace;">
        <h3 style="margin-top: 0; color: black;">Start a new encounter?</h3>
        <p style="color: black;">This will clear the current session, including combatants and narration.</p>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
          <button (click)="cancelNewEncounter()" style="padding: 6px 12px; cursor: pointer; color: black;">Cancel</button>
          <button (click)="confirmNewEncounter()" style="padding: 6px 12px; background: #dc2626; color: white; border: none; cursor: pointer;">Start New Encounter</button>
        </div>
      </div>
    </div>
  `,
})
export class AppComponent implements OnInit {
  combat = inject(CombatService);
  private isServer = isPlatformServer(inject(PLATFORM_ID));

  selectedTargetId = '';
  damageAmount = 8;
  selectedType: DamageType = 'Slashing';
  conditionInput = '';
  weaponInput = '';

  showAddModal = false;
  showNewEncounterConfirm = false;
  selectedTemplate = '';
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

  ngOnInit(): void {
    this.pollHealth();
  }

  pollHealth(): void {
    this.combat.checkHealth().subscribe({
      next: () => {
        this.backendStarting = false;
        this.createFreshEncounter();
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

  createFreshEncounter(): void {
    const initialEncounter: EncounterState = {
      encounter_id: 'enc_' + Math.floor(Math.random() * 100000),
      round: 1,
      active_turn_index: 0,
      combatants: [],
    };

    // By the time this runs, pollHealth() has already confirmed the
    // backend is reachable -- this retry is defense-in-depth for a one-off
    // transient blip on this specific call, not the primary cold-start
    // handling (that's pollHealth's job).
    this.combat
      .createEncounter(initialEncounter)
      .pipe(retry({ count: 10, delay: () => timer(2000) }))
      .subscribe({
        next: (res) => this.combat.encounter.set(res),
        error: (err) => {
          console.error('Failed to create initial encounter after retries:', err);
          this.connectionError = true;
        },
      });
  }

  newEncounter(): void {
    this.showNewEncounterConfirm = true;
  }

  confirmNewEncounter(): void {
    this.showNewEncounterConfirm = false;
    this.selectedTargetId = '';
    this.damageAmount = 8;
    this.selectedType = 'Slashing';
    this.conditionInput = '';
    this.weaponInput = '';
    this.combat.narrative.set('');

    this.createFreshEncounter();
  }

  cancelNewEncounter(): void {
    this.showNewEncounterConfirm = false;
  }

  selectedTargetName(): string | undefined {
    return this.combat.encounter()?.combatants.find((c) => c.id === this.selectedTargetId)?.name;
  }

  submitAction(): void {
    const enc = this.combat.encounter();
    if (!enc) return;

    const event: DamageEvent = {
      target_id: this.selectedTargetId,
      damage_amount: this.damageAmount,
      damage_type: this.selectedType,
      applied_conditions: this.conditionInput
        ? this.conditionInput.split(',').map((c) => c.trim())
        : [],
    };

    this.combat.applyDamageStream(enc.encounter_id, event);
  }

  equipWeapon(): void {
    const enc = this.combat.encounter();
    if (!enc || !this.selectedTargetId || !this.weaponInput) return;

    this.combat.equipWeapon(enc.encounter_id, this.selectedTargetId, this.weaponInput).subscribe({
      next: (updatedEnc) => {
        this.combat.encounter.set(updatedEnc);
        this.weaponInput = '';
      },
      error: (err) => console.error('Failed to equip weapon:', err)
    });
  }

  nextTurn(): void {
    const enc = this.combat.encounter();
    if (!enc || enc.combatants.length === 0) return;

    enc.active_turn_index++;
    if (enc.active_turn_index >= enc.combatants.length) {
      enc.active_turn_index = 0;
      enc.round++;
    }

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => this.combat.encounter.set(updatedEnc),
      error: (err) => console.error('Failed to update encounter:', err)
    });
  }

  openAddModal(): void {
    this.selectedTemplate = '';
    this.addAmount = 1;
    this.newCombatant = this.getEmptyCombatant();
    this.showAddModal = true;
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

    // Captured before mutation so a re-sort below can preserve *who* is
    // acting, not merely which array index currently means "active".
    const activeCombatant = enc.combatants[enc.active_turn_index];

    if (this.newCombatant.type === 'player') {
      this.addAmount = 1;
    }

    const newIds: string[] = [];
    for (let i = 0; i < this.addAmount; i++) {
      const id = this.newCombatant.type + '_' + Math.floor(Math.random() * 1000000);
      const name = this.addAmount > 1 ? `${this.newCombatant.name || 'Unknown'} ${i + 1}` : (this.newCombatant.name || 'Unknown');

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

      enc.combatants.push(combatant);
      newIds.push(id);
    }

    // Highest initiative acts first (standard tabletop convention). Re-sort
    // by identity, not index: if a newly added combatant's initiative
    // outranks the currently active one, active_turn_index must follow the
    // active combatant to their new position -- otherwise the turn pointer
    // would silently land on a different combatant after the reorder.
    enc.combatants.sort((a, b) => b.initiative - a.initiative);
    enc.active_turn_index = activeCombatant
      ? enc.combatants.findIndex((c) => c.id === activeCombatant.id)
      : 0;

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => {
        this.combat.encounter.set(updatedEnc);
        this.showAddModal = false;
        if (!this.selectedTargetId && newIds.length > 0) {
          this.selectedTargetId = newIds[newIds.length - 1];
        }
      },
      error: (err) => console.error('Failed to add combatant:', err)
    });
  }
}
