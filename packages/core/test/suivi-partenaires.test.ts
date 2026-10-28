import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  Annuaire,
  EspacePartenaire,
  MiseEnRelation,
  PiecesPartenaires,
  SuiviPartenaires,
  addWorkingDays,
  checkSummary,
  fallbackSummary,
  followUpText,
  nextSendingSlot,
  type ConsentProofStore,
  type FollowUpSummaryWriter,
  type SummaryFacts,
} from '../src/partenaires/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { localTime } from '../src/envoi/horaires.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, client, bien et partenaires inventés. Le 12 juillet 2027 est un lundi ; Paris est à UTC+2.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const set = (iso: string): void => {
  clock = Date.parse(iso);
};
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'b'.repeat(64);
const paris = (iso: string) => localTime(new Date(iso), 'Europe/Paris');

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

async function setup(writer?: FollowUpSummaryWriter) {
  set('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 7 });
  const space = new EspacePartenaire(db, annuaire, relations, journal, { now });
  const pieces = new PiecesPartenaires(db, space, relations, annuaire, files, journal, { now, newId: uuid });
  const suivi = new SuiviPartenaires(db, relations, journal, { now, newId: uuid, writer });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Clémence', lastName: 'Imaginaire' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-7', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * 86_400_000).toISOString().slice(0, 10);
  const partner = async (trade: string, name: string, domain?: string): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: name, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    await annuaire.addCredential(dir, id, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    if (domain) await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain, number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    return id;
  };
  /** Une demande de diagnostic confiée, avec l'accord du client, à l'instant donné. */
  const request = async (at = '2027-07-12T08:00:00.000Z'): Promise<{ partnerId: string; referralId: string }> => {
    set(at);
    const partnerId = await partner('diagnostiqueur', `Diagnostics Zéphyr ${++n}`, 'amiante');
    const r = await relations.propose(agent, { projectId: project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: property.id });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    const c = await relations.recordConsent(agent, id, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    const e = await relations.entrust(agent, id);
    if (!e.ok) throw new Error(e.code);
    return { partnerId, referralId: id };
  };
  const asPartner = (partnerId: string) => ({ role: 'partner' as const, userId: partnerId, networkId: network.id });
  return { db, journal, annuaire, relations, space, pieces, suivi, network, agent, other, dir, property, project, request, asPartner, files, person };
}

describe('U07 · calendrier des relances', () => {
  it('[R01] 2 jours ouvrés : le week-end et le 14 juillet ne comptent pas', () => {
    // Confiée un vendredi : lundi 12 et mardi 13.
    expect(addWorkingDays(new Date('2027-07-09T08:00:00.000Z'), 2).toISOString()).toBe('2027-07-13T08:00:00.000Z');
    // Confiée un mardi : le mercredi 14 juillet est férié, donc jeudi 15 et vendredi 16.
    expect(addWorkingDays(new Date('2027-07-13T08:00:00.000Z'), 2).toISOString()).toBe('2027-07-16T08:00:00.000Z');
    // Confiée un samedi : lundi et mardi.
    expect(addWorkingDays(new Date('2027-07-10T08:00:00.000Z'), 2).toISOString()).toBe('2027-07-13T08:00:00.000Z');
  });

  it('[R01] aux changements d’heure, près de minuit, le jour compté reste celui de Paris', () => {
    // Vendredi 26 mars 2027 à 23 h 30 (heure d'hiver) ; passage à l'heure d'été le 28, lundi de Pâques le 29 :
    // mardi 30 et mercredi 31, à 23 h 30 (heure d'été).
    expect(addWorkingDays(new Date('2027-03-26T22:30:00.000Z'), 2).toISOString()).toBe('2027-03-31T21:30:00.000Z');
    // Vendredi 29 octobre 2027 à 0 h 30 (heure d'été) ; retour à l'heure d'hiver le 31, lundi 1er novembre férié :
    // mardi 2 et mercredi 3, à 0 h 30 (heure d'hiver).
    expect(addWorkingDays(new Date('2027-10-28T22:30:00.000Z'), 2).toISOString()).toBe('2027-11-02T23:30:00.000Z');
    // Vendredi 23 octobre 2026 à 23 h 30 (heure d'été) ; retour à l'heure d'hiver le 25 : mardi 27 à 23 h 30.
    expect(addWorkingDays(new Date('2026-10-23T21:30:00.000Z'), 2).toISOString()).toBe('2026-10-27T22:30:00.000Z');
  });

  it('[R01] une relance préparée hors des heures d’envoi est due au premier instant permis', () => {
    // Dans les heures : tout de suite.
    expect(nextSendingSlot(new Date('2027-07-14T10:00:00.000Z')).toISOString()).toBe('2027-07-14T10:00:00.000Z');
    // Un mercredi à 21 h 30 à Paris : le jeudi à 8 h.
    expect(nextSendingSlot(new Date('2027-07-14T19:30:00.000Z')).toISOString()).toBe('2027-07-15T06:00:00.000Z');
    // Un samedi à 20 h à Paris : le lundi à 8 h, jamais le dimanche.
    expect(nextSendingSlot(new Date('2027-07-17T18:00:00.000Z')).toISOString()).toBe('2027-07-19T06:00:00.000Z');
    // Un dimanche à 10 h : le lundi à 8 h.
    expect(nextSendingSlot(new Date('2027-07-18T08:00:00.000Z')).toISOString()).toBe('2027-07-19T06:00:00.000Z');
    // À 7 h 59 et 30 secondes : 8 h pile.
    expect(nextSendingSlot(new Date('2027-07-15T05:59:30.000Z')).toISOString()).toBe('2027-07-15T06:00:00.000Z');
    // En hiver, Paris est à UTC+1.
    expect(nextSendingSlot(new Date('2027-12-01T05:00:00.000Z')).toISOString()).toBe('2027-12-01T07:00:00.000Z');
  });

  it('[R06] le texte de relance ne parle pas de l’IA et passe le contrôle des textes', () => {
    const text = followUpText(new Date('2027-07-12T08:00:00.000Z'));
    expect(text).toContain('12 juillet');
    expect(checkText(text, { audience: 'client', channel: 'email', figures: [12] }).filter((p) => p.rule !== 'R08')).toEqual([]);
    expect(text).not.toMatch(/\bIA\b|intelligence artificielle|automatique/i);
  });
});

describeWithSqlite('U07 · suivi des demandes confiées', () => {
  it('le délai de réponse est mesuré de la remise au partenaire à sa première réponse', async () => {
    const t = await setup();
    const req = await t.request();
    const entrusted = (await t.suivi.measure(req.referralId)).entrustedAt!;
    expect(await t.suivi.measure(req.referralId)).toMatchObject({ state: 'confiee', answered: false, firstResponseAt: null });
    set(new Date(Date.parse(entrusted) + 3 * 3_600_000).toISOString());
    expect((await t.space.progress(t.asPartner(req.partnerId), req.referralId, 'en_cours')).ok).toBe(true);
    const m = await t.suivi.measure(req.referralId);
    expect(m).toMatchObject({ state: 'en_cours', answered: true });
    expect(m.delayMinutes).toBe(180);
  });

  it('une pièce déposée compte comme une réponse du partenaire', async () => {
    const t = await setup();
    const req = await t.request();
    set('2027-07-12T12:00:00.000Z');
    const r = await t.pieces.deposit(t.asPartner(req.partnerId), req.referralId, { sort: 'amiante', ref: t.files.put(`partenaires/${req.partnerId}/relations/${req.referralId}`), sha256: SHA, issuedOn: '2027-07-12' });
    expect(r.ok).toBe(true);
    expect(await t.suivi.measure(req.referralId)).toMatchObject({ answered: true, state: 'confiee' });
    const summary = await t.suivi.summary(t.agent, req.referralId);
    expect(summary).toMatchObject({ ok: true, value: { source: 'secours', summary: { headline: 'Demande confiée, le partenaire a répondu.' } } });
    set('2027-07-20T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
  });

  it('[R01] [R05] [R79] sans réponse 2 jours ouvrés : une seule relance, due dans les heures d’envoi, rien ne part', async () => {
    const t = await setup();
    const req = await t.request('2027-07-12T08:00:00.000Z');
    set('2027-07-13T07:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    set('2027-07-13T09:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    // Mercredi 14 juillet : férié, ne compte pas.
    set('2027-07-14T09:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    // Jeudi 15 à 23 h à Paris : la relance est préparée, due le vendredi à 8 h.
    set('2027-07-15T21:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(1);
    expect(await t.suivi.run(t.network.id)).toBe(0);
    set('2027-07-15T21:30:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    const f = await t.suivi.followUps(t.agent, req.referralId);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.value.followUps).toHaveLength(1);
    const relance = f.value.followUps[0]!;
    expect(relance).toMatchObject({ kind: 'relance', recipient: `partner:${req.partnerId}`, dueAt: '2027-07-16T06:00:00.000Z' });
    const due = paris(relance.dueAt);
    expect(due.weekday).toBeLessThanOrEqual(6);
    expect(due.minutes).toBeGreaterThanOrEqual(8 * 60);
    expect(due.minutes).toBeLessThan(20 * 60);
    // Rien ne part : ni boîte d'essai, ni journal des envois, ni message.
    for (const table of ['trial_outbox', 'send_log', 'messages']) expect(await t.db.all(`SELECT 1 FROM ${table}`), table).toHaveLength(0);
    // La base refuse une deuxième relance pour la même demande [R05].
    await expect(
      t.db.run("INSERT INTO partner_followups (id, network_id, referral_id, kind, recipient, text, due_at, prepared_at) VALUES ('x', ?, ?, 'relance', 'p', 'Bonjour, un autre texte de relance.', 'd', 'p')", [t.network.id, req.referralId]),
    ).rejects.toThrow();
    // Rien ne change ni ne s'efface.
    await expect(t.db.run('DELETE FROM partner_followups')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE partner_followups SET text = 'Bonjour, un texte changé après coup.'")).rejects.toThrow(/ne change plus/);
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'partenaire.relance_preparee'");
    expect(events).toHaveLength(1);
  });

  it('[R19] la relance ne nomme ni le client, ni le bien, ni son adresse', async () => {
    const t = await setup();
    const req = await t.request();
    set('2027-07-16T08:00:00.000Z');
    await t.suivi.run(t.network.id);
    const [row] = await t.db.all<{ text: string }>('SELECT text FROM partner_followups WHERE referral_id = ?', [req.referralId]);
    expect(row!.text).toContain('12 juillet');
    for (const word of ['Clémence', 'Imaginaire', 'T-7', '21000']) expect(row!.text).not.toContain(word);
  });

  it('[R05] toujours sans réponse 2 jours ouvrés après la relance : une seule alerte à l’agent du projet', async () => {
    const t = await setup();
    const req = await t.request();
    set('2027-07-16T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(1);
    // Relance due le vendredi 16 à 10 h : lundi 19, mardi 20 à 10 h.
    set('2027-07-20T07:59:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    set('2027-07-20T08:01:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(1);
    set('2027-07-27T08:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    const f = await t.suivi.followUps(t.dir, req.referralId);
    if (!f.ok) throw new Error(f.code);
    expect(f.value.followUps.map((x) => x.kind)).toEqual(['relance', 'alerte_agent']);
    expect(f.value.followUps[1]).toMatchObject({ recipient: `agent:${t.agent.userId}` });
    expect(f.value.followUps[1]!.text).toContain('12 juillet');
    const alerts = await t.db.all<{ actor: string; subject: string; data: string }>("SELECT actor, subject, data FROM journal WHERE type = 'partenaire.alerte_agent'");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toBe(`referral:${req.referralId}`);
    for (const word of ['Clémence', 'Imaginaire', 'Zéphyr', '21000', 'juillet']) expect(JSON.stringify(alerts)).not.toContain(word);
  });

  it('une réponse du partenaire arrête relance et alerte ; une demande close aussi', async () => {
    const t = await setup();
    const answered = await t.request();
    const closed = await t.request();
    set('2027-07-13T09:00:00.000Z');
    await t.space.progress(t.asPartner(answered.partnerId), answered.referralId, 'en_cours');
    await t.relations.close(t.agent, closed.referralId, 'abandonnee');
    set('2027-07-30T09:00:00.000Z');
    expect(await t.suivi.run(t.network.id)).toBe(0);
    expect(await t.db.all('SELECT 1 FROM partner_followups')).toHaveLength(0);
  });

  it('une étape rangée par l’agent n’est pas une réponse du partenaire', async () => {
    const t = await setup();
    const req = await t.request();
    set('2027-07-12T09:00:00.000Z');
    // L'agent ferme la demande lui-même : terminée, mais pas par le partenaire.
    await t.relations.close(t.agent, req.referralId, 'terminee');
    expect(await t.suivi.measure(req.referralId)).toMatchObject({ answered: false, state: 'terminee' });
  });

  it('[R16] le suivi, le résumé et les avis sont refusés à un autre agent et à un partenaire', async () => {
    const t = await setup();
    const req = await t.request();
    for (const viewer of [t.other, t.asPartner(req.partnerId)]) {
      expect(await t.suivi.followUps(viewer, req.referralId)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.suivi.summary(viewer, req.referralId)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.suivi.readReviews(viewer, req.referralId)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.suivi.recordReview(viewer, req.referralId, { text: 'Très bien.', channel: 'oral' })).toMatchObject({ ok: false, rule: 'R16' });
    }
  });
});

describeWithSqlite('U07 · résumé des réponses', () => {
  const answeredWith = async (writer?: FollowUpSummaryWriter) => {
    const t = await setup(writer);
    const req = await t.request();
    set('2027-07-13T10:00:00.000Z');
    await t.space.progress(t.asPartner(req.partnerId), req.referralId, 'en_cours');
    await t.pieces.deposit(t.asPartner(req.partnerId), req.referralId, { sort: 'amiante', ref: t.files.put(`partenaires/${req.partnerId}/relations/${req.referralId}`), sha256: SHA, issuedOn: '2027-07-13' });
    return { t, req };
  };

  it('[R15] [R23] l’IA ne reçoit aucune donnée de personne, ni nom, ni adresse, ni partenaire', async () => {
    const seen: SummaryFacts[] = [];
    const { t, req } = await answeredWith({ write: async (f) => (seen.push(f), { headline: 'Demande en cours, diagnostic amiante déposé.', points: ['Réponse du partenaire le 13/07.'] }) });
    const r = await t.suivi.summary(t.agent, req.referralId);
    expect(r).toMatchObject({ ok: true, value: { source: 'ia', summary: { headline: 'Demande en cours, diagnostic amiante déposé.' } } });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(['delayHours', 'documents', 'domain', 'entrustedOn', 'firstResponseOn', 'followUps', 'state', 'trade']);
    const json = JSON.stringify(seen[0]);
    for (const word of ['Clémence', 'Imaginaire', 'Zéphyr', '21000', 'T-7', req.partnerId, t.project.id, t.person.id, 'Alex']) expect(json).not.toContain(word);
  });

  it('[R12] une IA qui invente un chiffre, rend une autre forme, donne une coordonnée ou échoue : le secours rend la même structure', async () => {
    const answers: unknown[] = [
      { headline: 'Le partenaire a répondu en 2 h.', points: [] },
      { headline: 'Réponse rapide.', points: ['ok'], note: 4 },
      { headline: 'Rappeler le 06 12 34 56 78.', points: [] },
      'texte libre',
    ];
    for (const answer of answers) {
      const { t, req } = await answeredWith({ write: async () => answer });
      const r = await t.suivi.summary(t.agent, req.referralId);
      expect(r, JSON.stringify(answer)).toMatchObject({ ok: true, value: { source: 'secours' } });
      if (r.ok) expect(Object.keys(r.value.summary).sort()).toEqual(['headline', 'points']);
    }
    const { t, req } = await answeredWith({
      write: async () => {
        throw new Error('panne');
      },
    });
    const r = await t.suivi.summary(t.dir, req.referralId);
    expect(r).toMatchObject({ ok: true, value: { source: 'secours', summary: { headline: 'Demande en cours chez le partenaire.' } } });
    const ev = await t.db.all("SELECT 1 FROM journal WHERE type = 'partenaire.resume_secours'");
    expect(ev).toHaveLength(1);
  });

  it('le secours sans IA dit la remise, la première réponse, son délai et les pièces', async () => {
    const { t, req } = await answeredWith();
    const r = await t.suivi.summary(t.agent, req.referralId);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.source).toBe('secours');
    expect(r.value.summary.points).toEqual(['Confiée le 12/07.', 'Première réponse le 13/07, après 26 h.', 'Pièces déposées : amiante.']);
    // Le secours passe son propre contrôle : même forme, chiffres des faits seuls.
    const facts: SummaryFacts = {
      trade: 'diagnostiqueur',
      domain: 'amiante',
      state: 'en_cours',
      entrustedOn: '2027-07-12',
      firstResponseOn: '2027-07-13',
      delayHours: 26,
      documents: [{ sort: 'amiante', destination: 'property', depositedOn: '2027-07-13' }],
      followUps: [],
    };
    expect(checkSummary(fallbackSummary(facts), facts)).toEqual(fallbackSummary(facts));
  });
});

describeWithSqlite('U07 · avis du client, lus par un humain', () => {
  it('[R14] un avis est un texte : une note, des étoiles ou un rang sont refusés', async () => {
    const t = await setup();
    const req = await t.request();
    for (const extra of [{ rating: 5 }, { stars: 4 }, { rank: 1 }, { score: 'bon' }]) {
      expect(await t.suivi.recordReview(t.agent, req.referralId, { text: 'Rapide et clair.', channel: 'oral', ...extra })).toMatchObject({ ok: false, rule: 'R14', code: 'only_text' });
    }
    expect(await t.suivi.recordReview(t.agent, req.referralId, { text: '  ', channel: 'oral' })).toMatchObject({ ok: false, code: 'bad_text' });
    expect(await t.suivi.recordReview(t.agent, req.referralId, { text: 'Bien.', channel: 'pigeon' })).toMatchObject({ ok: false, code: 'bad_channel' });
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('partner_reviews')")).map((c) => c.name);
    expect(cols.filter((c) => /note|rating|score|rank|star/.test(c))).toEqual([]);
  });

  it('[R74] un avis seulement sur une demande qui a été confiée', async () => {
    const t = await setup();
    const p = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: t.property.id });
    // Aucun partenaire encore : rien à proposer.
    expect(p.ok).toBe(false);
    const req = await t.request();
    const open = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: t.property.id });
    if (!open.ok) throw new Error(open.code);
    expect(await t.suivi.recordReview(t.agent, open.value.referralId, { text: 'Bien.', channel: 'oral' })).toMatchObject({ ok: false, rule: 'R74' });
    expect((await t.suivi.recordReview(t.agent, req.referralId, { text: 'Bien.', channel: 'oral' })).ok).toBe(true);
  });

  it('[R75] [R14] les avis ne changent ni la recherche, ni l’ordre du tirage', async () => {
    const t = await setup();
    const first = await t.request();
    await t.request();
    await t.request();
    const before = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'amiante' });
    const drawBefore = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: t.property.id });
    await t.suivi.recordReview(t.agent, first.referralId, { text: 'Excellent, très réactif, à recommander en premier.', channel: 'mail' });
    await t.suivi.recordReview(t.agent, first.referralId, { text: 'Un peu lent pour le rapport.', channel: 'oral' });
    const after = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'amiante' });
    const drawAfter = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: t.property.id });
    expect(after).toEqual(before);
    if (!drawBefore.ok || !drawAfter.ok) throw new Error('tirage');
    expect(drawAfter.value.shown).toEqual(drawBefore.value.shown);
    expect(JSON.stringify(after)).not.toMatch(/avis|review|note|rating|score/i);
  });

  it('[R13] chaque lecture est rangée au nom de l’humain qui lit ; le compte des avis non lus tombe à zéro', async () => {
    const t = await setup();
    const req = await t.request();
    await t.suivi.recordReview(t.agent, req.referralId, { text: 'Rendez-vous tenu, rapport clair.', channel: 'oral' });
    expect(await t.suivi.unreadReviewCount(t.agent, req.referralId)).toEqual({ ok: true, value: 1 });
    const r = await t.suivi.readReviews(t.dir, req.referralId);
    expect(r).toMatchObject({ ok: true, value: [{ text: 'Rendez-vous tenu, rapport clair.', channel: 'oral' }] });
    expect(await t.suivi.unreadReviewCount(t.agent, req.referralId)).toEqual({ ok: true, value: 0 });
    expect(await t.db.all('SELECT reader FROM partner_review_reads')).toEqual([{ reader: 'direction:dir-1' }]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type IN ('partenaire.avis_range', 'partenaire.avis_lus')");
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toContain('Rendez-vous tenu');
    await expect(t.db.run('DELETE FROM partner_reviews')).rejects.toThrow(/rien ne s'efface/);
  });
});
