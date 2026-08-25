import { Component, OnInit, PLATFORM_ID, inject } from '@angular/core';
import { CommonModule, isPlatformServer } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { retry, timer } from 'rxjs';
import { CombatService } from './services/combat.service';
import { Combatant, DamageEvent, DamageType, EncounterState, EntityType } from './models/combat.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div *ngIf="connectionError" style="background: #dc2626; color: white; padding: 10px 20px; font-family: monospace;">
      Could not reach the backend after several retries. It may still be starting up (this can take up to a minute on first boot) -- wait a bit and <a (click)="createFreshEncounter()" style="color: white; text-decoration: underline; cursor: pointer;">try again</a>.
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
        
        <div *ngIf="combat.encounter() as enc">
          <p><strong>Round:</strong> {{ enc.round }} | <strong>Turn:</strong> {{ enc.active_turn_index + 1 }}</p>
          
          <div *ngIf="enc.combatants.length === 0" style="padding: 20px; text-align: center; color: #888;">
            No combatants in this encounter.
          </div>

          <div *ngFor="let c of enc.combatants; let i = index" 
               [style.border]="c.id === selectedTargetId ? '2px solid gold' : (i === enc.active_turn_index ? '2px solid #3b82f6' : '1px solid #ccc')"
               (click)="selectedTargetId = c.id"
               style="padding: 10px; margin-bottom: 10px; cursor: pointer; border-radius: 4px; position: relative;">
            
            <div *ngIf="i === enc.active_turn_index" style="position: absolute; top: 10px; right: 10px; font-size: 10px; background: #3b82f6; color: white; padding: 2px 4px; border-radius: 4px;">ACTIVE</div>

            <div style="display: flex; justify-content: space-between;">
              <strong>{{ c.name }} ({{ c.type }})</strong>
              <span>Init: {{ c.initiative }} | AC: {{ c.armor_class }}</span>
            </div>
            <div>HP: {{ c.current_hp }} / {{ c.max_hp }}</div>
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
          <label>Target ID: </label>
          <input type="text" [(ngModel)]="selectedTargetId" style="width: 100%; margin-bottom: 8px;" />
          
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
                  style="width: 100%; padding: 8px; background: #2563eb; color: white; border: none; cursor: pointer;">
            Apply Damage & Stream Narration
          </button>
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
        <select [(ngModel)]="newCombatant.type" style="width: 100%; margin-bottom: 8px;">
          <option value="player">Player</option>
          <option value="enemy">Enemy</option>
          <option value="npc">NPC</option>
        </select>

        <label style="color: black;">Initiative: </label>
        <input type="number" [(ngModel)]="newCombatant.initiative" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Max HP: </label>
        <input type="number" [(ngModel)]="newCombatant.max_hp" style="width: 100%; margin-bottom: 8px;" />

        <label style="color: black;">Armor Class: </label>
        <input type="number" [(ngModel)]="newCombatant.armor_class" style="width: 100%; margin-bottom: 8px;" />

        <label *ngIf="newCombatant.type === 'enemy'" style="color: black;">Faction: </label>
        <input *ngIf="newCombatant.type === 'enemy'" type="text" [(ngModel)]="newCombatant.faction" style="width: 100%; margin-bottom: 8px;" />

        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
          <button (click)="showAddModal = false" style="padding: 6px 12px; cursor: pointer; color: black;">Cancel</button>
          <button (click)="addCombatant()" style="padding: 6px 12px; background: #10b981; color: white; border: none; cursor: pointer;">Add</button>
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
  
  showAddModal = false;
  selectedTemplate = '';
  addAmount = 1;
  newCombatant: Partial<Combatant> = this.getEmptyCombatant();
  connectionError = false;

  damageTypes: DamageType[] = [
    'Slashing', 'Piercing', 'Bludgeoning', 'Fire', 'Cold',
    'Lightning', 'Acid', 'Poison', 'Psychic', 'Radiant', 'Necrotic', 'Force'
  ];

  ngOnInit(): void {
    this.createFreshEncounter();
  }

  createFreshEncounter(): void {
    this.connectionError = false;

    const initialEncounter: EncounterState = {
      encounter_id: 'enc_' + Math.floor(Math.random() * 100000),
      round: 1,
      active_turn_index: 0,
      combatants: [],
    };

    // A cold backend (first-ever boot re-ingests lore/rules before it
    // starts accepting requests) can take up to ~30s, during which nginx
    // returns 502 for the API. Without a retry, this call fails silently
    // (console.error only) and every later action -- including the "Add"
    // button in the modal -- becomes a no-op with zero user-visible
    // feedback, which looks exactly like the whole app hanging.
    //
    // Retries are skipped during SSR/prerendering (isServer): ngOnInit also
    // runs server-side at `ng build` time with no real backend to ever
    // succeed against, and retrying there just burns wall-clock time until
    // Angular's own prerender timeout aborts the build -- confirmed by
    // reproducing the exact "TimeoutError: The operation was aborted due to
    // timeout" build failure this caused before adding this guard.
    this.combat
      .createEncounter(initialEncounter)
      .pipe(retry({ count: this.isServer ? 0 : 10, delay: () => timer(2000) }))
      .subscribe({
        next: (res) => this.combat.encounter.set(res),
        error: (err) => {
          console.error('Failed to create initial encounter after retries:', err);
          this.connectionError = true;
        },
      });
  }

  newEncounter(): void {
    if (!window.confirm('Start a new encounter? This will clear the current session.')) {
      return;
    }

    this.selectedTargetId = '';
    this.damageAmount = 8;
    this.selectedType = 'Slashing';
    this.conditionInput = '';
    this.combat.narrative.set('');

    this.createFreshEncounter();
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
    return { name: '', type: 'enemy', armor_class: 10, max_hp: 10, faction: '', initiative: 0 };
  }

  onTemplateChange(): void {
    if (this.selectedTemplate === 'enemy') {
      this.newCombatant = { name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile', initiative: 0 };
    } else if (this.selectedTemplate === 'player') {
      this.newCombatant = { name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '', initiative: 0 };
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
        initiative: this.newCombatant.initiative ?? 0
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
