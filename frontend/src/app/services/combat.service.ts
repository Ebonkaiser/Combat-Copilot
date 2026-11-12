import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DamageEvent, EncounterCreate, EncounterState } from '../models/combat.model';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class CombatService {
  private readonly baseUrl = environment.apiUrl;

  // Reactive State Signals
  public encounter = signal<EncounterState | null>(null);
  public narrative = signal<string>('');
  public isStreaming = signal<boolean>(false);

  constructor(private http: HttpClient) {}

  public checkHealth(): Observable<{ status: string; detail?: string }> {
    return this.http.get<{ status: string; detail?: string }>(`${this.baseUrl}/health`);
  }

  /** The server assigns the encounter id: use the one in the response, not one of your own. */
  public createEncounter(payload: EncounterCreate): Observable<EncounterState> {
    return this.http.post<EncounterState>(`${this.baseUrl}/encounters`, payload);
  }

  public updateEncounter(encounterId: string, payload: EncounterState): Observable<EncounterState> {
    return this.http.put<EncounterState>(`${this.baseUrl}/encounters/${encounterId}`, payload);
  }

  public equipWeapon(encounterId: string, combatantId: string, weaponName: string): Observable<EncounterState> {
    return this.http.put<EncounterState>(
      `${this.baseUrl}/encounters/${encounterId}/combatants/${combatantId}/equipment`,
      { weapon_name: weaponName }
    );
  }

  /**
   * Streams the narrated result of a damage/heal/condition event.
   *
   * `onFailure` is told when the server refused or the connection failed -- with the HTTP
   * status (401: owner session gone, 404: the encounter no longer exists for this caller)
   * or null for a network error -- so the caller can recover instead of the narration
   * silently never appearing.
   */
  public applyDamageStream(
    encounterId: string,
    event: DamageEvent,
    onFailure?: (status: number | null) => void,
  ): void {
    this.isStreaming.set(true);
    this.narrative.set('');

    // Fetch SSE stream with POST via Fetch API + ReadableStream
    fetch(`${this.baseUrl}/encounters/${encounterId}/damage/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(event),
    })
      .then(async (response) => {
        if (!response.ok) {
          console.error('SSE Stream refused:', response.status);
          this.isStreaming.set(false);
          onFailure?.(response.status);
          return;
        }
        if (!response.body) throw new Error('ReadableStream unavailable');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n\r?\n/);
          buffer = lines.pop() || '';

          for (const block of lines) {
            const matchEvent = block.match(/event:\s*(.+)/);
            const matchData = block.match(/data:\s*(.+)/);

            if (!matchData) continue;
            const eventType = matchEvent ? matchEvent[1].trim() : 'message';
            const rawData = matchData[1].trim();

            if (eventType === 'state_update') {
              const parsed = JSON.parse(rawData);
              this.encounter.update((prev) =>
                prev ? { ...prev, combatants: parsed.combatants } : null
              );
            } else if (eventType === 'narrative_chunk') {
              const parsed = JSON.parse(rawData);
              this.narrative.update((curr) => curr + parsed.token);
            } else if (eventType === 'end') {
              this.isStreaming.set(false);
            }
          }
        }
        // The connection closed: never leave the UI waiting on a stream that is gone.
        this.isStreaming.set(false);
      })
      .catch((err) => {
        console.error('SSE Stream Failure:', err);
        this.isStreaming.set(false);
        onFailure?.(null);
      });
  }
}
