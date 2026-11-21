import { expect, it } from 'vitest';
import { CheminCritique, Echeancier } from '../src/dossiers/index.ts';
import { DIA_FIELDS, EtatRisques, RISK_STATEMENT_VALIDITY_MONTHS } from '../src/documents/etat-risques.ts';
import { SOURCES, type PublicFacts } from '../src/estimation/collecte.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Données publiques inventées, telles que la collecte de E03 les rend : adresse, parcelle et risques de test.
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
function facts(o: { addressAt?: string; parcelAt?: string; risksAt?: string; risksDown?: boolean; parcelMissing?: boolean } = {}): PublicFacts {
  const addressAt = o.addressAt ?? '2027-02-20T09:00:00.000Z';
  return {
    address: { ok: true, source: SOURCES.address, collectedAt: addressAt, value: { label: '1 Rue de l’Exemple 21000 Dijon', lat: 47.32, lon: 5.04, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: 'test-ban', score: 0.95 } },
    parcel: o.parcelMissing
      ? { ok: false, source: SOURCES.parcel, collectedAt: o.parcelAt ?? addressAt, reason: 'introuvable' }
      : { ok: true, source: SOURCES.parcel, collectedAt: o.parcelAt ?? addressAt, value: { id: '21231000AB0042', section: 'AB', number: '0042', area: 312 } },
    energy: { ok: false, source: SOURCES.energy, collectedAt: addressAt, reason: 'introuvable' },
    risks: o.risksDown
      ? { ok: false, source: SOURCES.risks, collectedAt: o.risksAt ?? addressAt, reason: 'panne' }
      : { ok: true, source: SOURCES.risks, collectedAt: o.risksAt ?? addressAt, value: [{ code: '11', label: 'Inondation' }, { code: '13', label: 'Séisme' }] },
    missing: [],
  };
}

async function setup() {
  const t = await setupDossier('maison');
  const etat = new EtatRisques(t.db, t.acces, t.journal, t.storage, { now: t.now });
  return { ...t, etat };
}

describeWithSqlite('HX34 · état des risques et déclaration d’intention d’aliéner préparés', () => {
  it('[R444] chaque rubrique de l’état cite sa source et son jour de collecte ; ce qui manque est dit, la déclaration du vendeur n’est jamais remplie', async () => {
    const t = await setup();
    const r = await t.etat.prepare(t.agent, t.fileId, facts({ parcelAt: '2027-02-10T23:30:00.000Z' }));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.rubrics.map((l) => l.rubric)).toEqual(['adresse', 'parcelle', 'risques', 'sinistres_indemnises']);
    for (const l of r.value.rubrics) {
      expect(l.source.length).toBeGreaterThan(0);
      if (l.filled) expect(l.collectedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(r.value.rubrics.find((l) => l.rubric === 'risques')).toMatchObject({ filled: true, source: SOURCES.risks, collectedOn: '2027-02-20', value: [{ code: '11', label: 'Inondation' }, { code: '13', label: 'Séisme' }] });
    // Le jour est celui de Paris : 23 h 30 en temps universel le 10 février, c'est le 11 à Paris.
    expect(r.value.rubrics.find((l) => l.rubric === 'parcelle')).toMatchObject({ filled: true, collectedOn: '2027-02-11' });
    expect(r.value.rubrics.find((l) => l.rubric === 'sinistres_indemnises')).toEqual({ rubric: 'sinistres_indemnises', filled: false, value: null, source: 'déclaration du vendeur', collectedOn: null, reason: 'a_declarer_par_le_vendeur' });
    // La date de l'état est celle de la donnée la plus ancienne ; il vaut 6 mois.
    expect(RISK_STATEMENT_VALIDITY_MONTHS).toBe(6);
    expect(r.value).toMatchObject({ complete: true, statementDate: '2027-02-11', validUntil: '2027-08-10', version: 1 });
    expect(r.value.hash).toMatch(/^[0-9a-f]{64}$/);
    // Une source en panne : la rubrique dit sa raison, l'état n'est pas complet et ne se range pas.
    const down = await t.etat.prepare(t.agent, t.fileId, facts({ risksDown: true }));
    if (!down.ok) throw new Error(down.code);
    expect(down.value.rubrics.find((l) => l.rubric === 'risques')).toEqual({ rubric: 'risques', filled: false, value: null, source: SOURCES.risks, collectedOn: '2027-02-20', reason: 'panne' });
    expect(down.value).toMatchObject({ complete: false, version: 2 });
    expect(await t.etat.range(t.agent, t.fileId, { statementId: down.value.id, ref: t.upload() })).toEqual({ ok: false, rule: null, code: 'incomplete' });
    // Une version plus ancienne ne se range pas : seule la dernière compte.
    expect(await t.etat.range(t.agent, t.fileId, { statementId: r.value.id, ref: t.upload() })).toEqual({ ok: false, rule: null, code: 'not_latest' });
    // Une donnée qui ne vient pas de la collecte, ou datée du futur, est refusée.
    const f = facts();
    expect(await t.etat.prepare(t.agent, t.fileId, { ...f, risks: { ...f.risks, source: 'Un site quelconque' } } as PublicFacts)).toEqual({ ok: false, rule: null, code: 'bad_facts' });
    expect(await t.etat.prepare(t.agent, t.fileId, facts({ risksAt: '2027-03-02T09:00:00.000Z' }))).toEqual({ ok: false, rule: null, code: 'bad_facts' });
    // Le journal ne porte ni adresse, ni parcelle, ni risque.
    const events = JSON.stringify(await t.db.all("SELECT data FROM journal WHERE type LIKE 'dossier.etat_risques%'"));
    // Des chaînes qu'un identifiant tiré au hasard ne peut pas contenir par chance (« 0042 » seul l'a pu).
    for (const s of ['Exemple', 'Dijon', 'AB0042', '"0042"', 'Inondation', '21231000']) expect(events).not.toContain(s);
  });

  it('[R445] l’état rangé entre dans le chemin critique : plus de 6 mois au jour de l’acte, il est signalé', async () => {
    const t = await setup();
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const chemin = new CheminCritique(t.db, t.acces, t.journal, t.storage, { now: t.now });
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['acte_prevu', '2027-06-10']]) {
      const r = await e.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
    // Un état fait de données du 1er décembre 2026 vaut jusqu'au 31 mai 2027 : périmé à l'acte prévu du 10 juin.
    const old = await t.etat.prepare(t.agent, t.fileId, facts({ addressAt: '2026-12-01T09:00:00.000Z' }));
    if (!old.ok) throw new Error(old.code);
    expect(old.value.validUntil).toBe('2027-05-31');
    const ranged = await t.etat.range(t.agent, t.fileId, { statementId: old.value.id, ref: t.upload() });
    if (!ranged.ok) throw new Error(ranged.code);
    expect(ranged.value.lines.find((l) => l.piece === 'etat_risques')?.received).toMatchObject({ issuedOn: '2026-12-01', version: 1 });
    expect(await t.etat.validity(t.agent, t.fileId)).toEqual({ ok: true, value: { statementId: old.value.id, statementDate: '2026-12-01', validUntil: '2027-05-31', actDay: '2027-06-10', actDaySource: 'acte_prevu', expiredAtAct: true } });
    const path = await chemin.of(t.agent, t.fileId);
    if (!path.ok) throw new Error(path.code);
    expect(path.value.path.lines).toContainEqual({ reason: 'piece_perimee', item: 'etat_risques', who: 'vendeur', notBefore: null });
    expect(await t.db.first("SELECT 1 AS x FROM journal WHERE type = 'dossier.etat_risques_perime_a_l_acte'")).toEqual({ x: 1 });
    // Un nouvel état, de données fraîches, rangé : plus de pièce périmée, plus de signal.
    const fresh = await t.etat.prepare(t.agent, t.fileId, facts({ addressAt: '2027-03-10T09:00:00.000Z' }));
    if (!fresh.ok) throw new Error(fresh.code);
    const again = await t.etat.range(t.agent, t.fileId, { statementId: fresh.value.id, ref: t.upload() });
    if (!again.ok) throw new Error(again.code);
    expect(await t.etat.validity(t.agent, t.fileId)).toMatchObject({ ok: true, value: { validUntil: '2027-09-09', expiredAtAct: false } });
    const after = await chemin.of(t.agent, t.fileId);
    if (!after.ok) throw new Error(after.code);
    expect(after.value.path.lines.filter((l) => l.item === 'etat_risques')).toEqual([]);
  });

  it('[R446] la déclaration d’intention d’aliéner : chaque champ rempli dit d’où il vient, aucun champ sans donnée du dossier', async () => {
    const t = await setup();
    // Sans état ni échéancier : adresse, parcelle et date de l'acte restent vides, avec leur raison.
    const bare = await t.etat.dia(t.agent, t.fileId);
    if (!bare.ok) throw new Error(bare.code);
    expect(bare.value.lines.map((l) => l.field)).toEqual([...DIA_FIELDS]);
    for (const l of bare.value.lines) {
      if (l.value === null) expect(l.from).toBeNull();
      else expect(l.from).not.toBeNull();
    }
    for (const field of ['adresse', 'parcelle', 'date_acte_prevue', 'honoraires']) expect(bare.value.lines.find((l) => l.field === field)).toEqual({ field, value: null, from: null, reason: 'absent_du_dossier' });
    for (const field of ['proprietaire', 'acquereur']) expect(bare.value.lines.find((l) => l.field === field)).toEqual({ field, value: null, from: null, reason: 'tenu_par_le_notaire' });
    expect(bare.value.toComplete).toEqual(expect.arrayContaining(['adresse', 'parcelle', 'date_acte_prevue', 'honoraires', 'proprietaire', 'acquereur']));
    // Les champs remplis viennent du bien, de sa fiche et du dossier, avec leur référence.
    const sale = await t.db.first<{ amount_eur: number }>('SELECT amount_eur FROM sale_files WHERE id = ?', [t.fileId]);
    expect(bare.value.lines.find((l) => l.field === 'prix')).toEqual({ field: 'prix', value: sale!.amount_eur, from: { kind: 'dossier', ref: `sale_file:${t.fileId}` } });
    expect(bare.value.lines.find((l) => l.field === 'surface_terrain')).toMatchObject({ value: 450, from: { kind: 'fiche', ref: `property:${t.propertyId}` } });
    expect(bare.value.lines.find((l) => l.field === 'lot_copropriete')).toMatchObject({ value: 'non', from: { kind: 'fiche' } });
    expect(bare.value.lines.find((l) => l.field === 'nature')).toMatchObject({ value: 'immeuble bâti', from: { kind: 'bien', ref: `property:${t.propertyId}` } });
    // Avec l'état et l'acte prévu : adresse et parcelle reprises de l'état, avec leur source et leur jour.
    const st = await t.etat.prepare(t.agent, t.fileId, facts());
    if (!st.ok) throw new Error(st.code);
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['acte_prevu', '2027-06-10']]) {
      const r = await e.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
    const full = await t.etat.dia(t.agent, t.fileId);
    if (!full.ok) throw new Error(full.code);
    expect(full.value.lines.find((l) => l.field === 'adresse')).toEqual({ field: 'adresse', value: '1 Rue de l’Exemple 21000 Dijon', from: { kind: 'etat_risques', ref: `risk_statement:${st.value.id}`, source: SOURCES.address, collectedOn: '2027-02-20' } });
    expect(full.value.lines.find((l) => l.field === 'parcelle')).toMatchObject({ value: 'section AB, n° 0042 (21231000AB0042)', from: { kind: 'etat_risques', source: SOURCES.parcel } });
    expect(full.value.lines.find((l) => l.field === 'date_acte_prevue')).toMatchObject({ value: '2027-06-10', from: { kind: 'echeancier', ref: `sale_file:${t.fileId}` } });
    // Aucun nom de personne dans la déclaration préparée.
    const json = JSON.stringify(full.value);
    for (const s of ['Léa', 'Acheteur', t.personId, t.buyerId]) expect(json).not.toContain(s);
    // Une parcelle introuvable à la collecte ne se devine pas.
    await t.etat.prepare(t.agent, t.fileId, facts({ parcelMissing: true }));
    const noParcel = await t.etat.dia(t.agent, t.fileId);
    if (!noParcel.ok) throw new Error(noParcel.code);
    expect(noParcel.value.lines.find((l) => l.field === 'parcelle')).toEqual({ field: 'parcelle', value: null, from: null, reason: 'absent_du_dossier' });
    // Le journal ne porte aucun prix.
    const events = JSON.stringify(await t.db.all("SELECT data FROM journal WHERE type = 'dossier.dia_preparee'"));
    expect(events).not.toContain(String(sale!.amount_eur));
  });

  it('[R446] un terrain : sa surface vient du bien, pas de surface habitable', async () => {
    const t = await setupDossier('terrain');
    const etat = new EtatRisques(t.db, t.acces, t.journal, t.storage, { now: t.now });
    const p = await t.db.first<{ surface_m2: number }>('SELECT surface_m2 FROM properties WHERE id = ?', [t.propertyId]);
    const r = await etat.dia(t.agent, t.fileId);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.lines.find((l) => l.field === 'surface_terrain')).toEqual({ field: 'surface_terrain', value: p!.surface_m2, from: { kind: 'bien', ref: `property:${t.propertyId}` } });
    expect(r.value.lines.find((l) => l.field === 'surface_habitable')).toEqual({ field: 'surface_habitable', value: null, from: null, reason: 'sans_objet' });
    expect(r.value.lines.find((l) => l.field === 'nature')).toMatchObject({ value: 'terrain non bâti' });
  });

  it('[R447] une erreur de la base qui n’est pas un conflit de version n’est pas tue', async () => {
    const t = await setup();
    const run = t.db.run.bind(t.db);
    t.db.run = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO risk_statements')) throw new Error('disque plein');
      return run(sql, params as never);
    }) as typeof t.db.run;
    await expect(t.etat.prepare(t.agent, t.fileId, facts())).rejects.toThrow('disque plein');
    t.db.run = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO risk_statements')) throw new Error('UNIQUE constraint failed: risk_statements.file_id, risk_statements.version');
      return run(sql, params as never);
    }) as typeof t.db.run;
    expect(await t.etat.prepare(t.agent, t.fileId, facts())).toEqual({ ok: false, rule: null, code: 'busy' });
  });

  it('[R16] [R447] seul l’agent du bien prépare et range ; direction et conformité lisent ; rien ne s’efface ni ne se réécrit', async () => {
    const t = await setup();
    expect(await t.etat.prepare(t.sam, t.fileId, facts())).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.etat.prepare(t.direction, t.fileId, facts())).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.etat.latest(t.agent, t.fileId)).toEqual({ ok: false, rule: null, code: 'no_statement' });
    const r = await t.etat.prepare(t.agent, t.fileId, facts());
    if (!r.ok) throw new Error(r.code);
    for (const v of [t.agent, t.direction, { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' }]) expect(await t.etat.latest(v, t.fileId)).toMatchObject({ ok: true, value: { id: r.value.id } });
    expect(await t.etat.latest(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.etat.dia(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.etat.range(t.direction, t.fileId, { statementId: r.value.id, ref: t.upload() })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.etat.prepare(t.agent, 'dossier-inconnu', facts())).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    await expect(t.db.run('DELETE FROM risk_statements WHERE id = ?', [r.value.id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE risk_statements SET complete = 0 WHERE id = ?', [r.value.id])).rejects.toThrow(/rien ne se réécrit/);
  });
});
