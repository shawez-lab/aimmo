import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLOT_SETTINGS,
  agentFreeSlots,
  checkAvailability,
  conflictOf,
  freeSlots,
  localTime,
  parisInstant,
  withinAvailability,
  type Availability,
  type BookedInterval,
  type Interval,
  type Slot,
} from '../src/index.ts';

// Novembre 2026 : Paris est à UTC+1. Mardi 10 novembre.
const paris = (iso: string): Date => {
  const [date, time] = iso.split(' ') as [string, string];
  const [h, m] = time.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const hhmm = (d: Date): string => {
  const l = localTime(d, 'Europe/Paris');
  return `${String(Math.floor(l.minutes / 60)).padStart(2, '0')}:${String(l.minutes % 60).padStart(2, '0')}`;
};
const NOW = paris('2026-11-09 08:00');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '09:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const day = (date: string) => ({ from: paris(`${date} 00:00`), to: paris(`${date} 23:59`) });
const starts = (slots: Slot[]) => slots.map((s) => hhmm(s.start));

describe('V01 · disponibilités et créneaux libres', () => {
  it('[R33] aucun créneau hors des plages de l’agent : chaque créneau y tient entier', () => {
    const slots = freeSlots({ availability: WEEK, kind: 'estimation', ...day('2026-11-10'), now: NOW, booked: [], busy: [] });
    expect(starts(slots)).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45', '16:00', '16:15', '16:30', '16:45', '17:00']);
    for (const s of slots) {
      expect(withinAvailability(s, WEEK)).toBe(true);
      expect(s.end.getTime() - s.start.getTime()).toBe(60 * 60_000);
    }
    // Samedi et dimanche : l'agent n'a rien ouvert.
    expect(freeSlots({ availability: WEEK, kind: 'appel', ...day('2026-11-14'), now: NOW, booked: [], busy: [] })).toEqual([]);
    expect(freeSlots({ availability: WEEK, kind: 'appel', ...day('2026-11-15'), now: NOW, booked: [], busy: [] })).toEqual([]);
  });

  it('[R33] une exception remplace la journée : fermée, ou d’autres plages', () => {
    const a: Availability = { ...WEEK, exceptions: [{ date: '2026-11-10', ranges: [] }, { date: '2026-11-12', ranges: [{ from: '10:00', to: '11:00' }] }] };
    expect(freeSlots({ availability: a, kind: 'appel', ...day('2026-11-10'), now: NOW, booked: [], busy: [] })).toEqual([]);
    expect(starts(freeSlots({ availability: a, kind: 'estimation', ...day('2026-11-12'), now: NOW, booked: [], busy: [] }))).toEqual(['10:00']);
    // Le 11 novembre n'a pas d'exception : la semaine type s'applique.
    expect(freeSlots({ availability: a, kind: 'estimation', ...day('2026-11-11'), now: NOW, booked: [], busy: [] }).length).toBeGreaterThan(0);
  });

  it('[R33] aucun créneau sur un événement occupé de l’agenda, trajet compris pour un rendez-vous sur place', () => {
    const busy: Interval[] = [{ start: paris('2026-11-10 10:00'), end: paris('2026-11-10 11:00') }];
    const onSite = starts(freeSlots({ availability: WEEK, kind: 'estimation', ...day('2026-11-10'), now: NOW, booked: [], busy }));
    expect(onSite.filter((s) => s < '12:00')).toEqual([]);
    const call = starts(freeSlots({ availability: WEEK, kind: 'appel', ...day('2026-11-10'), now: NOW, booked: [], busy }));
    expect(call.filter((s) => s < '12:00')).toEqual(['09:00', '09:15', '09:30', '11:00', '11:15', '11:30']);
  });

  it('[R32] aucun chevauchement d’un rendez-vous, et le temps de trajet laissé entre deux rendez-vous sur place', () => {
    const booked: BookedInterval[] = [{ kind: 'visite', start: paris('2026-11-10 14:00'), end: paris('2026-11-10 14:45') }];
    const visits = starts(freeSlots({ availability: WEEK, kind: 'visite', ...day('2026-11-10'), now: NOW, booked, busy: [] })).filter((s) => s >= '14:00');
    // 14:45 + 30 min de trajet : la première visite suivante est à 15:15.
    expect(visits[0]).toBe('15:15');
    const calls = starts(freeSlots({ availability: WEEK, kind: 'appel', ...day('2026-11-10'), now: NOW, booked, busy: [] })).filter((s) => s >= '14:00');
    // Un appel n'a pas de trajet : il suit la visite tout de suite.
    expect(calls[0]).toBe('14:45');
    const slot: Slot = { kind: 'estimation', start: paris('2026-11-10 13:15'), end: paris('2026-11-10 14:15') };
    expect(conflictOf(slot, booked, [])).toBe('R32');
    expect(conflictOf({ kind: 'estimation', start: paris('2026-11-10 15:15'), end: paris('2026-11-10 16:15') }, booked, [])).toBeNull();
    expect(conflictOf({ kind: 'estimation', start: paris('2026-11-10 15:00'), end: paris('2026-11-10 16:00') }, booked, [])).toBe('R32');
  });

  it('[R33] des plages qui se chevauchent ou se touchent : ni créneau en double, ni créneau perdu', () => {
    const overlap: Availability = { weekly: [{ weekday: 2, from: '09:00', to: '12:00' }, { weekday: 2, from: '11:00', to: '13:00' }] };
    const a = starts(freeSlots({ availability: overlap, kind: 'estimation', ...day('2026-11-10'), now: NOW, booked: [], busy: [] }));
    expect(new Set(a).size).toBe(a.length);
    expect(a.at(-1)).toBe('12:00');
    const touching: Availability = { weekly: [{ weekday: 2, from: '09:00', to: '12:00' }, { weekday: 2, from: '12:00', to: '13:00' }] };
    const b = starts(freeSlots({ availability: touching, kind: 'estimation', ...day('2026-11-10'), now: NOW, booked: [], busy: [] }));
    expect(b).toContain('11:30');
    expect(b).toEqual(a);
    expect(withinAvailability({ start: paris('2026-11-10 11:30'), end: paris('2026-11-10 12:30') }, touching)).toBe(true);
  });

  it('jamais dans le passé ni avant le délai minimal', () => {
    const now = paris('2026-11-10 10:10');
    const slots = freeSlots({ availability: WEEK, kind: 'appel', ...day('2026-11-10'), now, booked: [], busy: [] });
    expect(starts(slots)[0]).toBe('14:00');
    expect(slots.every((s) => s.start.getTime() >= now.getTime() + DEFAULT_SLOT_SETTINGS.minNoticeMinutes * 60_000)).toBe(true);
  });

  it('heure de Paris au changement d’heure : ni heure qui n’existe pas, ni heure en double', () => {
    // 28 mars 2027 : 2 h devient 3 h. 31 octobre 2027 : 3 h redevient 2 h.
    expect(parisInstant('2027-03-28', 150)).toBeNull();
    expect(parisInstant('2027-03-28', 180)!.toISOString()).toBe('2027-03-28T01:00:00.000Z');
    expect(parisInstant('2027-10-31', 150)!.toISOString()).toBe('2027-10-31T00:30:00.000Z');
    const sunday: Availability = { weekly: [{ weekday: 7, from: '01:00', to: '05:00' }] };
    const settings = { ...DEFAULT_SLOT_SETTINGS, minNoticeMinutes: 0, durations: { ...DEFAULT_SLOT_SETTINGS.durations, appel: 60 } };
    const spring = freeSlots({ availability: sunday, kind: 'appel', from: new Date('2027-03-27T12:00:00Z'), to: new Date('2027-03-28T12:00:00Z'), now: new Date('2027-03-01T00:00:00Z'), booked: [], busy: [], settings });
    // La plage ne dure que 3 heures réelles ce jour-là.
    for (const s of spring) expect(s.end.getTime()).toBeLessThanOrEqual(parisInstant('2027-03-28', 300)!.getTime());
    expect(starts(spring)).not.toContain('02:00');
    const autumn = freeSlots({ availability: sunday, kind: 'appel', from: new Date('2027-10-30T12:00:00Z'), to: new Date('2027-10-31T12:00:00Z'), now: new Date('2027-10-01T00:00:00Z'), booked: [], busy: [], settings });
    const isos = autumn.map((s) => s.start.toISOString());
    expect(new Set(isos).size).toBe(isos.length);
    for (const s of autumn) expect(withinAvailability(s, sunday)).toBe(true);
  });

  it('[R33] une borne de plage dans l’heure qui n’existe pas n’allonge jamais la plage', () => {
    const sunday: Availability = { weekly: [{ weekday: 7, from: '01:00', to: '02:30' }] };
    const settings = { ...DEFAULT_SLOT_SETTINGS, minNoticeMinutes: 0 };
    const slots = freeSlots({ availability: sunday, kind: 'estimation', from: new Date('2027-03-27T12:00:00Z'), to: new Date('2027-03-28T12:00:00Z'), now: new Date('2027-03-01T00:00:00Z'), booked: [], busy: [], settings });
    // La plage dure une heure réelle, de 1 h à 3 h (2 h n'existe pas) : seul 01:00 tient.
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2027-03-28T00:00:00.000Z']);
    expect(withinAvailability({ start: new Date('2027-03-28T00:30:00Z'), end: new Date('2027-03-28T01:30:00Z') }, sunday)).toBe(false);
  });

  it('au passage à l’heure d’hiver, un créneau qui tient en temps réel est proposé', () => {
    const sunday: Availability = { weekly: [{ weekday: 7, from: '01:00', to: '03:00' }] };
    const settings = { ...DEFAULT_SLOT_SETTINGS, minNoticeMinutes: 0 };
    const slots = freeSlots({ availability: sunday, kind: 'estimation', from: new Date('2027-10-30T12:00:00Z'), to: new Date('2027-10-31T12:00:00Z'), now: new Date('2027-10-01T00:00:00Z'), booked: [], busy: [], settings });
    // La plage dure 3 heures réelles : le premier 02:15 finit au second 02:15, dans la plage.
    expect(slots.map((s) => s.start.toISOString())).toContain(parisInstant('2027-10-31', 135)!.toISOString());
    for (const s of slots) expect(withinAvailability(s, sunday)).toBe(true);
  });

  it('des disponibilités mal formées sont refusées', () => {
    expect(() => checkAvailability({ weekly: [{ weekday: 8, from: '09:00', to: '10:00' }] })).toThrow('Jour');
    expect(() => checkAvailability({ weekly: [{ weekday: 1, from: '11:00', to: '10:00' }] })).toThrow('plage');
    expect(() => checkAvailability({ weekly: [{ weekday: 1, from: '9h', to: '10:00' }] })).toThrow('HH:MM');
    expect(() => checkAvailability({ weekly: [{ weekday: 1, from: '09:02', to: '10:00' }] })).toThrow('5 minutes');
    expect(() => checkAvailability({ weekly: [], exceptions: [{ date: '10/11/2026', ranges: [] }] })).toThrow('AAAA-MM-JJ');
  });

  it('lit les événements occupés dans l’agenda de l’agent, trajet compris de chaque côté', async () => {
    const calls: [string, Date, Date][] = [];
    const source = {
      busy: async (agentId: string, from: Date, to: Date) => {
        calls.push([agentId, from, to]);
        return [{ start: paris('2026-11-10 09:00'), end: paris('2026-11-10 12:00') }];
      },
    };
    const slots = await agentFreeSlots(source, 'agent-1', { availability: WEEK, kind: 'estimation', ...day('2026-11-10'), now: NOW, booked: [] });
    expect(starts(slots)[0]).toBe('14:00');
    expect(calls[0]![0]).toBe('agent-1');
    expect(calls[0]![1].getTime()).toBe(paris('2026-11-10 00:00').getTime() - 30 * 60_000);
  });
});
