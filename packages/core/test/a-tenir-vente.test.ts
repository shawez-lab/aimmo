import { expect, it } from 'vitest';
import { ATenirVente, BouclierFonds, Echeancier, FinancementDossier, SALE_FOLLOW_UP_PURPOSE } from '../src/dossiers/index.ts';
import { EcheancesOffres } from '../src/offres/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé. Mars 2027, avant l'heure d'été : Paris est à UTC+1.
const paris = (day: string, hour: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + (hour - 1) * 3_600_000);
const IBAN = 'FR76 3000 1007 9412 3456 7890 185';

describeWithSqlite('W26 · ce que l’agent doit tenir sur ses ventes', () => {
  async function setup() {
    const t = await setupDossier();
    for (const [personId, email] of [[t.personId, 'vendeuse@example.test'], [t.buyerId, 'acheteur@example.test']] as const) {
      await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value: email });
      await t.store.addConsent({ networkId: t.network.id, personId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    }
    const watch = new ATenirVente(t.db, t.acces, t.journal, { now: t.now });
    const bouclier = new BouclierFonds(t.db, t.acces, t.journal, { now: t.now });
    const receive = async (personId: string, body: string) => {
      const m = await t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId, channel: 'email', direction: 'in', authorKind: 'person', body, occurredAt: t.now() });
      await bouclier.scan(m.id);
      return m;
    };
    const read = async () => {
      const r = await watch.of(t.agent);
      if (!r.ok) throw new Error(r.code);
      return r.value;
    };
    const reference = (await t.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ?', [t.propertyId]))!.reference;
    return { ...t, watch, receive, read, reference };
  }

  it('[R16] rien à tenir : trois listes vides ; la direction n’y entre pas, un agent parti non plus', async () => {
    const t = await setup();
    expect(await t.read()).toEqual({ fonds: [], financement: [], echeances: [] });
    expect(await t.watch.of(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.watch.of(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R61] les échéances du dossier sont dites avec la référence du bien, le jour le plus proche d’abord, celles sans jour ensuite', async () => {
    const t = await setup();
    await t.startCompromis();
    t.setClock(paris('2027-03-10', 9));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now, noticeDays: { fin_retractation: 60, reponse_preemption: 60, date_limite_pret: 60, etat_date: 60, acte: 60 } });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.run(t.network.id);
    const first = await t.read();
    expect(first.echeances.length).toBeGreaterThan(0);
    expect(first.echeances[0]).toMatchObject({ source: 'dossier', fileId: t.fileId, reference: t.reference, kind: 'a_saisir', day: null });
    t.setClock(paris('2027-03-11', 9));
    await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'date_limite_pret', day: '2027-04-30', proofRef: PROOF });
    await e.run(t.network.id);
    const days = (await t.read()).echeances.map((l) => l.day);
    const dated = days.filter((d) => d !== null);
    expect(dated.length).toBeGreaterThan(0);
    expect(dated).toEqual([...dated].sort());
    expect(days.slice(0, dated.length)).toEqual(dated);
  });

  it('[R59] une offre sans réponse est dite jusqu’à son dernier jour, puis sort ; un bien passé à un autre agent sort aussi [R16]', async () => {
    const t = await setupOffre();
    const offer = await t.record({ validUntil: '2027-03-10' });
    const watch = new ATenirVente(t.db, t.acces, t.journal, { now: t.now });
    const lines = async () => {
      const r = await watch.of(t.agent);
      if (!r.ok) throw new Error(r.code);
      return r.value.echeances;
    };
    t.setClock(paris('2027-03-09', 9));
    expect(await new EcheancesOffres(t.db, t.journal, { now: t.now }).run(t.network.id)).toEqual([offer.id]);
    const reference = (await t.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ?', [t.propertyId]))!.reference;
    expect(await lines()).toEqual([{ source: 'offre', propertyId: t.propertyId, reference, proposal: false, day: '2027-03-10' }]);
    t.setClock(paris('2027-03-10', 23));
    expect(await lines()).toHaveLength(1);
    t.setClock(paris('2027-03-11', 9));
    expect(await lines()).toEqual([]);
    t.setClock(paris('2027-03-09', 9));
    expect(await lines()).toHaveLength(1);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    expect(await lines()).toEqual([]);
    // Le nouvel agent du bien la voit : l'échéance n'est perdue pour personne.
    expect(await watch.of(t.sam)).toMatchObject({ ok: true, value: { echeances: [{ source: 'offre', propertyId: t.propertyId, day: '2027-03-10' }] } });
  });

  it('[R61] les alertes de financement portent la référence du bien', async () => {
    const t = await setup();
    await t.startCompromis();
    t.setClock(paris('2027-03-10', 9));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    t.setClock(paris('2027-03-19', 9));
    const fin = new FinancementDossier(t.db, t.acces, t.journal, { now: t.now });
    expect(await fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-03-19', declaredBy: 'acquereur' })).toMatchObject({ ok: true });
    await fin.run(t.network.id);
    expect((await t.read()).financement).toEqual([{ fileId: t.fileId, propertyId: t.propertyId, reference: t.reference, kind: 'refus_declare', day: '2027-03-19' }]);
  });

  it('[R62] [R15] les messages sur l’argent d’un côté font une ligne, sans texte ni IBAN ; le rappel déjà passé compte, même refusé ensuite par R05', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    await t.receive(t.buyerId, `Voici le nouveau RIB : ${IBAN}`);
    t.setClock(paris('2027-03-08', 11));
    await t.receive(t.buyerId, 'Je fais le virement demain');
    const { fonds } = await t.read();
    expect(fonds).toEqual([
      { fileId: t.fileId, propertyId: t.propertyId, reference: t.reference, side: 'acquereur', signals: ['iban', 'coordonnees_bancaires', 'virement'], messages: 2, lastAt: paris('2027-03-08', 11).toISOString(), reminder: 'fait' },
    ]);
    expect(JSON.stringify(fonds)).not.toContain('FR76');
    t.setClock(paris('2027-03-08', 12));
    await t.receive(t.personId, 'Le notaire demande un acompte');
    const again = await t.read();
    expect(again.fonds.map((l) => l.side)).toEqual(['vendeur', 'acquereur']);
  });

  it('[R62] un rappel qui attend l’heure est dit en attente, un rappel refusé dit de prévenir le client', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 22));
    await t.receive(t.personId, 'Le notaire demande un virement');
    expect((await t.read()).fonds[0]!.reminder).toBe('attente');
    t.setClock(paris('2027-03-09', 10));
    await t.store.addExclusion({ networkId: t.network.id, personId: t.buyerId, reason: 'network_list', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    await t.receive(t.buyerId, 'Je vire l’acompte ce soir');
    expect((await t.read()).fonds.find((l) => l.side === 'acquereur')!.reminder).toBe('a_prevenir');
  });

  it('[R62] une alerte sur l’argent reste tant que le dossier est en cours, et sort à sa fin ou si le bien change de main [R16]', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    await t.receive(t.buyerId, 'Je fais le virement demain');
    t.setClock(paris('2027-06-01', 10));
    expect((await t.read()).fonds).toHaveLength(1);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    expect((await t.read()).fonds).toEqual([]);
    await t.db.run('UPDATE properties SET agent_id = ?, status = ? WHERE id = ?', [t.agent.userId, 'sold', t.propertyId]);
    expect((await t.read()).fonds).toEqual([]);
  });
});
