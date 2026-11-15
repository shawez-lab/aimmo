import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import {
  ContenusRepriseAgence,
  LicencesLogiciel,
  PIECE_OCTETS_MAX,
  PREFIXE_COFFRE,
  RepriseDonneesAgence,
  Sha256Flux,
  TRANCHE_OCTETS,
  empreinteManifestePiece,
  pieceRecomposee,
  trancheIntacte,
  type StockageFichiers,
  type StockageFichiersPlages,
} from '../src/licences/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, agences, SIREN (clé juste, aucune entreprise réelle visée), cartes, octets.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Agence des Prés (essai)', siren: '732829320', cardNumber: 'CPI 2101 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '21' };
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
/** Des octets d'essai, différents d'une place à l'autre, toujours les mêmes pour une même graine. */
const octets = (n: number, graine = 7) => {
  const b = new Uint8Array(n);
  let x = graine;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
};
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

// Une tranche de 100 octets dans les essais : la vidéo fait 1050 octets, onze tranches dont la dernière de 50.
const TRANCHE = 100;
const VIDEO = octets(1050);

async function setup(options: { maxBytes?: number; pieceMax?: number } = {}) {
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
  // Le stockage d'essai, avec tailles et plages ; chaque lecture est notée.
  const store = new Map<string, Uint8Array>([
    ['stock/lac/visite.mp4', VIDEO.slice()],
    ['stock/lac/note-1.ogg', octets(30, 3)],
    ['stock/lac/vide.ogg', new Uint8Array()],
  ]);
  const reads: string[] = [];
  const ranges: [string, number, number][] = [];
  const sizes: string[] = [];
  const storage: StockageFichiersPlages & { broken: boolean; onRange?: ((ref: string, debut: number) => void) | undefined; rangeShift: number } = {
    broken: false,
    rangeShift: 0,
    async read(ref) {
      reads.push(ref);
      if (this.broken) throw new Error('panne');
      return store.get(ref) ?? null;
    },
    async taille(ref) {
      sizes.push(ref);
      if (this.broken) throw new Error('panne');
      return store.get(ref)?.byteLength ?? null;
    },
    async lirePlage(ref, debut, longueur) {
      ranges.push([ref, debut, longueur]);
      if (this.broken) throw new Error('panne');
      this.onRange?.(ref, debut);
      const b = store.get(ref);
      return b === undefined ? null : b.subarray(debut, debut + longueur + this.rangeShift);
    },
  };
  const at = '2028-01-09T08:00:00.000Z';
  const note = (net: string, id: string, ref: string) =>
    db.run("INSERT INTO voice_notes (id, network_id, channel, external_id, status, media_ref, mime, transcript, created_at) VALUES (?, ?, 'whatsapp', ?, 'transcrite', ?, 'audio/ogg', 'Bonjour, essai.', ?)", [id, net, `ext-${id}`, ref, at]);
  // L'ordre de la liste : visite (0), lien masqué (1), note (2), perdue (3), coffre (4), vide (5).
  await note(lacNet, 'note-lac-1', 'stock/lac/visite.mp4');
  await note(lacNet, 'note-lac-2', 'https://stockage.exemple.test/lac/note-2.ogg?jeton=AbCdEf0123456789xyz_lac');
  await note(lacNet, 'note-lac-3', 'stock/lac/note-1.ogg');
  await note(lacNet, 'note-lac-4', 'stock/lac/perdue.ogg');
  await note(lacNet, 'note-lac-5', `${PREFIXE_COFFRE}${lacNet}/piece-essai`);
  await note(lacNet, 'note-lac-6', 'stock/lac/vide.ogg');
  await note(presNet, 'note-pres-1', 'stock/pres/note-1.ogg');
  const lacDirection = as('direction', 'direction-lac', lacNet);
  const presDirection = as('direction', 'direction-pres', presNet);
  const reprise = new RepriseDonneesAgence(db, journal, gate, { now });
  const made = await reprise.make(lacDirection, 'preuve-ok');
  if (!made.ok) throw new Error(made.code);
  const contenus = new ContenusRepriseAgence(db, journal, gate, storage, { now, trancheOctets: TRANCHE, ...options });
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const copy = () => JSON.parse(JSON.stringify(made.value.document)) as typeof made.value.document;
  const indexOf = (ref: string) => made.value.document.fichiers.findIndex((f) => f.ref === ref);
  proofs.length = 0;
  return { db, journal, gate, as, lacNet, presNet, lacDirection, presDirection, made: made.value, contenus, storage, store, reads, ranges, sizes, proofs, events, copy, indexOf };
}

describe('RC46 · Le SHA-256 incrémental', () => {
  it('[R667] égal au SHA-256 du navigateur, autour de chaque bord de bloc et en morceaux quelconques', async () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
      const data = octets(n, n + 1);
      expect(new Sha256Flux().update(data).hex()).toBe(await hex(data));
      // Les mêmes octets donnés en morceaux de tailles variées.
      const h = new Sha256Flux();
      let o = 0;
      for (let step = 1; o < n; step = (step * 7 + 3) % 97) {
        h.update(data.subarray(o, o + step));
        o += step;
      }
      expect(h.hex()).toBe(await hex(data));
    }
    // Les valeurs connues de la norme.
    expect(new Sha256Flux().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256Flux().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // Rendue une fois, fermée ensuite.
    const done = new Sha256Flux();
    done.hex();
    expect(() => done.hex()).toThrow();
    expect(() => done.update(new Uint8Array(1))).toThrow();
  });
});

describeWithSqlite('RC46 · Une pièce trop grosse pour un lot, remise en tranches', () => {
  it('[R667] l’empreinte d’une pièce : taille, SHA-256 entier, chaque tranche, la pièce jamais lue entière', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const r = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
    if (!r.ok) throw new Error(r.code);
    const e = r.value;
    expect([e.fingerprint, e.index, e.table, e.ligne, e.statut, e.taille, e.trancheOctets]).toEqual([t.made.fingerprint, i, 'voice_notes', { id: 'note-lac-1' }, 'prete', 1050, TRANCHE]);
    expect(e.sha256).toBe(await hex(VIDEO));
    expect(e.tranches).toHaveLength(11);
    for (const [k, tr] of e.tranches.entries()) {
      expect([tr.debut, tr.taille]).toEqual([k * 100, k === 10 ? 50 : 100]);
      expect(tr.sha256).toBe(await hex(VIDEO.subarray(tr.debut, tr.debut + tr.taille)));
    }
    // Jamais lue entière : seulement par plages, aucune plus grande qu'une tranche.
    expect(t.reads).toEqual([]);
    expect(t.ranges.every(([, , n]) => n <= TRANCHE)).toBe(true);
    expect(await empreinteManifestePiece(e)).toBe(e.manifeste);
    expect(t.proofs).toEqual([{ subject: `licence:${t.made.document.licenceId}`, stepUpId: 'preuve-ok' }]);
  });

  it('[R667] les tranches remises dans l’ordre recomposent la pièce, chacune vérifiée par la liste', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const e = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
    if (!e.ok) throw new Error(e.code);
    const parts: Uint8Array[] = [];
    let debut: number | null = 0;
    while (debut !== null) {
      const dite = e.value.tranches.find((x) => x.debut === debut)!;
      const r = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, debut, dite.sha256);
      if (!r.ok) throw new Error(r.code);
      expect(r.value).toMatchObject({ statut: 'remise', index: i, debut, total: 1050, sha256: dite.sha256 });
      expect(await trancheIntacte(e.value, r.value)).toBe(true);
      parts.push(r.value.contenu!);
      debut = r.value.suite;
    }
    expect(parts).toHaveLength(11);
    expect(concat(parts)).toEqual(VIDEO);
    expect(await pieceRecomposee(e.value, parts)).toBe(true);
    // Une tranche changée, manquante, en trop ou dans le désordre : la pièce n'est pas recomposée.
    const changed = parts.map((p) => p.slice());
    changed[4]![0] = changed[4]![0]! ^ 1;
    expect(await pieceRecomposee(e.value, changed)).toBe(false);
    expect(await pieceRecomposee(e.value, parts.slice(0, 10))).toBe(false);
    expect(await pieceRecomposee(e.value, [...parts, new Uint8Array()])).toBe(false);
    expect(await pieceRecomposee(e.value, [parts[1]!, parts[0]!, ...parts.slice(2)])).toBe(false);
    // Une tranche remise comparée à une autre place, ou à l'empreinte d'une autre pièce : pas intacte.
    const t0 = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0);
    if (!t0.ok) throw new Error(t0.code);
    expect(await trancheIntacte(e.value, { ...t0.value, debut: 100 })).toBe(false);
    expect(await trancheIntacte({ ...e.value, index: 2 }, t0.value)).toBe(false);
  });

  it('[R667] un octet changé au stockage après l’empreinte : la tranche attendue est « altérée », rien remis', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const e = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
    if (!e.ok) throw new Error(e.code);
    const video = t.store.get('stock/lac/visite.mp4')!;
    video[310] = video[310]! ^ 0xff;
    const dite = e.value.tranches[3]!;
    const r = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 300, dite.sha256);
    expect(r).toMatchObject({ ok: true, value: { statut: 'alteree', taille: null, sha256: null, contenu: null, suite: null } });
    // Sans empreinte attendue, la tranche est remise avec la sienne : la liste la dit changée.
    const sans = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 300);
    if (!sans.ok) throw new Error(sans.code);
    expect(sans.value.statut).toBe('remise');
    expect(await trancheIntacte(e.value, sans.value)).toBe(false);
    // Les autres tranches restent remises.
    const autre = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 200, e.value.tranches[2]!.sha256);
    expect(autre).toMatchObject({ ok: true, value: { statut: 'remise' } });
    const [ev] = (await t.events('licences.reprise.tranche')).filter((x) => x.statut === 'alteree');
    expect(ev).toEqual({ rule: 'R667', fingerprint: t.made.fingerprint, index: i, debut: 300, statut: 'alteree', octets: 0, attendue: true });
  });

  it('[R663] taille changée pendant la lecture, plage trop courte ou trop longue, panne : absente', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const absente = async () => {
      const r = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
      if (!r.ok) throw new Error(r.code);
      expect(r.value).toMatchObject({ statut: 'absente', taille: null, sha256: null, tranches: [] });
    };
    // La pièce grandit pendant la lecture.
    t.storage.onRange = (_ref, debut) => {
      if (debut === 500) t.store.set('stock/lac/visite.mp4', concat([VIDEO, new Uint8Array(1)]));
    };
    await absente();
    t.storage.onRange = undefined;
    t.store.set('stock/lac/visite.mp4', VIDEO.slice());
    // Une plage plus courte, puis plus longue que demandé.
    t.storage.rangeShift = -1;
    await absente();
    expect((await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0)) as unknown).toMatchObject({ ok: true, value: { statut: 'absente', contenu: null } });
    t.storage.rangeShift = 1;
    await absente();
    t.storage.rangeShift = 0;
    // La pièce change de taille pendant la lecture d'une tranche dont la plage garde sa longueur : rien remis.
    t.storage.onRange = (_ref, debut) => {
      if (debut === 200) t.store.set('stock/lac/visite.mp4', concat([VIDEO, new Uint8Array(7)]));
    };
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 200)).toMatchObject({ ok: true, value: { statut: 'absente', total: null, contenu: null, suite: null } });
    t.store.set('stock/lac/visite.mp4', VIDEO.subarray(0, 900).slice());
    t.storage.onRange = (_ref, debut) => {
      if (debut === 200) t.store.set('stock/lac/visite.mp4', VIDEO.slice());
    };
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 200)).toMatchObject({ ok: true, value: { statut: 'absente', contenu: null } });
    t.storage.onRange = undefined;
    t.store.set('stock/lac/visite.mp4', VIDEO.slice());
    // Le stockage en panne.
    t.storage.broken = true;
    await absente();
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0)).toMatchObject({ ok: true, value: { statut: 'absente', contenu: null } });
    t.storage.broken = false;
    // Une pièce perdue : absente, comme les autres.
    const perdue = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', t.indexOf('stock/lac/perdue.ogg'));
    expect(perdue).toMatchObject({ ok: true, value: { statut: 'absente' } });
  });

  it('[R663] une référence masquée ou du coffre n’est jamais lue', async () => {
    const t = await setup();
    const masquee = t.made.document.fichiers.findIndex((f) => f.ligne.id === 'note-lac-2');
    const coffre = t.made.document.fichiers.findIndex((f) => f.ligne.id === 'note-lac-5');
    expect(await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', masquee)).toMatchObject({ ok: true, value: { statut: 'masquee', tranches: [] } });
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', masquee, 0)).toMatchObject({ ok: true, value: { statut: 'masquee', contenu: null } });
    const v = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', coffre);
    const perdue = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', t.indexOf('stock/lac/perdue.ogg'));
    if (!v.ok || !perdue.ok) throw new Error('refus');
    // Le coffre et une pièce perdue se ressemblent en tout, hors de leur place [R663].
    const sans = (e: typeof v.value) => ({ ...e, index: 0, ligne: null, ref: null, manifeste: null });
    expect(sans(v.value)).toEqual(sans(perdue.value));
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', coffre, 0)).toMatchObject({ ok: true, value: { statut: 'absente', contenu: null } });
    const touched = [...t.reads, ...t.sizes, ...t.ranges.map(([r]) => r)];
    expect(touched.some((x) => x.startsWith(PREFIXE_COFFRE) || x.startsWith('https://'))).toBe(false);
  });

  it('[R667] une pièce de plus que le plafond : trop grosse, rien lu ; une pièce vide a une tranche vide', async () => {
    const t = await setup({ pieceMax: 1000 });
    const i = t.indexOf('stock/lac/visite.mp4');
    expect(await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i)).toMatchObject({ ok: true, value: { statut: 'trop_grosse', taille: 1050, sha256: null, tranches: [] } });
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0)).toMatchObject({ ok: true, value: { statut: 'trop_grosse', total: 1050, contenu: null } });
    expect(t.ranges).toEqual([]);
    expect(t.reads).toEqual([]);
    // Le plafond par défaut : 2 Go, une tranche de 8 Mo.
    expect([PIECE_OCTETS_MAX, TRANCHE_OCTETS]).toEqual([2 * 1024 ** 3, 8 * 1024 ** 2]);
    const vide = t.indexOf('stock/lac/vide.ogg');
    const e = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', vide);
    if (!e.ok) throw new Error(e.code);
    const empty = await hex(new Uint8Array());
    expect(e.value).toMatchObject({ statut: 'prete', taille: 0, sha256: empty, tranches: [{ debut: 0, taille: 0, sha256: empty }] });
    const r = await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', vide, 0, empty);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ statut: 'remise', taille: 0, total: 0, suite: null });
    // La pièce vide se vérifie comme les autres : sa tranche vide, puis la pièce recomposée.
    expect(await trancheIntacte(e.value, r.value)).toBe(true);
    expect(await pieceRecomposee(e.value, [r.value.contenu!])).toBe(true);
    expect(await pieceRecomposee(e.value, [])).toBe(false);
  });

  it('[R659] place mal formée, hors de la pièce, pas au bord d’une tranche, empreinte attendue mal formée : refus, rien lu', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    for (const bad of [-1, 6, 99, 1.5, '0', null]) {
      expect(await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', bad)).toMatchObject({ ok: false, rule: 'R659', code: 'bad_input' });
      expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', bad, 0)).toMatchObject({ ok: false, rule: 'R659', code: 'bad_input' });
    }
    for (const bad of [-100, 50, 1.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, bad)).toMatchObject({ ok: false, rule: 'R659', code: 'bad_input' });
    }
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 42, null]) {
      expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0, bad)).toMatchObject({ ok: false, rule: 'R659', code: 'bad_input' });
    }
    expect([t.reads, t.sizes, t.ranges, t.proofs]).toEqual([[], [], [], []]);
    // Une tranche au-delà de la fin : rien à remettre.
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 1100)).toMatchObject({ ok: true, value: { statut: 'absente', total: 1050, contenu: null } });
    expect(await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 1000)).toMatchObject({ ok: true, value: { statut: 'remise', taille: 50, suite: null } });
  });

  it('[R16, R657, R659, R601] autre rôle, sans licence, fichier changé ou d’une autre agence, sans preuve : refus, rien lu', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const calls = [
      (v: Viewer, doc: unknown, proof: unknown) => t.contenus.empreintePiece(v, doc, proof, i),
      (v: Viewer, doc: unknown, proof: unknown) => t.contenus.remettreTranche(v, doc, proof, i, 0),
    ];
    for (const call of calls) {
      expect(await call(t.as('agent', 'agent-lac', t.lacNet), t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect(await call(t.as('compliance', 'conf-lac', t.lacNet), t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect(await call(t.as('direction', 'direction-1', 'reseau-sans-licence'), t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R657' });
      expect(await call(t.presDirection, t.copy(), 'preuve-ok')).toMatchObject({ ok: false, rule: 'R659', code: 'fichier_non_verifie' });
      const slipped = t.copy();
      slipped.fichiers[i] = { ...slipped.fichiers[i]!, ref: 'stock/pres/note-1.ogg' };
      expect(await call(t.lacDirection, slipped, 'preuve-ok')).toMatchObject({ ok: false, rule: 'R659', code: 'fichier_non_verifie' });
      expect(await call(t.lacDirection, null, 'preuve-ok')).toMatchObject({ ok: false, rule: 'R659' });
    }
    expect(t.proofs).toEqual([]);
    for (const call of calls) {
      expect(await call(t.lacDirection, t.copy(), 'mauvaise')).toMatchObject({ ok: false, rule: 'R601', code: 'second_factor_required' });
      expect(await call(t.lacDirection, t.copy(), undefined)).toMatchObject({ ok: false, rule: 'R601' });
    }
    expect([t.reads, t.sizes, t.ranges]).toEqual([[], [], []]);
    expect([...(await t.events('licences.reprise.piece')), ...(await t.events('licences.reprise.tranche'))]).toEqual([]);
  });

  it('[R667] un stockage qui réutilise un tampon de Node : chaque tranche et chaque pièce gardent leurs propres octets', async () => {
    const t = await setup();
    // `Buffer.prototype.slice` partage la mémoire : la copie ne doit jamais passer par lui.
    const shared = Buffer.alloc(2048);
    const reuse: StockageFichiersPlages = {
      async read(ref) {
        const b = t.store.get(ref);
        if (b === undefined) return null;
        shared.set(b);
        return shared.subarray(0, b.byteLength);
      },
      taille: async (ref) => t.store.get(ref)?.byteLength ?? null,
      async lirePlage(ref, debut, longueur) {
        const b = t.store.get(ref);
        if (b === undefined) return null;
        shared.set(b.subarray(debut, debut + longueur));
        return shared.subarray(0, longueur);
      },
    };
    const contenus = new ContenusRepriseAgence(t.db, t.journal, t.gate, reuse, { trancheOctets: TRANCHE });
    const i = t.indexOf('stock/lac/visite.mp4');
    const e = await contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
    if (!e.ok) throw new Error(e.code);
    const first = await contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0);
    const second = await contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 100);
    if (!first.ok || !second.ok) throw new Error('refus');
    expect(first.value.contenu).toEqual(VIDEO.subarray(0, 100));
    expect(await trancheIntacte(e.value, first.value)).toBe(true);
    expect(await trancheIntacte(e.value, second.value)).toBe(true);
    // Les pièces d'un lot aussi (RC45).
    const lot = await contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!lot.ok) throw new Error(lot.code);
    const note = lot.value.pieces.find((p) => p.ref === 'stock/lac/note-1.ogg')!;
    shared.fill(0);
    expect(note.contenu).toEqual(t.store.get('stock/lac/note-1.ogg'));
  });

  it('[R667] un stockage qui ne lit pas par plages : refus dit, rien lu', async () => {
    const t = await setup();
    const reads: string[] = [];
    const plain: StockageFichiers = { read: async (ref) => (reads.push(ref), t.store.get(ref) ?? null) };
    const contenus = new ContenusRepriseAgence(t.db, t.journal, t.gate, plain, { trancheOctets: TRANCHE });
    const i = t.indexOf('stock/lac/visite.mp4');
    expect(await contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i)).toMatchObject({ ok: false, rule: 'R667', code: 'stockage_sans_plages' });
    expect(await contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 0)).toMatchObject({ ok: false, rule: 'R667', code: 'stockage_sans_plages' });
    expect(reads).toEqual([]);
    expect(t.proofs).toEqual([]);
  });

  it('[R666, R667] `remettre` ne lit plus entière une pièce plus grosse qu’un lot quand le stockage dit sa taille', async () => {
    const t = await setup({ maxBytes: 500 });
    const r = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.pieces.find((p) => p.ref === 'stock/lac/visite.mp4')).toMatchObject({ statut: 'trop_grosse', taille: 1050, sha256: null, contenu: null });
    expect(t.reads).not.toContain('stock/lac/visite.mp4');
    // Les petites pièces restent remises entières, avec leur empreinte.
    const note = r.value.pieces.find((p) => p.ref === 'stock/lac/note-1.ogg')!;
    expect([note.statut, note.sha256]).toEqual(['remise', await hex(t.store.get('stock/lac/note-1.ogg')!)]);
    // Une taille que le stockage ne sait pas dire (panne, réponse mal formée) : absente, la pièce jamais lue entière.
    const before = t.reads.length;
    t.storage.taille = async () => {
      throw new Error('panne');
    };
    const panne = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!panne.ok) throw new Error(panne.code);
    expect(panne.value.pieces.filter((p) => p.ref.startsWith('stock/')).map((p) => p.statut)).toEqual(['absente', 'absente', 'absente', 'absente']);
    t.storage.taille = async () => -1 as number;
    const malforme = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!malforme.ok) throw new Error(malforme.code);
    expect(malforme.value.pieces.find((p) => p.ref === 'stock/lac/visite.mp4')!.statut).toBe('absente');
    expect(t.reads.length).toBe(before);
    // Une taille annoncée petite mais des octets trop gros : toujours trop grosse, jamais remise.
    t.storage.taille = async () => 10;
    const menteur = await t.contenus.remettre(t.lacDirection, t.copy(), 'preuve-ok');
    if (!menteur.ok) throw new Error(menteur.code);
    expect(menteur.value.pieces.find((p) => p.ref === 'stock/lac/visite.mp4')).toMatchObject({ statut: 'trop_grosse', taille: 1050, contenu: null });
  });

  it('[R13, R667] au journal : empreintes, place et tailles, jamais une référence ni un contenu', async () => {
    const t = await setup();
    const i = t.indexOf('stock/lac/visite.mp4');
    const e = await t.contenus.empreintePiece(t.lacDirection, t.copy(), 'preuve-ok', i);
    if (!e.ok) throw new Error(e.code);
    await t.contenus.remettreTranche(t.lacDirection, t.copy(), 'preuve-ok', i, 100, e.value.tranches[1]!.sha256);
    expect(await t.events('licences.reprise.piece')).toEqual([{ rule: 'R667', fingerprint: t.made.fingerprint, manifeste: e.value.manifeste, index: i, statut: 'prete', taille: 1050, tranches: 11 }]);
    expect(await t.events('licences.reprise.tranche')).toEqual([{ rule: 'R667', fingerprint: t.made.fingerprint, index: i, debut: 100, statut: 'remise', octets: 100, attendue: true }]);
    const journal = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(journal).not.toMatch(/stock\/|visite\.mp4|coffre\//);
    expect(journal).not.toContain(e.value.sha256!);
    for (const tr of e.value.tranches) expect(journal).not.toContain(tr.sha256);
  });
});
