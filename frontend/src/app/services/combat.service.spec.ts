import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { CombatService } from './combat.service';
import { Combatant, DamageEvent, EncounterState } from '../models/combat.model';

describe('CombatService', () => {
  let service: CombatService;
  let httpMock: HttpTestingController;
  const baseUrl = 'http://localhost:8000';

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

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [CombatService],
    });
    service = TestBed.inject(CombatService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created with empty initial state', () => {
    expect(service).toBeTruthy();
    expect(service.encounter()).toBeNull();
    expect(service.narrative()).toBe('');
    expect(service.isStreaming()).toBeFalse();
  });

  describe('createEncounter', () => {
    it('POSTs to /encounters and returns the response', () => {
      const payload = makeEncounter();
      let result: EncounterState | undefined;

      service.createEncounter(payload).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${baseUrl}/encounters`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(payload);
      req.flush(payload);

      expect(result).toEqual(payload);
    });
  });

  describe('updateEncounter', () => {
    it('PUTs to /encounters/:id and returns the response', () => {
      const payload = makeEncounter({ round: 2 });
      let result: EncounterState | undefined;

      service.updateEncounter('enc_1', payload).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${baseUrl}/encounters/enc_1`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual(payload);
      req.flush(payload);

      expect(result).toEqual(payload);
    });
  });

  describe('applyDamageStream', () => {
    const sseBody = (blocks: string[]) => blocks.join('\n\n') + '\n\n';

    function mockFetchStream(text: string) {
      const encoder = new TextEncoder();
      const chunk = encoder.encode(text);
      let sent = false;

      const reader = {
        read: () =>
          Promise.resolve(
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: chunk })
          ),
      };

      spyOn(window, 'fetch').and.returnValue(
        Promise.resolve({
          body: { getReader: () => reader },
        } as unknown as Response)
      );
    }

    const event: DamageEvent = {
      target_id: 'c1',
      damage_amount: 8,
      damage_type: 'Slashing',
      applied_conditions: [],
    };

    it('sets isStreaming and clears narrative immediately, POSTs to the stream endpoint', () => {
      mockFetchStream(sseBody(['event: end\ndata: {}']));

      service.applyDamageStream('enc_1', event);

      expect(service.isStreaming()).toBeTrue();
      expect(service.narrative()).toBe('');
      expect(window.fetch).toHaveBeenCalledWith(
        `${baseUrl}/encounters/enc_1/damage/stream`,
        jasmine.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        })
      );
    });

    it('appends narrative_chunk tokens to narrative()', async () => {
      mockFetchStream(
        sseBody([
          'event: narrative_chunk\ndata: {"token":"The "}',
          'event: narrative_chunk\ndata: {"token":"goblin "}',
          'event: narrative_chunk\ndata: {"token":"snarls."}',
          'event: end\ndata: {}',
        ])
      );

      service.applyDamageStream('enc_1', event);
      await flushMicrotasks();

      expect(service.narrative()).toBe('The goblin snarls.');
    });

    it('merges state_update combatants into the current encounter', async () => {
      const initial = makeEncounter({ combatants: [makeCombatant({ current_hp: 10 })] });
      service.encounter.set(initial);

      const updatedCombatants = [makeCombatant({ current_hp: 2 })];
      mockFetchStream(
        sseBody([
          `event: state_update\ndata: ${JSON.stringify({ combatants: updatedCombatants })}`,
          'event: end\ndata: {}',
        ])
      );

      service.applyDamageStream('enc_1', event);
      await flushMicrotasks();

      expect(service.encounter()?.combatants).toEqual(updatedCombatants);
      expect(service.encounter()?.encounter_id).toBe('enc_1');
    });

    it('ignores state_update when there is no current encounter', async () => {
      service.encounter.set(null);

      mockFetchStream(
        sseBody([
          `event: state_update\ndata: ${JSON.stringify({ combatants: [makeCombatant()] })}`,
          'event: end\ndata: {}',
        ])
      );

      service.applyDamageStream('enc_1', event);
      await flushMicrotasks();

      expect(service.encounter()).toBeNull();
    });

    it('sets isStreaming to false on an end event', async () => {
      mockFetchStream(sseBody(['event: end\ndata: {}']));

      service.applyDamageStream('enc_1', event);
      expect(service.isStreaming()).toBeTrue();

      await flushMicrotasks();

      expect(service.isStreaming()).toBeFalse();
    });

    it('sets isStreaming to false when the fetch call rejects', async () => {
      spyOn(window, 'fetch').and.returnValue(Promise.reject(new Error('network down')));
      spyOn(console, 'error');

      service.applyDamageStream('enc_1', event);
      await flushMicrotasks();

      expect(service.isStreaming()).toBeFalse();
      expect(console.error).toHaveBeenCalled();
    });

    it('sets isStreaming to false when the response has no body', async () => {
      spyOn(window, 'fetch').and.returnValue(Promise.resolve({ body: null } as unknown as Response));
      spyOn(console, 'error');

      service.applyDamageStream('enc_1', event);
      await flushMicrotasks();

      expect(service.isStreaming()).toBeFalse();
      expect(console.error).toHaveBeenCalled();
    });

    async function flushMicrotasks(): Promise<void> {
      // Allow the chained promise/async-await work inside applyDamageStream to settle.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    }
  });
});
