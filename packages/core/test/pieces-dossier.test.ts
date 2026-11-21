import { expect, it } from 'vitest';
import type { PropertySheet } from '../src/annonces/index.ts';
import { FORBIDDEN_PIECES, PiecesDossier, expectedPieces } from '../src/dossiers/index.ts';
import type { SqlDatabase } from '../src/index.ts';
import { setupDossier, type DossierKind } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const sheet = (patch: { buildYear?: number | null; heating?: PropertySheet['characteristics']['heating']; coownership?: PropertySheet['coownership'] } = {}): PropertySheet => ({
  characteristics: { bedrooms: 2, floor: 1, floorsTotal: 3, buildYear: 'buildYear' in patch ? patch.buildYear! : 1965, heating: 'heating' in patch ? patch.heating! : 'collectif', outdoor: [], landM2: null, parkingSpaces: null, elevator: null },
  energy: null,
  coownership: 'coownership' in patch ? patch.coownership! : { isCoownership: false },
  risks: null,
  media: [],
});

const DOC = '2027-02-15';

const names = (l: ReturnType<typeof expectedPieces>) => l?.pieces.map((p) => `${p.piece}:${p.reason}`);

it('[R60] la liste des pièces suit des règles écrites, chaque ligne avec sa raison, la même pour les mêmes données', () => {
  const copro = sheet({ coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false } });
  expect(names(expectedPieces('home', copro, 2027))).toEqual([
    'titre_propriete:toujours', 'fiche_renseignements_vendeur:toujours', 'etat_risques:toujours', 'dpe:bien_bati',
    'amiante:construit_avant_juillet_1997', 'electricite:installation_plus_15_ans', 'gaz:installation_gaz_possible',
    'reglement_copropriete:lot_copropriete', 'pv_assemblees:lot_copropriete', 'fiche_synthetique:lot_copropriete',
    'pre_etat_date:lot_copropriete', 'carnet_entretien:lot_copropriete', 'mesurage_carrez:lot_copropriete',
    'notice_information:lot_copropriete', 'pppt_dtg:lot_copropriete', 'dta_parties_communes:construit_avant_juillet_1997',
    'fiche_renseignements_acquereur:toujours',
  ]);
  expect(expectedPieces('home', copro, 2027)).toEqual(expectedPieces('home', copro, 2027));
  // Une maison récente chauffée au gaz : ni amiante, ni plomb, ni électricité ; le gaz seulement à partir de 15 ans.
  expect(names(expectedPieces('home', sheet({ buildYear: 2013, heating: 'individuel_gaz' }), 2027))).toEqual([
    'titre_propriete:toujours', 'fiche_renseignements_vendeur:toujours', 'etat_risques:toujours', 'dpe:bien_bati', 'fiche_renseignements_acquereur:toujours',
  ]);
  expect(names(expectedPieces('home', sheet({ buildYear: 2012, heating: 'individuel_gaz' }), 2027))).toContain('gaz:chauffage_gaz');
  // Le gaz sert aussi à la cuisson et à l'eau chaude : demandé pour tout logement de 15 ans ou plus, quel que soit le chauffage.
  for (const heating of ['pompe_a_chaleur', 'individuel_electrique', 'collectif', 'autre', 'fioul', 'bois', null] as const) {
    expect(names(expectedPieces('home', sheet({ buildYear: 2012, heating }), 2027))).toContain('gaz:installation_gaz_possible');
  }
  // Bornes : 1997 compris pour l'amiante, avant 1949 pour le plomb, plus de 15 ans pour l'électricité.
  expect(names(expectedPieces('home', sheet({ buildYear: 1997 }), 2027))).toContain('amiante:construit_avant_juillet_1997');
  expect(names(expectedPieces('home', sheet({ buildYear: 1998 }), 2027))?.some((n) => n.startsWith('amiante'))).toBe(false);
  expect(names(expectedPieces('home', sheet({ buildYear: 1948 }), 2027))).toContain('plomb:construit_avant_1949');
  expect(names(expectedPieces('home', sheet({ buildYear: 1949 }), 2027))?.some((n) => n.startsWith('plomb'))).toBe(false);
  // Seule l'année est connue : 15 ans pile comptent.
  expect(names(expectedPieces('home', sheet({ buildYear: 2013 }), 2027))?.some((n) => n.startsWith('electricite') || n.startsWith('gaz'))).toBe(false);
  expect(names(expectedPieces('home', sheet({ buildYear: 2012 }), 2027))).toContain('electricite:installation_plus_15_ans');
  // Lecture prudente : une donnée inconnue fait demander le diagnostic.
  expect(names(expectedPieces('home', sheet({ buildYear: null, heating: null }), 2027))).toEqual([
    'titre_propriete:toujours', 'fiche_renseignements_vendeur:toujours', 'etat_risques:toujours', 'dpe:bien_bati',
    'amiante:annee_construction_inconnue', 'plomb:annee_construction_inconnue', 'electricite:annee_construction_inconnue', 'gaz:installation_gaz_possible',
    'fiche_renseignements_acquereur:toujours',
  ]);
  // Un local commercial : ni plomb, ni électricité, ni gaz, qui visent les logements.
  expect(names(expectedPieces('commercial', sheet({ buildYear: 1930 }), 2027))).toEqual([
    'titre_propriete:toujours', 'fiche_renseignements_vendeur:toujours', 'etat_risques:toujours', 'dpe:bien_bati', 'amiante:construit_avant_juillet_1997', 'fiche_renseignements_acquereur:toujours',
  ]);
  // Un terrain : bornage, aucun diagnostic du bâti, même sans fiche.
  expect(expectedPieces('land', null, 2027)).toEqual({
    pieces: [
      { piece: 'titre_propriete', side: 'vendeur', reason: 'toujours' }, { piece: 'fiche_renseignements_vendeur', side: 'vendeur', reason: 'toujours' },
      { piece: 'etat_risques', side: 'vendeur', reason: 'toujours' }, { piece: 'bornage', side: 'vendeur', reason: 'terrain' },
      { piece: 'fiche_renseignements_acquereur', side: 'acquereur', reason: 'toujours' },
    ],
    unknown: [],
    local: [],
    installations: [],
  });
  // Ce qui ne se devine pas empêche le dossier d'être complet.
  expect(expectedPieces('home', null, 2027)?.unknown).toEqual(['fiche_bien', 'commune', 'assainissement']);
  // Une copropriété inconnue : sans DPE à la fiche, la classe énergie non plus ne se devine pas (AU010).
  expect(expectedPieces('home', sheet({ coownership: null }), 2027)?.unknown).toEqual(['copropriete', 'classe_energie', 'commune', 'assainissement']);
  // Un fonds de commerce relève de M16.
  expect(expectedPieces('business', null, 2027)).toBeNull();
});

describeWithSqlite('N01 · pièces du dossier notaire', () => {
  for (const [kind, count] of [['appartement', 17], ['maison', 7], ['terrain', 5]] as [DossierKind, number][]) {
    it(`[R60] le dossier test « ${kind} » arrive à « complet » quand chaque pièce est reçue et l'identité vérifiée`, async () => {
      const t = await setupDossier(kind);
      const first = await t.pieces.status(t.agent, t.fileId);
      if (!first.ok) throw new Error(first.code);
      expect(first.value.lines).toHaveLength(count);
      expect(first.value).toMatchObject({ complete: false, identity: 'non_verifiee', unknown: [] });
      expect(first.value.missing).toHaveLength(count);
      for (const piece of first.value.missing) {
        const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: DOC });
        expect(r.ok).toBe(true);
      }
      const all = await t.pieces.status(t.agent, t.fileId);
      // Toutes les pièces, mais l'identité de l'acquéreur n'est pas vérifiée : pas complet.
      expect(all).toMatchObject({ ok: true, value: { missing: [], identity: 'non_verifiee', complete: false } });
      await t.verifyBuyer();
      expect(await t.pieces.status(t.agent, t.fileId)).toMatchObject({ ok: true, value: { missing: [], identity: 'verifiee', complete: true } });
      // Le journal dit quelle pièce, jamais sa référence.
      const events = await t.journal.bySubject(`sale_file:${t.fileId}`);
      expect(events.filter((e) => e.type === 'dossier.piece_recue')).toHaveLength(count);
      expect(JSON.stringify(events)).not.toContain('dossiers/');
    });
  }

  it('[R15] une pièce d’identité, un document anti-blanchiment ou un RIB ne sont jamais des pièces du dossier', async () => {
    const t = await setupDossier();
    for (const piece of FORBIDDEN_PIECES) {
      expect(await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: 'R15', code: 'forbidden_piece' });
    }
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_pieces'))?.n).toBe(0);
    const refused = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.piece_refusee');
    expect(refused).toHaveLength(FORBIDDEN_PIECES.length);
    expect(refused.every((e) => e.data.rule === 'R15' && !JSON.stringify(e.data).includes('dossiers/'))).toBe(true);
    // L'identité n'apparaît que comme un état.
    const s = await t.pieces.status(t.agent, t.fileId);
    expect(s.ok && s.value.lines.map((l) => l.piece)).not.toContain('piece_identite');
    expect(s.ok && s.value.identity).toBe('non_verifiee');
  });

  it('une pièce inconnue, non attendue, une référence libre, absente du stockage ou déjà prise sont refusées', async () => {
    const t = await setupDossier();
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'photo_du_vendeur', ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'unknown_piece' });
    // Un appartement n'a pas de bornage.
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'bornage', ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'not_expected' });
    for (const ref of [`dossiers/${t.fileId}/titre rue des Lilas.pdf`, `biens/${t.propertyId}/0b6f1d2e-4444-4a2b-8c3d-000000000999.pdf`, t.upload('pdf', 'autre-dossier'), `dossiers/${t.fileId}/0b6f1d2e-4444-4a2b-8c3d-000000000998.docx`]) {
      expect(await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref, issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'bad_ref' });
    }
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: `dossiers/${t.fileId}/0b6f1d2e-4444-4a2b-8c3d-000000000997.pdf`, issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    const ref = t.upload();
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref, issuedOn: DOC })).toMatchObject({ ok: true });
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref, issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'ref_used' });
    // La date du document : un vrai jour, jamais dans le futur à Paris.
    for (const issuedOn of ['2027-02-30', '15/02/2027', '2027-13-45', '2027-03-02', '']) {
      expect(await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    }
    const today = await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: '2027-03-01' });
    expect(today.ok && today.value.lines.find((l) => l.piece === 'dpe')?.received?.issuedOn).toBe('2027-03-01');
  });

  it('[R17] une nouvelle version s’ajoute, l’ancienne reste ; rien ne change ni ne s’efface', async () => {
    const t = await setupDossier();
    const v1 = t.upload();
    const v2 = t.upload('jpg');
    await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref: v1, issuedOn: DOC });
    const r = await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref: v2, issuedOn: DOC });
    expect(r.ok && r.value.lines.find((l) => l.piece === 'dpe')?.received).toMatchObject({ version: 2, ref: v2 });
    expect((await t.db.all<{ ref: string }>("SELECT ref FROM sale_file_pieces WHERE piece = 'dpe' ORDER BY version")).map((x) => x.ref)).toEqual([v1, v2]);
    await expect(t.db.run('DELETE FROM sale_file_pieces')).rejects.toThrow(/rien ne s'efface/);
    // Deux envois en même temps de la même pièce : le second a lu la même dernière version que le premier (lecture
    // rendue en retard ici) ; il est refusé « busy », sans rien écrire.
    const stale: SqlDatabase = {
      ...t.db,
      run: (sql, params) => t.db.run(sql, params),
      all: (sql, params) => t.db.all(sql, params),
      first: async (sql, params) => (/MAX\(version\) AS v/.test(sql) ? ({ v: 1 } as never) : t.db.first(sql, params)),
    } as SqlDatabase;
    const late = new PiecesDossier(stale, t.acces, t.journal, t.storage, { now: t.now });
    expect(await late.add(t.agent, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: null, code: 'busy' });
    expect((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sale_file_pieces WHERE piece = 'dpe'"))?.n).toBe(2);
    await expect(t.db.run("UPDATE sale_file_pieces SET ref = 'x'")).rejects.toThrow(/rien ne change/);
  });

  it('[R16] seul l’agent du dossier range une pièce ; la direction lit ; un autre agent ne voit rien ; chaque refus au journal', async () => {
    const t = await setupDossier();
    expect(await t.pieces.add(t.direction, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.pieces.status(t.direction, t.fileId)).toMatchObject({ ok: true });
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    expect(await t.pieces.status(compliance, t.fileId)).toMatchObject({ ok: true });
    expect(await t.pieces.add(compliance, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: DOC })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.pieces.status(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pieces.add(t.sam, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: DOC })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pieces.status(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    expect(await t.pieces.status({ ...t.agent, networkId: 'autre-reseau' }, t.fileId)).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    const refusals = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals.map((e) => e.data.code)).toEqual(expect.arrayContaining(['role', 'unknown']));
    // Le refus fait à un autre agent par le bien est aussi écrit sous le dossier.
    expect(refusals.filter((e) => e.actor === `agent:${t.sam.userId}`)).toHaveLength(2);
    expect((await t.journal.bySubject('sale_file:dossier-inconnu')).map((e) => e.type)).toEqual(['acces.refuse']);
  });

  it('[R16] l’état d’identité de l’acquéreur n’est dit qu’à qui voit sa fiche en entier, lecture écrite au journal', async () => {
    const t = await setupDossier('terrain');
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: DOC });
    await t.verifyBuyer();
    const before = (await t.journal.bySubject(`person:${t.buyerId}`)).length;
    expect(await t.pieces.status(t.agent, t.fileId)).toMatchObject({ ok: true, value: { identity: 'verifiee', complete: true } });
    expect((await t.journal.bySubject(`person:${t.buyerId}`)).length).toBeGreaterThan(before);
    // L'acquéreur est confié à un autre agent : l'agent du bien ne connaît plus l'état de son identité.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.userId, t.buyerId]);
    const hidden = await t.pieces.status(t.agent, t.fileId);
    expect(hidden).toMatchObject({ ok: true, value: { identity: 'non_visible', complete: false } });
    const added = await t.pieces.add(t.agent, t.fileId, { piece: 'bornage', ref: t.upload(), issuedOn: DOC });
    expect(added.ok && added.value.identity).toBe('non_visible');
    expect((await t.journal.bySubject(`person:${t.buyerId}`)).some((e) => e.type === 'acces.refuse')).toBe(true);
  });

  it('[R60] sans fiche du bien ou sans copropriété connue, le dossier n’est jamais complet', async () => {
    const t = await setupDossier();
    const current = await t.db.first<{ data: string; version: number }>('SELECT data, version FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const data = JSON.parse(current!.data);
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['v-copro-inconnue', t.propertyId, t.network.id, current!.version + 1, JSON.stringify({ ...data, coownership: null }), 'agent:test', t.now().toISOString()]);
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    expect(s.value.unknown).toEqual(['copropriete']);
    for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: DOC });
    await t.verifyBuyer();
    expect(await t.pieces.status(t.agent, t.fileId)).toMatchObject({ ok: true, value: { missing: [], unknown: ['copropriete'], complete: false } });
  });
});
