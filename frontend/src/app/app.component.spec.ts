import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { AppComponent } from './app.component';
import { CombatService } from './services/combat.service';
import { Combatant, EncounterState } from './models/combat.model';

describe('AppComponent', () => {
  let httpMock: HttpTestingController;
  let combat: CombatService;

  const makeEncounter = (overrides: Partial<EncounterState> = {}): EncounterState => ({
    encounter_id: 'enc_1',
    round: 1,
    active_turn_index: 0,
    combatants: [],
    ...overrides,
  });

  const makeCombatant = (overrides: Partial<Combatant> = {}): Combatant => ({
    id: 'c1',
    name: 'Goblin',
    type: 'enemy',
    armor_class: 12,
    max_hp: 10,
    current_hp: 10,
    conditions: [],
    tactical_tags: [],
    resources: {},
    initiative: 0,
    weapon_equipped: 'Unarmed',
    ...overrides,
  });

  function createReadyFixture(): ComponentFixture<AppComponent> {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.method === 'GET' && r.url.endsWith('/health')).flush({ status: 'ok' });
    return fixture;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent, HttpClientTestingModule],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    combat = TestBed.inject(CombatService);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('creates the component', () => {
    const fixture = createReadyFixture();
    httpMock.expectOne((req) => req.method === 'POST' && req.url.endsWith('/encounters')).flush(makeEncounter());
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('startup (health polling)', () => {
    it('polls /health, then creates an initial encounter once the backend reports ready', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      expect(fixture.componentInstance.backendStarting).toBeTrue();

      httpMock.expectOne((r) => r.method === 'GET' && r.url.endsWith('/health')).flush({ status: 'ok' });
      expect(fixture.componentInstance.backendStarting).toBeFalse();

      const req = httpMock.expectOne((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      const created = makeEncounter({ encounter_id: req.request.body.encounter_id });
      req.flush(created);

      expect(combat.encounter()).toEqual(created);
    });

    it('keeps polling without setting connectionError while /health reports "starting"', fakeAsync(() => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      httpMock.expectOne((r) => r.url.endsWith('/health'))
        .flush({ status: 'starting' }, { status: 503, statusText: 'Service Unavailable' });
      tick(2000);
      httpMock.expectOne((r) => r.url.endsWith('/health'))
        .flush({ status: 'starting' }, { status: 503, statusText: 'Service Unavailable' });
      tick(2000);
      httpMock.expectOne((r) => r.url.endsWith('/health')).flush({ status: 'ok' });

      expect(fixture.componentInstance.connectionError).toBeFalse();
      const req = httpMock.expectOne((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      req.flush(makeEncounter({ encounter_id: req.request.body.encounter_id }));
    }));

    it('fails fast with connectionError when /health reports a startup error, without retrying', fakeAsync(() => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      httpMock.expectOne((r) => r.url.endsWith('/health'))
        .flush({ status: 'error', detail: 'Backend failed to start. Check server logs.' }, { status: 503, statusText: 'Service Unavailable' });

      expect(fixture.componentInstance.backendStarting).toBeFalse();
      expect(fixture.componentInstance.connectionError).toBeTrue();
      expect(fixture.componentInstance.connectionErrorDetail).toBe('Backend failed to start. Check server logs.');

      tick(2000);
      httpMock.expectNone((r) => r.url.endsWith('/health'));
    }));

    it('sets connectionError once every health poll attempt is exhausted', fakeAsync(() => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      for (let i = 0; i < fixture.componentInstance.maxHealthPollAttempts; i++) {
        httpMock.expectOne((r) => r.url.endsWith('/health'))
          .flush({ status: 'starting' }, { status: 503, statusText: 'Service Unavailable' });
        tick(2000);
      }

      expect(combat.encounter()).toBeNull();
      expect(fixture.componentInstance.connectionError).toBeTrue();
    }));
  });

  describe('submitAction', () => {
    function flushEncounterPut(): EncounterState {
      const req = httpMock.expectOne((r) => r.method === 'PUT' && r.url.endsWith('/enc_1'));
      const body = req.request.body as EncounterState;
      req.flush(body);
      return body;
    }

    it('does nothing when there is no active encounter', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      combat.encounter.set(null);
      spyOn(combat, 'applyDamageStream');

      fixture.componentInstance.submitAction();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });

    it('does nothing when nothing in the modal changed', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 0, damage_type: 'Slashing' }];
      comp.modalConditionAction = null;

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });

    it('builds a DamageEvent summing multiple damage types and streams it after saving', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant(), makeCombatant({ id: 'attacker_1', name: 'Attacker' })] })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalAttackerId = 'attacker_1';
      comp.modalDamageEntries = [
        { amount: 6, damage_type: 'Piercing' },
        { amount: 5, damage_type: 'Cold' },
      ];
      comp.modalConditionAction = 'add';
      comp.modalConditionName = 'Prone';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();
      expect(comp.showDamageModal).toBeFalse();

      flushEncounterPut();

      expect(combat.applyDamageStream).toHaveBeenCalledWith('enc_1', {
        target_id: 'c1',
        attacker_id: 'attacker_1',
        damage_entries: [
          { amount: 6, damage_type: 'Piercing' },
          { amount: 5, damage_type: 'Cold' },
        ],
        healing_amount: 0,
        condition_name: 'Prone',
        condition_action: 'add',
      });
    });

    it('allows a healing-only change with no damage entries, targeting whoever is selected regardless of turn', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant({ id: 'c1' }), makeCombatant({ id: 'c2' })], active_turn_index: 1 })
      );

      const comp = fixture.componentInstance;
      // c1 is selected even though it isn't c1's turn (active_turn_index points at c2).
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 0, damage_type: 'Slashing' }];
      comp.modalHealingAmount = 12;

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();
      flushEncounterPut();

      expect(combat.applyDamageStream).toHaveBeenCalledWith(
        'enc_1',
        jasmine.objectContaining({ target_id: 'c1', damage_entries: [], healing_amount: 12 })
      );
    });

    it('combines healing and damage in the same event when both are set', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 8, damage_type: 'Fire' }];
      comp.modalHealingAmount = 3;

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();
      flushEncounterPut();

      expect(combat.applyDamageStream).toHaveBeenCalledWith(
        'enc_1',
        jasmine.objectContaining({
          damage_entries: [{ amount: 8, damage_type: 'Fire' }],
          healing_amount: 3,
        })
      );
    });

    it('omits condition fields when no condition action is chosen', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 8, damage_type: 'Fire' }];
      comp.modalConditionAction = null;

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();
      flushEncounterPut();

      expect(combat.applyDamageStream).toHaveBeenCalledWith(
        'enc_1',
        jasmine.objectContaining({ condition_name: undefined, condition_action: undefined })
      );
    });

    it('allows a condition-only change with no damage entries', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 0, damage_type: 'Slashing' }];
      comp.modalConditionAction = 'remove';
      comp.modalConditionName = 'Prone';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();
      flushEncounterPut();

      expect(combat.applyDamageStream).toHaveBeenCalledWith(
        'enc_1',
        jasmine.objectContaining({ damage_entries: [], condition_name: 'Prone', condition_action: 'remove' })
      );
    });

    it('saves a weapon change on the chosen attacker without triggering narration', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant(), makeCombatant({ id: 'attacker_1', name: 'Attacker', weapon_equipped: 'Unarmed' })] })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalAttackerId = 'attacker_1';
      comp.modalOriginalWeapon = 'Unarmed';
      comp.modalWeaponInput = 'Rapier';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();

      const body = flushEncounterPut();
      expect(body.combatants.find((c) => c.id === 'attacker_1')?.weapon_equipped).toBe('Rapier');
      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });

    it('saves a Battle Notes change without triggering narration', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant()], gm_notes: '' })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalOriginalNotes = '';
      const enc = combat.encounter();
      if (enc) enc.gm_notes = 'The bridge is collapsing underfoot.';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();

      const body = flushEncounterPut();
      expect(body.gm_notes).toBe('The bridge is collapsing underfoot.');
      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });
  });

  describe('damage modal', () => {
    it('openDamageModal resets entries, defaults the attacker to the active combatant, and hydrates their weapon + notes', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [makeCombatant({ id: 'attacker_1', weapon_equipped: 'Longbow' }), makeCombatant({ id: 'c1' })],
          active_turn_index: 0,
          gm_notes: 'Existing scene notes.',
        })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalDamageEntries = [{ amount: 42, damage_type: 'Fire' }];
      comp.modalHealingAmount = 25;
      comp.modalWeaponInput = 'stale value';

      comp.openDamageModal();

      expect(comp.showDamageModal).toBeTrue();
      expect(comp.modalAttackerId).toBe('attacker_1');
      expect(comp.modalDamageEntries).toEqual([{ amount: 0, damage_type: 'Slashing' }]);
      expect(comp.modalHealingAmount).toBe(0);
      expect(comp.modalConditionAction).toBeNull();
      expect(comp.modalWeaponInput).toBe('Longbow');
      expect(comp.modalOriginalWeapon).toBe('Longbow');
      expect(comp.modalOriginalNotes).toBe('Existing scene notes.');
    });

    it('leaves the attacker unspecified when the active combatant is the target itself', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant({ id: 'c1' })], active_turn_index: 0 })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';

      comp.openDamageModal();

      expect(comp.modalAttackerId).toBe('');
      expect(comp.modalWeaponInput).toBe('');
    });

    it('hydrateWeaponFromAttacker re-syncs the weapon field when the attacker selection changes', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [
            makeCombatant({ id: 'a', weapon_equipped: 'Rapier' }),
            makeCombatant({ id: 'b', weapon_equipped: 'Dagger' }),
            makeCombatant({ id: 'c1' }),
          ],
        })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalAttackerId = 'a';
      comp.hydrateWeaponFromAttacker();
      expect(comp.modalWeaponInput).toBe('Rapier');

      comp.modalAttackerId = 'b';
      comp.hydrateWeaponFromAttacker();
      expect(comp.modalWeaponInput).toBe('Dagger');
      expect(comp.modalOriginalWeapon).toBe('Dagger');
    });

    it('modalTotalDamage sums all entries', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.modalDamageEntries = [
        { amount: 6, damage_type: 'Piercing' },
        { amount: 5, damage_type: 'Cold' },
      ];

      expect(comp.modalTotalDamage()).toBe(11);
    });
  });

  describe('canSubmitDamageModal', () => {
    it('is enabled when the weapon input differs from the attacker\'s stored weapon', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant(), makeCombatant({ id: 'attacker_1', weapon_equipped: 'Unarmed' })] })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalAttackerId = 'attacker_1';
      comp.modalOriginalWeapon = 'Unarmed';
      comp.modalWeaponInput = 'Unarmed';
      expect(comp.canSubmitDamageModal()).toBeFalse();

      comp.modalWeaponInput = 'Greatsword';
      expect(comp.canSubmitDamageModal()).toBeTrue();
    });

    it('is enabled when Battle Notes differ from the snapshot taken at modal-open time', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({ combatants: [makeCombatant()], gm_notes: 'original' })
      );

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.modalOriginalNotes = 'original';
      expect(comp.canSubmitDamageModal()).toBeFalse();

      const enc = combat.encounter();
      if (enc) enc.gm_notes = 'updated mid-fight';
      expect(comp.canSubmitDamageModal()).toBeTrue();
    });
  });

  describe('nextTurn', () => {
    it('does nothing when there is no encounter', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      combat.encounter.set(null);

      fixture.componentInstance.nextTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()).toBeNull();
    });

    it('does nothing when there are no combatants', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      fixture.componentInstance.nextTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()?.combatants.length).toBe(0);
    });

    it('advances the active_turn_index within the same round', () => {
      const fixture = createReadyFixture();
      httpMock
        .expectOne((r) => r.url.endsWith('/encounters'))
        .flush(makeEncounter({ combatants: [makeCombatant({ id: 'c1' }), makeCombatant({ id: 'c2' })], active_turn_index: 0 }));

      fixture.componentInstance.nextTurn();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.active_turn_index).toBe(1);
      expect(body.round).toBe(1);

      req.flush(body);
      expect(combat.encounter()?.active_turn_index).toBe(1);
    });

    it('wraps to the next round when the last combatant acts', () => {
      const fixture = createReadyFixture();
      httpMock
        .expectOne((r) => r.url.endsWith('/encounters'))
        .flush(makeEncounter({ combatants: [makeCombatant({ id: 'c1' })], active_turn_index: 0, round: 1 }));

      fixture.componentInstance.nextTurn();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.active_turn_index).toBe(0);
      expect(body.round).toBe(2);
      req.flush(body);
    });
  });

  describe('previousTurn', () => {
    it('does nothing when there is no encounter', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      combat.encounter.set(null);

      fixture.componentInstance.previousTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()).toBeNull();
    });

    it('does nothing when there are no combatants', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      fixture.componentInstance.previousTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()?.combatants.length).toBe(0);
    });

    it('is disabled at the very start of the encounter (round 1, first combatant)', () => {
      const fixture = createReadyFixture();
      httpMock
        .expectOne((r) => r.url.endsWith('/encounters'))
        .flush(makeEncounter({ combatants: [makeCombatant({ id: 'c1' }), makeCombatant({ id: 'c2' })], active_turn_index: 0, round: 1 }));

      const comp = fixture.componentInstance;
      expect(comp.canGoToPreviousTurn()).toBeFalse();

      comp.previousTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
    });

    it('steps back the active_turn_index within the same round', () => {
      const fixture = createReadyFixture();
      httpMock
        .expectOne((r) => r.url.endsWith('/encounters'))
        .flush(makeEncounter({ combatants: [makeCombatant({ id: 'c1' }), makeCombatant({ id: 'c2' })], active_turn_index: 1, round: 1 }));

      const comp = fixture.componentInstance;
      expect(comp.canGoToPreviousTurn()).toBeTrue();
      comp.previousTurn();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.active_turn_index).toBe(0);
      expect(body.round).toBe(1);

      req.flush(body);
      expect(combat.encounter()?.active_turn_index).toBe(0);
    });

    it('wraps back to the previous round and the last combatant', () => {
      const fixture = createReadyFixture();
      httpMock
        .expectOne((r) => r.url.endsWith('/encounters'))
        .flush(makeEncounter({ combatants: [makeCombatant({ id: 'c1' }), makeCombatant({ id: 'c2' })], active_turn_index: 0, round: 2 }));

      fixture.componentInstance.previousTurn();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.active_turn_index).toBe(1);
      expect(body.round).toBe(1);
      req.flush(body);
    });
  });

  describe('add combatant button availability', () => {
    it('disables the Add Combatant button until the initial encounter has loaded, so a fast click cannot silently no-op', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      const button = fixture.nativeElement.querySelector('[data-testid="add-combatant-btn"]') as HTMLButtonElement;
      expect(button.disabled).toBeTrue();

      httpMock.expectOne((r) => r.method === 'GET' && r.url.endsWith('/health')).flush({ status: 'ok' });
      fixture.detectChanges();
      expect(button.disabled).toBeTrue();

      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      fixture.detectChanges();

      expect(button.disabled).toBeFalse();
    });
  });

  describe('add combatant modal', () => {
    it('openAddModal resets the form and shows the modal', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'enemy';
      comp.addAmount = 5;
      comp.showAddModal = false;

      comp.openAddModal();

      expect(comp.showAddModal).toBeTrue();
      expect(comp.selectedTemplate).toBe('');
      expect(comp.addAmount).toBe(1);
      expect(comp.newCombatant).toEqual(comp.getEmptyCombatant());
    });

    it('onTemplateChange applies the enemy template', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'enemy';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual({ name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile', initiative: 0, weapon_equipped: 'Unarmed' });
    });

    it('onTemplateChange applies the player template', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'player';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual({ name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '', initiative: 0, weapon_equipped: 'Unarmed' });
    });

    it('onTemplateChange falls back to an empty combatant for custom', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = '';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual(comp.getEmptyCombatant());
    });

    it('addCombatant does nothing without an active encounter', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      combat.encounter.set(null);

      fixture.componentInstance.addCombatant();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()).toBeNull();
    });

    it('adds a single combatant with the entered fields', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Orc', type: 'enemy', armor_class: 14, max_hp: 25, faction: 'Hostile' };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.length).toBe(1);
      expect(body.combatants[0]).toEqual(
        jasmine.objectContaining({ name: 'Orc', type: 'enemy', armor_class: 14, max_hp: 25, current_hp: 25, faction: 'Hostile' })
      );

      req.flush(body);
      expect(comp.showAddModal).toBeFalse();
      expect(comp.selectedTargetId).toBe(body.combatants[0].id);
    });

    it('adds multiple numbered combatants when addAmount > 1', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Goblin', type: 'enemy', armor_class: 12, max_hp: 7, faction: 'Hostile' };
      comp.addAmount = 3;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.map((c) => c.name)).toEqual(['Goblin 1', 'Goblin 2', 'Goblin 3']);
      req.flush(body);
    });

    it('forces addAmount to 1 for player type regardless of prior value', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Hero', type: 'player', armor_class: 16, max_hp: 40 };
      comp.addAmount = 4;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.length).toBe(1);
      expect(comp.addAmount).toBe(1);
      req.flush(body);
    });

    it('does not overwrite an already-selected target after adding', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'existing_target';
      comp.newCombatant = { name: 'Goblin', type: 'enemy', armor_class: 12, max_hp: 7 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      req.flush(req.request.body);
      expect(comp.selectedTargetId).toBe('existing_target');
    });
  });

  describe('addCombatant initiative ordering', () => {
    it('queues a higher-initiative newcomer right after the active combatant instead of disturbing them', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [makeCombatant({ id: 'slow', name: 'Slow Guy', initiative: 5 })],
          active_turn_index: 0, // Slow Guy is currently acting
        })
      );

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Fast Guy', type: 'enemy', armor_class: 12, max_hp: 10, initiative: 18 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      // Slow Guy is mid-turn -- a global initiative resort would have put
      // Fast Guy ahead of him, which an increment-only pointer can never
      // reach again this round (the bug: Fast Guy skipped until next
      // round). Instead Fast Guy lands right after Slow Guy, and the
      // pointer doesn't move since nothing before/at it changed.
      expect(body.combatants.map((c) => c.name)).toEqual(['Slow Guy', 'Fast Guy']);
      expect(body.active_turn_index).toBe(0);
      req.flush(body);
    });

    it('never disturbs the position of the currently active combatant, even when a newcomer outranks everyone', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [
            makeCombatant({ id: 'a', name: 'Alice', initiative: 10 }),
            makeCombatant({ id: 'b', name: 'Bob', initiative: 5 }),
          ],
          active_turn_index: 1, // Bob is currently acting
        })
      );

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Zara', type: 'enemy', armor_class: 12, max_hp: 10, initiative: 20 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      // Alice already acted and Bob is acting now -- Zara (highest
      // initiative) joins at the tail, since there's nothing left to act
      // this round for her to outrank. The pointer stays on Bob at the
      // same index; no relocation search needed.
      expect(body.combatants.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Zara']);
      expect(body.active_turn_index).toBe(1);
      req.flush(body);
    });

    it('does not skip a newcomer who outranks the active combatant -- they act this round, right after', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [
            makeCombatant({ id: 'a', name: 'Alice', initiative: 10 }),
            makeCombatant({ id: 'b', name: 'Bob', initiative: 5 }),
          ],
          active_turn_index: 0, // Alice is currently acting
        })
      );

      const comp = fixture.componentInstance;
      // Zara outranks both Alice (active) and Bob (not yet acted this round).
      comp.newCombatant = { name: 'Zara', type: 'enemy', armor_class: 12, max_hp: 10, initiative: 20 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      // Alice (mid-turn) is untouched; Zara slots ahead of Bob, who hasn't
      // acted yet this round -- so Zara is queued up next, not skipped to
      // next round.
      expect(body.combatants.map((c) => c.name)).toEqual(['Alice', 'Zara', 'Bob']);
      expect(body.active_turn_index).toBe(0);
      req.flush(body);

      // Clicking Next Turn proves Zara is actually visited this round.
      fixture.componentInstance.nextTurn();
      const nextReq = httpMock.expectOne((r) => r.method === 'PUT');
      expect((nextReq.request.body as EncounterState).active_turn_index).toBe(1);
      nextReq.flush(nextReq.request.body);
      expect(combat.encounter()?.combatants[combat.encounter()!.active_turn_index].name).toBe('Zara');
    });

    it('defaults to index 0 as active when the encounter had no combatants yet', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [], active_turn_index: 0 }));

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'First', type: 'enemy', armor_class: 10, max_hp: 10, initiative: 7 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.active_turn_index).toBe(0);
      req.flush(body);
    });
  });

  describe('newEncounter', () => {
    it('does nothing when the confirm modal is cancelled', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      combat.narrative.set('some narration');

      comp.newEncounter();
      expect(comp.showNewEncounterConfirm).toBeTrue();

      comp.cancelNewEncounter();
      expect(comp.showNewEncounterConfirm).toBeFalse();

      httpMock.expectNone((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      expect(comp.selectedTargetId).toBe('c1');
      expect(combat.narrative()).toBe('some narration');
    });

    it('clears form state, narrative, and creates a fresh encounter when confirmed', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.showDamageModal = true;
      comp.modalDamageEntries = [{ amount: 99, damage_type: 'Fire' }];
      comp.modalConditionAction = 'add';
      comp.modalConditionName = 'Bleed';
      combat.narrative.set('leftover narration');

      comp.newEncounter();
      comp.confirmNewEncounter();

      expect(comp.showNewEncounterConfirm).toBeFalse();
      expect(comp.selectedTargetId).toBe('');
      expect(comp.showDamageModal).toBeFalse();
      expect(comp.modalDamageEntries).toEqual([{ amount: 0, damage_type: 'Slashing' }]);
      expect(comp.modalConditionAction).toBeNull();
      expect(combat.narrative()).toBe('');

      const req = httpMock.expectOne((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      const body = req.request.body as EncounterState;
      expect(body.combatants).toEqual([]);
      expect(body.round).toBe(1);

      const fresh = makeEncounter({ encounter_id: body.encounter_id, combatants: [] });
      req.flush(fresh);
      expect(combat.encounter()).toEqual(fresh);
    });
  });
});
