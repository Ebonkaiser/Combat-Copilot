import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import { CampaignService } from './services/campaign.service';
import { CombatService } from './services/combat.service';
import { Campaign } from './models/campaign.model';
import { Combatant, EncounterState } from './models/combat.model';
import { FakeAuthService } from './testing/fake-auth';

const LAST_CAMPAIGN_KEY = 'combat-copilot.last-campaign';

describe('AppComponent: anonymous and owner modes', () => {
  let httpMock: HttpTestingController;
  let auth: FakeAuthService;
  let combat: CombatService;
  let campaigns: CampaignService;

  const LIGHT: Campaign = { id: 'light-and-magic', name: 'Light and Magic', description: '' };
  const SIDE: Campaign = { id: 'side-quest', name: 'Side Quest', description: '' };

  const makeCombatant = (overrides: Partial<Combatant> = {}): Combatant => ({
    id: 'c1', name: 'Goblin', type: 'enemy', armor_class: 12, max_hp: 10, current_hp: 10,
    conditions: [], tactical_tags: [], resources: {}, initiative: 0, weapon_equipped: 'Unarmed',
    ...overrides,
  });
  const hero = makeCombatant({ id: 'pc_hero', name: 'Hero', type: 'player', max_hp: 30, current_hp: 30 });
  const guard = makeCombatant({ id: 'npc_guard', name: 'Amber Quill Guard', faction: 'amber_quill_chancery' });

  const makeEncounter = (overrides: Partial<EncounterState> = {}): EncounterState => ({
    encounter_id: 'enc_server_1', round: 1, active_turn_index: 0, combatants: [],
    gm_notes: '', combat_started: false, campaign_id: null, owner_scoped: false,
    ...overrides,
  });
  // What the server returns for a new campaign encounter: EMPTY, exactly as it was posted. Tests that
  // need people at the table add them explicitly (via the dialog, or `party`).
  const campaignEncounter = (id = LIGHT.id, overrides: Partial<EncounterState> = {}) =>
    makeEncounter({ campaign_id: id, owner_scoped: true, combatants: [], ...overrides });
  const party = [hero, guard];

  const isCreate = (r: { method: string; url: string }) => r.method === 'POST' && r.url === '/api/encounters';
  const expectCreate = (): TestRequest => httpMock.expectOne(isCreate);
  const expectCampaignList = (): TestRequest =>
    httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/campaigns');
  const expectRoster = (id: string): TestRequest => httpMock.expectOne(`/api/campaigns/${id}/roster`);

  function boot(): ComponentFixture<AppComponent> {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.method === 'GET' && r.url === '/api/health').flush({ status: 'ok' });
    return fixture;
  }

  /** Owner session already established, a campaign encounter on screen. */
  function bootInCampaign(): ComponentFixture<AppComponent> {
    auth.becomeOwner();
    localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
    const fixture = boot();
    expectCampaignList().flush([LIGHT, SIDE]);
    expectRoster(LIGHT.id).flush({ combatants: party });
    expectCreate().flush(campaignEncounter());
    return fixture;
  }

  beforeEach(async () => {
    localStorage.removeItem(LAST_CAMPAIGN_KEY);
    await TestBed.configureTestingModule({
      imports: [AppComponent, HttpClientTestingModule],
      providers: [{ provide: AuthService, useClass: FakeAuthService }],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService) as unknown as FakeAuthService;
    combat = TestBed.inject(CombatService);
    campaigns = TestBed.inject(CampaignService);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem(LAST_CAMPAIGN_KEY);
  });

  describe('anonymous start', () => {
    it('creates a blank, campaign-less encounter and never asks for campaigns', () => {
      boot();

      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      expect(req.request.body.combatants).toEqual([]);
      expect(req.request.body.encounter_id).toBeUndefined();
      req.flush(makeEncounter());

      expect(combat.encounter()?.combatants).toEqual([]);
      // (httpMock.verify() proves no /campaigns request was ever made)
    });

    it('shows the Anonymous header with no campaign switcher', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      fixture.detectChanges();

      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('[data-testid="mode-badge"]')?.textContent?.trim()).toBe('Anonymous');
      expect(root.querySelector('app-campaign-switcher')).toBeNull();
      expect(root.querySelector('[data-testid="campaign-select"]')).toBeNull();
    });

    it('asks the server who is using the app if the first check did not get through', () => {
      auth.loaded.set(false);
      auth.load.and.callFake(() => {
        auth.loaded.set(true);
        auth.becomeOwner();
        return of(true);
      });

      boot();

      expect(auth.load).toHaveBeenCalledTimes(1);
      expectCampaignList().flush([LIGHT]);
      expectCreate().flush(makeEncounter());
    });

    it('does not ask again when the mode is already known', () => {
      boot();
      expectCreate().flush(makeEncounter());

      expect(auth.load).not.toHaveBeenCalled();
    });
  });

  describe('owner start', () => {
    beforeEach(() => auth.becomeOwner());

    it('loads the campaign list, then starts a blank encounter when nothing is remembered', () => {
      boot();

      expectCampaignList().flush([LIGHT, SIDE]);
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      req.flush(makeEncounter());

      expect(campaigns.campaigns()).toEqual([LIGHT, SIDE]);
      expect(campaigns.activeCampaignId()).toBeNull();
    });

    it('restores the remembered campaign as an EMPTY encounter, with its characters ready to pick from', () => {
      localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
      boot();

      expectCampaignList().flush([LIGHT, SIDE]);
      expectRoster(LIGHT.id).flush({ combatants: party });
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBe(LIGHT.id);
      expect(req.request.body.combatants).toEqual([]); // nobody is added for you
      expect(campaigns.activeCampaignId()).toBeNull(); // not until the server has created it
      req.flush(campaignEncounter());

      expect(campaigns.activeCampaignId()).toBe(LIGHT.id);
      expect(combat.encounter()?.owner_scoped).toBeTrue();
      expect(combat.encounter()?.combatants).toEqual([]);
      expect(campaigns.roster()).toEqual(party);
    });

    it('ignores a remembered campaign the server no longer offers', () => {
      localStorage.setItem(LAST_CAMPAIGN_KEY, 'deleted-campaign');
      boot();

      expectCampaignList().flush([LIGHT]);
      expect(expectCreate().request.body.campaign_id).toBeNull();
    });

    it('still starts a blank encounter if the campaign list cannot be loaded', () => {
      boot();

      expectCampaignList().flush({ detail: 'down' }, { status: 503, statusText: 'Service Unavailable' });

      expect(expectCreate().request.body.campaign_id).toBeNull();
    });

    it('shows the Owner header with the switcher on the active campaign', () => {
      localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
      const fixture = boot();
      expectCampaignList().flush([LIGHT, SIDE]);
      expectRoster(LIGHT.id).flush({ combatants: party });
      expectCreate().flush(campaignEncounter());
      fixture.detectChanges();

      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('[data-testid="mode-badge"]')?.textContent?.trim()).toBe('Owner');
      const select = root.querySelector('[data-testid="campaign-select"]') as HTMLSelectElement;
      expect(select.value).toBe(LIGHT.id);
      expect(root.querySelectorAll('.combatant').length).toBe(0); // nobody was added for the owner
    });

    it('tells the owner how to fill an empty campaign encounter', () => {
      localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
      const fixture = boot();
      expectCampaignList().flush([LIGHT]);
      expectRoster(LIGHT.id).flush({ combatants: party });
      expectCreate().flush(campaignEncounter());
      fixture.detectChanges();

      const text = fixture.nativeElement.querySelector('[data-testid="empty-state"]').textContent;
      expect(text).toContain('choose characters from');
      expect(text).toContain('Light and Magic');
    });
  });

  describe('encounterInProgress', () => {
    it('is false for a fresh, empty encounter', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());

      expect(fixture.componentInstance.encounterInProgress()).toBeFalse();
    });

    it('is false when there is no encounter at all', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      combat.encounter.set(null);

      expect(fixture.componentInstance.encounterInProgress()).toBeFalse();
    });

    it('is true as soon as anyone has been added (that table was built on purpose)', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());

      combat.encounter.set(makeEncounter({ combatants: [hero] }));

      expect(fixture.componentInstance.encounterInProgress()).toBeTrue();
    });

    it('is true once combat has started or the round has advanced, even with an empty table', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      const comp = fixture.componentInstance;

      combat.encounter.set(makeEncounter({ combat_started: true }));
      expect(comp.encounterInProgress()).toBeTrue();

      combat.encounter.set(makeEncounter({ round: 2 }));
      expect(comp.encounterInProgress()).toBeTrue();
    });
  });

  describe('switching campaigns', () => {
    it('starts an EMPTY campaign encounter, keeps the roster as a pick-list, and clears narration and selection', () => {
      const fixture = bootInCampaign();
      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'pc_hero';
      combat.narrative.set('leftover narration');

      comp.selectCampaign(SIDE.id);
      expectRoster(SIDE.id).flush({ combatants: [hero] });
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBe(SIDE.id);
      expect(req.request.body.combatants).toEqual([]); // the roster is NOT loaded into the encounter
      req.flush(campaignEncounter(SIDE.id));

      expect(combat.narrative()).toBe('');
      expect(comp.selectedTargetId).toBe('');
      expect(campaigns.activeCampaignId()).toBe(SIDE.id);
      expect(campaigns.roster()).toEqual([hero]);
      expect(localStorage.getItem(LAST_CAMPAIGN_KEY)).toBe(SIDE.id);
      expect(combat.encounter()?.campaign_id).toBe(SIDE.id);
      expect(combat.encounter()?.combatants).toEqual([]);
    });

    it('"no campaign" starts a blank encounter, forgets the remembered campaign and drops its pick-list', () => {
      const fixture = bootInCampaign();
      expect(campaigns.roster()).toEqual(party);

      fixture.componentInstance.selectCampaign(null);
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      expect(req.request.body.combatants).toEqual([]);
      req.flush(makeEncounter());

      expect(campaigns.activeCampaignId()).toBeNull();
      expect(campaigns.roster()).toEqual([]);
      expect(localStorage.getItem(LAST_CAMPAIGN_KEY)).toBeNull();
    });

    it('keeps the old pick-list if the new campaign cannot be loaded', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');

      fixture.componentInstance.selectCampaign(SIDE.id);
      expectRoster(SIDE.id).flush({ detail: 'down' }, { status: 500, statusText: 'Server Error' });

      expect(campaigns.roster()).toEqual(party);
      expect(campaigns.activeCampaignId()).toBe(LIGHT.id);
    });

    it('leaves the current encounter alone, with a notice, when the roster cannot be loaded', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');
      const before = combat.encounter();

      fixture.componentInstance.selectCampaign(SIDE.id);
      expectRoster(SIDE.id).flush({ detail: 'Campaign not found' }, { status: 404, statusText: 'Not Found' });

      expect(combat.encounter()).toBe(before);
      expect(campaigns.activeCampaignId()).toBe(LIGHT.id);
      expect(fixture.componentInstance.notice).toContain('Could not load that campaign');
    });

    it('does not report a notice for a 401 (the session-expiry handling owns that)', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');

      fixture.componentInstance.selectCampaign(SIDE.id);
      expectRoster(SIDE.id).flush({ detail: 'Owner sign-in required' }, { status: 401, statusText: 'Unauthorized' });

      expect(fixture.componentInstance.notice).toBe('');
    });

    it('"New Encounter" inside a campaign starts another empty encounter in the same campaign', () => {
      const fixture = bootInCampaign();
      const comp = fixture.componentInstance;
      combat.encounter.set(campaignEncounter(LIGHT.id, { combatants: party, combat_started: true }));
      combat.narrative.set('old fight');

      comp.newEncounter();
      comp.confirmNewEncounter();
      expectRoster(LIGHT.id).flush({ combatants: party });
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBe(LIGHT.id);
      expect(req.request.body.combatants).toEqual([]);
      req.flush(campaignEncounter());

      expect(combat.narrative()).toBe('');
      expect(combat.encounter()?.combatants).toEqual([]);
      expect(campaigns.activeCampaignId()).toBe(LIGHT.id);
      expect(campaigns.roster()).toEqual(party); // still there to pick from
    });
  });

  describe('creating encounters', () => {
    it('does not retry a 4xx answer, and says what happened', fakeAsync(() => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      spyOn(console, 'error');

      fixture.componentInstance.createFreshEncounter('gone', []);
      expectCreate().flush({ detail: 'Campaign not found' }, { status: 404, statusText: 'Not Found' });
      tick(2000);

      httpMock.expectNone(isCreate);
      expect(fixture.componentInstance.notice).toContain('Could not start that encounter');
      expect(fixture.componentInstance.connectionError).toBeFalse();
    }));

    it('still retries a server hiccup', fakeAsync(() => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());

      fixture.componentInstance.createFreshEncounter();
      expectCreate().flush('oops', { status: 503, statusText: 'Service Unavailable' });
      tick(2000);
      expectCreate().flush(makeEncounter({ encounter_id: 'enc_after_retry' }));

      expect(combat.encounter()?.encounter_id).toBe('enc_after_retry');
    }));
  });

  describe('signing out', () => {
    it('returns to an anonymous blank encounter and forgets the campaign state', () => {
      const fixture = bootInCampaign();
      combat.narrative.set('narration');

      fixture.componentInstance.signOut();
      expect(auth.logout).toHaveBeenCalled();
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      req.flush(makeEncounter({ encounter_id: 'enc_anon' }));
      fixture.detectChanges();

      expect(campaigns.campaigns()).toEqual([]);
      expect(campaigns.activeCampaignId()).toBeNull();
      expect(campaigns.roster()).toEqual([]); // the campaign's characters are not left behind
      expect(combat.narrative()).toBe('');
      expect(combat.encounter()?.owner_scoped).toBeFalse();
      expect(fixture.nativeElement.querySelector('[data-testid="mode-badge"]')?.textContent?.trim()).toBe('Anonymous');
      expect(fixture.nativeElement.querySelector('[data-testid="campaign-select"]')).toBeNull();
    });

    it('stays put, with a notice, if the server cannot be reached to sign out', () => {
      const fixture = bootInCampaign();
      auth.logout.and.returnValue(throwError(() => new Error('offline')));

      fixture.componentInstance.signOut();

      expect(fixture.componentInstance.notice).toContain('Could not sign out');
      expect(combat.encounter()?.campaign_id).toBe(LIGHT.id);
    });
  });

  describe('signing in', () => {
    it('opens and closes the dialog from the header', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('app-login')).toBeNull();

      (root.querySelector('[data-testid="sign-in-btn"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(root.querySelector('app-login')).not.toBeNull();

      (root.querySelector('[data-testid="login-cancel"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(root.querySelector('app-login')).toBeNull();
    });

    it('after signing in, loads the campaigns and restores the remembered one', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
      auth.becomeOwner();
      fixture.componentInstance.showLogin = true;

      fixture.componentInstance.onSignedIn();
      expect(fixture.componentInstance.showLogin).toBeFalse();
      expectCampaignList().flush([LIGHT, SIDE]);
      expectRoster(LIGHT.id).flush({ combatants: party });
      const req = expectCreate();
      expect(req.request.body.combatants).toEqual([]);
      req.flush(campaignEncounter());

      expect(campaigns.activeCampaignId()).toBe(LIGHT.id);
      expect(campaigns.roster()).toEqual(party);
      expect(combat.encounter()?.combatants).toEqual([]);
    });

    it('does not replace an encounter that is already under way', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter({ combatants: [hero], round: 3, combat_started: true }));
      localStorage.setItem(LAST_CAMPAIGN_KEY, LIGHT.id);
      auth.becomeOwner();

      fixture.componentInstance.onSignedIn();
      expectCampaignList().flush([LIGHT, SIDE]);

      httpMock.expectNone(isCreate);
      expect(combat.encounter()?.round).toBe(3);
      expect(campaigns.campaigns().length).toBe(2); // the switcher is ready for them to choose
    });

    it('says so when the campaign list cannot be loaded after signing in', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      auth.becomeOwner();

      fixture.componentInstance.onSignedIn();
      expectCampaignList().flush('down', { status: 500, statusText: 'Server Error' });

      expect(fixture.componentInstance.notice).toContain('campaign list could not be loaded');
    });
  });

  describe('an ended session', () => {
    it('falls back to an anonymous blank encounter and asks the owner to sign in again', () => {
      const fixture = bootInCampaign();
      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'pc_hero';

      auth.markSessionExpired();
      fixture.detectChanges(); // runs the effect that reacts to the flag

      expect(comp.showLogin).toBeTrue();
      expect(campaigns.campaigns()).toEqual([]);
      expect(campaigns.activeCampaignId()).toBeNull();
      expect(campaigns.roster()).toEqual([]);
      expect(comp.selectedTargetId).toBe('');
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      req.flush(makeEncounter({ encounter_id: 'enc_anon' }));
      fixture.detectChanges();

      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('[data-testid="session-expired-banner"]')?.textContent).toContain('session ended');
      expect(root.querySelector('[data-testid="mode-badge"]')?.textContent?.trim()).toBe('Anonymous');
      expect(root.querySelector('app-login')).not.toBeNull();
    });

    it('reacts only once, not on every change-detection pass', () => {
      const fixture = bootInCampaign();

      auth.markSessionExpired();
      fixture.detectChanges();
      expectCreate().flush(makeEncounter());
      fixture.detectChanges();
      fixture.detectChanges();

      expect(httpMock.match(isCreate).length).toBe(0); // no second encounter was requested
    });

    it('a stream that answers 401 ends the session', () => {
      const fixture = bootInCampaign();
      spyOn(combat, 'applyDamageStream').and.callFake((_id, _event, onFailure) => onFailure?.(401));
      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'npc_guard';
      comp.modalDamageEntries = [{ amount: 3, damage_type: 'Fire' }];

      comp.submitAction();
      httpMock.expectOne((r) => r.method === 'PUT').flush(campaignEncounter());
      fixture.detectChanges();

      expect(auth.markSessionExpired).toHaveBeenCalled();
      expectCreate().flush(makeEncounter());
    });
  });

  describe('an encounter that disappeared (404)', () => {
    function advanceTurn(fixture: ComponentFixture<AppComponent>): void {
      combat.encounter.set(campaignEncounter(LIGHT.id, { combat_started: true, combatants: party }));
      fixture.componentInstance.nextTurn();
    }

    it('restores this page\'s copy under a new server id when the owner is still signed in', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');
      advanceTurn(fixture);

      httpMock.expectOne((r) => r.method === 'PUT').flush({ detail: 'Encounter not found' }, { status: 404, statusText: 'Not Found' });
      expect(auth.load).toHaveBeenCalled(); // asks the server who this is before deciding
      const req = expectCreate();
      expect(req.request.body.encounter_id).toBeUndefined();
      expect(req.request.body.owner_scoped).toBeUndefined();
      expect(req.request.body.campaign_id).toBe(LIGHT.id);
      expect(req.request.body.combatants.length).toBe(2);
      req.flush(campaignEncounter(LIGHT.id, { encounter_id: 'enc_restored', combat_started: true }));

      expect(combat.encounter()?.encounter_id).toBe('enc_restored');
      expect(fixture.componentInstance.notice).toContain('restored from this page');
    });

    it('treats it as an ended session when /auth/me now says anonymous', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');
      auth.load.and.callFake(() => {
        auth.mode.set('anonymous'); // the cookie is gone server-side
        return of(true);
      });
      advanceTurn(fixture);

      httpMock.expectOne((r) => r.method === 'PUT').flush({ detail: 'Encounter not found' }, { status: 404, statusText: 'Not Found' });
      fixture.detectChanges();

      expect(auth.markSessionExpired).toHaveBeenCalled();
      expect(fixture.componentInstance.showLogin).toBeTrue();
      expect(expectCreate().request.body.campaign_id).toBeNull(); // a blank anonymous encounter, not a restore
    });

    it('restores an anonymous encounter too (it was idle long enough to be cleaned up)', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter({ combatants: [hero], combat_started: true }));
      spyOn(console, 'error');

      fixture.componentInstance.nextTurn();
      httpMock.expectOne((r) => r.method === 'PUT').flush({ detail: 'Encounter not found' }, { status: 404, statusText: 'Not Found' });
      const req = expectCreate();
      expect(req.request.body.campaign_id).toBeNull();
      req.flush(makeEncounter({ encounter_id: 'enc_restored', combatants: [hero], combat_started: true }));

      expect(combat.encounter()?.encounter_id).toBe('enc_restored');
    });

    it('a stream that answers 404 recovers the same way', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');
      spyOn(combat, 'applyDamageStream').and.callFake((_id, _event, onFailure) => onFailure?.(404));
      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'npc_guard';
      comp.modalDamageEntries = [{ amount: 3, damage_type: 'Fire' }];

      comp.submitAction();
      httpMock.expectOne((r) => r.method === 'PUT').flush(campaignEncounter());

      expect(auth.load).toHaveBeenCalled();
      expectCreate().flush(campaignEncounter(LIGHT.id, { encounter_id: 'enc_restored' }));
      expect(combat.encounter()?.encounter_id).toBe('enc_restored');
    });

    it('says so when the encounter cannot be restored', () => {
      const fixture = bootInCampaign();
      spyOn(console, 'error');
      advanceTurn(fixture);

      httpMock.expectOne((r) => r.method === 'PUT').flush({ detail: 'x' }, { status: 404, statusText: 'Not Found' });
      expectCreate().flush({ detail: 'down' }, { status: 500, statusText: 'Server Error' });

      expect(fixture.componentInstance.notice).toContain('could not be restored');
    });
  });

  describe('other failures', () => {
    it('a stream that fails for another reason gets a plain notice', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter({ combatants: [guard] }));
      spyOn(combat, 'applyDamageStream').and.callFake((_id, _event, onFailure) => onFailure?.(500));
      const comp = fixture.componentInstance;
      comp.selectedTargetId = 'npc_guard';
      comp.modalDamageEntries = [{ amount: 3, damage_type: 'Fire' }];

      comp.submitAction();
      httpMock.expectOne((r) => r.method === 'PUT').flush(makeEncounter({ combatants: [guard] }));

      expect(fixture.componentInstance.notice).toContain('narration could not be generated');
    });

    it('a failed save gets a notice instead of failing silently', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter({ combatants: [guard], combat_started: true }));
      spyOn(console, 'error');

      fixture.componentInstance.nextTurn();
      httpMock.expectOne((r) => r.method === 'PUT').flush('boom', { status: 500, statusText: 'Server Error' });

      expect(fixture.componentInstance.notice).toContain('Could not update encounter');
    });

    it('a notice can be dismissed', () => {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      fixture.componentInstance.notice = 'Something happened.';
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;

      expect(root.querySelector('[data-testid="notice-banner"]')?.textContent).toContain('Something happened.');
      (root.querySelector('[data-testid="notice-banner"] a') as HTMLElement).click();
      fixture.detectChanges();

      expect(root.querySelector('[data-testid="notice-banner"]')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // The campaign's characters are a pick-list in "Add Combatant": nothing is added for the owner,
  // and only known characters can be added as players.
  // -------------------------------------------------------------------------------------------

  describe('campaign characters: a pick-list in Add Combatant', () => {
    const sage = makeCombatant({
      id: 'pc_sage', name: 'Sage', type: 'player', armor_class: 14, max_hp: 30, current_hp: 22,
      conditions: ['Blessed'], tactical_tags: ['Player'], resources: { slots: 3 }, weapon_equipped: 'Staff',
    });

    function openDialog(present: Combatant[] = [], roster: Combatant[] = [hero, guard, sage]): ComponentFixture<AppComponent> {
      const fixture = bootInCampaign();
      campaigns.roster.set(roster);
      if (present.length > 0) {
        combat.encounter.set(campaignEncounter(LIGHT.id, { combatants: present }));
      }
      fixture.componentInstance.openAddModal();
      fixture.detectChanges();
      return fixture;
    }
    const el = (fixture: ComponentFixture<AppComponent>, testId: string) =>
      fixture.nativeElement.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    const rosterOptions = (fixture: ComponentFixture<AppComponent>) =>
      Array.from((el(fixture, 'roster-select') as HTMLSelectElement).options).map((o) => o.textContent?.trim());

    async function choose(fixture: ComponentFixture<AppComponent>, characterId: string): Promise<void> {
      const select = el(fixture, 'roster-select') as HTMLSelectElement;
      select.value = characterId;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('is offered only inside a campaign', () => {
      // anonymous
      let fixture = boot();
      expectCreate().flush(makeEncounter());
      fixture.componentInstance.openAddModal();
      fixture.detectChanges();
      expect(el(fixture, 'roster-select')).toBeNull();
      fixture.destroy();

      // owner, but not in a campaign
      auth.becomeOwner();
      fixture = boot();
      expectCampaignList().flush([LIGHT]);
      expectCreate().flush(makeEncounter());
      fixture.componentInstance.openAddModal();
      fixture.detectChanges();
      expect(el(fixture, 'roster-select')).toBeNull();
    });

    it('lists every campaign character, with nobody added yet', () => {
      const fixture = openDialog();

      expect(rosterOptions(fixture)).toEqual(['-- Custom enemy / NPC --', 'Hero (player)', 'Amber Quill Guard (enemy)', 'Sage (player)']);
      expect(combat.encounter()?.combatants).toEqual([]);
    });

    it('leaves out characters who are already in the encounter', () => {
      const fixture = openDialog([hero]);

      expect(rosterOptions(fixture)).toEqual(['-- Custom enemy / NPC --', 'Amber Quill Guard (enemy)', 'Sage (player)']);
    });

    it('says when everyone is already there, and when the campaign lists nobody', () => {
      let fixture = openDialog([hero, guard, sage]);
      expect(el(fixture, 'roster-hint')?.textContent).toContain('Every campaign character is already in this encounter');
      fixture.destroy();

      fixture = openDialog([], []);
      expect(el(fixture, 'roster-hint')?.textContent).toContain('lists no characters');
    });

    it('filling from a character locks name, type and faction, and hides the template and amount', async () => {
      const fixture = openDialog();

      await choose(fixture, guard.id);

      const comp = fixture.componentInstance;
      expect(comp.newCombatant).toEqual({
        name: 'Amber Quill Guard', type: 'enemy', armor_class: 12, max_hp: 10, current_hp: 10, faction: 'amber_quill_chancery',
        initiative: 0, weapon_equipped: 'Unarmed',
      });
      const name = el(fixture, 'combatant-name') as HTMLInputElement;
      expect(name.value).toBe('Amber Quill Guard');
      expect(name.disabled).toBeTrue();
      expect((el(fixture, 'combatant-type') as HTMLSelectElement).disabled).toBeTrue();
      expect((el(fixture, 'combatant-type') as HTMLSelectElement).value).toBe('enemy');
      expect((el(fixture, 'combatant-faction') as HTMLInputElement).disabled).toBeTrue();
      expect(el(fixture, 'combatant-template')).toBeNull();
      expect(el(fixture, 'combatant-amount')).toBeNull();
      expect((el(fixture, 'combatant-initiative') as HTMLInputElement).disabled).toBeFalse(); // set per encounter
      expect((el(fixture, 'combatant-max-hp') as HTMLInputElement).disabled).toBeFalse();
      expect(el(fixture, 'roster-hint')?.textContent).toContain('come from the campaign');
      // the "add several at once with Amount" advice is for custom combatants, not for a known character
      expect(fixture.nativeElement.textContent).not.toContain('Add multiple identical');
    });

    it('a player character keeps their name and type locked too', async () => {
      const fixture = openDialog();

      await choose(fixture, sage.id);

      const type = el(fixture, 'combatant-type') as HTMLSelectElement;
      expect(type.value).toBe('player');
      expect(type.disabled).toBeTrue();
      expect((el(fixture, 'combatant-name') as HTMLInputElement).disabled).toBeTrue();
      expect(el(fixture, 'combatant-faction')).toBeNull(); // faction is enemy-only
    });

    it('clearing the choice goes back to a blank custom form', async () => {
      const fixture = openDialog();
      await choose(fixture, sage.id);

      await choose(fixture, '');

      expect(fixture.componentInstance.newCombatant).toEqual(fixture.componentInstance.getEmptyCombatant());
      expect((el(fixture, 'combatant-name') as HTMLInputElement).disabled).toBeFalse();
      expect(el(fixture, 'combatant-template')).not.toBeNull();
    });

    it('adding puts exactly that character at the table, under their own id and with their own sheet', async () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      await choose(fixture, sage.id);
      comp.newCombatant.initiative = 14;

      comp.addCombatant();

      const req = httpMock.expectOne((r) => r.method === 'PUT');
      const body = req.request.body as EncounterState;
      expect(body.combatants.length).toBe(1);
      expect(body.combatants[0]).toEqual({
        id: 'pc_sage', name: 'Sage', type: 'player', armor_class: 14, max_hp: 30, current_hp: 22,
        conditions: ['Blessed'], tactical_tags: ['Player'], resources: { slots: 3 },
        initiative: 14, weapon_equipped: 'Staff',
      });
      // a copy, never the campaign's own objects
      expect(body.combatants[0].tactical_tags).not.toBe(sage.tactical_tags);
      expect(body.combatants[0].resources).not.toBe(sage.resources);
      req.flush(body);
      expect(comp.showAddModal).toBeFalse();
      expect(comp.selectedTargetId).toBe('pc_sage');
    });

    describe('the stats in roster.yaml are placeholders: every one can be edited here', () => {
      it('shows AC, max HP and current HP as editable fields, starting from the listed values', async () => {
        const fixture = openDialog();

        await choose(fixture, sage.id);

        for (const [testId, expected] of [['combatant-ac', '14'], ['combatant-max-hp', '30'], ['combatant-current-hp', '22']]) {
          const field = el(fixture, testId) as HTMLInputElement;
          expect(field).withContext(testId).not.toBeNull();
          expect(field.disabled).withContext(testId).toBeFalse();
          expect(field.value).withContext(testId).toBe(expected);
        }
        expect((el(fixture, 'combatant-weapon') as HTMLInputElement).disabled).toBeFalse();
        expect((el(fixture, 'combatant-initiative') as HTMLInputElement).disabled).toBeFalse();
      });

      it('adds the character with the edited values, not the placeholders', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, sage.id);
        comp.newCombatant.armor_class = 17;
        comp.onMaxHpChange(45);
        comp.newCombatant.current_hp = 31;

        comp.addCombatant();
        const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

        expect(body.combatants[0]).toEqual(jasmine.objectContaining({ armor_class: 17, max_hp: 45, current_hp: 31 }));
      });

      it('leaves the campaign list itself untouched', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, sage.id);
        comp.newCombatant.armor_class = 17;
        comp.onMaxHpChange(45);
        comp.newCombatant.current_hp = 31;

        comp.addCombatant();
        httpMock.expectOne((r) => r.method === 'PUT');

        expect(campaigns.roster().find((c) => c.id === sage.id)).toEqual(sage);
      });

      it('keeps the wound the campaign lists when nothing else is typed', async () => {
        const fixture = openDialog();
        await choose(fixture, sage.id);

        fixture.componentInstance.addCombatant();
        const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

        expect(body.combatants[0]).toEqual(jasmine.objectContaining({ max_hp: 30, current_hp: 22 }));
      });

      it('current HP follows max HP for a character at full health', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, hero.id); // 30 / 30

        comp.onMaxHpChange(40);

        expect(comp.newCombatant.current_hp).toBe(40);
        comp.addCombatant();
        const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;
        expect(body.combatants[0]).toEqual(jasmine.objectContaining({ max_hp: 40, current_hp: 40 }));
      });

      it('but a wounded character keeps their current HP when max HP changes', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, sage.id); // 22 / 30

        comp.onMaxHpChange(40);

        expect(comp.newCombatant.current_hp).toBe(22);
      });

      it('typing max HP into the field moves current HP along for a full-health character', async () => {
        const fixture = openDialog();
        await choose(fixture, hero.id);
        const maxHp = el(fixture, 'combatant-max-hp') as HTMLInputElement;

        maxHp.value = '55';
        maxHp.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect((el(fixture, 'combatant-current-hp') as HTMLInputElement).value).toBe('55');
      });

      it('current HP above max HP, or below zero, cannot be added, and the dialog says why', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, sage.id);

        comp.newCombatant.current_hp = 31; // max is 30
        fixture.detectChanges();
        expect(comp.canAddCombatant()).toBeFalse();
        expect(el(fixture, 'add-blocked-reason')?.textContent).toContain('between 0 and max HP');
        comp.addCombatant();
        httpMock.expectNone((r) => r.method === 'PUT');

        comp.newCombatant.current_hp = -1;
        expect(comp.canAddCombatant()).toBeFalse();

        comp.newCombatant.current_hp = 0; // a character who starts down is fine
        expect(comp.canAddCombatant()).toBeTrue();
        comp.newCombatant.current_hp = 30;
        expect(comp.canAddCombatant()).toBeTrue();
      });

      it('an emptied current HP means full health', async () => {
        const fixture = openDialog();
        const comp = fixture.componentInstance;
        await choose(fixture, sage.id);
        comp.newCombatant.current_hp = null as unknown as undefined; // what clearing a number field leaves behind

        comp.addCombatant();
        const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

        expect(body.combatants[0]).toEqual(jasmine.objectContaining({ max_hp: 30, current_hp: 30 }));
      });

      it('custom enemies and NPCs have no current HP field (they start at full health)', () => {
        const fixture = openDialog();

        expect(el(fixture, 'combatant-current-hp')).toBeNull();
        expect(el(fixture, 'combatant-max-hp')).not.toBeNull();
      });
    });

    it('lets the owner set initiative, armor class and weapon for this encounter', async () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      await choose(fixture, hero.id);
      comp.newCombatant.initiative = 9;
      comp.newCombatant.armor_class = 19;
      comp.newCombatant.weapon_equipped = 'Longbow';

      comp.addCombatant();
      const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

      expect(body.combatants[0]).toEqual(jasmine.objectContaining({ initiative: 9, armor_class: 19, weapon_equipped: 'Longbow' }));
    });

    it('a character cannot be added twice', async () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      await choose(fixture, hero.id);
      comp.addCombatant();
      const first = httpMock.expectOne((r) => r.method === 'PUT');
      first.flush(first.request.body);

      comp.openAddModal();
      fixture.detectChanges();
      expect(rosterOptions(fixture)).not.toContain('Hero (player)');

      comp.selectedRosterId = hero.id; // a stale choice from before they were added
      expect(comp.canAddCombatant()).toBeFalse();
      expect(comp.addBlockedReason()).toContain('already in this encounter');
      comp.addCombatant();
      httpMock.expectNone((r) => r.method === 'PUT');
    });

    it('a character can be added again in the next encounter', async () => {
      const fixture = openDialog([hero]);
      fixture.componentInstance.newEncounter();
      fixture.componentInstance.confirmNewEncounter();
      expectRoster(LIGHT.id).flush({ combatants: party });
      expectCreate().flush(campaignEncounter());

      fixture.componentInstance.openAddModal();
      fixture.detectChanges();

      expect(rosterOptions(fixture)).toContain('Hero (player)');
    });
  });

  describe('nothing unknown can be added', () => {
    function openDialog(): ComponentFixture<AppComponent> {
      const fixture = boot();
      expectCreate().flush(makeEncounter());
      fixture.componentInstance.openAddModal();
      fixture.detectChanges();
      return fixture;
    }
    const el = (fixture: ComponentFixture<AppComponent>, testId: string) =>
      fixture.nativeElement.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    const optionValues = (fixture: ComponentFixture<AppComponent>, testId: string) =>
      Array.from((el(fixture, testId) as HTMLSelectElement).options).map((o) => o.value);

    it('a blank name cannot be added: the button is disabled, and says why', () => {
      const fixture = openDialog();

      expect(fixture.componentInstance.canAddCombatant()).toBeFalse();
      expect((el(fixture, 'add-combatant-submit') as HTMLButtonElement).disabled).toBeTrue();
      expect(el(fixture, 'add-blocked-reason')?.textContent).toContain('Enter a name');
    });

    it('a name of only spaces is blank too', () => {
      const fixture = openDialog();
      fixture.componentInstance.newCombatant = { name: '   ', type: 'enemy', armor_class: 10, max_hp: 10 };

      expect(fixture.componentInstance.canAddCombatant()).toBeFalse();
    });

    it('addCombatant adds nothing for a blank name, even if called directly', () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      comp.newCombatant = { name: '', type: 'enemy', armor_class: 10, max_hp: 10 };

      comp.addCombatant();

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(combat.encounter()?.combatants).toEqual([]);
      expect(comp.showAddModal).toBeTrue(); // still open, so the name can be filled in
    });

    it('never produces a combatant called "Unknown"', () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;

      for (const name of ['', '   ', undefined]) {
        comp.newCombatant = { name, type: 'enemy', armor_class: 10, max_hp: 10 };
        comp.addCombatant();
      }

      httpMock.expectNone((r) => r.method === 'PUT');
      expect(JSON.stringify(combat.encounter())).not.toContain('Unknown');
    });

    it('is enabled as soon as a name is typed', async () => {
      const fixture = openDialog();
      const name = el(fixture, 'combatant-name') as HTMLInputElement;

      name.value = 'Goblin';
      name.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect((el(fixture, 'add-combatant-submit') as HTMLButtonElement).disabled).toBeFalse();
      expect(el(fixture, 'add-blocked-reason')).toBeNull();
    });

    it('stores the name without surrounding spaces', () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      comp.newCombatant = { name: '  Orc  ', type: 'enemy', armor_class: 14, max_hp: 25 };

      comp.addCombatant();
      const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

      expect(body.combatants[0].name).toBe('Orc');
    });

    it('numbers several identical enemies from the trimmed name', () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      comp.newCombatant = { name: ' Goblin ', type: 'enemy', armor_class: 12, max_hp: 7 };
      comp.addAmount = 2;

      comp.addCombatant();
      const body = httpMock.expectOne((r) => r.method === 'PUT').request.body as EncounterState;

      expect(body.combatants.map((c) => c.name)).toEqual(['Goblin 1', 'Goblin 2']);
    });

    it('outside a campaign a named player is still fine (there is no campaign list to pick from)', () => {
      const fixture = openDialog();
      const comp = fixture.componentInstance;
      comp.newCombatant = { name: 'Guest', type: 'player', armor_class: 12, max_hp: 20 };
      fixture.detectChanges();

      expect(comp.canAddCombatant()).toBeTrue();
      expect(optionValues(fixture, 'combatant-type')).toEqual(['player', 'enemy', 'npc']);
      expect(optionValues(fixture, 'combatant-template')).toEqual(['', 'enemy', 'player']);
    });

    describe('inside a campaign', () => {
      function openCampaignDialog(): ComponentFixture<AppComponent> {
        const fixture = bootInCampaign();
        fixture.componentInstance.openAddModal();
        fixture.detectChanges();
        return fixture;
      }

      it('a named custom enemy or NPC can still be added (a fight needs them)', () => {
        const fixture = openCampaignDialog();
        const comp = fixture.componentInstance;

        comp.newCombatant = { name: 'Bandit', type: 'enemy', armor_class: 12, max_hp: 11 };
        expect(comp.canAddCombatant()).toBeTrue();
        comp.newCombatant = { name: 'Innkeeper', type: 'npc', armor_class: 10, max_hp: 4 };
        expect(comp.canAddCombatant()).toBeTrue();
      });

      it('but not without a name', () => {
        const fixture = openCampaignDialog();

        expect(fixture.componentInstance.canAddCombatant()).toBeFalse();
        expect(el(fixture, 'add-blocked-reason')?.textContent).toContain('Enter a name');
      });

      it('a player cannot be typed in: players come only from the campaign list', () => {
        const fixture = openCampaignDialog();
        const comp = fixture.componentInstance;
        comp.newCombatant = { name: 'Made-up Hero', type: 'player', armor_class: 15, max_hp: 30 };
        fixture.detectChanges();

        expect(comp.canAddCombatant()).toBeFalse();
        expect(comp.addBlockedReason()).toContain('chosen from the campaign list');
        comp.addCombatant();
        httpMock.expectNone((r) => r.method === 'PUT');
      });

      it('the dialog does not even offer Player as a type or template for a custom combatant', () => {
        const fixture = openCampaignDialog();

        expect(optionValues(fixture, 'combatant-type')).toEqual(['enemy', 'npc']);
        expect(optionValues(fixture, 'combatant-template')).toEqual(['', 'enemy']);
      });
    });
  });
});
