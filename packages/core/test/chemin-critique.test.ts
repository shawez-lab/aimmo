import { expect, it } from 'vitest';
import { CheminCritique, Echeancier, FinancementDossier, criticalPath, partyView, scheduleLines, type PathInput } from '../src/dossiers/index.ts';
import { PROOF, setupDossier, type DossierKind } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const facts = { hasLoanCondition: true, isCoownershipLot: true };
const allPieces = { lines: [{ piece: 'titre_propriete' as const, side: 'vendeur' as const, reason: 'toujours' as const, received: { piece: 'titre_propriete' as const, version: 1, ref: 'x', issuedOn: '2027-03-05', receivedAt: 'x' } }], missing: [], unknown: [], identity: 'verifiee' as const };
const base = (patch: Partial<PathInput> = {}): PathInput => ({
  today: '2027-03-15',
  schedule: scheduleLines({ compromis_signe: '2027-03-10', notification_acquereur: '2027-03-11', dia_recue: '2027-03-12', date_limite_pret: '2027-05-10', etat_date_attendu: '2027-05-20', acte_prevu: '2027-06-10' }, facts),
  plannedActDay: '2027-06-10',
  pieces: allPieces,
  hasLoanCondition: true,
  financing: [{ step: 'offre_pret_acceptee', day: '2027-04-20' }],
  ...patch,
});

it('[R61] le chemin critique suit des règles écrites : même calcul pour les mêmes données, chaque ligne avec sa raison', () => {
  const p = criticalPath('d', base());
  expect(criticalPath('d', base())).toEqual(p);
  expect(p.lines.map((l) => [l.reason, l.who, l.notBefore])).toEqual([
    ['fin_retractation', 'acquereur', '2027-03-23'],
    ['reponse_commune', 'commune', '2027-05-13'],
    ['etat_date_attendu', 'syndic', '2027-05-20'],
  ]);
  // Tout est daté et rien ne bloque : le plus tard tient le dossier.
  expect(p).toMatchObject({ earliestActDay: '2027-05-20', conditional: false, late: false, holder: { reason: 'etat_date_attendu', who: 'syndic' } });
  // Une offre de prêt reçue le 5 mai : acceptable au plus tôt le 16 ; elle tient le dossier si elle est plus tardive.
  const offer = criticalPath('d', base({ financing: [{ step: 'offre_pret_emise', day: '2027-05-15' }] }));
  expect(offer.holder).toEqual({ reason: 'reflexion_offre_pret', item: 'pret', who: 'acquereur', notBefore: '2027-05-26' });
  expect(offer.earliestActDay).toBe('2027-05-26');
  // Sans offre déclarée : au mieux dans 11 jours, la banque agit.
  expect(criticalPath('d', base({ financing: [], today: '2027-05-15' })).holder).toEqual({ reason: 'offre_pret_attendue', item: 'pret', who: 'banque', notBefore: '2027-05-26' });
  // Un refus après l'offre bloque sans date.
  expect(criticalPath('d', base({ financing: [{ step: 'offre_pret_emise', day: '2027-04-01' }, { step: 'refus', day: '2027-04-02' }] })).holder).toMatchObject({ reason: 'refus_de_pret', notBefore: null });
  // Un acte prévu trop tôt est dit en retard.
  expect(criticalPath('d', base({ plannedActDay: '2027-05-01' })).late).toBe(true);
});

it('[R10] ce qui manque est dit, jamais inventé : pièces, identité, dates à saisir bloquent sans date', () => {
  const p = criticalPath('d', base({
    schedule: scheduleLines({ compromis_signe: '2027-03-10' }, facts),
    plannedActDay: null,
    pieces: { lines: [{ piece: 'dpe', side: 'vendeur', reason: 'bien_bati', received: null }], missing: ['dpe'], unknown: ['copropriete'], identity: 'non_verifiee' },
    financing: [],
  }));
  expect(p.lines.map((l) => [l.reason, l.item, l.who])).toEqual([
    ['date_a_saisir', 'fin_retractation', 'agent'], ['date_a_saisir', 'reponse_preemption', 'agent'], ['offre_pret_attendue', 'pret', 'banque'],
    ['date_a_saisir', 'etat_date', 'agent'], ['date_a_saisir', 'acte', 'agent'], ['piece_manquante', 'dpe', 'vendeur'],
    ['donnee_du_bien_inconnue', 'copropriete', 'agent'], ['identite_a_verifier', null, 'acquereur'],
  ]);
  expect(p).toMatchObject({ conditional: true, holder: { reason: 'date_a_saisir', item: 'fin_retractation' }, plannedActDay: null, late: false });
  // Une pièce valable aujourd'hui mais périmée à l'acte prévu est nommée.
  const stale = criticalPath('d', base({ pieces: { ...allPieces, lines: [{ piece: 'etat_risques', side: 'vendeur', reason: 'toujours', received: { piece: 'etat_risques', version: 1, ref: 'x', issuedOn: '2026-12-02', receivedAt: 'x' } }] } }));
  expect(stale.holder).toEqual({ reason: 'piece_perimee', item: 'etat_risques', who: 'vendeur', notBefore: null });
  // Délai de la commune suspendu : sans date, la commune agit.
  const suspended = criticalPath('d', base({ schedule: scheduleLines({ compromis_signe: '2027-03-10', notification_acquereur: '2027-03-11', dia_recue: '2027-03-12', dia_suspension: '2027-04-01', etat_date_attendu: '2027-05-20', acte_prevu: '2027-06-10' }, facts) }));
  expect(suspended.holder).toEqual({ reason: 'delai_commune_suspendu', item: 'reponse_preemption', who: 'commune', notBefore: null });
});

it('[R52] [R19] chaque vue tait l’autre partie : le vendeur ne voit du prêt que « en cours », l’acquéreur pas les pièces du vendeur une à une', () => {
  const p = criticalPath('d', base({
    financing: [{ step: 'demande_deposee', day: '2027-03-12' }, { step: 'refus', day: '2027-03-20' }],
    pieces: { lines: [{ piece: 'titre_propriete', side: 'vendeur', reason: 'toujours', received: null }, { piece: 'fiche_renseignements_vendeur', side: 'vendeur', reason: 'toujours', received: null }, { piece: 'fiche_renseignements_acquereur', side: 'acquereur', reason: 'toujours', received: null }], missing: ['titre_propriete', 'fiche_renseignements_vendeur', 'fiche_renseignements_acquereur'], unknown: [], identity: 'verifiee' },
  }));
  const seller = partyView(p, 'vendeur');
  expect(JSON.stringify(seller)).not.toMatch(/refus|demande_deposee|offre_pret/);
  expect(seller.remaining.filter((r) => r.item === 'pret')).toEqual([{ reason: 'pret_en_cours', item: 'pret', who: 'autre_partie', notBefore: null }]);
  expect(seller.yourActions).toEqual([{ reason: 'piece_manquante', item: 'titre_propriete' }, { reason: 'piece_manquante', item: 'fiche_renseignements_vendeur' }]);
  const buyer = partyView(p, 'acquereur');
  expect(JSON.stringify(buyer)).not.toMatch(/titre_propriete|fiche_renseignements_vendeur/);
  expect(buyer.remaining.find((r) => r.reason === 'pieces_de_l_autre_partie')).toEqual({ reason: 'pieces_de_l_autre_partie', item: null, who: 'autre_partie', notBefore: null, count: 2 });
  expect(buyer.yourActions).toEqual([{ reason: 'refus_de_pret', item: 'pret' }, { reason: 'piece_manquante', item: 'fiche_renseignements_acquereur' }]);
});

describeWithSqlite('N07 · chemin critique de la vente', () => {
  for (const kind of ['appartement', 'maison', 'terrain'] as DossierKind[]) {
    it(`[R61] dossier test « ${kind} » : l’élément qui tient le dossier est le bon à chaque étape, jusqu’à l’acte possible`, async () => {
      const t = await setupDossier(kind);
      const chemin = new CheminCritique(t.db, t.acces, t.journal, t.storage, { now: t.now });
      const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
      const fin = new FinancementDossier(t.db, t.acces, t.journal, { now: t.now });
      const holder = async () => {
        const r = await chemin.of(t.agent, t.fileId);
        if (!r.ok) throw new Error(r.code);
        return r.value;
      };
      // 1. Le dossier vient de s'ouvrir : les dates sont à saisir.
      expect((await holder()).path.holder).toMatchObject({ reason: 'date_a_saisir', item: 'fin_retractation', who: 'agent' });
      await t.startCompromis();
      t.setClock(at9('2027-03-11'));
      for (const [k, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']]) await e.record(t.agent, t.fileId, { kind: k, day, proofRef: PROOF });
      // 2. Les dates sont là : la première pièce manquante tient le dossier.
      let v = await holder();
      expect(v.path.holder).toMatchObject({ reason: 'piece_manquante', item: 'titre_propriete', who: 'vendeur' });
      expect(v.path.conditional).toBe(true);
      const s = await t.pieces.status(t.agent, t.fileId);
      if (!s.ok) throw new Error(s.code);
      for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      // 3. Les pièces sont là, le prêt est attendu ; la commune répond le 11 mai.
      v = await holder();
      expect(v.path.conditional).toBe(false);
      const expected = kind === 'maison' ? '2027-05-12' : '2027-05-20';
      expect(v.path.earliestActDay).toBe(expected);
      expect(v.path.holder).toMatchObject(kind === 'maison' ? { reason: 'reponse_commune', who: 'commune' } : { reason: 'etat_date_attendu', who: 'syndic' });
      // 4. Un refus de prêt déclaré : il tient le dossier, sans date ; le vendeur ne voit que « prêt en cours ».
      t.setClock(at9('2027-04-20'));
      await fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-04-19', declaredBy: 'courtier' });
      v = await holder();
      expect(v.path.holder).toMatchObject({ reason: 'refus_de_pret', who: 'acquereur', notBefore: null });
      expect(JSON.stringify(v.seller)).not.toContain('refus');
      // 5. Une offre de prêt reçue le 15 mai : acceptable le 26, elle tient le dossier ; puis acceptée, la date tient.
      t.setClock(at9('2027-05-16'));
      await fin.declare(t.agent, t.fileId, { step: 'offre_pret_emise', day: '2027-05-15', declaredBy: 'acquereur' });
      v = await holder();
      expect(v.path.holder).toMatchObject({ reason: 'reflexion_offre_pret', notBefore: '2027-05-26' });
      t.setClock(at9('2027-05-27'));
      await fin.declare(t.agent, t.fileId, { step: 'offre_pret_acceptee', day: '2027-05-26', declaredBy: 'acquereur' });
      v = await holder();
      // Plus rien ne tient : l'acte prévu du 10 juin est possible.
      expect(v.path).toMatchObject({ holder: null, conditional: false, late: false, plannedActDay: '2027-06-10' });
      // Aucune vue ne nomme une personne.
      const json = JSON.stringify(v);
      for (const name of ['Léa', 'Acheteur', 'Exemple', t.personId, t.buyerId]) expect(json).not.toContain(name);
    });
  }

  it('[R16] le chemin critique : agent du bien, direction, conformité ; pas un autre agent', async () => {
    const t = await setupDossier();
    const chemin = new CheminCritique(t.db, t.acces, t.journal, t.storage, { now: t.now });
    for (const v of [t.agent, t.direction, { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' }]) expect(await chemin.of(v, t.fileId)).toMatchObject({ ok: true });
    expect(await chemin.of(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await chemin.of(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
  });
});
