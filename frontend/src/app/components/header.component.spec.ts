import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { HeaderComponent } from './header.component';
import { AuthService } from '../services/auth.service';
import { CampaignService } from '../services/campaign.service';
import { FakeAuthService } from '../testing/fake-auth';

describe('HeaderComponent', () => {
  let fixture: ComponentFixture<HeaderComponent>;
  let auth: FakeAuthService;

  const el = (testId: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HeaderComponent, HttpClientTestingModule],
      providers: [{ provide: AuthService, useClass: FakeAuthService }],
    }).compileComponents();

    auth = TestBed.inject(AuthService) as unknown as FakeAuthService;
    fixture = TestBed.createComponent(HeaderComponent);
  });

  it('shows the app title and subtitle', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h2').textContent).toContain('GM Assistant');
    expect(fixture.nativeElement.querySelector('.page-subtitle').textContent).toContain('apply damage');
  });

  it('waits for the server before showing any mode, so an owner never sees a flash of "Anonymous"', () => {
    auth.loaded.set(false);
    fixture.detectChanges();

    expect(el('mode-badge')).toBeNull();
    expect(el('sign-in-btn')).toBeNull();
  });

  describe('anonymous', () => {
    beforeEach(() => {
      auth.mode.set('anonymous');
      fixture.detectChanges();
    });

    it('shows the Anonymous badge', () => {
      expect(el('mode-badge')?.textContent?.trim()).toBe('Anonymous');
      expect(el('mode-badge')?.classList).not.toContain('owner');
    });

    it('offers owner sign-in', () => {
      expect(el('sign-in-btn')?.textContent?.trim()).toBe('Owner sign in');
      expect(el('sign-out-btn')).toBeNull();
    });

    it('has no campaign switcher', () => {
      expect(fixture.nativeElement.querySelector('app-campaign-switcher')).toBeNull();
      expect(fixture.nativeElement.querySelector('select')).toBeNull();
    });

    it('asks to sign in when the button is clicked', () => {
      let requested = 0;
      fixture.componentInstance.signInRequested.subscribe(() => requested++);

      (el('sign-in-btn') as HTMLButtonElement).click();

      expect(requested).toBe(1);
    });

    it('hides sign-in when the server has no owner configured', () => {
      auth.ownerLoginEnabled.set(false);
      fixture.detectChanges();

      expect(el('sign-in-btn')).toBeNull();
      expect(el('mode-badge')?.textContent?.trim()).toBe('Anonymous');
    });
  });

  describe('owner', () => {
    beforeEach(() => {
      auth.becomeOwner('owner@example.test');
      TestBed.inject(CampaignService).campaigns.set([{ id: 'light-and-magic', name: 'Light and Magic', description: '' }]);
      fixture.detectChanges();
    });

    it('shows the Owner badge, with the address only as a tooltip', () => {
      const badge = el('mode-badge') as HTMLElement;

      expect(badge.textContent?.trim()).toBe('Owner');
      expect(badge.classList).toContain('owner');
      expect(badge.getAttribute('title')).toBe('owner@example.test');
      expect(fixture.nativeElement.textContent).not.toContain('owner@example.test');
    });

    it('hosts the campaign switcher', () => {
      expect(fixture.nativeElement.querySelector('app-campaign-switcher')).not.toBeNull();
      expect(el('campaign-select')).not.toBeNull();
    });

    it('offers sign-out instead of sign-in', () => {
      expect(el('sign-out-btn')).not.toBeNull();
      expect(el('sign-in-btn')).toBeNull();
    });

    it('asks to sign out when the button is clicked', () => {
      let requested = 0;
      fixture.componentInstance.signOutRequested.subscribe(() => requested++);

      (el('sign-out-btn') as HTMLButtonElement).click();

      expect(requested).toBe(1);
    });

    it('passes the switcher\'s choice up', () => {
      const chosen: (string | null)[] = [];
      fixture.componentInstance.campaignSelected.subscribe((id) => chosen.push(id));

      const select = el('campaign-select') as HTMLSelectElement;
      select.value = 'light-and-magic';
      select.dispatchEvent(new Event('change'));

      expect(chosen).toEqual(['light-and-magic']);
    });

    it('tells the switcher whether an encounter is in progress', () => {
      const chosen: (string | null)[] = [];
      fixture.componentInstance.campaignSelected.subscribe((id) => chosen.push(id));
      fixture.componentRef.setInput('encounterInProgress', true);
      fixture.detectChanges();

      const select = el('campaign-select') as HTMLSelectElement;
      select.value = 'light-and-magic';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(chosen).toEqual([]); // held back for confirmation
      expect(el('switch-confirm')).not.toBeNull();
    });

    it('switches to the anonymous header when the session ends', () => {
      auth.markSessionExpired();
      fixture.detectChanges();

      expect(el('mode-badge')?.textContent?.trim()).toBe('Anonymous');
      expect(el('campaign-select')).toBeNull();
    });
  });
});
