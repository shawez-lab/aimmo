import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, UsageMatin, appendEvent, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
async function world(today: string) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const marc = await store.createAgent({ networkId: net.id, firstName: 'Marc', lastName: 'Essai' });
  const ailleurs = await store.createAgent({ networkId: other.id, firstName: 'Zoé', lastName: 'Essai' });
  const journal = new SqlJournalStore(db);
  /** Une lecture du plan du jour, à l'instant donné (UTC). */
  const read = (agentId: string, at: string, day: string, ready = true) =>
    appendEvent(journal, { type: 'plan_du_jour.lu', actor: `agent:${agentId}`, subject: `agent:${agentId}`, data: { rule: 'R16', day, ready } }, () => new Date(at));
  const usage = new UsageMatin(db, journal, { now: () => new Date(today) });
  const as = (role: string, userId: string, networkId = net.id): Viewer => ({ role, userId, networkId }) as Viewer;
  return { db, net, paul, lise, marc, ailleurs, read, usage, as, journal };
}

describeWithSqlite('A04 · usage du matin', () => {
  it('compte juste, à l’heure de Paris, les jours où l’agent a ouvert son plan figé avant midi, sur 7 jours', async () => {
    // Novembre 2026 : Paris est à UTC+1. Aujourd'hui : mardi 10 novembre, 10 h à Paris.
    const w = await world('2026-11-10T09:00:00.000Z');
    await w.read(w.paul.id, '2026-11-03T07:00:00.000Z', '2026-11-03'); // hors des 7 jours
    await w.read(w.paul.id, '2026-11-04T07:00:00.000Z', '2026-11-04'); // 8 h
    await w.read(w.paul.id, '2026-11-05T10:59:00.000Z', '2026-11-05'); // 11 h 59
    await w.read(w.paul.id, '2026-11-06T11:00:00.000Z', '2026-11-06'); // midi pile : trop tard
    await w.read(w.paul.id, '2026-11-07T06:00:00.000Z', '2026-11-07', false); // plan pas encore figé
    await w.read(w.paul.id, '2026-11-07T23:30:00.000Z', '2026-11-08'); // 0 h 30 le 8 à Paris
    await w.read(w.paul.id, '2026-11-09T07:00:00.000Z', '2026-11-09');
    await w.read(w.paul.id, '2026-11-09T08:00:00.000Z', '2026-11-09'); // deux fois le même jour : un jour
    await w.read(w.lise.id, '2026-11-09T08:00:00.000Z', '2026-11-09');
    await w.read(w.ailleurs.id, '2026-11-10T07:00:00.000Z', '2026-11-10');

    const r = await w.usage.read(w.as('agent', w.paul.id));
    expect(r).toEqual({
      ok: true,
      value: {
        scope: 'agent',
        days: [
          { day: '2026-11-04', opened: true },
          { day: '2026-11-05', opened: true },
          { day: '2026-11-06', opened: false },
          { day: '2026-11-07', opened: false },
          { day: '2026-11-08', opened: true },
          { day: '2026-11-09', opened: true },
          { day: '2026-11-10', opened: false },
        ],
        openedDays: 4,
      },
    });
    const lise = await w.usage.read(w.as('agent', w.lise.id));
    expect(lise.ok && lise.value.scope === 'agent' && lise.value.openedDays).toBe(1);
  });

  it('[R14] la direction ne voit que des nombres du réseau, sans nom ni classement d’agent', async () => {
    const w = await world('2026-11-10T09:00:00.000Z');
    await w.read(w.paul.id, '2026-11-09T07:00:00.000Z', '2026-11-09');
    await w.read(w.lise.id, '2026-11-09T08:00:00.000Z', '2026-11-09');
    await w.read(w.lise.id, '2026-11-10T07:00:00.000Z', '2026-11-10');
    await w.read(w.ailleurs.id, '2026-11-10T07:00:00.000Z', '2026-11-10');
    const r = await w.usage.read(w.as('direction', 'direction-1'));
    expect(r).toEqual({
      ok: true,
      value: {
        scope: 'network',
        days: ['04', '05', '06', '07', '08', '09', '10'].map((d) => ({ day: `2026-11-${d}`, agents: d === '09' ? 2 : d === '10' ? 1 : 0 })),
        daysUsed: 2,
        activeAgents: 3,
      },
    });
    const text = JSON.stringify(r);
    for (const agent of [w.paul, w.lise, w.marc]) {
      expect(text).not.toContain(agent.id);
      expect(text).not.toContain(agent.first_name);
    }
  });

  it('au changement d’heure d’octobre, midi reste midi à Paris', async () => {
    // Le 25 octobre 2026, Paris passe de UTC+2 à UTC+1.
    const w = await world('2026-10-27T09:00:00.000Z');
    await w.read(w.paul.id, '2026-10-24T09:30:00.000Z', '2026-10-24'); // 11 h 30 (UTC+2)
    await w.read(w.lise.id, '2026-10-24T10:30:00.000Z', '2026-10-24'); // 12 h 30 (UTC+2) : trop tard
    await w.read(w.paul.id, '2026-10-26T10:30:00.000Z', '2026-10-26'); // 11 h 30 (UTC+1)
    await w.read(w.lise.id, '2026-10-26T11:30:00.000Z', '2026-10-26'); // 12 h 30 (UTC+1) : trop tard
    const paul = await w.usage.read(w.as('agent', w.paul.id));
    expect(paul.ok && paul.value.scope === 'agent' && paul.value.days.filter((d) => d.opened).map((d) => d.day)).toEqual(['2026-10-24', '2026-10-26']);
    const lise = await w.usage.read(w.as('agent', w.lise.id));
    expect(lise.ok && lise.value.scope === 'agent' && lise.value.openedDays).toBe(0);
  });

  it('[R16] conformité, partenaire, agent parti ou d’un autre réseau : refusés, et le refus est au journal', async () => {
    const w = await world('2026-11-10T09:00:00.000Z');
    await w.db.run(`UPDATE agents SET status = 'left' WHERE id = ?`, [w.marc.id]);
    for (const viewer of [w.as('compliance', 'c-1'), w.as('partner', 'p-1'), w.as('agent', w.marc.id), w.as('agent', w.paul.id, 'autre')]) {
      expect(await w.usage.read(viewer)).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect((await w.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(4);
  });

  it('aucune donnée de client n’est lue ni rendue, même quand le journal en porte la trace', async () => {
    const w = await world('2026-11-10T09:00:00.000Z');
    const store = new FicheClient(w.db);
    const lea = await store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Léa', lastName: 'Exemple' });
    await appendEvent(w.journal, { type: 'fiche.lue', actor: `agent:${w.paul.id}`, subject: `person:${lea.id}`, data: { rule: 'R16' } }, () => new Date('2026-11-10T07:00:00.000Z'));
    await w.read(w.paul.id, '2026-11-10T07:01:00.000Z', '2026-11-10');
    const seen: string[] = [];
    const spy = { ...w.db, all: (sql: string, params?: unknown[]) => (seen.push(sql), w.db.all(sql, params as never)), first: (sql: string, params?: unknown[]) => (seen.push(sql), w.db.first(sql, params as never)) };
    const usage = new UsageMatin(spy as typeof w.db, w.journal, { now: () => new Date('2026-11-10T09:00:00.000Z') });
    for (const viewer of [w.as('agent', w.paul.id), w.as('direction', 'direction-1')]) {
      const r = await usage.read(viewer);
      const text = JSON.stringify(r);
      expect(r.ok).toBe(true);
      expect(text).not.toContain(lea.id);
      expect(text).not.toMatch(/Léa|Exemple|person:/);
      expect(Object.keys(r.ok ? r.value : {}).sort()).toEqual(r.ok && r.value.scope === 'agent' ? ['days', 'openedDays', 'scope'] : ['activeAgents', 'days', 'daysUsed', 'scope']);
    }
    // Seules la table des agents et les lectures du plan dans le journal sont lues ; aucune table de client.
    expect(seen.every((sql) => /FROM agents|FROM journal WHERE type = 'plan_du_jour.lu'/.test(sql))).toBe(true);
    expect(seen.some((sql) => /persons|messages|projects|consents|identifiers/.test(sql))).toBe(false);
  });
});
