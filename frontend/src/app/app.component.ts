import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CombatService } from './services/combat.service';
import { Combatant, DamageEvent, DamageType, EncounterState, EntityType } from './models/combat.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div style="display: flex; gap: 20px; padding: 20px; font-family: monospace;">
      <!-- Column 1: Combat Tracker -->
      <div style="flex: 1; border: 1px solid #444; padding: 15px; border-radius: 6px; position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h3>Initiative & Health Tracker</h3>
          <div>
            <button (click)="openAddModal()" style="padding: 6px; margin-right: 8px; background: #10b981; color: white; border: none; cursor: pointer;">Add Combatant</button>
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
              <span>AC: {{ c.armor_class }}</span>
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

  selectedTargetId = '';
  damageAmount = 8;
  selectedType: DamageType = 'Slashing';
  conditionInput = '';
  
  showAddModal = false;
  selectedTemplate = '';
  addAmount = 1;
  newCombatant: Partial<Combatant> = this.getEmptyCombatant();

  damageTypes: DamageType[] = [
    'Slashing', 'Piercing', 'Bludgeoning', 'Fire', 'Cold',
    'Lightning', 'Acid', 'Poison', 'Psychic', 'Radiant', 'Necrotic', 'Force'
  ];

  ngOnInit(): void {
    this.createFreshEncounter();
  }

  private createFreshEncounter(): void {
    const initialEncounter: EncounterState = {
      encounter_id: 'enc_' + Math.floor(Math.random() * 100000),
      round: 1,
      active_turn_index: 0,
      combatants: [],
    };

    this.combat.createEncounter(initialEncounter).subscribe({
      next: (res) => this.combat.encounter.set(res),
      error: (err) => console.error('Failed to create initial encounter:', err),
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
    return { name: '', type: 'enemy', armor_class: 10, max_hp: 10, faction: '' };
  }

  onTemplateChange(): void {
    if (this.selectedTemplate === 'enemy') {
      this.newCombatant = { name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile' };
    } else if (this.selectedTemplate === 'player') {
      this.newCombatant = { name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '' };
    } else {
      this.newCombatant = this.getEmptyCombatant();
    }
  }

  addCombatant(): void {
    const enc = this.combat.encounter();
    if (!enc) return;

    if (this.newCombatant.type === 'player') {
      this.addAmount = 1;
    }

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
        faction: this.newCombatant.faction || undefined
      };

      enc.combatants.push(combatant);
    }

    this.combat.updateEncounter(enc.encounter_id, enc).subscribe({
      next: (updatedEnc) => {
        this.combat.encounter.set(updatedEnc);
        this.showAddModal = false;
        if (!this.selectedTargetId && enc.combatants.length > 0) {
          this.selectedTargetId = enc.combatants[enc.combatants.length - 1].id;
        }
      },
      error: (err) => console.error('Failed to add combatant:', err)
    });
  }
}
