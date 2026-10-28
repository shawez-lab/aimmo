import { describe, expect, it } from 'vitest';
import { DecisionEnvoi, FicheUnique, applyMigrations, conformite, fromSyncSqlite, verifyChain, type SqlDatabase, type SqlValue, type Viewer } from '../src/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { CARTE_ACCES, REGISTRE_TRAITEMENTS, MASKED, accessOrder, assembleAccess, checkAccessMap, describeAccessGap, readSchema, erasurePlan } = conformite;

// Deux personnes inventées : chaque valeur rangée pour l'une porte son identifiant, pour voir d'où vient chaque donnée.
const A = 'pa-0001';
const B = 'pb-0002';

const gapsOf = (sql: string, carte = CARTE_ACCES, registre = REGISTRE_TRAITEMENTS) =>
  checkAccessMap(readSchema([...loadMigrations(), { id: '9999_essai', sql }]), registre, carte);

describe('L07 · carte des demandes d’accès vérifiée contre la base (Jamais vu)', () => {
  it('[R96] chaque table du registre est dans la carte, et chaque colonne qui désigne une personne y est suivie', () => {
    const gaps = checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, CARTE_ACCES);
    expect(gaps.map(describeAccessGap)).toEqual([]);
    // Toutes les tables du registre, ni plus ni moins.
    const registered = REGISTRE_TRAITEMENTS.flatMap((t) => Object.keys(t.tables)).sort();
    expect(Object.keys(CARTE_ACCES).sort()).toEqual(registered);
  });

  it('[R96] une table ajoutée au registre sans la carte, ou une personne non suivie, fait échouer la vérification', () => {
    const registre = [...REGISTRE_TRAITEMENTS, { ...REGISTRE_TRAITEMENTS[0]!, id: 'essai', tables: { essai_contacts: ['person_id', 'note'] } }];
    expect(gapsOf('CREATE TABLE essai_contacts (id TEXT PRIMARY KEY, person_id TEXT, note TEXT);', CARTE_ACCES, registre)).toEqual([{ kind: 'table_absente', table: 'essai_contacts' }]);
    expect(describeAccessGap({ kind: 'table_absente', table: 'essai_contacts' })).toContain('pas dans la carte');
    // Une colonne ajoutée qui désigne une personne, sur une table lue par une autre voie.
    expect(gapsOf('ALTER TABLE visit_slips ADD COLUMN visitor_person_id TEXT;')).toEqual([{ kind: 'personne_non_suivie', table: 'visit_slips', column: 'visitor_person_id' }]);
    // Une table écartée qui gagne une personne : l'écart n'est plus fondé.
    expect(gapsOf('ALTER TABLE agents ADD COLUMN person_id TEXT;')).toEqual([{ kind: 'exclusion_mal_fondee', table: 'agents', column: 'person_id' }]);
    // La lutte contre le blanchiment ne sert d'excuse qu'à ses propres tables.
    const wrong = { ...CARTE_ACCES, messages: { excluded: 'lcb_ft' as const, why: 'essai' } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, wrong).map((g) => g.kind)).toEqual(
      expect.arrayContaining(['exclusion_mal_fondee', 'source_inconnue']),
    );
    // Une source inconnue, une colonne fantôme, une boucle.
    const ghost = { ...CARTE_ACCES, visit_tasks: { locate: [{ column: 'appointment_id', from: 'agents', key: 'id' }] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, ghost)).toEqual([{ kind: 'source_inconnue', table: 'visit_tasks', from: 'agents' }]);
    const phantom = { ...CARTE_ACCES, consents: { locate: [{ column: 'person_id' }], secrets: ['fantome'] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, phantom)).toEqual([{ kind: 'colonne_inconnue', table: 'consents', column: 'fantome' }]);
    const loop = { ...CARTE_ACCES, projects: { locate: [{ column: 'person_id' }, { column: 'id', from: 'project_properties', key: 'project_id' }] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, loop).map((g) => g.kind)).toEqual(['boucle']);
  });
});

/**
 * Une base où chaque table de la carte reçoit une ligne pour A et une pour B, chaque colonne remplie d'une valeur qui
 * dit à qui elle est. Les protections de la base sont retirées dans cette base de test seulement, pour pouvoir remplir
 * toutes les tables d'un coup.
 */
async function seedEveryTable() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('PRAGMA ignore_check_constraints = ON');
  for (const { name } of await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")) raw.exec(`DROP TRIGGER "${name}"`);
  const seeded = new Map<string, Record<string, Record<string, SqlValue>>>();
  let n = 0;
  const insert = async (table: string, row: Record<string, SqlValue>) => {
    const cols = Object.keys(row);
    await db.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]!));
  };
  for (const table of accessOrder(CARTE_ACCES)) {
    const entry = CARTE_ACCES[table]!;
    if (!('locate' in entry)) continue;
    const info = await db.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info("${table}")`);
    const rows: Record<string, Record<string, SqlValue>> = {};
    for (const p of [A, B]) {
      const row: Record<string, SqlValue> = {};
      // Le plan du jour est celui d'un agent : ses autres colonnes ne sont à aucun client.
      const owner = entry.locate.some((l) => 'json' in l) ? (p === A ? 'agent-1' : 'agent-2') : p;
      for (const c of info) row[c.name] = c.pk === 1 && /^INTEGER$/i.test(c.type) ? ++n : `${owner}|${table}.${c.name}`;
      for (const l of entry.locate) {
        if ('json' in l) {
          // Le plan d'un agent nomme plusieurs personnes : celui de A nomme aussi B.
          const item = (who: string) => ({ personId: who, memberIds: [who], firstName: `${who}|prenom` });
          row[l.json] = JSON.stringify(p === A ? [item(A), item(B)] : [item(B)]);
          continue;
        }
        for (const [c, v] of Object.entries(l.where ?? {})) row[c] = v;
        if ('from' in l) row[l.column] = `${l.prefix ?? ''}${seeded.get(l.from)![p]![l.key]}`;
        else row[l.column] = `${l.prefix ?? ''}${p}`;
      }
      await insert(table, row);
      rows[p] = row;
    }
    seeded.set(table, rows);
  }
  return { db, raw, seeded, insert };
}

describeWithSqlite('L07 · réponse d’accès assemblée par le code', () => {
  it('[R96] la réponse contient chaque donnée de la personne dans chaque table du registre, et rien d’une autre', async () => {
    const { db, seeded } = await seedEveryTable();
    const response = await assembleAccess(db, [A]);
    const text = JSON.stringify(response);
    // Rien de B, nulle part : ni son identifiant ni une seule de ses valeurs.
    expect(response.sections.filter((x) => JSON.stringify(x).includes(B)).map((x) => x.table)).toEqual([]);
    expect(text).not.toContain(B);
    // Une section par table lue, avec la ligne de A entière.
    const located = Object.keys(CARTE_ACCES).filter((t) => 'locate' in CARTE_ACCES[t]!);
    expect(response.sections.map((s) => s.table).sort()).toEqual(located.sort());
    for (const section of response.sections) {
      const entry = CARTE_ACCES[section.table]!;
      if (!('locate' in entry)) throw new Error(section.table);
      const expected = { ...seeded.get(section.table)![A]! };
      for (const c of entry.secrets ?? []) expected[c] = MASKED;
      for (const l of entry.locate) if ('json' in l) expected[l.json] = JSON.stringify([{ personId: A, memberIds: [A], firstName: `${A}|prenom` }]);
      expect(section.rows, section.table).toEqual([expected]);
      // Chaque table vient avec son traitement : finalité, base légale, durée, destinataires (RGPD, article 15).
      const t = REGISTRE_TRAITEMENTS.find((r) => section.table in r.tables)!;
      expect(section).toMatchObject({ traitement: t.id, finalite: t.finalite, duree: t.duree, destinataires: t.destinataires });
    }
    // Les tables écartées disent pourquoi, et la liste est la même pour tout le monde.
    expect(response.notIncluded.map((x) => x.reason)).toEqual(['sans_client', 'agent', 'candidat', 'partenaire', 'non_rattachable', 'lcb_ft']);
    expect(response.notIncluded.find((x) => x.reason === 'lcb_ft')!.text).toContain('CNIL');
    // B reçoit la sienne, sans rien de A ; la même base donne la même réponse.
    const forB = await assembleAccess(db, [B]);
    expect(forB.sections.filter((x) => JSON.stringify(x).includes(A)).map((x) => x.table)).toEqual([]);
    expect(forB.sections.length).toBe(response.sections.length);
    expect(await conformite.sha256Of(await assembleAccess(db, [A]))).toBe(await conformite.sha256Of(response));
  });

  it('[R96] une ligne qui nomme deux personnes ne montre à chacune que ce qui est à elle', async () => {
    const { db, insert } = await seedEveryTable();
    const C = 'pc-0003';
    // A recommande C : A voit qu'il a recommandé quelqu'un, pas qui ; C voit sa recommandation entière.
    await insert('referrals', { id: 'r-ac', network_id: 'n', referrer_id: A, referred_id: C, project_id: 'proj-c', first_name: 'Prénom de C', agent_id: 'ag', callable: 1, call_due_at: 'x', call_done_at: null, created_by: 'ag', created_at: 't' });
    const ofA = (await assembleAccess(db, [A])).sections.find((s) => s.table === 'referrals')!.rows.find((r) => r.id === 'r-ac')!;
    expect(ofA).toMatchObject({ referrer_id: A, referred_id: MASKED, first_name: MASKED, project_id: MASKED, call_due_at: MASKED });
    const ofC = (await assembleAccess(db, [C])).sections.find((s) => s.table === 'referrals')!.rows;
    expect(ofC).toEqual([expect.objectContaining({ referrer_id: MASKED, referred_id: C, first_name: 'Prénom de C' })]);
    // Le vendeur voit le dossier de vente de son bien sans l'acquéreur, ni son offre, ni son financement.
    await insert('mandates', { id: 'm-2', network_id: 'n', agent_id: 'ag', person_id: A, project_id: null, property_id: 'bien-2', signed_at: 't', source_kind: 'x', source_detail: null, source_id: null, recorded_by: 'ag', created_at: 't' });
    await insert('sale_files', { id: 'f-c', network_id: 'n', property_id: 'bien-2', offer_id: 'offre-de-c', buyer_person_id: C, amount_eur: 250000, opened_at: 't', opened_by: 'ag' });
    await insert('sale_file_financing', { file_id: 'f-c', seq: 1, network_id: 'n', step: 'pret_accorde', day: 'd', declared_by: 'ag', at: 't', by: 'ag' });
    await insert('sale_file_steps', { file_id: 'f-c', step: 'compromis', at: 't', by: 'ag' });
    const seller = await assembleAccess(db, [A]);
    expect(seller.sections.find((s) => s.table === 'sale_files')!.rows.find((r) => r.id === 'f-c')).toMatchObject({ buyer_person_id: MASKED, offer_id: MASKED, amount_eur: 250000 });
    expect(seller.sections.find((s) => s.table === 'sale_file_steps')!.rows.some((r) => r.file_id === 'f-c')).toBe(true);
    expect(seller.sections.find((s) => s.table === 'sale_file_financing')!.rows.some((r) => r.file_id === 'f-c')).toBe(false);
    expect(JSON.stringify(seller)).not.toContain(C);
    const buyer = await assembleAccess(db, [C]);
    expect(buyer.sections.find((s) => s.table === 'sale_file_financing')!.rows).toEqual([expect.objectContaining({ file_id: 'f-c', step: 'pret_accorde' })]);
  });

  it('[R96] la lutte contre le blanchiment ne change rien à la réponse : rien ne trahit un signalement', async () => {
    const { db, insert } = await seedEveryTable();
    const before = await conformite.sha256Of(await assembleAccess(db, [A]));
    await insert('suspicion_reports', { id: 's-1', network_id: 'n', case_ref: 'mandate:x', person_id: A, note: 'note', snapshot: '{}', snapshot_sha256: 'x', reported_by: 'ag', reported_at: 't' });
    await insert('risk_sheets', { id: 'k-1', network_id: 'n', person_id: A, relation: 'vendeur', case_ref: 'mandate:x', grid_version: 'g', inputs: '{}', criteria: '[]', level: 'eleve', fingerprint: 'f', prepared_by: 'ag', prepared_at: 't' });
    for (const [seq, type] of [[9001, 'risque.prepare'], [9002, 'coffre.depose'], [9003, 'vigilance.alerte'], [9004, 'conformite.signalement'], [9005, 'identification.declaree']] as const) {
      await insert('journal', { seq, at: 't', type, actor: 'ag', subject: `person:${A}`, data: '{}', prev_hash: 'p', hash: `h${seq}` });
    }
    expect(await conformite.sha256Of(await assembleAccess(db, [A]))).toBe(before);
  });
});

// Un lundi de février, à 10 h à Paris.
const NOW = new Date('2027-02-01T09:00:00.000Z');

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const demandes = new conformite.DemandesPersonnes(t.db, t.journal, fiche, decisions, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const responsable = as('compliance', 'conformite-1');
  const record = async (kind: conformite.PersonRequestKind, personId = t.personId, receivedOn = '2027-02-01') => {
    const r = await demandes.record(responsable, { personId, kind, channel: 'mail', receivedOn });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, fiche, decisions, demandes, responsable, record, partner: as('partner', 'partenaire-1') };
}

const countAll = async (db: SqlDatabase) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = (await db.first<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`))!.n;
  return out;
};

describeWithSqlite('L07 · demandes des personnes en moins d’un mois, avec preuve', () => {
  it('[R96] [R16] la demande d’accès : réponse de toutes les fiches réunies, empreinte gardée, réponse notée une fois', async () => {
    const t = await setup();
    // Une deuxième fiche de la même personne, réunie à la première ; une autre personne, sans lien.
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Léa', lastName: 'Exemple' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: twin.id, kind: 'email', value: 'lea.double@example.test' });
    await t.fiche.merge({ survivorId: t.personId, mergedId: twin.id, reason: 'même adresse' });
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noé', lastName: 'Autre' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: other.id, kind: 'email', value: 'noe.autre@example.test' });
    const request = await t.record('acces', twin.id);
    // Échéance calculée par le code, un mois après la réception.
    expect(request).toMatchObject({ kind: 'acces', receivedOn: '2027-02-01', dueOn: '2027-03-01', noticeOn: '2027-02-22', answeredOn: null });
    // Personne d'autre que le responsable.
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.demandes.prepareAccess(viewer, request.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.demandes.record(viewer, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.demandes.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    // Pas de réponse notée sans réponse préparée.
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toEqual({ ok: false, rule: 'R96', code: 'not_prepared' });
    const prepared = await t.demandes.prepareAccess(t.responsable, request.id);
    if (!prepared.ok) throw new Error(prepared.code);
    const text = JSON.stringify(prepared.value.response);
    expect(prepared.value.response.personIds).toEqual([t.personId, twin.id]);
    expect(text).toContain('lea.double@example.test');
    expect(text).not.toContain('noe.autre@example.test');
    expect(text).not.toContain(other.id);
    const tables = prepared.value.response.sections.map((s) => s.table);
    expect(tables).toEqual(expect.arrayContaining(['persons', 'person_identifiers', 'person_merges', 'mandates', 'documents', 'properties', 'journal', 'person_requests']));
    expect(prepared.value.response.sections.find((s) => s.table === 'persons')!.rows.map((r) => r.id).sort()).toEqual([t.personId, twin.id].sort());
    // La base garde l'empreinte, jamais une copie.
    expect(await t.db.all('SELECT request_id, kind, mode, output_sha256 FROM person_request_outputs')).toEqual([{ request_id: request.id, kind: 'reponse_acces', mode: 'reel', output_sha256: prepared.value.sha256 }]);
    // La réponse notée a l'empreinte de la réponse préparée ; une seule fois.
    const answered = await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' });
    expect(answered).toMatchObject({ ok: true, value: { answeredOn: '2027-02-01', answerSha256: prepared.value.sha256, late: false } });
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    // Au journal, sans donnée personnelle, et la chaîne tient.
    const events = await t.journal.bySubject(`person_request:${request.id}`);
    expect(events.map((e) => e.type)).toEqual(['rgpd.demande', 'rgpd.reponse_acces_preparee', 'rgpd.reponse']);
    expect(JSON.stringify(events)).not.toContain('example.test');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    // Entrées refusées.
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-02' })).toEqual({ ok: false, rule: null, code: 'future_date' });
    expect(await t.demandes.record(t.responsable, { personId: 'inconnue', kind: 'acces', channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'unknown_person' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'autre' as never, channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'bad_kind' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'pigeon' as never, receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'bad_channel' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-30' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
  });

  it('[R96] échéance et alertes vérifiées jour par jour : rappel 7 jours avant, puis le jour même, une seule fois', async () => {
    const t = await setup();
    // Reçue le 31 janvier : l'échéance tombe le dernier jour de février.
    t.setClock(new Date('2027-01-31T09:00:00.000Z'));
    const late = await t.record('rectification', t.personId, '2027-01-31');
    const answered = await t.record('acces', t.personId, '2027-01-31');
    expect(late.dueOn).toBe('2027-02-28');
    const raised: Record<string, number> = {};
    for (let d = Date.parse('2027-01-31T09:00:00.000Z'); d <= Date.parse('2027-03-05T09:00:00.000Z'); d += 86_400_000) {
      t.setClock(new Date(d));
      const day = new Date(d).toISOString().slice(0, 10);
      if (day === '2027-02-10') {
        await t.demandes.prepareAccess(t.responsable, answered.id);
        await t.demandes.answer(t.responsable, answered.id, { answeredOn: day });
      }
      const n = await t.demandes.run(t.network.id);
      // Le planificateur repasse le même jour : rien de plus.
      expect(await t.demandes.run(t.network.id)).toBe(0);
      if (n > 0) raised[day] = n;
    }
    expect(raised).toEqual({ '2027-02-21': 1, '2027-02-28': 1 });
    const alerts = await t.demandes.alerts(t.responsable);
    expect(alerts).toMatchObject({
      ok: true,
      value: [
        { requestId: late.id, kind: 'rappel', dueOn: '2027-02-28', text: 'Demande de rectification à traiter avant le 28/02/2027.' },
        { requestId: late.id, kind: 'echeance', text: "Demande de rectification : l'échéance du 28/02/2027 est arrivée, la réponse n'est pas notée." },
      ],
    });
    expect(await t.demandes.alerts(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Une réponse après l'échéance est notée en retard, avec sa preuve.
    expect(await t.demandes.answer(t.responsable, late.id, { answeredOn: '2027-03-02' })).toMatchObject({ ok: true, value: { late: true, answeredOn: '2027-03-02' } });
    expect(await t.demandes.answer(t.responsable, late.id, { answeredOn: '2027-03-01' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    // Un planificateur qui a manqué des jours rattrape les deux alertes d'un coup, sans doublon.
    t.setClock(new Date('2027-03-05T09:00:00.000Z'));
    const missed = await t.record('rectification', t.personId, '2027-02-01');
    expect(missed.dueOn).toBe('2027-03-01');
    expect(await t.demandes.run(t.network.id)).toBe(2);
    expect(await t.demandes.run(t.network.id)).toBe(0);
    const list = await t.demandes.list(t.responsable);
    expect(list.ok && list.value.map((r) => [r.dueOn, r.kind, r.answeredOn]).sort()).toEqual([['2027-02-28', 'acces', '2027-02-10'], ['2027-02-28', 'rectification', '2027-03-02'], ['2027-03-01', 'rectification', null]]);
  });

  it('[R96] [R04] l’opposition pose aussitôt l’arrêt sur tous les canaux', async () => {
    const t = await setup();
    const before = await t.decisions.facts(t.personId, NOW);
    expect(before.exclusions.filter((e) => e.lifted_at === null)).toEqual([]);
    const request = await t.record('opposition');
    const facts = await t.decisions.facts(t.personId, NOW);
    expect(facts.exclusions).toEqual([expect.objectContaining({ id: request.exclusionId, reason: 'stop', channel: null, lifted_at: null })]);
    // La réponse : la preuve est l'arrêt posé.
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toMatchObject({ ok: true, value: { late: false } });
    expect(await t.demandes.prepareAccess(t.responsable, request.id)).toEqual({ ok: false, rule: null, code: 'not_access' });
  });

  it('[R17] [R96] l’effacement, en mode essai tant que H29 n’est pas fait : il garde registre, anti-blanchiment et factures, et n’efface rien', async () => {
    const t = await setup();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
    const request = await t.record('effacement');
    expect(await t.demandes.prepareErasure(t.agent, request.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const before = await countAll(t.db);
    const r = await t.demandes.prepareErasure(t.responsable, request.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.plan.mode).toBe('essai');
    const action = Object.fromEntries(r.value.plan.lines.map((l) => [l.table, l.action]));
    // Le registre des mandats, les documents signés et le journal sont gardés ; la fiche serait effacée.
    expect(action).toMatchObject({ mandate_register: 'garder', mandates: 'garder', documents: 'garder', journal: 'garder', persons: 'effacer', person_identifiers: 'effacer' });
    expect(r.value.plan.lines.find((l) => l.table === 'mandate_register')!.rows).toBe(1);
    expect(r.value.plan.alwaysKept.join(' ')).toContain('L561');
    // Les factures sont gardées : leur traitement est une obligation légale.
    expect(erasurePlan({ personIds: [], notIncluded: [], sections: [{ table: 'invoices', traitement: 'commissions-factures', finalite: '', baseLegale: '', duree: '', destinataires: [], sousTraitants: [], rows: [{}] }] }).lines).toEqual([
      expect.objectContaining({ table: 'invoices', action: 'garder' }),
    ]);
    // Rien n'est effacé : seules les lignes de preuve de la demande s'ajoutent.
    const after = await countAll(t.db);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.sort()).toEqual(['journal', 'person_request_outputs']);
    expect(after.journal).toBe(before.journal! + 1);
    const event = (await t.journal.bySubject(`person_request:${request.id}`)).at(-1)!;
    expect(event).toMatchObject({ type: 'rgpd.effacement_essai', data: { rule: 'R17', mode: 'essai', erased: 0, sha256: r.value.sha256 } });
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toMatchObject({ ok: true, value: { answerSha256: r.value.sha256 } });
    // Aucun envoi : rien n'est parti vers la personne.
    expect(after.send_log).toBe(before.send_log);
    expect(after.messages).toBe(before.messages);
  });
});
