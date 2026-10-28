import { expect, it } from 'vitest';
import { AlertesPilotage, PILOTAGE_ALERTS_JOB, isDrop, pilotageAlertsJob } from '../src/pilotage/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : agents, clients, coûts, documents.

it('la baisse d’un indicateur : moyenne des 7 jours sous celle des 28 précédents de plus du seuil, calcul en entiers', () => {
  expect(isDrop(7, 28, 3000)).toBe(false);
  expect(isDrop(4, 28, 3000)).toBe(true);
  expect(isDrop(5, 28, 3000)).toBe(false);
  expect(isDrop(0, 0, 3000)).toBe(false);
  expect(isDrop(0, 1, 3000)).toBe(true);
});

it('le passage est réglé chaque jour à 6 h', () => {
  const job = pilotageAlertsJob({} as never, {} as never);
  expect([job.name, job.hours, job.weekdays]).toEqual([PILOTAGE_ALERTS_JOB, [6], undefined]);
});

describeWithSqlite('K07 · alertes de pilotage', () => {
  async function world() {
    const t = await setupAnnonce();
    const documents = { dueBy: async (_n: string, until: string) => [{ agentId: t.alexId, document: 'assurance_rcp', validUntil: '2027-07-01' }, { agentId: t.alexId, document: 'attestation_vigilance', validUntil: '2027-09-01' }].filter((d) => d.validUntil <= until) };
    const alertes = new AlertesPilotage(t.db, t.journal, { now: t.now, documents });
    return { ...t, alertes };
  }

  it('[R18] budget de l’IA à 70 % : une alerte par mois ; baisse d’un indicateur : une par semaine ; document : une par échéance', async () => {
    const t = await world();
    expect(await t.alertes.setSettings(t.direction, { aiMonthlyBudgetCents: 1000 })).toEqual({ ok: true, version: 1 });
    // Mercredi 16 juin 2027, 6 h à Paris.
    t.setClock(new Date('2027-06-16T04:00:00.000Z'));
    const ai = async (cents: number, at: string) => t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', direction: 'out', authorKind: 'ai', body: 'Bonjour', costCents: cents, occurredAt: new Date(at) });
    await ai(500, '2027-05-31T10:00:00.000Z'); // mai : ne compte pas en juin
    await ai(699, '2027-06-02T10:00:00.000Z');
    // Un contact par jour sur les 28 jours d'avant la semaine écoulée, aucun depuis : les contacts baissent.
    for (let i = 8; i <= 35; i += 1) {
      const at = new Date(Date.parse('2027-06-16T10:00:00.000Z') - i * 86_400_000).toISOString();
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Client${i}` });
      await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, 'zone', 24, NULL, ?)", [`att-${i}`, t.network.id, p.id, t.alexId, at]);
    }
    expect(await t.alertes.run(t.network.id)).toBe(2); // la baisse des contacts, le document à 15 jours
    await ai(1, '2027-06-03T10:00:00.000Z'); // 700 sur 1 000 : 70 %
    expect(await t.alertes.run(t.network.id)).toBe(1);
    expect(await t.alertes.run(t.network.id)).toBe(0);
    const list = await t.alertes.list(t.direction);
    expect(list.ok && list.value.map((a) => a.key).sort()).toEqual(['baisse:contacts:2027-06-14', 'budget_ia:2027-06', `document:${t.alexId}:assurance_rcp:2027-07-01`]);
    // La semaine suivante, la baisse qui dure est redite une fois ; le budget, le mois suivant seulement.
    t.setClock(new Date('2027-06-21T04:00:00.000Z'));
    expect(await t.alertes.run(t.network.id)).toBe(1);
    // Au journal : la sorte et la clé, jamais un montant [R13].
    // Seules les données de la ligne comptent : une empreinte ou un identifiant tiré au hasard peut contenir « 700 ».
    expect(JSON.stringify((await t.journal.all()).filter((e) => e.type === 'pilotage.alerte').map((e) => e.data)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')).not.toMatch(/699|700/);
  });

  it('[R16, R25] la direction seule règle et lit ; réglages faux refusés ; sans budget, pas d’alerte de budget', async () => {
    const t = await world();
    expect(await t.alertes.setSettings(t.agent, { aiAlertBp: 9000 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.alertes.list({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(2);
    expect(await t.alertes.setSettings(t.direction, { aiAlertBp: 0 })).toMatchObject({ code: 'bad_threshold' });
    expect(await t.alertes.setSettings(t.direction, { aiMonthlyBudgetCents: -5 })).toMatchObject({ code: 'bad_budget' });
    expect(await t.alertes.setSettings(t.direction, { documentNoticeDays: 0 })).toMatchObject({ code: 'bad_notice' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', direction: 'out', authorKind: 'ai', body: 'Bonjour', costCents: 100_000, occurredAt: t.now() });
    expect(await t.alertes.run(t.network.id)).toBe(0);
  });
});
