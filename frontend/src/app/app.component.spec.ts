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
    it('does nothing when there is no active encounter', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      combat.encounter.set(null);
      spyOn(combat, 'applyDamageStream');

      fixture.componentInstance.submitAction();

      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });

    it('builds a DamageEvent from form fields and streams it', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.damageAmount = 15;
      comp.selectedType = 'Fire';
      comp.conditionInput = 'Burning, Prone';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();

      expect(combat.applyDamageStream).toHaveBeenCalledWith('enc_1', {
        target_id: 'c1',
        damage_amount: 15,
        damage_type: 'Fire',
        applied_conditions: ['Burning', 'Prone'],
      });
    });

    it('sends an empty conditions array when conditionInput is blank', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [makeCombatant()] }));

      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'c1';
      comp.conditionInput = '';

      spyOn(combat, 'applyDamageStream');
      comp.submitAction();

      expect(combat.applyDamageStream).toHaveBeenCalledWith(
        'enc_1',
        jasmine.objectContaining({ applied_conditions: [] })
      );
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

      expect(comp.newCombatant).toEqual({ name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile', initiative: 0 });
    });

    it('onTemplateChange applies the player template', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'player';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual({ name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '', initiative: 0 });
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
    it('sorts combatants by initiative descending after adding', () => {
      const fixture = createReadyFixture();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(
        makeEncounter({
          combatants: [makeCombatant({ id: 'slow', name: 'Slow Guy', initiative: 5 })],
          active_turn_index: 0,
        })
      );

      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Fast Guy', type: 'enemy', armor_class: 12, max_hp: 10, initiative: 18 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.map((c) => c.name)).toEqual(['Fast Guy', 'Slow Guy']);
      req.flush(body);
    });

    it('keeps the currently active combatant active after a re-sort shifts their position', () => {
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
      // A new combatant with higher initiative than both existing ones --
      // inserted at the front, pushing Bob from index 1 to index 2.
      comp.newCombatant = { name: 'Zara', type: 'enemy', armor_class: 12, max_hp: 10, initiative: 20 };
      comp.addAmount = 1;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.map((c) => c.name)).toEqual(['Zara', 'Alice', 'Bob']);
      expect(body.active_turn_index).toBe(2); // still Bob, now at index 2
      req.flush(body);
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
      comp.damageAmount = 99;
      comp.selectedType = 'Fire';
      comp.conditionInput = 'Bleed';
      combat.narrative.set('leftover narration');

      comp.newEncounter();
      comp.confirmNewEncounter();

      expect(comp.showNewEncounterConfirm).toBeFalse();
      expect(comp.selectedTargetId).toBe('');
      expect(comp.damageAmount).toBe(8);
      expect(comp.selectedType).toBe('Slashing');
      expect(comp.conditionInput).toBe('');
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
