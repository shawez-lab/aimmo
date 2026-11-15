import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import { ContenusRepriseAgence, LicencesLogiciel, PREFIXE_COFFRE, RepriseDonneesAgence, empreinteManifeste, pieceIntacte, type StockageFichiers } from '../src/licences/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, agences, SIREN (clé juste, aucune entreprise réelle visée), cartes, notes, octets.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Agence des Prés (essai)', siren: '732829320', cardNumber: 'CPI 2101 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '21' };
const bytes = (text: string) => new TextEncoder().encode(text);
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function setup(options: { maxBytes?: number; maxPieces?: number } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = () => new Date('2028-01-10T09:00:00.000Z');
  const journal = new SqlJournalStore(db);
  const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
  const as = (role: string, userId: string, networkId: string): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1', network.id);
  const licences = new LicencesLogiciel(db, journal, { now });
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  for (const phase of [2, 3, 4, 5]) if (!(await portes.open(direction, { phase })).ok) throw new Error('phase');
  await licences.setTariff(direction, { monthlyCents: 29900, reason: 'Tarif d’essai' });
  const lac = await licences.grant(direction, AGENCE);
  const pres = await licences.grant(direction, AUTRE);
  if (!lac.ok || !pres.ok) throw new Error('licence');
  const lacNet = lac.value.licenseeNetworkId;
  const presNet = pres.value.licenseeNetworkId;
  const proofs: unknown[] = [];
  const gate = {
    requireSecondFactor: async (_v: Viewer, _a: 'export_complet', subject: string, stepUpId: unknown) => {
      proofs.push({ subject, stepUpId });
      return stepUpId === 'preuve-ok' ? ({ ok: true } as const) : ({ ok: false, rule: 'R601', code: 'second_factor_required' } as const);
    },
  };
  // Le stockage d'essai : ce qu'il a, et chaque lecture qu'on lui demande.
  const store = new Map<string, Uint8Array>([
    ['stock/lac/note-1.ogg', bytes('note un du lac (essai)')],
    ['stock/lac/note-3.ogg', bytes('note trois du lac (essai)')],
    ['stock/lac/facture.pdf', bytes('%PDF facture du lac (essai)')],
    ['stock/pres/note-1.ogg', bytes('note des Prés (essai)')],
  ]);
  const reads: string[] = [];
  const storage: StockageFichiers & { broken: boolean } = {
    broken: false,
    async read(ref) {
      reads.push(ref);
      if (this.broken) throw new Error('panne');
      return store.get(ref) ?? null;
    },
  };
  const at = '2028-01-09T08:00:00.000Z';
  const note = (net: string, id: string, ref: string) =>
    db.run("INSERT INTO voice_notes (id, network_id, channel, external_id, status, media_ref, mime, transcript, created_at) VALUES (?, ?, 'whatsapp', ?, 'transcrite', ?, 'audio/ogg', 'Bonjour, essai.', ?)", [id, net, `ext-${id}`, ref, at]);
  await note(lacNet, 'note-lac-1', 'stock/lac/note-1.ogg');
  await note(lacNet, 'note-lac-2', 'https://stockage.exemple.test/lac/note-2.ogg?jeton=AbCdEf0123456789xyz_lac');
  await note(lacNet, 'note-lac-3', 'stock/lac/note-3.ogg');
  await note(lacNet, 'note-lac-4', 'stock/lac/perdue.ogg');
  await note(lacNet, 'note-lac-5', `${PREFIXE_COFFRE}${lacNet}/piece-essai`);
  await note(presNet, 'note-pres-1', 'stock/pres/note-1.ogg');
  await db.run("INSERT INTO mandate_source_costs (id, network_id, month, source, version, amount_cents, proof_ref, entered_by, entered_at) VALUES ('cout-lac', ?, '2027-12', 'flyers', 1, 12000, 'stock/lac/facture.pdf', 'direction:direction-lac', ?)", [lacNet, at]);
  const lacDirection = as('direction', 'direction-lac', lacNet);
  const presDirection = as('direction', 'direction-pres', presNet);
  const reprise = new RepriseDonneesAgence(db, journal, gate, { now });
  const made = await reprise.make(lacDirection, 'preuve-ok');
  if (!made.ok) throw new Error(made.code);
  const contenus = new ContenusRepriseAgence(db, journal, gate, storage, { now, ...options });
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const copy = () => JSON.parse(JSON.stringify(made.value.document)) as typeof made.value.document;
  proofs.length = 0;
  return { db, network, direction, as, lacNet, presNet, lacDirection, presDirection, reprise, made: made.value, contenus, storage, store, reads, proofs, events, copy };
}

describeWithSqlite('RC45 · Les fichiers déposés de l’agence sous licence, remis avec leur empreinte', () => {
  it('[R666] chaque pièce est remise avec son empreinte et sa taille recalculées sur les octets lus', async () => {
    const t = await setup();
    const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const lot = r.value;
    expect(lot.fingerprint).toBe(t.made.fingerprint);
    expect(lot.suite).toBeNull();
    expect(lot.pieces.map((p) => [p.index, p.table, p.ligne, p.statut])).toEqual([
      [0, 'mandate_source_costs', { id: 'cout-lac' }, 'remise'],
      [1, 'voice_notes', { id: 'note-lac-1' }, 'remise'],
      [2, 'voice_notes', { id: 'note-lac-2' }, 'masquee'],
      [3, 'voice_notes', { id: 'note-lac-3' }, 'remise'],
      [4, 'voice_notes', { id: 'note-lac-4' }, 'absente'],
      [5, 'voice_notes', { id: 'note-lac-5' }, 'absente'],
    ]);
    for (const p of lot.pieces.filter((x) => x.statut === 'remise')) {
      const original = t.store.get(p.ref)!;
      expect(p.contenu).toEqual(original);
      expect(p.taille).toBe(original.byteLength);
      expect(p.sha256).toBe(await hex(original));
      expect(await pieceIntacte(p, original)).toBe(true);
    }
    for (const p of lot.pieces.filter((x) => x.statut !== 'remise')) expect([p.sha256, p.contenu]).toEqual([null, null]);
    // La preuve du second facteur est demandée pour ce lot, avec la licence pour sujet [R601].
    expect(t.proofs).toEqual([{ subject: `licence:${t.made.document.licenceId}`, stepUpId: 'preuve-ok' }]);
  });

  it('[R666] un octet changé, un de plus ou de moins : la pièce n’est plus celle qui a été remise', async () => {
    const t = await setup();
    const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const p = r.value.pieces[1]!;
    const changed = p.contenu!.slice();
    changed[0] = changed[0]! ^ 1;
    expect(await pieceIntacte(p, changed)).toBe(false);
    expect(await pieceIntacte(p, new Uint8Array([...p.contenu!, 0]))).toBe(false);
    expect(await pieceIntacte(p, p.contenu!.slice(1))).toBe(false);
    expect(await pieceIntacte(r.value.pieces[4]!, new Uint8Array())).toBe(false);
    // Ce qui est remis est une copie : le stockage qui change ses octets après ne change pas la pièce remise.
    t.store.get('stock/lac/note-1.ogg')![0] = 0;
    expect(await pieceIntacte(p, p.contenu!)).toBe(true);
  });

  it('[R666, R13] le manifeste du lot, sans contenu, a son empreinte au journal ; ni référence ni contenu', async () => {
    const t = await setup();
    const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(await empreinteManifeste(r.value)).toBe(r.value.manifeste);
    const [e] = await t.events('licences.reprise.contenus');
    expect(e).toEqual({ rule: 'R666', fingerprint: t.made.fingerprint, manifeste: r.value.manifeste, depuis: 0, suite: null, remises: 3, absentes: 2, masquees: 1, tropGrosses: 0, octets: 22 + 25 + 27 });
    const journal = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(journal).not.toMatch(/stock\/|note un|coffre\/|facture du lac/);
    // Une pièce remise changée dans le lot rendu : son manifeste n'est plus celui du journal.
    const altered = { ...r.value, pieces: r.value.pieces.map((p, i) => (i === 1 ? { ...p, sha256: '0'.repeat(64) } : p)) };
    expect(await empreinteManifeste(altered)).not.toBe(r.value.manifeste);
  });

  it('[R663] une référence du coffre n’est jamais lue, dite absente comme une pièce perdue ; un stockage en panne aussi', async () => {
    const t = await setup();
    const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(t.reads.some((x) => x.startsWith(PREFIXE_COFFRE))).toBe(false);
    expect(t.reads).not.toContain('https://stockage.exemple.test/lac/note-2.ogg?jeton=AbCdEf0123456789xyz_lac');
    const [lost, vault] = [r.value.pieces[4]!, r.value.pieces[5]!];
    expect({ ...lost, index: 0, ligne: null, ref: null }).toEqual({ ...vault, index: 0, ligne: null, ref: null });
    t.storage.broken = true;
    const down = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!down.ok) throw new Error(down.code);
    expect(down.value.pieces.map((p) => p.statut)).toEqual(['absente', 'absente', 'masquee', 'absente', 'absente', 'absente']);
  });

  it('[R659, R661] un fichier changé, d’une autre agence ou à la liste trafiquée n’ouvre jamais le stockage', async () => {
    const t = await setup();
    const refused = async (viewer: Viewer, doc: unknown) => {
      const before = t.reads.length;
      const r = await t.contenus.remettre(viewer, doc, 'preuve-ok');
      expect(r).toMatchObject({ ok: false, rule: 'R659', code: 'fichier_non_verifie' });
      expect(t.reads.length).toBe(before);
    };
    // Une référence d'une autre agence glissée dans la liste et dans la ligne : l'empreinte n'est plus celle rangée.
    const slipped = t.copy();
    slipped.tables.voice_notes![0]!.media_ref = 'stock/pres/note-1.ogg';
    slipped.fichiers = slipped.fichiers.map((f) => (f.ligne.id === 'note-lac-1' ? { ...f, ref: 'stock/pres/note-1.ogg' } : f));
    await refused(t.lacDirection, slipped);
    // La liste seule changée.
    const list = t.copy();
    list.fichiers[1] = { ...list.fichiers[1]!, ref: 'stock/pres/note-1.ogg' };
    await refused(t.lacDirection, list);
    // Le vrai fichier du Lac présenté par la direction des Prés.
    await refused(t.presDirection, t.copy());
    // Rien, ou pas un fichier de reprise.
    await refused(t.lacDirection, null);
    await refused(t.lacDirection, { format: 'autre' });
    // Aucune preuve demandée pour un fichier refusé.
    expect(t.proofs).toEqual([]);
    expect((await t.events('licences.refuse')).filter((e) => e.kind === 'licence_reprise_contenus')).toHaveLength(5);
  });

  it('[R16, R657, R601] autre rôle, réseau sans licence, preuve absente : refusé au journal, rien lu', async () => {
    const t = await setup();
    expect(await t.contenus.remettre(t.as('agent', 'agent-lac', t.lacNet), t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.contenus.remettre(t.as('compliance', 'conf-lac', t.lacNet), t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.contenus.remettre(t.direction, t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R657', code: 'pas_de_licence' });
    expect(await t.contenus.remettre(t.lacDirection, t.copy(), 'mauvaise')).toMatchObject({ ok: false, rule: 'R601', code: 'second_factor_required' });
    expect(await t.contenus.remettre(t.lacDirection, t.copy())).toMatchObject({ ok: false, rule: 'R601' });
    expect(t.reads).toEqual([]);
    expect((await t.events('acces.refuse')).filter((e) => e.kind === 'licence_reprise_contenus')).toHaveLength(2);
    expect(await t.events('licences.reprise.contenus')).toEqual([]);
  });

  it('[R666] par lots : la suite reprend où le lot s’arrête, rien n’est perdu ni doublé ; une pièce trop grosse n’est pas coupée', async () => {
    const t = await setup({ maxBytes: 50 });
    const all: number[] = [];
    let at: number | null = 0;
    const statuts: string[] = [];
    let lots = 0;
    while (at !== null) {
      const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok', at);
      if (!r.ok) throw new Error(r.code);
      expect(r.value.depuis).toBe(at);
      expect(r.value.pieces.reduce((s, p) => s + (p.statut === 'remise' ? p.taille! : 0), 0)).toBeLessThanOrEqual(50);
      all.push(...r.value.pieces.map((p) => p.index));
      statuts.push(...r.value.pieces.map((p) => p.statut));
      at = r.value.suite;
      lots++;
    }
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
    expect(statuts).toEqual(['remise', 'remise', 'masquee', 'remise', 'absente', 'absente']);
    expect(lots).toBe(2);
    // Une pièce plus grosse que le plafond d'un lot : dite trop grosse, avec sa taille, jamais coupée ni remise.
    const small = await setup({ maxBytes: 24 });
    const r = await small.contenus.remettre(small.lacDirection, small.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.pieces[0]).toMatchObject({ statut: 'trop_grosse', taille: 27, sha256: null, contenu: null });
    // Au plus tant de pièces par lot.
    const few = await setup({ maxPieces: 2 });
    const f = await few.contenus.remettre(few.lacDirection, few.copy(), 'preuve-ok');
    if (!f.ok) throw new Error(f.code);
    expect([f.value.pieces.length, f.value.suite]).toEqual([2, 2]);
    // Une place hors de la liste : refusée, rien lu.
    for (const bad of [-1, 7, 1.5, '0']) expect(await few.contenus.remettre(few.lacDirection, few.copy(), 'preuve-ok', bad)).toMatchObject({ ok: false, rule: 'R659', code: 'bad_input' });
    // La fin de la liste : un lot vide, sans suite.
    const end = await few.contenus.remettre(few.lacDirection, few.copy(), 'preuve-ok', 6);
    expect(end).toMatchObject({ ok: true, value: { pieces: [], suite: null } });
  });

  it('[R666] une même référence citée par deux lignes n’est lue qu’une fois dans le lot', async () => {
    const t = await setup();
    const at = '2028-01-09T08:00:00.000Z';
    await t.db.run("INSERT INTO voice_notes (id, network_id, channel, external_id, status, media_ref, mime, transcript, created_at) VALUES ('note-lac-6', ?, 'whatsapp', 'ext-6', 'transcrite', 'stock/lac/note-1.ogg', 'audio/ogg', 'Bonjour, essai.', ?)", [t.lacNet, at]);
    const made = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!made.ok) throw new Error(made.code);
    const r = await t.contenus.remettre(t.lacDirection, made.value.document, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const twice = r.value.pieces.filter((p) => p.ref === 'stock/lac/note-1.ogg');
    expect(twice.map((p) => p.statut)).toEqual(['remise', 'remise']);
    expect(twice[0]!.sha256).toBe(twice[1]!.sha256);
    expect(t.reads.filter((x) => x === 'stock/lac/note-1.ogg')).toHaveLength(1);
  });
});
