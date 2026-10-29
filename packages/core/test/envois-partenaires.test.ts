import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  AdressesPartenaires,
  Annuaire,
  EnvoisPartenaires,
  MiseEnRelation,
  Prospection,
  SuiviPartenaires,
  followUpSubject,
  prospectSubject,
  type ConsentProofStore,
} from '../src/partenaires/index.ts';
import { ControleEnvois } from '../src/envoi/controle.ts';
import { SqlSendJournal } from '../src/envoi/journal-envois.ts';
import { DecisionEnvoi } from '../src/envoi/service.ts';
import { ProTrialMailbox } from '../src/envoi/professionnels.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent, client, bien, partenaires et adresses inventés. Le 12 juillet 2027 est un lundi ; Paris est à UTC+2.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const set = (iso: string): void => {
  clock = Date.parse(iso);
};
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  set('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 7 });
  const suivi = new SuiviPartenaires(db, relations, journal, { now, newId: uuid });
  const adresses = new AdressesPartenaires(db, journal, { now, newId: uuid });
  const prospection = new Prospection(db, journal, { now, newId: uuid, optOutBase: 'https://aimmo.example/partenaires/opposition/' });
  const envois = new EnvoisPartenaires(db, relations, suivi, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Clémence', lastName: 'Imaginaire' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-7', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * 86_400_000).toISOString().slice(0, 10);
  /** Une demande de diagnostic confiée à un nouveau partenaire, à l'instant donné ; avec son adresse, si demandé. */
  const request = async (at: string, withAddress = true): Promise<{ partnerId: string; referralId: string }> => {
    set(at);
    const p = await annuaire.addPartner(dir, { trade: 'diagnostiqueur', businessName: `Diagnostics Zéphyr ${++n}`, postcodes: ['21000'] });
    if (!p.ok) throw new Error(p.code);
    const partnerId = p.value.partnerId;
    await annuaire.addCredential(dir, partnerId, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${partnerId}`) });
    await annuaire.addCredential(dir, partnerId, { kind: 'certification_diagnostic', domain: 'amiante', number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${partnerId}`) });
    if (withAddress) {
      const a = await adresses.record(dir, partnerId, { email: `contact${n}@zephyr-diagnostics.example`, consentProof: 'Accord écrit dans la convention de partenariat.' });
      if (!a.ok) throw new Error(a.code);
    }
    const r = await relations.propose(agent, { projectId: project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: property.id });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    // Au-delà des professionnels montrés au client, le tirage en choisit d'autres : on prend le premier montré.
    const chosen = r.value.shown.find((s) => s.partnerId === partnerId)?.partnerId ?? r.value.shown[0]!.partnerId;
    const c = await relations.recordConsent(agent, id, { partnerId: chosen, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    const e = await relations.entrust(agent, id);
    if (!e.ok) throw new Error(e.code);
    return { partnerId: chosen, referralId: id };
  };
  const outbox = async (): Promise<number> => Number((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM pro_trial_outbox'))?.n ?? 0);
  const decisions = (subject: string) => db.all<{ outcome: string; rule: string | null }>('SELECT outcome, rule FROM pro_send_log WHERE network_id = ? AND subject = ? ORDER BY id', [network.id, subject]);
  return { db, journal, annuaire, relations, suivi, adresses, prospection, envois, network, dir, agent, request, outbox, decisions, now };
}

describeWithSqlite('U12 · relances aux partenaires par le contrôle central', () => {
  it('[R01] une relance due hors des heures attend le créneau permis, puis part une seule fois [R05]', async () => {
    const t = await setup();
    const { referralId } = await t.request('2027-07-12T08:00:00.000Z');
    // Deux jours ouvrés sans réponse : relance préparée mercredi 14 ? Non, férié : jeudi 15 juillet à 10 h.
    set('2027-07-15T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(1);
    // Jeudi à 21 h 30 : hors des heures d'envoi, rien ne part.
    set('2027-07-15T19:30:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 1, failed: 0 });
    // Une attente identique n'est écrite qu'une fois.
    await t.envois.run(t.network.id);
    expect(await t.decisions(followUpSubject(referralId))).toEqual([{ outcome: 'waiting', rule: 'R01' }]);
    expect(await t.outbox()).toBe(0);
    // Vendredi à 9 h : elle part, dans la boîte d'essai seulement.
    set('2027-07-16T07:00:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 1, refused: 0, waiting: 0, failed: 0 });
    expect(await t.outbox()).toBe(1);
    // Jamais deux fois.
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 0, failed: 0 });
    expect(await t.outbox()).toBe(1);
  });

  it('[R04] une opposition posée entre la préparation et l’envoi arrête la relance', async () => {
    const t = await setup();
    const { partnerId, referralId } = await t.request('2027-07-12T08:00:00.000Z');
    set('2027-07-15T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(1);
    const o = await t.adresses.oppose(t.dir, partnerId);
    expect(o).toEqual({ ok: true, value: 1 });
    expect((await t.envois.run(t.network.id)).refused).toBe(1);
    expect(await t.decisions(followUpSubject(referralId))).toEqual([{ outcome: 'refused', rule: 'R04' }]);
    expect(await t.outbox()).toBe(0);
    // Refusée pour de bon : elle n'est plus reprise.
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 0, failed: 0 });
  });

  it('[R03] sans adresse et sans accord rangés, la relance attend ; elle part dès qu’ils le sont', async () => {
    const t = await setup();
    const { partnerId } = await t.request('2027-07-12T08:00:00.000Z', false);
    set('2027-07-15T08:00:00.000Z');
    await t.suivi.run(t.network.id);
    expect((await t.envois.run(t.network.id)).waiting).toBe(1);
    expect(await t.outbox()).toBe(0);
    // Une adresse sans preuve d'accord est refusée.
    expect(await t.adresses.record(t.dir, partnerId, { email: 'contact@zephyr.example', consentProof: '' })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect((await t.adresses.record(t.dir, partnerId, { email: 'contact@zephyr.example', consentProof: 'Accord oral du 15 juillet, noté par la direction.' })).ok).toBe(true);
    expect((await t.envois.run(t.network.id)).sent).toBe(1);
    expect(await t.outbox()).toBe(1);
  });

  it('une réponse du partenaire arrivée avant l’envoi arrête la relance', async () => {
    const t = await setup();
    const { partnerId, referralId } = await t.request('2027-07-12T08:00:00.000Z');
    set('2027-07-15T08:00:00.000Z');
    await t.suivi.run(t.network.id);
    const r = await t.relations.advanceByPartner(t.network.id, referralId, partnerId, 'en_cours', `partner:${partnerId}`);
    expect(r.ok).toBe(true);
    expect((await t.envois.run(t.network.id)).refused).toBe(1);
    expect(await t.outbox()).toBe(0);
  });

  it('[R11] au plus 5 messages aux partenaires par jour ouvré ; le sixième attend le jour ouvré suivant', async () => {
    const t = await setup();
    for (let i = 0; i < 6; i++) await t.request('2027-07-12T08:00:00.000Z');
    set('2027-07-15T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(6);
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 5, refused: 0, waiting: 1, failed: 0 });
    // Samedi : pas un jour ouvré pour les partenaires.
    set('2027-07-17T08:00:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 1, failed: 0 });
    // Lundi : le sixième part.
    set('2027-07-19T08:00:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 1, refused: 0, waiting: 0, failed: 0 });
    expect(await t.outbox()).toBe(6);
  });

  it('[R13] le journal des envois aux professionnels ne garde ni adresse ni texte', async () => {
    const t = await setup();
    await t.request('2027-07-12T08:00:00.000Z');
    set('2027-07-15T08:00:00.000Z');
    await t.suivi.run(t.network.id);
    await t.envois.run(t.network.id);
    const log = JSON.stringify(await t.db.all('SELECT * FROM pro_send_log'));
    const journal = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    for (const text of [log, journal]) {
      expect(text).not.toMatch(/zephyr-diagnostics\.example/);
      expect(text).not.toMatch(/attend encore votre réponse/);
    }
    await expect(t.db.run('DELETE FROM pro_send_log')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM pro_sends')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE pro_sends SET recipient = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R16] seule la direction range l’adresse ou l’opposition d’un partenaire', async () => {
    const t = await setup();
    const { partnerId } = await t.request('2027-07-12T08:00:00.000Z');
    expect(await t.adresses.record(t.agent, partnerId, { email: 'x@y.example', consentProof: 'Accord écrit.' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.adresses.oppose(t.agent, partnerId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.adresses.record(t.dir, partnerId, { email: 'pas une adresse', consentProof: 'Accord écrit.' })).toEqual({ ok: false, rule: null, code: 'bad_email' });
  });
});

describeWithSqlite('U12 · prospection par le contrôle central', () => {
  const addProspects = async (t: Awaited<ReturnType<typeof setup>>, count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await t.prospection.add(t.dir, { email: `cabinet${i}@notaires-imaginaires.example`, addressKind: 'professionnelle', trade: 'notaire', businessName: `Étude Imaginaire ${i}`, source: 'Annuaire public inventé' });
      if (!r.ok) throw new Error(r.code);
      ids.push(r.value.prospectId);
    }
    return ids;
  };

  it('[R03] un brouillon de prospection refusé sous R03 reste refusé tant que H32 n’a pas écrit son exception', async () => {
    const t = await setup();
    const [id] = await addProspects(t, 2);
    set('2027-07-12T08:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(2);
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 2, waiting: 0, failed: 0 });
    expect(await t.decisions(prospectSubject(id!))).toEqual([{ outcome: 'refused', rule: 'R03' }]);
    // Le lendemain : toujours rien, et le refus n'est pas redécidé en boucle.
    set('2027-07-13T08:00:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 0, failed: 0 });
    expect(await t.outbox()).toBe(0);
  });

  it('[R01] hors des heures, un brouillon attend ; [R04] une opposition posée entre-temps l’arrête avant R03', async () => {
    const t = await setup();
    const [a, b] = await addProspects(t, 2);
    set('2027-07-12T08:00:00.000Z');
    await t.prospection.run(t.network.id);
    set('2027-07-12T19:00:00.000Z');
    expect(await t.envois.run(t.network.id)).toEqual({ sent: 0, refused: 0, waiting: 2, failed: 0 });
    expect(await t.prospection.oppose(t.dir, a)).toEqual({ ok: true, value: true });
    set('2027-07-13T07:00:00.000Z');
    await t.envois.run(t.network.id);
    expect(await t.decisions(prospectSubject(a!))).toEqual([
      { outcome: 'waiting', rule: 'R01' },
      { outcome: 'refused', rule: 'R04' },
    ]);
    expect((await t.decisions(prospectSubject(b!))).at(-1)).toEqual({ outcome: 'refused', rule: 'R03' });
    expect(await t.outbox()).toBe(0);
  });
});

describeWithSqlite('U12 · rien ne part réellement', () => {
  async function controle(t: Awaited<ReturnType<typeof setup>>, proMailbox?: unknown) {
    const fiches = new FicheClient(t.db, { now: t.now });
    const unique = new FicheUnique(t.db, fiches, { now: t.now });
    return new ControleEnvois(t.db, unique, new DecisionEnvoi(t.db, fiches, unique, { now: t.now }), {
      channels: [],
      journal: new SqlSendJournal(t.db, undefined, t.now),
      now: t.now,
      ...(proMailbox === undefined ? {} : { proMailbox: proMailbox as ProTrialMailbox }),
    });
  }

  it('sans la boîte d’essai, ou avec un autre port, le contrôle refuse tout envoi à un professionnel', async () => {
    const t = await setup();
    const { partnerId } = await t.request('2027-07-12T08:00:00.000Z');
    const sent: unknown[] = [];
    const realLooking = { channel: 'email', deliver: async (m: unknown) => (sent.push(m), { externalId: 'x' }) };
    for (const c of [await controle(t), await controle(t, realLooking)]) {
      const r = await c.sendToProfessional({ networkId: t.network.id, kind: 'partner', recipient: { partnerId }, subject: `essai:${++n}`, text: 'Bonjour, une demande vous attend dans votre espace partenaire. Merci !' });
      expect(r.status).toBe('refused');
      expect(r.reason).toMatch(/Aucun envoi réel/);
    }
    expect(sent).toEqual([]);
  });

  it('[R06] un texte qui parle de l’IA ne part pas à un partenaire', async () => {
    const t = await setup();
    const { partnerId } = await t.request('2027-07-12T08:00:00.000Z');
    const c = await controle(t, new ProTrialMailbox(t.db, t.journal, t.now));
    const r = await c.sendToProfessional({ networkId: t.network.id, kind: 'partner', recipient: { partnerId }, subject: `essai:${++n}`, text: 'Bonjour, notre intelligence artificielle a préparé votre demande. Merci !' });
    expect(r).toMatchObject({ status: 'refused', rule: 'R06' });
    expect(await t.outbox()).toBe(0);
  });
});

describe('U12 · le seul chemin de sortie', () => {
  it('la boîte d’essai des professionnels n’est appelée que par le contrôle central', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/partenaires/envois.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.deliver\s*\(/);
    expect(src).toMatch(/sendToProfessional/);
  });
});
