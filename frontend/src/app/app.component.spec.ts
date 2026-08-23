import { TestBed } from '@angular/core/testing';
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
    ...overrides,
  });

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
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    httpMock.expectOne((req) => req.method === 'POST' && req.url.endsWith('/encounters')).flush(makeEncounter());
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('ngOnInit', () => {
    it('creates an initial encounter and stores it on the service', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      const req = httpMock.expectOne((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      const body = req.request.body as EncounterState;
      expect(body.round).toBe(1);
      expect(body.active_turn_index).toBe(0);
      expect(body.combatants).toEqual([]);

      const created = makeEncounter({ encounter_id: body.encounter_id });
      req.flush(created);

      expect(combat.encounter()).toEqual(created);
    });

    it('logs an error and leaves encounter unset if creation fails', () => {
      spyOn(console, 'error');
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      const req = httpMock.expectOne((r) => r.method === 'POST' && r.url.endsWith('/encounters'));
      req.flush('boom', { status: 500, statusText: 'Server Error' });

      expect(combat.encounter()).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('submitAction', () => {
    it('does nothing when there is no active encounter', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      combat.encounter.set(null);
      spyOn(combat, 'applyDamageStream');

      fixture.componentInstance.submitAction();

      expect(combat.applyDamageStream).not.toHaveBeenCalled();
    });

    it('builds a DamageEvent from form fields and streams it', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      combat.encounter.set(null);

      fixture.componentInstance.nextTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()).toBeNull();
    });

    it('does nothing when there are no combatants', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter({ combatants: [] }));

      fixture.componentInstance.nextTurn();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()?.combatants.length).toBe(0);
    });

    it('advances the active_turn_index within the same round', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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

  describe('add combatant modal', () => {
    it('openAddModal resets the form and shows the modal', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'enemy';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual({ name: 'Enemy', type: 'enemy', armor_class: 12, max_hp: 20, faction: 'Hostile' });
    });

    it('onTemplateChange applies the player template', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = 'player';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual({ name: 'Player', type: 'player', armor_class: 15, max_hp: 30, faction: '' });
    });

    it('onTemplateChange falls back to an empty combatant for custom', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());

      const comp = fixture.componentInstance;
      comp.selectedTemplate = '';
      comp.onTemplateChange();

      expect(comp.newCombatant).toEqual(comp.getEmptyCombatant());
    });

    it('addCombatant does nothing without an active encounter', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      httpMock.expectOne((r) => r.url.endsWith('/encounters')).flush(makeEncounter());
      combat.encounter.set(null);

      fixture.componentInstance.addCombatant();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()).toBeNull();
    });

    it('adds a single combatant with the entered fields', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
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
});
