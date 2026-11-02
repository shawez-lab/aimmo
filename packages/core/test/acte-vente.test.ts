import { expect, it } from 'vitest';
import { ActeVente, Echeancier, expiredPieces, feeFrom, validUntil } from '../src/dossiers/index.ts';
import type { SqlDatabase } from '../src/index.ts';
import { PROOF, setupDossier, type DossierKind } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';

it('[R60] une pièce datée est valable jusqu’à la veille du même jour, des mois plus tard ; périmée au jour de l’acte, elle manque', () => {
  expect(validUntil('2027-01-15', 6)).toBe('2027-07-14');
  expect(validUntil('2026-08-31', 6)).toBe('2027-02-27');
  expect(validUntil('2024-06-10', 36)).toBe('2027-06-09');
  const lines = [
    { piece: 'etat_risques' as const, received: { issuedOn: '2026-12-09' } },
    { piece: 'electricite' as const, received: { issuedOn: '2024-06-10' } },
    { piece: 'dpe' as const, received: { issuedOn: '2017-01-01' } },
    { piece: 'titre_propriete' as const, received: { issuedOn: '1990-01-01' } },
    { piece: 'gaz' as const, received: null },
  ];
  expect(expiredPieces(lines, '2027-06-09')).toEqual(['etat_risques', 'dpe']);
  expect(expiredPieces(lines, '2027-06-10')).toEqual(['etat_risques', 'electricite', 'dpe']);
  // Gaz 3 ans, plomb 1 an.
  expect(expiredPieces([{ piece: 'gaz', received: { issuedOn: '2024-06-09' } }, { piece: 'plomb', received: { issuedOn: '2026-06-09' } }], '2027-06-10')).toEqual(['gaz', 'plomb']);
  expect(expiredPieces([{ piece: 'gaz', received: { issuedOn: '2024-06-11' } }, { piece: 'plomb', received: { issuedOn: '2026-06-11' } }], '2027-06-10')).toEqual([]);
  // Un document daté après l'acte n'existait pas encore : il manque.
  expect(expiredPieces([{ piece: 'titre_propriete', received: { issuedOn: '2027-06-11' } }], '2027-06-10')).toEqual(['titre_propriete']);
  // Un DPE de l'ancienne méthode, d'avant juillet 2021, n'est plus valable depuis 2025 ; un DPE de juillet 2021 l'est.
  expect(expiredPieces([{ piece: 'dpe', received: { issuedOn: '2020-05-01' } }], '2027-06-10')).toEqual(['dpe']);
  expect(expiredPieces([{ piece: 'dpe', received: { issuedOn: '2020-05-01' } }], '2024-12-31')).toEqual([]);
  expect(expiredPieces([{ piece: 'dpe', received: { issuedOn: '2021-07-01' } }], '2027-06-10')).toEqual([]);
});

it('[R63] les honoraires viennent du document signé, entiers et connus, jamais devinés', () => {
  expect(feeFrom({ feeEur: 10000 })).toBe(10000);
  expect(feeFrom({ feeEur: 0 })).toBe(0);
  for (const f of [null, { feeEur: null }, { feeEur: -1 }, { feeEur: 10.5 }]) expect(feeFrom(f as never)).toBeNull();
});

describeWithSqlite('N06 · acte signé : vente close, commission due', () => {
  async function ready(kind: DossierKind = 'appartement', issuedOn = '2027-03-05') {
    const t = await setupDossier(kind);
    await t.startCompromis();
    t.setClock(at9('2027-03-10'));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn });
    return { ...t, acte: new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }) };
  }

  for (const kind of ['appartement', 'maison', 'terrain'] as DossierKind[]) {
    it(`[R63] dossier test « ${kind} » : l’acte clôt la vente, le bien est vendu, la commission due au montant du mandat`, async () => {
      const t = await ready(kind);
      t.setClock(at9('2027-06-11'));
      const r = await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
      expect(r).toEqual({ ok: true, value: { fileId: t.fileId, signedOn: '2027-06-10', aftersale: 'a_demarrer', commission: { mandateId: t.mandateId, feeEur: 10000, feeCharge: 'acquereur', dueOn: '2027-06-10' } } });
      expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('sold');
      // Une seule clôture ; plus de pièce ensuite ; rien ne change ni ne s'efface.
      expect(await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: null, code: 'already_closed' });
      expect(await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: t.upload(), issuedOn: '2027-06-10' })).toEqual({ ok: false, rule: null, code: 'closed' });
      await expect(t.db.run('UPDATE sale_commissions SET fee_eur = 1')).rejects.toThrow(/rien ne change/);
      await expect(t.db.run('DELETE FROM sale_file_closings')).rejects.toThrow(/rien ne s'efface/);
    });
  }

  it('[R63] la commission vient du mandat, jamais d’une saisie ; un avenant de prix ne la change pas', async () => {
    const t = await ready();
    // L'annonce était en ligne, montrée « sous offre ».
    await t.annonces.validate(t.agent, t.draftId);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'sous_offre' });
    await t.amend(195000);
    t.setClock(at9('2027-06-11'));
    // Un montant saisi n'est pas lu : la saisie ne porte que le jour et la preuve.
    const r = await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF, feeEur: 1 } as never);
    expect(r.ok && r.value.commission.feeEur).toBe(10000);
    // La publication montre le bien vendu au passage suivant.
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'vendu' });
  });

  it('[R60] pas d’acte avec une pièce manquante ou une pièce périmée ce jour-là', async () => {
    const t = await ready('appartement', '2026-11-01');
    t.setClock(at9('2027-06-11'));
    // L'état des risques du 1er novembre est périmé le 1er mai.
    const r = await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    expect(r).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', missing: [], expired: ['etat_risques'] });
    await t.pieces.add(t.agent, t.fileId, { piece: 'etat_risques', ref: t.upload(), issuedOn: '2027-06-01' });
    expect(await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: true });
    const u = await setupDossier('terrain');
    await u.startCompromis();
    u.setClock(at9('2027-03-10'));
    await new Echeancier(u.db, u.acces, u.journal, { now: u.now }).record(u.agent, u.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const acte = new ActeVente(u.db, u.acces, u.journal, u.storage, { now: u.now });
    expect(await acte.record(u.agent, u.fileId, { signedOn: '2027-03-10', proofRef: ACT_PROOF })).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', missing: ['titre_propriete', 'fiche_renseignements_vendeur', 'etat_risques', 'bornage', 'fiche_renseignements_acquereur'] });
    expect((await u.journal.bySubject(`sale_file:${u.fileId}`)).filter((e) => e.type === 'dossier.acte_refuse').map((e) => e.data.rule)).toEqual(['R60']);
    expect((await u.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [u.propertyId]))?.status).toBe('under_offer');
  });

  it('[R60] pas d’acte si l’identité de l’acquéreur n’est plus vérifiée, même toutes les pièces reçues', async () => {
    const t = await ready();
    // Le contrôle d'identité a une durée de validité (D03) : bien plus tard, il faut le refaire.
    t.setClock(at9('2028-06-11'));
    const r = await t.acte.record(t.agent, t.fileId, { signedOn: '2028-06-10', proofRef: ACT_PROOF });
    expect(r).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', identity: 'non_verifiee' });
  });

  it('[R60] un contrôle d’identité fait après l’acte ne compte pas pour un acte rapporté après coup', async () => {
    const t = await setupDossier('terrain');
    // L'identité n'est vérifiée que le 11 juin, après l'acte du 10.
    await t.verifyBuyer(new Date('2027-03-01T11:30:00.000Z'));
    await new (await import('../src/offres/index.ts')).DossiersVente(t.db, t.acces, t.journal, { now: t.now }).startCompromis(t.agent, t.fileId);
    t.setClock(at9('2027-03-10'));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-05' });
    t.setClock(at9('2028-06-12'));
    // Le contrôle du 1er mars 2027 est trop ancien au 10 juin 2028 ; un nouveau, fait le 11 juin 2028, vient après l'acte.
    await t.verifyBuyer(new Date('2028-06-11T09:00:00.000Z'));
    const acte = new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2028-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', identity: 'non_verifiee' });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2028-06-11', proofRef: ACT_PROOF })).toMatchObject({ ok: false, rule: 'R60', expired: ['etat_risques'] });
  });

  it('[R63] pas de commission sans mandat en vigueur au compromis : signé après, ou encore dans son délai de rétractation', async () => {
    for (const compromis of ['2027-02-05', '2027-02-20']) {
      const t = await setupDossier('terrain');
      await t.startCompromis();
      t.setClock(at9('2027-03-10'));
      await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: compromis, proofRef: PROOF });
      const s = await t.pieces.status(t.agent, t.fileId);
      if (!s.ok) throw new Error(s.code);
      for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-05' });
      const acte = new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now });
      // Le mandat du jeu est signé le 10 février hors de l'agence : rétractation jusqu'au 24 février.
      expect([compromis, await acte.record(t.agent, t.fileId, { signedOn: '2027-03-10', proofRef: ACT_PROOF })]).toEqual([compromis, { ok: false, rule: 'R63', code: 'no_mandate_in_force' }]);
      expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('under_offer');
      expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.acte_refuse').map((e) => e.data.rule)).toEqual(['R63']);
    }
  });

  it('[R63] une demande de début anticipé reçue après le compromis ne rend pas le mandat en vigueur ce jour-là', async () => {
    for (const [received, expected] of [['2027-02-23T09:00:00.000Z', false], ['2027-02-19T09:00:00.000Z', true]] as const) {
      const t = await setupDossier('terrain');
      await t.startCompromis();
      t.setClock(at9('2027-03-10'));
      await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-02-20', proofRef: PROOF });
      const s = await t.pieces.status(t.agent, t.fileId);
      if (!s.ok) throw new Error(s.code);
      for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-05' });
      const { Diffusion } = await import('../src/documents/retractation.ts');
      expect(await new Diffusion(t.db, t.acces, t.journal, { now: t.now }).recordEarlyStart(t.agent, t.mandateId, { proof: 'demande écrite du vendeur', receivedAt: new Date(received) })).toEqual({ ok: true });
      const r = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-03-10', proofRef: ACT_PROOF });
      expect([received, r.ok]).toEqual([received, expected]);
      if (!expected) expect(r).toEqual({ ok: false, rule: 'R63', code: 'no_mandate_in_force' });
    }
  });

  it('[R60] un acte rapporté après coup ne compte pas une pièce datée après lui', async () => {
    const t = await ready('terrain');
    t.setClock(at9('2027-06-12'));
    // Le titre reçu en dernier est daté du 11 juin, après l'acte du 10.
    await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: t.upload(), issuedOn: '2027-06-11' });
    expect(await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', expired: ['titre_propriete'] });
  });

  it('une coupure entre la clôture et la commission : un nouvel essai complète, sans rien doubler', async () => {
    const t = await ready();
    t.setClock(at9('2027-06-11'));
    let fail = true;
    const flaky: SqlDatabase = {
      exec: (q) => t.db.exec(q),
      all: (q, p) => t.db.all(q, p),
      first: (q, p) => t.db.first(q, p),
      run: async (q, p) => {
        if (fail && q.includes('INSERT INTO sale_commissions')) { fail = false; throw new Error('coupure'); }
        return t.db.run(q, p);
      },
    };
    await expect(new ActeVente(flaky, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).rejects.toThrow('coupure');
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('under_offer');
    expect(await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: true, value: { commission: { feeEur: 10000, dueOn: '2027-06-10' } } });
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('sold');
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.acte_signe')).toHaveLength(1);
  });

  it('[R63] N13 : clôture, commission et bien vendu s’écrivent ensemble : une panne ne laisse pas un dossier clos à moitié', async () => {
    const t = await ready();
    t.setClock(at9('2027-06-11'));
    const broken: SqlDatabase = {
      exec: (q) => t.db.exec(q),
      all: (q, p) => t.db.all(q, p),
      first: (q, p) => t.db.first(q, p),
      run: (q, p) => t.db.run(q, p),
      batch: (list) => t.db.batch!(list.map((x) => (x.sql.includes('INSERT INTO sale_commissions') ? { ...x, sql: 'INSERT INTO table_absente VALUES (1)', params: [] } : x))),
    };
    await expect(new ActeVente(broken, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).rejects.toThrow();
    expect(await t.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [t.fileId])).toBeNull();
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('under_offer');
    expect(await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: true, value: { signedOn: '2027-06-10' } });
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('sold');
  });

  it('[R58] pas d’acte sans compromis en préparation ni compromis signé ; un jour réel, prouvé, ni futur ni avant le compromis', async () => {
    const t = await setupDossier('terrain');
    const acte = new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now });
    t.setClock(at9('2027-03-10'));
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-10', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: 'R58', code: 'compromis_not_started' });
    await t.startCompromis();
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-10', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: null, code: 'compromis_missing' });
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-09', proofRef: PROOF });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-08', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: null, code: 'before_compromis' });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-11', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: null, code: 'future_day' });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-02-30', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-10', proofRef: 'attestation.pdf' })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
  });

  it('[R16] seul l’agent du dossier rapporte l’acte ; direction et conformité lisent la clôture ; un autre agent rien', async () => {
    const t = await ready();
    t.setClock(at9('2027-06-11'));
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    for (const v of [t.direction, compliance]) expect(await t.acte.record(v, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.acte.record(t.sam, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).toMatchObject({ ok: false, rule: 'R16' });
    await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    for (const v of [t.direction, compliance, t.agent]) expect(await t.acte.closing(v, t.fileId)).toMatchObject({ ok: true, value: { signedOn: '2027-06-10' } });
    // Le bien vendu n'est plus au fichier commun : un autre agent ne le voit plus.
    expect(await t.acte.closing(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('le dossier clos n’a plus d’échéances ni de tâches', async () => {
    const t = await ready();
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    t.setClock(at9('2027-06-11'));
    await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    expect(await e.run(t.network.id)).toBe(0);
    expect(await e.tasksOf(t.agent)).toEqual({ ok: true, tasks: [] });
  });
});
