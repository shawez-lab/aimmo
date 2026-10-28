import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { Annuaire, PARTNER_TRADES, REQUIRED_CREDENTIALS, type PartnerProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, partenaires et justificatifs inventés.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeProofs implements PartnerProofStore {
  readonly refs = new Set<string>();
  put(partnerId: string): string {
    const ref = `partenaires/${partnerId}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const proofs = new FakeProofs();
  const annuaire = new Annuaire(db, proofs, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const at = new Date(clock).toISOString();
  for (const [id, status] of [
    ['agent-1', 'active'],
    ['agent-parti', 'left'],
  ] as const) {
    await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, status, created_at, updated_at) VALUES (?, ?, 'Léa', 'Essai', 'Dijon', ?, ?, ?)", [id, network.id, status, at, at]);
  }
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: 'agent-1', networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  /** Un justificatif valide d'un an, sauf indication. */
  const credential = async (partnerId: string, kind: string, extra: { domain?: string; from?: string; until?: string } = {}) => {
    const r = await annuaire.addCredential(dir, partnerId, { kind, domain: extra.domain, number: 'N-2027-001', validFrom: extra.from ?? day(-30), validUntil: extra.until ?? day(335), proofRef: proofs.put(partnerId) });
    if (!r.ok) throw new Error(`${kind} : ${r.code}`);
    return r.value;
  };
  const partner = async (trade: string, name: string, postcodes = ['21000']): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: name, postcodes });
    if (!r.ok) throw new Error(r.code);
    return r.value.partnerId;
  };
  return { db, journal, annuaire, proofs, network, other, dir, agent, day, credential, partner };
}

describeWithSqlite('U01 · annuaire des partenaires', () => {
  it('[R73] un partenaire n’est proposable qu’avec chaque justificatif exigé pour son métier, valide ce jour-là', async () => {
    const t = await setup();
    const courtier = await t.partner('courtier', 'Courtage des Ducs');
    const s0 = await t.annuaire.status(t.agent, courtier);
    expect(s0.ok && s0.value).toMatchObject({ proposable: false, reasons: ['Assurance de responsabilité civile professionnelle : manquante.', 'Immatriculation ORIAS : manquante.'] });
    await t.credential(courtier, 'assurance_rcp');
    const s1 = await t.annuaire.status(t.agent, courtier);
    expect(s1.ok && s1.value).toMatchObject({ proposable: false, reasons: ['Immatriculation ORIAS : manquante.'] });
    const s2 = await t.credential(courtier, 'immatriculation_orias');
    expect(s2).toMatchObject({ proposable: true, reasons: [] });
    expect(await t.annuaire.proposableOn(t.network.id, courtier, new Date(clock))).toBe(true);
    // Un an plus tard, l'assurance est échue : il n'est plus proposable, et la raison est dite.
    expect(await t.annuaire.proposableOn(t.network.id, courtier, new Date(clock + 400 * DAY))).toBe(false);
  });

  it('[R73] chaque métier a ses justificatifs écrits ; une sorte qui ne va pas avec le métier est refusée', async () => {
    const t = await setup();
    for (const { trade } of PARTNER_TRADES) expect(REQUIRED_CREDENTIALS[trade]).toContain('assurance_rcp');
    expect(REQUIRED_CREDENTIALS.gestionnaire).toContain('carte_g');
    expect(REQUIRED_CREDENTIALS.geometre).toContain('inscription_ordre');
    const notaire = await t.partner('notaire', 'Étude du Parc');
    const r = await t.annuaire.addCredential(t.dir, notaire, { kind: 'immatriculation_orias', number: 'X1', validFrom: t.day(-1), validUntil: t.day(10), proofRef: t.proofs.put(notaire) });
    expect(r).toEqual({ ok: false, rule: 'R73', code: 'kind_not_for_trade' });
    const c = await t.annuaire.addCredential(t.dir, notaire, { kind: 'certification_diagnostic', domain: 'amiante', number: 'X1', validFrom: t.day(-1), validUntil: t.day(10), proofRef: t.proofs.put(notaire) });
    expect(c).toEqual({ ok: false, rule: 'R73', code: 'kind_not_for_trade' });
    expect(await t.credential(notaire, 'assurance_rcp')).toMatchObject({ proposable: true });
  });

  it('[R73] un justificatif échu ou pas encore commencé rend le partenaire indisponible, avec la raison datée', async () => {
    const t = await setup();
    const artisan = await t.partner('artisan', 'Menuiserie Lumière');
    await t.credential(artisan, 'assurance_rcp', { from: t.day(-400), until: t.day(-2) });
    const s = await t.annuaire.status(t.dir, artisan);
    expect(s.ok && s.value.proposable).toBe(false);
    expect(s.ok && s.value.reasons[0]).toMatch(/^Assurance de responsabilité civile professionnelle : échue le \d{2}\/\d{2}\/\d{4}\.$/);
    // Le renouvellement commence dans 5 jours : toujours pas proposable aujourd'hui.
    const renewed = await t.credential(artisan, 'assurance_rcp', { from: t.day(5), until: t.day(370) });
    expect(renewed.proposable).toBe(false);
    expect(renewed.reasons[0]).toMatch(/valable seulement à partir du/);
    expect(await t.annuaire.proposableOn(t.network.id, artisan, new Date(clock + 6 * DAY))).toBe(true);
  });

  it('[R73] un diagnostiqueur n’est proposable que pour les domaines couverts par une certification valide', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur', 'Diagnostics Bourgogne');
    await t.credential(diag, 'assurance_rcp');
    // Assurance seule : le mesurage seulement, qui n'exige aucune certification.
    expect(await t.annuaire.status(t.dir, diag)).toMatchObject({ ok: true, value: { proposable: true, domains: ['mesurage'] } });
    await t.credential(diag, 'certification_diagnostic', { domain: 'amiante' });
    await t.credential(diag, 'certification_diagnostic', { domain: 'plomb', from: t.day(-800), until: t.day(-1) });
    const s = await t.annuaire.status(t.dir, diag);
    expect(s.ok && s.value).toMatchObject({ proposable: true, domains: ['amiante', 'mesurage'] });
    const amiante = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'amiante' });
    expect(amiante.ok && amiante.value.proposable.map((p) => p.partnerId)).toEqual([diag]);
    const plomb = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'plomb' });
    expect(plomb.ok && plomb.value.proposable).toEqual([]);
    expect(plomb.ok && plomb.value.unavailable[0]!.reasons[0]).toMatch(/^Certification plomb : échue le/);
    const gaz = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'gaz' });
    expect(gaz.ok && gaz.value.unavailable[0]!.reasons).toEqual(['Certification gaz : manquante.']);
    expect(await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000' })).toEqual({ ok: false, rule: null, code: 'domain_required' });
    expect(await t.annuaire.proposableOn(t.network.id, diag, new Date(clock), 'amiante')).toBe(true);
    expect(await t.annuaire.proposableOn(t.network.id, diag, new Date(clock), 'plomb')).toBe(false);
    const mesurage = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain: 'mesurage' });
    expect(mesurage.ok && mesurage.value.proposable.map((p) => p.partnerId)).toEqual([diag]);
  });

  it('[R73] sans assurance valide, un diagnostiqueur n’est proposable pour rien, même pas le mesurage', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur', 'Diagnostics Sans Assurance');
    await t.credential(diag, 'certification_diagnostic', { domain: 'amiante' });
    const s = await t.annuaire.status(t.dir, diag);
    expect(s.ok && s.value).toMatchObject({ proposable: false, domains: [] });
    for (const domain of ['amiante', 'mesurage']) {
      const r = await t.annuaire.search(t.agent, { trade: 'diagnostiqueur', postcode: '21000', domain });
      expect(r.ok && r.value.unavailable[0]!.reasons).toEqual(['Assurance de responsabilité civile professionnelle : manquante.']);
    }
  });

  it('[R73] un renouvellement rangé à l’avance ne retire pas le partenaire tant que la version en cours le couvre', async () => {
    const t = await setup();
    const notaire = await t.partner('notaire', 'Étude du Renouveau');
    await t.credential(notaire, 'assurance_rcp', { from: t.day(-300), until: t.day(20) });
    const renewed = await t.credential(notaire, 'assurance_rcp', { from: t.day(21), until: t.day(400) });
    expect(renewed).toMatchObject({ proposable: true, reasons: [] });
    expect(renewed.lines[0]).toMatchObject({ version: 1, validUntil: t.day(20) });
    expect(await t.annuaire.proposableOn(t.network.id, notaire, new Date(clock + 21 * DAY))).toBe(true);
    const later = await t.annuaire.search(t.agent, { trade: 'notaire', postcode: '21000' });
    expect(later.ok && later.value.proposable.map((p) => p.partnerId)).toEqual([notaire]);
    // Un correctif rangé pour la même période (version plus récente, déjà commencée) remplace la précédente.
    const fixed = await t.credential(notaire, 'assurance_rcp', { from: t.day(-300), until: t.day(-1) });
    expect(fixed).toMatchObject({ proposable: false });
  });

  it('[R73] une version remplacée ne compte plus aujourd’hui, mais couvrait les jours de sa période', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur', 'Diag Côte-d’Or');
    await t.credential(diag, 'certification_diagnostic', { domain: 'dpe', from: t.day(-700), until: t.day(-100) });
    await t.credential(diag, 'certification_diagnostic', { domain: 'dpe', from: t.day(-50), until: t.day(600) });
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(-300))).toBe(true);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(-80))).toBe(false);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(0))).toBe(true);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'amiante', t.day(0))).toBe(false);
    expect(await t.annuaire.coveredOn(t.other.id, diag, 'certification_diagnostic', 'dpe', t.day(0))).toBe(false);
  });

  it('[R73] une correction qui raccourcit une période l’emporte, pour aujourd’hui comme pour le passé', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur', 'Diag Corrigé');
    await t.credential(diag, 'assurance_rcp');
    await t.credential(diag, 'certification_diagnostic', { domain: 'dpe', from: t.day(-200), until: t.day(30) });
    // Erreur de saisie : la certification finissait en fait hier.
    await t.credential(diag, 'certification_diagnostic', { domain: 'dpe', from: t.day(-200), until: t.day(-1) });
    expect(await t.annuaire.proposableOn(t.network.id, diag, new Date(clock), 'dpe')).toBe(false);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(0))).toBe(false);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(10))).toBe(false);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(-100))).toBe(true);
    // Un renouvellement ensuite ne ressuscite pas la période corrigée, mais couvre la sienne.
    await t.credential(diag, 'certification_diagnostic', { domain: 'dpe', from: t.day(40), until: t.day(400) });
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(10))).toBe(false);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(50))).toBe(true);
    expect(await t.annuaire.coveredOn(t.network.id, diag, 'certification_diagnostic', 'dpe', t.day(-100))).toBe(true);
  });

  it('[R14] la recherche ne rend ni note, ni rang, ni avis, et ne sort que la zone et le métier demandés', async () => {
    const t = await setup();
    const a = await t.partner('notaire', 'Étude A', ['21000', '21121']);
    const b = await t.partner('notaire', 'Étude B', ['21000']);
    const c = await t.partner('notaire', 'Étude C', ['71100']);
    await t.partner('artisan', 'Artisan D', ['21000']);
    for (const id of [a, b, c]) await t.credential(id, 'assurance_rcp');
    const r = await t.annuaire.search(t.agent, { trade: 'notaire', postcode: '21000' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.proposable.map((p) => p.partnerId)).toEqual([a, b]);
    for (const card of r.value.proposable) expect(Object.keys(card).sort()).toEqual(['businessName', 'partnerId', 'trade']);
    expect(JSON.stringify(r.value)).not.toMatch(/score|note|rank|rang|rating|avis/i);
    const fontaine = await t.annuaire.search(t.agent, { trade: 'notaire', postcode: '21121' });
    expect(fontaine.ok && fontaine.value.proposable.map((p) => p.partnerId)).toEqual([a]);
  });

  it('[R16] la direction et les agents actifs écrivent, la conformité lit, un partenaire et un agent parti sont refusés', async () => {
    const t = await setup();
    const id = await t.partner('photographe', 'Studio Clair');
    const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: t.network.id };
    const partner = { role: 'partner' as const, userId: id, networkId: t.network.id };
    const gone = { role: 'agent' as const, userId: 'agent-parti', networkId: t.network.id };
    const stranger = { role: 'direction' as const, userId: 'dir-x', networkId: t.other.id };
    expect((await t.annuaire.addPartner(t.agent, { trade: 'artisan', businessName: 'Plomberie Nord', postcodes: ['21000'] })).ok).toBe(true);
    expect((await t.annuaire.status(compliance, id)).ok).toBe(true);
    expect(await t.annuaire.addPartner(compliance, { trade: 'artisan', businessName: 'X X', postcodes: ['21000'] })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.annuaire.search(partner, { trade: 'photographe', postcode: '21000' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.annuaire.status(gone, id)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.annuaire.status(stranger, id)).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    const refusals = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type = 'acces.refuse'");
    expect(refusals.length).toBe(4);
  });

  it('[R13] chaque ajout et chaque vérification au journal, sans nom ni numéro ; la chaîne reste intacte', async () => {
    const t = await setup();
    const id = await t.partner('geometre', 'Cabinet Géomètre Unique');
    await t.annuaire.addCredential(t.dir, id, { kind: 'inscription_ordre', number: 'ORDRE-77421', validFrom: t.day(-10), validUntil: t.day(300), proofRef: t.proofs.put(id) });
    const events = await t.db.all<{ type: string; data: string; actor: string }>('SELECT type, data, actor FROM journal ORDER BY seq');
    expect(events.map((e) => e.type)).toEqual(['partenaire.ajoute', 'partenaire.justificatif_verifie']);
    expect(events[1]!.actor).toBe('direction:dir-1');
    expect(JSON.parse(events[1]!.data)).toEqual({ rule: 'R73', kind: 'inscription_ordre', domain: null, version: 1 });
    const all = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(all).not.toContain('Cabinet');
    expect(all).not.toContain('ORDRE-77421');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R17] rien ne s’efface ni ne change : un justificatif remplacé reste, la dernière version compte', async () => {
    const t = await setup();
    const id = await t.partner('avocat', 'Cabinet Droit Immo');
    await t.credential(id, 'assurance_rcp', { until: t.day(10) });
    await t.credential(id, 'assurance_rcp', { until: t.day(400) });
    const rows = await t.db.all<{ version: number }>('SELECT version FROM partner_credentials WHERE partner_id = ? ORDER BY version', [id]);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    const s = await t.annuaire.status(t.dir, id);
    expect(s.ok && s.value.lines.find((l) => l.kind === 'assurance_rcp')).toMatchObject({ version: 2, validUntil: t.day(400) });
    await expect(t.db.run('DELETE FROM partner_credentials')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE partner_credentials SET valid_until = '2099-01-01'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM partners')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM partner_zones')).rejects.toThrow(/rien ne s'efface/);
  });

  it('les entrées mal formées sont refusées sans rien ranger', async () => {
    const t = await setup();
    expect(await t.annuaire.addPartner(t.dir, { trade: 'banquier', businessName: 'Banque', postcodes: ['21000'] })).toMatchObject({ code: 'unknown_trade' });
    expect(await t.annuaire.addPartner(t.dir, { trade: 'artisan', businessName: ' ', postcodes: ['21000'] })).toMatchObject({ code: 'bad_name' });
    expect(await t.annuaire.addPartner(t.dir, { trade: 'artisan', businessName: 'Maçon', postcodes: ['2100'] })).toMatchObject({ code: 'bad_postcodes' });
    expect(await t.annuaire.addPartner(t.dir, { trade: 'artisan', businessName: 'Maçon', postcodes: [] })).toMatchObject({ code: 'bad_postcodes' });
    const id = await t.partner('artisan', 'Maçonnerie Sud');
    const base = { kind: 'assurance_rcp', number: 'A-1', validFrom: t.day(-1), validUntil: t.day(10) };
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, proofRef: `partenaires/${id}/pas-un-uuid.pdf` })).toMatchObject({ code: 'bad_ref' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, proofRef: `partenaires/autre/${uuid()}.pdf` })).toMatchObject({ code: 'bad_ref' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, proofRef: `partenaires/${id}/${uuid()}.pdf` })).toMatchObject({ code: 'not_stored' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, validUntil: t.day(-5), proofRef: t.proofs.put(id) })).toMatchObject({ code: 'bad_dates' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, validFrom: '2027-02-30', proofRef: t.proofs.put(id) })).toMatchObject({ code: 'bad_dates' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, number: '', proofRef: t.proofs.put(id) })).toMatchObject({ code: 'bad_number' });
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, domain: 'amiante', proofRef: t.proofs.put(id) })).toMatchObject({ code: 'bad_domain' });
    const ref = t.proofs.put(id);
    expect((await t.annuaire.addCredential(t.dir, id, { ...base, proofRef: ref })).ok).toBe(true);
    expect(await t.annuaire.addCredential(t.dir, id, { ...base, proofRef: ref })).toMatchObject({ code: 'ref_used' });
    expect(await t.db.all('SELECT id FROM partner_credentials')).toHaveLength(1);
  });

  it('les zones s’ajoutent sans doublon', async () => {
    const t = await setup();
    const id = await t.partner('demenageur', 'Déménagements Express', ['21000']);
    const r = await t.annuaire.addZones(t.agent, id, ['21000', '21800', '21800']);
    expect(r.ok && r.value.postcodes).toEqual(['21000', '21800']);
  });

  it('[R73] une alerte par justificatif, une seule fois, 30 jours avant l’échéance de la dernière version', async () => {
    const t = await setup();
    const id = await t.partner('notaire', 'Étude des Halles');
    await t.credential(id, 'assurance_rcp', { until: t.day(20) });
    const first = await t.annuaire.dueAlerts(t.network.id);
    expect(first).toEqual([{ partnerId: id, kind: 'assurance_rcp', domain: null, validUntil: t.day(20) }]);
    expect(await t.annuaire.dueAlerts(t.network.id)).toEqual([]);
    // Renouvelé à un an : plus d'alerte pour la nouvelle version tant qu'elle est loin.
    await t.credential(id, 'assurance_rcp', { until: t.day(365) });
    expect(await t.annuaire.dueAlerts(t.network.id)).toEqual([]);
    expect(await t.annuaire.dueAlerts(t.other.id)).toEqual([]);
  });

  it('[R73] un renouvellement qui laisse un trou garde l’alerte de la version en cours', async () => {
    const t = await setup();
    const id = await t.partner('notaire', 'Étude du Trou');
    await t.credential(id, 'assurance_rcp', { from: t.day(-300), until: t.day(10) });
    await t.credential(id, 'assurance_rcp', { from: t.day(40), until: t.day(400) });
    expect(await t.annuaire.dueAlerts(t.network.id)).toEqual([{ partnerId: id, kind: 'assurance_rcp', domain: null, validUntil: t.day(10) }]);
    // Sans trou, pas d'alerte.
    const id2 = await t.partner('notaire', 'Étude Continue');
    await t.credential(id2, 'assurance_rcp', { from: t.day(-300), until: t.day(10) });
    await t.credential(id2, 'assurance_rcp', { from: t.day(11), until: t.day(400) });
    expect(await t.annuaire.dueAlerts(t.network.id)).toEqual([]);
  });
});
