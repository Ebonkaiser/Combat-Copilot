import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { CampaignService } from './campaign.service';
import { Campaign } from '../models/campaign.model';
import { Combatant } from '../models/combat.model';

const STORAGE_KEY = 'combat-copilot.last-campaign';

describe('CampaignService', () => {
  let service: CampaignService;
  let http: HttpTestingController;

  const campaigns: Campaign[] = [
    { id: 'light-and-magic', name: 'Light and Magic', description: 'The main campaign.' },
    { id: 'side-quest', name: 'Side Quest', description: '' },
  ];

  const hero: Combatant = {
    id: 'pc_1', name: 'Hero', type: 'player', armor_class: 15, max_hp: 30, current_hp: 30,
    conditions: [], tactical_tags: [], resources: {}, initiative: 0, weapon_equipped: 'Unarmed',
  };

  const clearStorage = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
  };

  beforeEach(() => {
    clearStorage();
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(CampaignService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    clearStorage();
  });

  it('starts empty', () => {
    expect(service.campaigns()).toEqual([]);
    expect(service.activeCampaignId()).toBeNull();
  });

  it('loadCampaigns GETs /campaigns and keeps the list', () => {
    service.loadCampaigns().subscribe();

    const req = http.expectOne('/api/campaigns');
    expect(req.request.method).toBe('GET');
    req.flush(campaigns);

    expect(service.campaigns()).toEqual(campaigns);
  });

  it('a failed loadCampaigns leaves the list as it was', () => {
    service.campaigns.set(campaigns);
    service.loadCampaigns().subscribe({ error: () => undefined });

    http.expectOne('/api/campaigns').flush({ detail: 'Owner sign-in required' }, { status: 401, statusText: 'Unauthorized' });

    expect(service.campaigns()).toEqual(campaigns);
  });

  it('loadRoster GETs the roster of that campaign and returns just the combatants', () => {
    let roster: Combatant[] | undefined;
    service.loadRoster('light-and-magic').subscribe((combatants) => (roster = combatants));

    const req = http.expectOne('/api/campaigns/light-and-magic/roster');
    expect(req.request.method).toBe('GET');
    req.flush({ combatants: [hero] });

    expect(roster).toEqual([hero]);
  });

  it('encodes the campaign id in the roster URL', () => {
    service.loadRoster('a/b c').subscribe({ error: () => undefined });

    const req = http.expectOne('/api/campaigns/a%2Fb%20c/roster');
    expect(req.request.url).toBe('/api/campaigns/a%2Fb%20c/roster');
    req.flush({ detail: 'Campaign not found' }, { status: 404, statusText: 'Not Found' });
  });

  describe('remembering the selection', () => {
    it('select sets the active campaign and remembers it in the browser', () => {
      service.select('light-and-magic');

      expect(service.activeCampaignId()).toBe('light-and-magic');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light-and-magic');
    });

    it('select(null) clears both', () => {
      service.select('light-and-magic');

      service.select(null);

      expect(service.activeCampaignId()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('restorableSelection returns the remembered campaign while the server still offers it', () => {
      service.campaigns.set(campaigns);
      service.select('side-quest');

      expect(service.restorableSelection()).toBe('side-quest');
    });

    it('restorableSelection ignores a remembered campaign the server no longer lists', () => {
      localStorage.setItem(STORAGE_KEY, 'deleted-campaign');
      service.campaigns.set(campaigns);

      expect(service.restorableSelection()).toBeNull();
    });

    it('restorableSelection is null when nothing was remembered', () => {
      service.campaigns.set(campaigns);

      expect(service.restorableSelection()).toBeNull();
    });

    it('survives storage being unavailable (private window, blocked site data)', () => {
      service.campaigns.set(campaigns);
      spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');
      spyOn(Storage.prototype, 'removeItem').and.throwError('SecurityError');
      spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');

      expect(() => service.select('light-and-magic')).not.toThrow();
      expect(service.activeCampaignId()).toBe('light-and-magic');
      expect(() => service.select(null)).not.toThrow();
      expect(service.restorableSelection()).toBeNull();
    });
  });

  it('campaignName looks a name up by id', () => {
    service.campaigns.set(campaigns);

    expect(service.campaignName('side-quest')).toBe('Side Quest');
    expect(service.campaignName('nope')).toBeUndefined();
    expect(service.campaignName(null)).toBeUndefined();
  });

  it('reset forgets the list and the active campaign but not the remembered choice', () => {
    service.campaigns.set(campaigns);
    service.select('light-and-magic');

    service.reset();

    expect(service.campaigns()).toEqual([]);
    expect(service.activeCampaignId()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light-and-magic');
  });
});
