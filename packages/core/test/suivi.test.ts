import { expect, it } from 'vitest';
import {
  AvisDeValeur,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  Fourchette,
  Planificateur,
  SqlJournalStore,
  SuiviVendeur,
  VALUATION_PURPOSE,
  applyMigrations,
  checkText,
  followUpText,
  fromSyncSqlite,
  vendorFollowUpJob,
  type RangeResult,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import { mergeWithDouble } from './doublon.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Tout est inventé.
const FRI_1000 = new Date('2026-11-06T09:00:00.000Z');
const TUE_1000 = new Date('2026-11-10T09:00:00.000Z');
const SAT_1000 = new Date('2026-11-07T09:00:00.000Z');
const TUE_2130 = new Date('2026-11-10T20:30:00.000Z');
const WED_1000 = new Date('2026-11-11T09:00:00.000Z');
const THU_1000 = new Date('2026-11-12T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t:${i}`,
  kind: 'apartment' as const,
  lat: 47.3225 + i * 0.0002,
  lon: 5.0412,
  surface: 60 + i,
  pricePerM2: 2500 + i * 20,
  month: `2025-0${(i % 9) + 1}`,
}));

async function world() {
  let clock = FRI_1000;
  const now = () => clock;
  const setClock = (d: Date) => {
    clock = d;
  };
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const seller = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: seller.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: seller.id, purpose: VALUATION_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const avis = new AvisDeValeur(db, journal, { now });
  const suivi = new SuiviVendeur(db, journal, { now });
  const fiche = new FicheUnique(db, store);
  const decisions = new DecisionEnvoi(db, store, fiche);
  const paulViewer: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const range = (await new Fourchette(
    { coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }), within: async () => SALES },
    undefined,
    now,
  ).estimate({ kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000' })) as Extract<RangeResult, { ok: true }>;
  const report = async (validate = true) => {
    const r = await avis.draft({ networkId: net.id, propertyId: property.id, kind: 'apartment', surface: 65, range });
    if (validate) await avis.validate(paulViewer, r.id);
    return r;
  };
  const sendNoted = async () => {
    const r = await report();
    expect(await suivi.noteSent({ reportId: r.id, personId: seller.id, channel: 'email', by: `agent:${paul.id}` })).toEqual({ ok: true, already: false });
    return r;
  };
  const outbox = () => db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox');
  return { db, store, net, paul, property, seller, journal, avis, suivi, decisions, report, sendNoted, outbox, setClock, now };
}

describeWithSqlite('E06 · suivi du vendeur', () => {
  it('[R30] seul un avis validé peut être noté envoyé, une seule fois', async () => {
    const w = await world();
    const draft = await w.report(false);
    expect(await w.suivi.noteSent({ reportId: draft.id, personId: w.seller.id, channel: 'email', by: 'agent:x' })).toMatchObject({ ok: false, rule: 'R30', code: 'not_validated' });
    const r = await w.sendNoted();
    expect(await w.suivi.noteSent({ reportId: r.id, personId: w.seller.id, channel: 'email', by: 'agent:x' })).toEqual({ ok: true, already: true });
    w.setClock(TUE_1000);
    expect((await w.suivi.run()).map((o) => o.reportId)).toEqual([r.id]);
  });

  it('pas de relance avant le délai ; ensuite une seule, rangée en essai et jamais envoyée [R05] [R26]', async () => {
    const w = await world();
    const r = await w.sendNoted();
    w.setClock(SAT_1000);
    expect(await w.suivi.run()).toEqual([]);
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'sent', rule: null, delivered: false }]);
    expect(await w.outbox()).toHaveLength(1);
    w.setClock(WED_1000);
    expect(await w.suivi.run()).toEqual([]);
    w.setClock(THU_1000);
    expect(await w.suivi.run()).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
    const out = await w.db.all<{ body: string; direction: string }>("SELECT body, direction FROM messages WHERE direction = 'out'");
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain('Bonjour Léa');
  });

  it('[R01] hors des heures d’envoi, la relance attend le créneau suivant, sans partir deux fois', async () => {
    const w = await world();
    const r = await w.sendNoted();
    w.setClock(TUE_2130);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'waiting', rule: 'R01', delivered: false }]);
    expect(await w.outbox()).toHaveLength(0);
    w.setClock(WED_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'sent', rule: null, delivered: false }]);
    w.setClock(THU_1000);
    expect(await w.suivi.run()).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R02] jamais à une personne exclue', async () => {
    const w = await world();
    const r = await w.sendNoted();
    await w.decisions.recordExclusion({ networkId: w.net.id, personId: w.seller.id, at: FRI_1000, reason: 'refused' });
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'refused', rule: 'R02', delivered: false }]);
    w.setClock(WED_1000);
    expect(await w.suivi.run()).toEqual([]);
    expect(await w.outbox()).toHaveLength(0);
  });

  it('[R04] jamais à une personne qui a demandé l’arrêt, sur n’importe quel canal', async () => {
    const w = await world();
    const r = await w.sendNoted();
    // La demande d'arrêt arrive avant l'avis, sur un autre canal.
    await w.decisions.recordStopRequest({ networkId: w.net.id, personId: w.seller.id, at: new Date(FRI_1000.getTime() - 60_000) });
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'refused', rule: 'R04', delivered: false }]);
    expect(await w.outbox()).toHaveLength(0);
  });

  it('le vendeur a répondu depuis l’envoi : pas de relance, jamais', async () => {
    const w = await world();
    const r = await w.sendNoted();
    await w.store.recordMessage({ networkId: w.net.id, personId: w.seller.id, channel: 'email', conversationId: 'm1', direction: 'in', authorKind: 'person', body: 'Merci, je réfléchis.', occurredAt: new Date(FRI_1000.getTime() + 3_600_000) });
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'answered', rule: null, delivered: false }]);
    expect(await w.outbox()).toHaveLength(0);
  });

  it('[R03] sans accord pour le suivi de l’estimation, rien ne part', async () => {
    const w = await world();
    const other = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Marc' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: other.id, kind: 'email', value: 'marc.exemple@example.test' });
    const r = await w.report();
    await w.suivi.noteSent({ reportId: r.id, personId: other.id, channel: 'email', by: 'agent:x' });
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'refused', rule: 'R03', delivered: false }]);
    expect(await w.outbox()).toHaveLength(0);
  });

  it('[R13] le journal ne porte ni texte ni coordonnée', async () => {
    const w = await world();
    await w.sendNoted();
    w.setClock(TUE_1000);
    await w.suivi.run();
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    for (const secret of ['Léa', 'Exemple', 'lea.exemple', 'avez-vous']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('avis.relance.essai');
  });

  it('le texte de relance passe le contrôle du texte, sans chiffre [R06] [R08] [R10]', () => {
    for (const name of ['Léa', null]) {
      expect(checkText(followUpText(name), { audience: 'client', channel: 'email', figures: [], firstOfConversation: name !== null, firstName: name })).toEqual([]);
    }
  });

  it('une panne après la réservation ne perd pas la relance, qui repart au créneau suivant une seule fois', async () => {
    const w = await world();
    const r = await w.sendNoted();
    let broken = true;
    const flaky = {
      ...w.db,
      exec: w.db.exec.bind(w.db),
      run: w.db.run.bind(w.db),
      first: <T>(sql: string, params?: readonly (string | number | null)[]) => {
        if (broken && sql.includes('author_kind')) {
          broken = false;
          return Promise.reject(new Error('panne passagère'));
        }
        return w.db.first<T>(sql, params as never);
      },
      all: w.db.all.bind(w.db),
    };
    w.setClock(TUE_1000);
    await expect(new SuiviVendeur(flaky, w.journal, { now: w.now }).run()).rejects.toThrow('panne passagère');
    expect(await w.outbox()).toHaveLength(0);
    w.setClock(WED_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'sent', rule: null, delivered: false }]);
    w.setClock(THU_1000);
    expect(await w.suivi.run()).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('la tâche du planificateur passe une fois par créneau, du lundi au samedi', async () => {
    const w = await world();
    await w.sendNoted();
    w.setClock(TUE_1000);
    const planificateur = new Planificateur(w.db, w.journal, [vendorFollowUpJob(w.db, w.journal, { now: w.now })], { now: w.now });
    expect((await planificateur.tick()).ran).toEqual(['estimation.relance_vendeur']);
    expect((await planificateur.tick()).skipped).toEqual(['estimation.relance_vendeur']);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R08] AC10 : sur une fiche réunie, la relance salue par le prénom de la fiche gardée', async () => {
    const w = await world();
    const r = await w.sendNoted();
    const expected = await mergeWithDouble(w.db, w.store, w.seller.id, 'Inna');
    w.setClock(TUE_1000);
    expect(await w.suivi.run()).toEqual([{ reportId: r.id, status: 'sent', rule: null, delivered: false }]);
    const out = await w.db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'out'");
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain(`Bonjour ${expected}`);
  });
});
