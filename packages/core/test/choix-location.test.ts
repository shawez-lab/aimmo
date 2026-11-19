import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { Candidatures, ChoixProprietaire, MisesEnLocation, candidateReceiptText, ownerReceiptText, verificationCode, type RentalFacts } from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire et candidats inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  firstLetting: true,
  gas: 'aucune',
  leaseStart: '2027-09-01',
};

describe('W05 · reçus d’équité', () => {
  it('[R105] [R06] [R07] les reçus passent le contrôle des textes, sans nom ni note, et disent la règle', () => {
    const c = candidateReceiptText('2027-07-12', 3, ['Trois dernières quittances de loyer', 'Contrat de travail ou de stage, ou attestation de l’employeur'], false);
    expect(c).toContain('arrivé le 12 juillet 2027, en position 3');
    expect(c).toContain('Les seules pièces qui vous ont été demandées : Trois dernières quittances de loyer ; Contrat de travail');
    expect(c).toContain('sans note ni classement');
    expect(candidateReceiptText('2027-07-12', 1, [], true)).toContain('votre dossier DossierFacile, et aucune autre pièce');
    const o = ownerReceiptText(4, '2027-07-12', 'f'.repeat(64));
    expect(o).toContain('les 4 dossiers complets reçus vous sont présentés');
    expect(o).toContain('Le choix vous appartient');
    // La référence n'a aucun chiffre : jamais prise pour un montant ni un numéro de compte, quelle que soit l'empreinte.
    expect(verificationCode('0123456789abcdef'.repeat(4))).toBe('abcd-efgh-jkmn-pqrs');
    for (const fp of ['de89370400440532013000'.padEnd(64, '0'), 'fr7630006000011234567890189'.replace(/[^0-9a-f]/g, '0').padEnd(64, '1'), 'f'.repeat(64)]) {
      const text = ownerReceiptText(2, '2027-07-12', fp);
      expect(text.split('ordre : ')[1]).not.toMatch(/\d/);
      expect(checkText(text, { audience: 'client', channel: 'email', figures: [2, 12, 2027] }).filter((x) => x.rule !== 'R08' && x.rule !== 'length')).toEqual([]);
    }
    for (const text of [c, o]) {
      const figures = (text.match(/\d+/g) ?? []).map(Number);
      expect(checkText(text, { audience: 'client', channel: 'email', figures }).filter((p) => p.rule !== 'R08' && p.rule !== 'length')).toEqual([]);
      expect(text).not.toMatch(/\bIA\b|intelligence artificielle|score|note \d|rang \d|mandataire|gratuit/i);
    }
  });
});

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const verified = new Set<string>();
  const identity = { state: async (_n: string, personId: string) => ({ identityVerifiedOn: verified.has(personId) ? '2027-07-10' : null }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
  const listingId = c.ok ? c.value.listingId : '';
  await listings.recordFacts(agent, listingId, FACTS);
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  /** Une candidature, complète ou non : identité au coffre et pièces de la liste officielle. */
  const candidate = async (i: number, complete = true) => {
    const pid = (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' })).id;
    const a = await apps.apply(agent, listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    const sorts = complete ? ['quittances_loyer', 'contrat_travail', 'bulletins_salaire'] : ['quittances_loyer'];
    for (const sort of sorts) expect((await apps.addPiece(agent, id, { holder: 'candidat', sort, ref: put(`location/${listingId}/candidatures/${id}`), sha256: SHA })).ok).toBe(true);
    verified.add(pid);
    return { id, pid };
  };
  const proof = () => put(`location/${listingId}/choix`);
  const ref = (applicationId: string) => put(`location/${listingId}/candidatures/${applicationId}`);
  const events = (type: string) => db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, choix, apps, agent, other, compliance, listingId, owner, candidate, proof, ref, events, journal };
}

describeWithSqlite('W05 · présentation au propriétaire et choix', () => {
  it('[R105] [R14] seuls les dossiers complets, dans leur ordre d’arrivée, sans nom, sans note ni rang', async () => {
    const t = await setup();
    const a = await t.candidate(1);
    const b = await t.candidate(2, false);
    const c = await t.candidate(3);
    const d = await t.candidate(4);
    const p = await t.choix.present(t.agent, t.listingId);
    expect(p.ok && p.value.files.map((f) => f.applicationId)).toEqual([a.id, c.id, d.id]);
    expect(p.ok && p.value.files.map((f) => f.arrival)).toEqual([1, 3, 4]);
    expect(JSON.stringify(p)).not.toMatch(/Candidat|Inventé|score|note|rank|rang"|revenu|salaire net/i);
    expect(p.ok && p.value.files[0]!.pieces).toEqual(['Trois dernières quittances de loyer', 'Contrat de travail ou de stage, ou attestation de l’employeur', 'Trois derniers bulletins de salaire']);
    expect(b.id).not.toBe('');
  });

  it('[R105] Jamais vu : chaque candidat présenté reçoit son reçu d’équité, le propriétaire sa preuve, une seule fois, rien n’est envoyé', async () => {
    const t = await setup();
    await t.candidate(1);
    await t.candidate(2, false);
    await t.candidate(3);
    const p = await t.choix.present(t.agent, t.listingId);
    const pid = p.ok ? p.value.presentationId : '';
    const r = await t.choix.receipts(t.agent, t.listingId, pid);
    expect(r.ok && r.value.map((x) => x.recipient)).toEqual(['candidat', 'candidat', 'candidat', 'proprietaire']);
    expect(r.ok && r.value[1]!.text).toContain('en position 3');
    expect(r.ok && r.value[1]!.text).toContain('Les seules pièces qui vous ont été demandées : Trois dernières quittances de loyer ; Contrat de travail');
    // Le candidat encore incomplet reçoit aussi son reçu : ses pièces, ce qui manque, la règle.
    expect(r.ok && r.value[2]!.text).toContain('en position 2');
    expect(r.ok && r.value[2]!.text).toContain('Il manque encore : un justificatif d’activité ; un justificatif de ressources');
    expect(r.ok && r.value[3]!.text).toContain('les 2 dossiers complets reçus vous sont présentés');
    expect(r.ok && r.value[3]!.text).toContain(verificationCode(p.ok ? p.value.sha256 : 'x'.repeat(64)));
    // Rien ne part : aucun message.
    expect(await t.db.all('SELECT 1 FROM messages')).toHaveLength(0);
    const prepared = await t.events('location.recu_prepare');
    expect(prepared.length).toBe(4);
    for (const e of prepared) expect(JSON.parse(e.data).sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(t.db.run("UPDATE rental_fairness_receipts SET text = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R105] la présentation se rejoue à l’identique depuis le journal ; une présentation retouchée ne se rejoue pas', async () => {
    const t = await setup();
    await t.candidate(1);
    await t.candidate(2);
    const p = await t.choix.present(t.agent, t.listingId);
    const pid = p.ok ? p.value.presentationId : '';
    expect(await t.choix.replay(t.agent.networkId, pid)).toBe(true);
    expect(await t.choix.replay('autre-reseau', pid)).toBe(false);
    // Une présentation glissée sans passer par le code (ordre inversé, empreinte recalculée) n'a pas sa trace au journal.
    const row = (await t.db.first<{ snapshot: string }>('SELECT snapshot FROM rental_presentations WHERE id = ?', [pid]))!;
    const snap = JSON.parse(row.snapshot) as { files: unknown[] };
    const forged = JSON.stringify({ ...snap, files: [...snap.files].reverse() });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(forged)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await t.db.run("INSERT INTO rental_presentations (id, listing_id, network_id, version, snapshot, snapshot_sha256, created_by, created_at) VALUES ('faux', ?, ?, 9, ?, ?, 'x', 'y')", [t.listingId, t.agent.networkId, forged, digest]);
    expect(await t.choix.replay(t.agent.networkId, 'faux')).toBe(false);
    // Un reçu glissé sans passer par le code fait échouer le rejeu de la vraie présentation.
    await t.db.run("INSERT INTO rental_fairness_receipts (id, presentation_id, recipient, application_id, person_id, text, prepared_at) VALUES ('r-faux', ?, 'candidat', 'autre', 'p', 'Texte inventé', 'y')", [pid]);
    expect(await t.choix.replay(t.agent.networkId, pid)).toBe(false);
  });

  it('[R105] sans aucun dossier complet, chaque candidat reçoit quand même son reçu ; le propriétaire n’a rien à choisir', async () => {
    const t = await setup();
    const a = await t.candidate(1, false);
    await t.candidate(2, false);
    const p = await t.choix.present(t.agent, t.listingId);
    expect(p).toMatchObject({ ok: true, value: { files: [] } });
    const pid = p.ok ? p.value.presentationId : '';
    const r = await t.choix.receipts(t.agent, t.listingId, pid);
    expect(r.ok && r.value.map((x) => x.recipient)).toEqual(['candidat', 'candidat']);
    expect(r.ok && r.value[0]!.text).toContain('Il manque encore');
    expect(await t.choix.replay(t.agent.networkId, pid)).toBe(true);
    expect(await t.choix.recordChoice(t.agent, t.listingId, { presentationId: pid, applicationId: a.id, decidedAt: new Date(clock).toISOString(), channel: 'mail', proofRef: t.proof() })).toEqual({ ok: false, rule: 'R105', code: 'not_presented' });
  });

  it('[R104] [R105] le reçu du candidat ne cite que ses pièces, jamais celles de son garant', async () => {
    const t = await setup();
    const a = await t.candidate(1);
    const g = await t.apps.addGuarantor(t.agent, a.id, { kind: 'visale' });
    const gid = g.ok ? g.value.guarantorId : '';
    expect((await t.apps.addPiece(t.agent, a.id, { holder: gid, sort: 'visa_visale', ref: t.ref(a.id), sha256: 'b'.repeat(64) })).ok).toBe(true);
    const p = await t.choix.present(t.agent, t.listingId);
    expect(p.ok && p.value.files[0]!.pieces).not.toContain('Visa de la garantie Visale');
    expect(p.ok && p.value.files[0]!.guarantors).toEqual(['visale']);
    const r = await t.choix.receipts(t.agent, t.listingId, p.ok ? p.value.presentationId : '');
    expect(r.ok && r.value[0]!.text).not.toContain('Visale');
    expect(await t.choix.replay(t.agent.networkId, p.ok ? p.value.presentationId : '')).toBe(true);
  });

  it('[R105] le choix est celui du propriétaire : un dossier présenté, sa date, son canal et sa preuve ; un seul', async () => {
    const t = await setup();
    const a = await t.candidate(1);
    const b = await t.candidate(2);
    const late = await t.candidate(3, false);
    const p = await t.choix.present(t.agent, t.listingId);
    const pid = p.ok ? p.value.presentationId : '';
    const base = { presentationId: pid, applicationId: b.id, decidedAt: new Date(clock).toISOString(), channel: 'mail', proofRef: t.proof() };
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, applicationId: late.id })).toEqual({ ok: false, rule: 'R105', code: 'not_presented' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, presentationId: 'autre' })).toEqual({ ok: false, rule: 'R105', code: 'not_latest_presentation' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, decidedAt: '2030-01-01T00:00:00.000Z' })).toEqual({ ok: false, rule: 'R105', code: 'bad_date' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, decidedAt: '2027-07-01T00:00:00.000Z' })).toEqual({ ok: false, rule: 'R105', code: 'before_presentation' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, channel: 'pigeon' })).toEqual({ ok: false, rule: 'R105', code: 'bad_channel' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, proofRef: `location/${t.listingId}/choix/${uuid()}.pdf` })).toEqual({ ok: false, rule: 'R105', code: 'not_stored' });
    expect(await t.choix.recordChoice(t.agent, t.listingId, base)).toEqual({ ok: true, value: { applicationId: b.id } });
    expect(await t.choix.chosen(t.agent.networkId, t.listingId)).toEqual({ applicationId: b.id, personId: b.pid });
    expect(await t.choix.recordChoice(t.agent, t.listingId, { ...base, applicationId: a.id, proofRef: t.proof() })).toEqual({ ok: false, rule: 'R105', code: 'already_chosen' });
    expect(await t.choix.present(t.agent, t.listingId)).toEqual({ ok: false, rule: 'R105', code: 'already_chosen' });
    await expect(t.db.run("UPDATE rental_choices SET application_id = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R105] [R14] aucune fonction ne choisit : sans choix rangé, aucun candidat n’est retenu', async () => {
    const t = await setup();
    await t.candidate(1);
    expect((await t.choix.present(t.agent, t.listingId)).ok).toBe(true);
    expect(await t.choix.chosen(t.agent.networkId, t.listingId)).toBeNull();
    // Le module n'offre aucune méthode qui choisirait d'elle-même.
    const methods = Object.getOwnPropertyNames(ChoixProprietaire.prototype);
    expect(methods.filter((m) => /auto|best|rank|score|select|pick|suggest|recommend/i.test(m))).toEqual([]);
  });

  it('[R16] l’agent du logement présente et range le choix ; un autre agent est refusé ; sans dossier complet, rien', async () => {
    const t = await setup();
    expect(await t.choix.present(t.agent, t.listingId)).toEqual({ ok: false, rule: null, code: 'no_application' });
    await t.candidate(1);
    expect(await t.choix.present(t.other, t.listingId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.choix.present(t.compliance, t.listingId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const p = await t.choix.present(t.agent, t.listingId);
    expect((await t.choix.receipts(t.compliance, t.listingId, p.ok ? p.value.presentationId : '')).ok).toBe(true);
    expect((await t.events('location.lue')).map((e) => JSON.parse(e.data).what)).toEqual(['receipts']);
    for (const e of await t.events('location.presentation')) expect(e.data).not.toMatch(/Candidat|Inventé/);
  });
});
