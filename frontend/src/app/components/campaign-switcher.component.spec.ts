import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { CampaignSwitcherComponent } from './campaign-switcher.component';
import { AuthService } from '../services/auth.service';
import { CampaignService } from '../services/campaign.service';
import { FakeAuthService } from '../testing/fake-auth';

describe('CampaignSwitcherComponent', () => {
  let fixture: ComponentFixture<CampaignSwitcherComponent>;
  let auth: FakeAuthService;
  let campaigns: CampaignService;
  let emitted: (string | null)[];

  const el = (testId: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  const picker = () => el('campaign-select') as HTMLSelectElement;

  function pick(value: string): void {
    const select = picker();
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CampaignSwitcherComponent, HttpClientTestingModule],
      providers: [{ provide: AuthService, useClass: FakeAuthService }],
    }).compileComponents();

    auth = TestBed.inject(AuthService) as unknown as FakeAuthService;
    campaigns = TestBed.inject(CampaignService);
    campaigns.campaigns.set([
      { id: 'light-and-magic', name: 'Light and Magic', description: '' },
      { id: 'side-quest', name: 'Side Quest', description: '' },
    ]);
    fixture = TestBed.createComponent(CampaignSwitcherComponent);
    emitted = [];
    fixture.componentInstance.campaignSelected.subscribe((value) => emitted.push(value));
  });

  describe('who sees it', () => {
    it('renders nothing for an anonymous user', () => {
      auth.mode.set('anonymous');
      fixture.detectChanges();

      expect(picker()).toBeNull();
      expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders the picker for the owner', () => {
      auth.becomeOwner();
      fixture.detectChanges();

      expect(picker()).not.toBeNull();
    });

    it('disappears again when the owner signs out', () => {
      auth.becomeOwner();
      fixture.detectChanges();
      expect(picker()).not.toBeNull();

      auth.mode.set('anonymous');
      fixture.detectChanges();

      expect(picker()).toBeNull();
    });
  });

  describe('the options', () => {
    beforeEach(() => {
      auth.becomeOwner();
      fixture.detectChanges();
    });

    it('offers a blank encounter plus each campaign by name', () => {
      const labels = Array.from(picker().options).map((option) => option.textContent?.trim());

      expect(labels).toEqual(['No campaign (blank encounter)', 'Light and Magic', 'Side Quest']);
      expect(Array.from(picker().options).map((option) => option.value)).toEqual(['', 'light-and-magic', 'side-quest']);
    });

    it('shows the active campaign as selected', () => {
      campaigns.select('side-quest');
      fixture.detectChanges();

      expect(picker().value).toBe('side-quest');
    });

    it('shows "no campaign" when none is active', () => {
      expect(picker().value).toBe('');
    });

    it('has an accessible label', () => {
      const label = fixture.nativeElement.querySelector('label[for="campaign-select"]') as HTMLLabelElement;

      expect(label.textContent?.trim()).toBe('Campaign');
      expect(picker().id).toBe('campaign-select');
    });
  });

  describe('switching with nothing in progress', () => {
    beforeEach(() => {
      auth.becomeOwner();
      fixture.componentRef.setInput('encounterInProgress', false);
      fixture.detectChanges();
    });

    it('emits the chosen campaign straight away, without asking', () => {
      pick('light-and-magic');

      expect(emitted).toEqual(['light-and-magic']);
      expect(el('switch-confirm')).toBeNull();
    });

    it('emits null for "no campaign"', () => {
      campaigns.select('light-and-magic');
      fixture.detectChanges();

      pick('');

      expect(emitted).toEqual([null]);
    });

    it('does nothing when the active campaign is picked again', () => {
      campaigns.select('light-and-magic');
      fixture.detectChanges();

      pick('light-and-magic');

      expect(emitted).toEqual([]);
    });

    it('keeps showing the ACTIVE campaign until the parent has really switched', () => {
      pick('side-quest');

      expect(picker().value).toBe(''); // still the active one (none); the service moves it on success

      campaigns.select('side-quest');
      fixture.detectChanges();
      expect(picker().value).toBe('side-quest');
    });
  });

  describe('switching with an encounter in progress', () => {
    beforeEach(() => {
      auth.becomeOwner();
      campaigns.select('light-and-magic');
      fixture.componentRef.setInput('encounterInProgress', true);
      fixture.detectChanges();
    });

    it('asks inline first and emits nothing yet', () => {
      pick('side-quest');

      expect(emitted).toEqual([]);
      const confirmRow = el('switch-confirm');
      expect(confirmRow).not.toBeNull();
      expect(confirmRow?.textContent).toContain('Switch to Side Quest?');
      expect(confirmRow?.textContent).toContain('discarded');
    });

    it('is an inline row, not window.confirm', () => {
      const confirmSpy = spyOn(window, 'confirm');

      pick('side-quest');

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(el('switch-confirm')?.getAttribute('role')).toBe('alertdialog');
    });

    it('emits the campaign once the owner confirms, and closes the row', () => {
      pick('side-quest');

      (el('switch-confirm-yes') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(emitted).toEqual(['side-quest']);
      expect(el('switch-confirm')).toBeNull();
    });

    it('emits nothing and restores the picker when the owner keeps the current encounter', () => {
      pick('side-quest');

      (el('switch-confirm-no') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(emitted).toEqual([]);
      expect(el('switch-confirm')).toBeNull();
      expect(picker().value).toBe('light-and-magic');
    });

    it('names a blank encounter when "no campaign" is picked', () => {
      pick('');

      expect(el('switch-confirm')?.textContent).toContain('Switch to a blank encounter?');
      (el('switch-confirm-yes') as HTMLButtonElement).click();
      expect(emitted).toEqual([null]);
    });

    it('does not ask when the active campaign is picked again', () => {
      pick('light-and-magic');

      expect(el('switch-confirm')).toBeNull();
      expect(emitted).toEqual([]);
    });

    it('replaces a pending question when another campaign is picked', () => {
      pick('side-quest');
      pick('');

      expect(el('switch-confirm')?.textContent).toContain('a blank encounter');
      expect(fixture.nativeElement.querySelectorAll('[data-testid="switch-confirm"]').length).toBe(1);
    });
  });
});
