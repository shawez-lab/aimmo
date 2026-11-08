import { expect, it } from 'vitest';
import { AvantContrat, briefText, compareDraft, differenceText, type BriefTerms, type DraftTerms } from '../src/avant-contrat/index.ts';
import { Echeancier } from '../src/dossiers/echeancier.ts';
import { fundsInOutgoing } from '../src/envoi/texte.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Dossier, montants, dates et pièces inventés. Mercredi 10 mars 2027, 10 h à Paris.
const WED_10H = new Date('2027-03-10T09:00:00.000Z');
let refs = 0;

async function setup(kind: 'appartement' | 'maison' = 'appartement', o: { start?: boolean } = {}) {
  const t = await setupDossier(kind);
  if (o.start !== false) await t.startCompromis();
  t.setClock(WED_10H);
  const ac = new AvantContrat(t.db, t.acces, t.journal, t.storage, { now: t.now });
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  /** Un projet ou une attestation rangés au faux stockage. */
  const doc = () => {
    refs += 1;
    const ref = `preuves/0b6f1d2e-5555-4a2b-8c3d-${String(refs).padStart(12, '0')}.pdf`;
    t.storage.refs.add(ref);
    return ref;
  };
  t.storage.refs.add(PROOF);
  const brief = async (patch: Record<string, unknown> = {}) => {
    const r = await ac.prepare(t.agent, t.fileId, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15', ...patch });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  /** Un projet du notaire conforme à la note par défaut ; `patch` change un terme. */
  const same = (patch: Record<string, unknown> = {}) => ({
    documentRef: doc(),
    priceEur: { value: 205000, page: 2 },
    conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
    loanDeadline: { value: '2027-04-30', page: 4 },
    deedBy: { value: '2027-06-15', page: 7 },
    deposit: { eur: 10000, holder: 'notaire', page: 5 },
    ...patch,
  });
  return { ...t, ac, echeancier, doc, brief, same };
}

const BASE: BriefTerms = { priceEur: 205000, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }], depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' };
const DRAFT: DraftTerms = {
  priceEur: { value: 205000, page: 2 },
  conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
  loanDeadline: { value: '2027-04-30', page: 4 },
  deedBy: { value: '2027-06-15', page: 7 },
  deposit: { eur: 10000, holder: 'notaire', page: 5 },
};

describeWithSqlite('HX45 · avant-contrat préparé, et projet du notaire comparé à l’offre', () => {
  it('[R510] la note reprend le prix du dossier et les conditions de l’offre acceptée, sans les changer ; rien avant l’identité vérifiée', async () => {
    const early = await setup('appartement', { start: false });
    expect(await early.ac.prepare(early.agent, early.fileId, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' })).toEqual({ ok: false, rule: 'R58', code: 'compromis_not_started' });
    const t = await setup();
    const b = await t.brief();
    expect(b.terms).toEqual(BASE);
    expect(b.version).toBe(1);
    // Ce que l'offre porte ne s'écrit pas : un prix ou une condition passés en entrée ne changent rien.
    const r = await t.ac.prepare(t.agent, t.fileId, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15', priceEur: 1, conditions: [] } as never);
    expect(r).toMatchObject({ ok: true, value: { id: b.id, version: 1, terms: BASE } });
    expect(b.text).toContain('Prix convenu : 205 000 €.');
    expect(b.text).toContain("obtention du prêt de 150 000 € sur 240 mois");
    // La date limite du prêt est exigée avec une condition de prêt ; l'ordre des dates est tenu.
    expect(await t.ac.prepare(t.agent, t.fileId, { depositEur: 10000, loanDeadline: null, deedBy: '2027-06-15' })).toMatchObject({ ok: false, code: 'bad_loan_deadline' });
    expect(await t.ac.prepare(t.agent, t.fileId, { depositEur: 10000, loanDeadline: '2027-07-01', deedBy: '2027-06-15' })).toMatchObject({ ok: false, code: 'bad_order' });
    expect(await t.ac.prepare(t.agent, t.fileId, { depositEur: 205001, loanDeadline: '2027-04-30', deedBy: '2027-06-15' })).toMatchObject({ ok: false, code: 'bad_deposit' });
    // Une autre date prévue : nouvelle version, l'ancienne reste [R17].
    const v2 = await t.brief({ deedBy: '2027-06-30' });
    expect(v2.version).toBe(2);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM pre_contract_briefs WHERE file_id = ?', [t.fileId])).toEqual({ n: 2 });
    await expect(t.db.run('UPDATE pre_contract_briefs SET terms = ? WHERE id = ?', ['{}', b.id])).rejects.toThrow(/réécrit/);
  });

  it('[R511] un projet conforme ne signale rien ; chaque différence est signalée avec sa page, dans un ordre fixe', async () => {
    expect(compareDraft(BASE, DRAFT)).toEqual([]);
    const t = await setup();
    await t.brief();
    const ok = await t.ac.recordDraft(t.agent, t.fileId, t.same());
    expect(ok).toMatchObject({ ok: true, value: { differences: [], dates: null } });
    const r = await t.ac.recordDraft(
      t.agent,
      t.fileId,
      t.same({
        priceEur: { value: 210000, page: 2 },
        conditions: [{ kind: 'pret', amountEur: 160000, durationMonths: 300, page: 4 }, { kind: 'vente_autre_bien', page: 4 }],
        loanDeadline: { value: '2027-05-15', page: 4 },
        deedBy: null,
        deposit: { eur: 20500, holder: 'notaire', page: 5 },
      }),
    );
    if (!r.ok) throw new Error(r.code);
    expect(r.value.draft.version).toBe(2);
    expect(r.value.differences).toEqual([
      { field: 'prix', expected: '205 000 €', found: '210 000 €', page: 2, blocking: false },
      { field: 'condition.pret.amountEur', expected: '150 000 €', found: '160 000 €', page: 4, blocking: false },
      { field: 'condition.pret.durationMonths', expected: '240 mois', found: '300 mois', page: 4, blocking: false },
      { field: 'condition.vente_autre_bien', expected: null, found: 'ajoutée', page: 4, blocking: false },
      { field: 'date_limite_pret', expected: '30/04/2027', found: '15/05/2027', page: 4, blocking: false },
      { field: 'acte_prevu', expected: '15/06/2027', found: null, page: null, blocking: false },
      { field: 'depot_garantie.montant', expected: '10 000 €', found: '20 500 €', page: 5, blocking: false },
    ]);
    // Une condition de l'offre absente du projet est signalée aussi.
    expect(compareDraft(BASE, { ...DRAFT, conditions: [] })).toEqual([{ field: 'condition.pret', expected: "obtention du prêt de 150 000 € sur 240 mois", found: null, page: null, blocking: false }]);
    // Rangées une fois avec le projet, relues telles quelles, avec leur texte pour l'agent.
    const s = await t.ac.state(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    expect(s.value.differences).toEqual(r.value.differences);
    expect(s.value.texts[0]).toBe("Prix : 205 000 € dans l'offre acceptée et le dossier, 210 000 € dans le projet du notaire (page 2).");
    expect(s.value.texts[3]).toContain("vente d'un autre bien");
    // Le même projet lu de la même façon : rien de neuf.
    const again = await t.ac.recordDraft(t.agent, t.fileId, { ...t.same(), documentRef: r.value.draft.documentRef, priceEur: { value: 210000, page: 2 }, conditions: [{ kind: 'pret', amountEur: 160000, durationMonths: 300, page: 4 }, { kind: 'vente_autre_bien', page: 4 }], loanDeadline: { value: '2027-05-15', page: 4 }, deedBy: null, deposit: { eur: 20500, holder: 'notaire', page: 5 } });
    expect(again).toMatchObject({ ok: true, value: { draft: { version: 2 } } });
    // Au journal : les noms des termes, aucun montant ni date.
    const ev = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'avant_contrat.projet').at(-1)!;
    expect(ev.data).toEqual({ rule: 'R511', version: 2, differences: ['prix', 'condition.pret.amountEur', 'condition.pret.durationMonths', 'condition.vente_autre_bien', 'date_limite_pret', 'acte_prevu', 'depot_garantie.montant'], blocking: false });
    expect(JSON.stringify(ev.data)).not.toMatch(/\d{4}/);
  });

  it('[R511] un projet sans note, mal saisi ou absent du stockage est refusé', async () => {
    const t = await setup();
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same())).toEqual({ ok: false, rule: null, code: 'no_brief' });
    await t.brief();
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same({ priceEur: { value: 205000 } }))).toMatchObject({ ok: false, code: 'bad_priceEur' });
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same({ conditions: [{ kind: 'pret', amountEur: 1, durationMonths: 1, page: 1 }, { kind: 'pret', amountEur: 1, durationMonths: 1, page: 1 }] }))).toMatchObject({ ok: false, code: 'bad_conditions.1' });
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same({ deposit: { eur: 10000, holder: 'banque', page: 5 } }))).toMatchObject({ ok: false, code: 'bad_deposit' });
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same({ documentRef: 'preuves/0b6f1d2e-5555-4a2b-8c3d-999999999999.pdf' }))).toMatchObject({ ok: false, code: 'not_stored' });
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same({ documentRef: 'projet.pdf' }))).toMatchObject({ ok: false, code: 'bad_document' });
  });

  it('[R512] le dépôt de garantie est reçu par le notaire seul : un projet qui le confie à un autre est bloquant, la base refuse tout autre destinataire', async () => {
    const t = await setup();
    await t.brief();
    const r = await t.ac.recordDraft(t.agent, t.fileId, t.same({ deposit: { eur: 10000, holder: 'agence', page: 5 } }));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.differences).toEqual([{ field: 'depot_garantie.detenteur', expected: 'le notaire', found: "l'agence", page: 5, blocking: true }]);
    expect(differenceText(r.value.differences[0]!)).toContain("À faire corriger : le dépôt de garantie est reçu par le notaire, jamais par l'agence ni par le vendeur.");
    // Saisi comme reçu par un autre que le notaire : refusé, par le code et par la base.
    const attest = t.doc();
    for (const receivedBy of ['agence', 'aimmo', 'agent', 'vendeur', undefined]) {
      expect(await t.ac.recordDeposit(t.agent, t.fileId, { amountEur: 10000, receivedBy, receivedOn: '2027-03-10', proofRef: attest })).toEqual({ ok: false, rule: 'R512', code: 'notary_only' });
    }
    await expect(
      t.db.run("INSERT INTO pre_contract_deposits (file_id, network_id, version, amount_eur, received_by, received_on, proof_ref, recorded_by, recorded_at) VALUES (?, ?, 1, 10000, 'agence', '2027-03-10', ?, 'x', 'x')", [t.fileId, t.network.id, attest]),
    ).rejects.toThrow(/CHECK/i);
    // Reçu par le notaire, avec son attestation : suivi, et comparé au dépôt du dernier projet.
    const ok = await t.ac.recordDeposit(t.agent, t.fileId, { amountEur: 10000, receivedBy: 'notaire', receivedOn: '2027-03-10', proofRef: attest });
    expect(ok).toEqual({ ok: true, value: { expectedEur: 10000, receivedEur: 10000, receivedBy: 'notaire', receivedOn: '2027-03-10', status: 'recu' } });
    const gap = await t.ac.recordDeposit(t.agent, t.fileId, { amountEur: 9000, receivedBy: 'notaire', receivedOn: '2027-03-10', proofRef: attest });
    expect(gap).toMatchObject({ ok: true, value: { status: 'ecart', receivedEur: 9000 } });
    expect(await t.ac.recordDeposit(t.agent, t.fileId, { amountEur: 9000, receivedBy: 'notaire', receivedOn: '2027-03-11', proofRef: attest })).toMatchObject({ ok: false, code: 'bad_day' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM pre_contract_deposits WHERE file_id = ?', [t.fileId])).toEqual({ n: 2 });
  });

  it('[R512] [R62] aucun texte n’appelle un versement ni ne donne de coordonnée bancaire, et chacun dit que l’argent passe par le notaire', async () => {
    const variants: BriefTerms[] = [BASE, { ...BASE, depositEur: 0 }, { ...BASE, conditions: [], loanDeadline: null }, { ...BASE, conditions: [{ kind: 'pret', amountEur: 1, durationMonths: 1 }, { kind: 'vente_autre_bien' }, { kind: 'permis_construire' }, { kind: 'certificat_urbanisme' }, { kind: 'autre' }], depositEur: 99999 }];
    for (const v of variants) {
      const text = briefText(v);
      expect(fundsInOutgoing(text)).toBe(false);
      expect(text).toContain("AIMMO et l'agent immobilier ne reçoivent jamais de fonds : tout l'argent de la vente passe par le notaire.");
    }
    const all = compareDraft(BASE, { priceEur: { value: 1, page: 1 }, conditions: [{ kind: 'autre', page: 2 }], loanDeadline: null, deedBy: { value: '2028-01-01', page: 3 }, deposit: { eur: 5, holder: 'vendeur', page: 4 } });
    expect(all.map((d) => d.field)).toEqual(['prix', 'condition.pret', 'condition.autre', 'date_limite_pret', 'acte_prevu', 'depot_garantie.montant', 'depot_garantie.detenteur']);
    for (const d of all) expect(fundsInOutgoing(differenceText(d))).toBe(false);
    // Aucune colonne ne porte de coordonnée bancaire.
    const t = await setup();
    for (const table of ['pre_contract_briefs', 'notary_drafts', 'notary_draft_differences', 'pre_contract_deposits']) {
      const cols = await t.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      expect(cols.map((c) => c.name).join(' ')).not.toMatch(/iban|bic|rib|account|compte/i);
    }
  });

  it('[R513] les dates du projet remplissent l’échéancier dès la signature, avec le projet pour preuve, sans ressaisie', async () => {
    const t = await setup();
    await t.brief();
    // Avant la signature : le projet est rangé, rien n'est écrit dans l'échéancier.
    const before = await t.ac.recordDraft(t.agent, t.fileId, t.same());
    if (!before.ok) throw new Error(before.code);
    expect(before.value.dates).toBeNull();
    expect(await t.ac.reportDates(t.agent, t.fileId)).toEqual({ ok: false, rule: 'R513', code: 'compromis_not_signed' });
    const signed = await t.echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    if (!signed.ok) throw new Error(signed.code);
    // Un geste : les deux dates passent, avec le projet pour preuve.
    expect(await t.ac.reportDates(t.agent, t.fileId)).toEqual({ ok: true, value: { date_limite_pret: 'ecrite', acte_prevu: 'ecrite' } });
    const s = await t.echeancier.schedule(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    expect(s.value.lines.find((l) => l.deadline === 'date_limite_pret')).toMatchObject({ status: 'datee', day: '2027-04-30' });
    expect(s.value.lines.find((l) => l.deadline === 'acte')).toMatchObject({ status: 'datee', day: '2027-06-15' });
    expect(await t.db.all("SELECT kind, proof_ref FROM sale_file_dates WHERE file_id = ? AND kind IN ('date_limite_pret', 'acte_prevu') ORDER BY kind", [t.fileId])).toEqual([
      { kind: 'acte_prevu', proof_ref: before.value.draft.documentRef },
      { kind: 'date_limite_pret', proof_ref: before.value.draft.documentRef },
    ]);
    // Deux fois : rien de plus.
    expect(await t.ac.reportDates(t.agent, t.fileId)).toEqual({ ok: true, value: { date_limite_pret: 'deja_la', acte_prevu: 'deja_la' } });
    // Un nouveau projet après la signature : ses dates passent seules, en nouvelle version [R17].
    const later = await t.ac.recordDraft(t.agent, t.fileId, t.same({ deedBy: { value: '2027-06-30', page: 7 } }));
    expect(later).toMatchObject({ ok: true, value: { dates: { date_limite_pret: 'deja_la', acte_prevu: 'ecrite' } } });
    expect(await t.db.all("SELECT version, day FROM sale_file_dates WHERE file_id = ? AND kind = 'acte_prevu' ORDER BY version", [t.fileId])).toEqual([
      { version: 1, day: '2027-06-15' },
      { version: 2, day: '2027-06-30' },
    ]);
  });

  it('[R511] une note plus récente que le projet : les différences sont recalculées contre elle, jamais montrées dépassées', async () => {
    const t = await setup();
    await t.brief();
    const r = await t.ac.recordDraft(t.agent, t.fileId, t.same({ deedBy: { value: '2027-06-30', page: 7 } }));
    expect(r).toMatchObject({ ok: true, value: { differences: [{ field: 'acte_prevu' }] } });
    // La note suit le projet : plus rien à signaler.
    await t.brief({ deedBy: '2027-06-30' });
    expect(await t.ac.state(t.agent, t.fileId)).toMatchObject({ ok: true, value: { differences: [], comparedToEarlierBrief: true, blocked: false } });
    // Une note qui s'écarte du projet : la différence apparaît.
    await t.brief({ deedBy: '2027-07-15' });
    const s = await t.ac.state(t.agent, t.fileId);
    expect(s).toMatchObject({ ok: true, value: { differences: [{ field: 'acte_prevu', expected: '15/07/2027', found: '30/06/2027', page: 7 }], comparedToEarlierBrief: true } });
  });

  it('[R512] un projet qui confie le dépôt à un autre que le notaire bloque le report de ses dates jusqu’à sa correction', async () => {
    const t = await setup();
    await t.brief();
    await t.ac.recordDraft(t.agent, t.fileId, t.same({ deposit: { eur: 10000, holder: 'vendeur', page: 5 } }));
    expect(await t.ac.state(t.agent, t.fileId)).toMatchObject({ ok: true, value: { blocked: true } });
    const signed = await t.echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    if (!signed.ok) throw new Error(signed.code);
    expect(await t.ac.reportDates(t.agent, t.fileId)).toEqual({ ok: false, rule: 'R512', code: 'blocking_difference' });
    expect(await t.ac.run(t.network.id)).toBe(0);
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sale_file_dates WHERE file_id = ? AND kind IN ('date_limite_pret', 'acte_prevu')", [t.fileId])).toEqual({ n: 0 });
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).some((e) => e.type === 'avant_contrat.dates_bloquees')).toBe(true);
    // Le projet corrigé : ses dates passent aussitôt.
    expect(await t.ac.recordDraft(t.agent, t.fileId, t.same())).toMatchObject({ ok: true, value: { differences: [], dates: { date_limite_pret: 'ecrite', acte_prevu: 'ecrite' } } });
  });

  it('[R513] la signature saisie après le projet : le passage du système remplit l’échéancier, sans geste ni ressaisie', async () => {
    const t = await setup();
    await t.brief();
    const d = await t.ac.recordDraft(t.agent, t.fileId, t.same());
    if (!d.ok) throw new Error(d.code);
    expect(await t.ac.run(t.network.id)).toBe(0);
    const signed = await t.echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    if (!signed.ok) throw new Error(signed.code);
    expect(await t.ac.run(t.network.id)).toBe(2);
    expect(await t.db.all("SELECT kind, day, proof_ref, by FROM sale_file_dates WHERE file_id = ? AND kind IN ('date_limite_pret', 'acte_prevu') ORDER BY kind", [t.fileId])).toEqual([
      { kind: 'acte_prevu', day: '2027-06-15', proof_ref: d.value.draft.documentRef, by: 'system:avant-contrat' },
      { kind: 'date_limite_pret', day: '2027-04-30', proof_ref: d.value.draft.documentRef, by: 'system:avant-contrat' },
    ]);
    // Le passage suivant n'ajoute rien ; aucune date « à saisir » ne reste pour ces deux échéances.
    expect(await t.ac.run(t.network.id)).toBe(0);
    const s = await t.echeancier.schedule(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const k of ['date_limite_pret', 'acte']) expect(s.value.lines.find((l) => l.deadline === k)?.status).toBe('datee');
    // Une date hors de l'ordre du compromis n'est pas écrite.
    const late = await setup();
    await late.brief();
    await late.ac.recordDraft(late.agent, late.fileId, late.same({ deedBy: { value: '2027-03-01', page: 7 } }));
    const sig = await late.echeancier.record(late.agent, late.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    if (!sig.ok) throw new Error(sig.code);
    expect(await late.ac.run(late.network.id)).toBe(1);
    expect(await late.db.all("SELECT kind FROM sale_file_dates WHERE file_id = ? AND kind IN ('date_limite_pret', 'acte_prevu')", [late.fileId])).toEqual([{ kind: 'date_limite_pret' }]);
    expect((await late.journal.bySubject(`sale_file:${late.fileId}`)).filter((e) => e.type === 'avant_contrat.dates').at(-1)?.data).toEqual({ rule: 'R513', version: 1, report: { date_limite_pret: 'ecrite', acte_prevu: 'before_compromis' } });
  });

  it('[R16] seul l’agent du bien prépare et range ; direction et conformité lisent ; un autre agent ne voit rien', async () => {
    const t = await setup();
    await t.brief();
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    for (const v of [t.direction, compliance]) {
      expect(await t.ac.prepare(v, t.fileId, { depositEur: 0, loanDeadline: '2027-04-30', deedBy: '2027-06-15' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.ac.recordDraft(v, t.fileId, t.same())).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.ac.state(v, t.fileId)).toMatchObject({ ok: true, value: { brief: { version: 1 } } });
    }
    expect(await t.ac.state(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.ac.recordDeposit(t.sam, t.fileId, { amountEur: 1, receivedBy: 'notaire', receivedOn: '2027-03-10', proofRef: t.doc() })).toMatchObject({ ok: false, rule: 'R16' });
  });
});
