import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Combatant, DamageEvent, EncounterState } from '../models/combat.model';
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

  public createEncounter(payload: EncounterState): Observable<EncounterState> {
    return this.http.post<EncounterState>(`${this.baseUrl}/encounters`, payload);
  }

  public updateEncounter(encounterId: string, payload: EncounterState): Observable<EncounterState> {
    return this.http.put<EncounterState>(`${this.baseUrl}/encounters/${encounterId}`, payload);
  }

  public applyDamageStream(encounterId: string, event: DamageEvent): void {
    this.isStreaming.set(true);
    this.narrative.set('');

    // Fetch SSE stream with POST via Fetch API + ReadableStream
    fetch(`${this.baseUrl}/encounters/${encounterId}/damage/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
      .then(async (response) => {
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
      })
      .catch((err) => {
        console.error('SSE Stream Failure:', err);
        this.isStreaming.set(false);
      });
  }
}