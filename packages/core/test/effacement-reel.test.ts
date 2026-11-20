import { expect, it } from 'vitest';
import { DecisionEnvoi, FicheUnique, conformite, copyKeyFromSecret, replayErasures, verifyChain, type ErasureLedgerStore, type SqlDatabase, type Viewer } from '../src/index.ts';
import { EffacementReel, erasureModeOf, eraseForReal, IDENTIFIERS_KEPT, SqlPersonEraser, type ObjectEraser } from '../src/conformite/effacement-reel.ts';
import { fileReferences, type ObjectStorage } from '../src/sauvegarde/objets.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, les appels, les fichiers, le stockage et la clé du registre.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 7)));
const NOW = new Date('2027-02-11T09:00:00.000Z');
const LATER = new Date('2027-02-11T10:00:00.000Z');

const memoryLedger = (failing = false) => {
  const parts = new Map<string, Uint8Array>();
  const store: ErasureLedgerStore = {
    put: async (k, b) => {
      if (failing) throw new Error('stockage indisponible');
      parts.set(k, b);
    },
    get: async (k) => parts.get(k) ?? null,
    list: async (prefix) => [...parts.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  return { parts, store };
};

const memoryObjects = (keys: [ObjectStorage, string][]) => {
  const held = new Set(keys.map(([s, k]) => `${s}:${k}`));
  const eraser: ObjectEraser = {
    async remove(storage, key) {
      held.delete(`${storage}:${key}`);
    },
  };
  return { held, eraser };
};

const countAll = async (db: SqlDatabase) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = (await db.first<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`))!.n;
  return out;
};

// Les tables en ajout seul du bien de la vendeuse, que la base refuse d'effacer (AU020b).
const BLOCKED = [{ table: 'listing_drafts', rows: 1 }, { table: 'property_sheets', rows: 1 }];

const FILES: [ObjectStorage, string][] = [
  ['PIECES', 'boite/appels/seule-a.ogg'],
  ['PIECES', 'boite/appels/partage.ogg'],
  ['COFFRE', 'coffre/essai/piece.pdf'],
];

async function setup(options: { mode?: unknown; ledgerFails?: boolean; noLedger?: boolean; noObjects?: boolean } = {}) {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const demandes = new conformite.DemandesPersonnes(t.db, t.journal, fiche, decisions, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const responsable = as('compliance', 'conformite-1');
  // La vendeuse : une adresse, un arrêt, deux appels (l'un cite un fichier à elle seule, l'autre un fichier aussi cité
  // ailleurs, et une pièce du coffre), une note d'appel.
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.vendeuse@example.test' });
  await decisions.recordStopRequest({ networkId: t.network.id, personId: t.personId, at: NOW });
  const call = async (id: string, personId: string, ref: string) =>
    t.db.run(
      "INSERT INTO calls (id, network_id, provider, call_id, status, failure, person_id, consent_given_at, recording_ref, created_at) VALUES (?, ?, 'essai', ?, 'impossible', 'echec', ?, ?, ?, ?)",
      [id, t.network.id, id, personId, NOW.toISOString(), ref, NOW.toISOString()],
    );
  await call('appel-a1', t.personId, 'boite/appels/seule-a.ogg');
  await call('appel-a2', t.personId, 'boite/appels/partage.ogg');
  await call('appel-a3', t.personId, 'coffre/essai/piece.pdf');
  await t.db.run("INSERT INTO call_notes (id, network_id, person_id, outcome, basis, noted_by, noted_at) VALUES ('note-a', ?, ?, 'called', 'request', 'ag', ?)", [t.network.id, t.personId, NOW.toISOString()]);
  // Une autre personne, sans lien : son appel cite le fichier partagé.
  const other = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noé', lastName: 'Autre' });
  await t.store.addIdentifier({ networkId: t.network.id, personId: other.id, kind: 'email', value: 'noe.autre@example.test' });
  await call('appel-b', other.id, 'boite/appels/partage.ogg');
  const ledger = memoryLedger(options.ledgerFails);
  const objects = memoryObjects(FILES);
  const key = await copyKeyFromSecret(SECRET);
  const reel = new EffacementReel(t.db, t.journal, fiche, {
    mode: erasureModeOf('mode' in options ? options.mode : 'reel'),
    ledger: options.noLedger ? null : { store: ledger.store, key },
    objects: options.noObjects ? null : objects.eraser,
    now: t.now,
  });
  const request = await demandes.record(responsable, { personId: t.personId, kind: 'effacement', channel: 'mail', receivedOn: '2027-02-11' });
  if (!request.ok) throw new Error(request.code);
  return { ...t, fiche, demandes, reel, responsable, request: request.value, other, ledger, objects, key, as };
}

describeWithSqlite('AU020 · l’effacement réel, sa preuve et sa note au registre', () => {
  it('[R17] constat reproduit : sans le mode réel écrit tel quel, la demande ne fait qu’un essai et rien n’est effacé', async () => {
    for (const mode of [undefined, '', 'REEL', 'reel ', 'oui', true]) expect(erasureModeOf(mode)).toBe('essai');
    expect(erasureModeOf('reel')).toBe('reel');
    const t = await setup({ mode: undefined });
    expect((await t.demandes.prepareErasure(t.responsable, t.request.id)).ok).toBe(true);
    const before = await countAll(t.db);
    expect(await t.reel.erase(t.responsable, t.request.id)).toEqual({ ok: false, rule: 'R17', code: 'trial_only' });
    expect(await countAll(t.db)).toEqual(before);
    expect(t.ledger.parts.size).toBe(0);
    expect(t.objects.held.size).toBe(3);
  });

  it('[R16] [R17] [R96] [R231] le responsable seul, une demande d’effacement de son réseau, plan vu, registre et stockage donnés', async () => {
    const t = await setup();
    expect(await t.reel.erase(t.agent, t.request.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).at(-1)).toMatchObject({ type: 'acces.refuse', data: { rule: 'R16', kind: 'effacement_reel', code: 'role' } });
    expect(await t.reel.erase(t.responsable, 'inconnue')).toEqual({ ok: false, rule: null, code: 'unknown' });
    expect(await t.reel.erase({ ...t.responsable, networkId: 'autre-reseau' }, t.request.id)).toEqual({ ok: false, rule: null, code: 'unknown' });
    const access = await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-11' });
    expect(await t.reel.erase(t.responsable, access.ok ? access.value.id : '')).toEqual({ ok: false, rule: null, code: 'not_erasure' });
    // Le plan d'essai n'a pas été préparé : le responsable n'a pas vu ce qui part.
    expect(await t.reel.erase(t.responsable, t.request.id)).toEqual({ ok: false, rule: 'R96', code: 'plan_not_prepared' });
    await t.demandes.prepareErasure(t.responsable, t.request.id);
    const before = await countAll(t.db);
    for (const [options, refusal] of [
      [{ noLedger: true }, { ok: false, rule: 'R231', code: 'ledger_missing' }],
      [{ noObjects: true }, { ok: false, rule: 'R17', code: 'objects_missing' }],
      [{ ledgerFails: true }, { ok: false, rule: 'R231', code: 'ledger_unwritable' }],
    ] as const) {
      const u = await setup(options);
      await u.demandes.prepareErasure(u.responsable, u.request.id);
      const was = await countAll(u.db);
      expect(await u.reel.erase(u.responsable, u.request.id)).toEqual(refusal);
      // Rien n'est effacé si l'effacement ne peut pas être noté [R231].
      expect(await countAll(u.db)).toEqual(was);
      expect(u.objects.held.size).toBe(3);
    }
    expect(await countAll(t.db)).toMatchObject({ calls: before.calls });
  });

  it('[R17] [R96] [R231] efface ce qui n’est qu’à la personne et ses fichiers, garde ce que la loi garde, note au registre et rend la preuve', async () => {
    const t = await setup();
    const plan = await t.demandes.prepareErasure(t.responsable, t.request.id);
    if (!plan.ok) throw new Error(plan.code);
    const before = await countAll(t.db);
    t.setClock(LATER);
    const r = await t.reel.erase(t.responsable, t.request.id);
    if (!r.ok) throw new Error(r.code);
    const { receipt, sha256 } = r.value;
    // Les appels et la note de la vendeuse sont partis ; ceux de l'autre personne restent.
    expect(await t.db.all('SELECT id FROM calls ORDER BY id')).toEqual([{ id: 'appel-b' }]);
    expect(await t.db.all('SELECT id FROM call_notes')).toEqual([]);
    // La fiche reste, citée par le mandat et la demande, mais son nom est vidé ; l'autre fiche ne change pas.
    expect(await t.db.first('SELECT first_name, last_name, last_contact_at FROM persons WHERE id = ?', [t.personId])).toEqual({ first_name: null, last_name: null, last_contact_at: null });
    expect(await t.db.first('SELECT first_name, last_name FROM persons WHERE id = ?', [t.other.id])).toEqual({ first_name: 'Noé', last_name: 'Autre' });
    // Ce que la loi garde, l'arrêt et les identifiants restent tels quels ; le reçu ne promet pas d'empreinte (AU020c).
    const after = await countAll(t.db);
    for (const table of ['mandates', 'mandate_register', 'documents', 'signed_documents', 'exclusions', 'person_identifiers', 'person_requests', 'persons']) expect(after[table], table).toBe(before[table]);
    // Le fichier qu'elle seule citait est retiré ; le fichier partagé et le coffre restent.
    expect([...t.objects.held].sort()).toEqual(['COFFRE:coffre/essai/piece.pdf', 'PIECES:boite/appels/partage.ogg']);
    // Le reçu : ce qui part, ce qui reste et pourquoi, sans nom, sans coordonnée, sans identifiant. Le brouillon d'annonce
    // et la fiche du bien sont en ajout seul : la base refuse de les effacer, le reçu le dit et l'effacement n'est pas
    // dit complet (AU020b).
    expect(receipt).toMatchObject({ mode: 'reel', records: 1, complete: false, remaining: BLOCKED, objectsRemoved: { PIECES: 1 }, objectsRemaining: 0, at: LATER.toISOString() });
    // Le bien reste, cité par le mandat que la loi garde.
    expect(receipt.cited).toEqual([{ table: 'properties', rows: 1 }]);
    expect(receipt.erased).toEqual([{ table: 'call_notes', rows: 1 }, { table: 'calls', rows: 3 }, { table: 'project_properties', rows: 1 }, { table: 'projects', rows: 1 }]);
    expect(receipt.pseudonymized).toEqual([{ table: 'persons', rows: 1 }]);
    expect(receipt.kept).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'mandates', action: 'garder' }), expect.objectContaining({ table: 'exclusions', action: 'garder' }), expect.objectContaining({ table: 'person_identifiers', action: 'garder', why: IDENTIFIERS_KEPT })]));
    expect(receipt.kept.some((k) => k.action === 'empreinte')).toBe(false);
    expect(receipt.alwaysKept.join(' ')).toContain('L561');
    const text = JSON.stringify(receipt);
    for (const secret of ['Exemple', 'Léa', 'example.test', t.personId, 'appel-a', 'seule-a']) expect(text).not.toContain(secret);
    expect(sha256).toBe(await conformite.sha256Of(receipt));
    // La preuve : l'empreinte du reçu gardée, au journal, puis reprise par la réponse notée.
    expect(await t.db.all("SELECT kind, mode, output_sha256 FROM person_request_outputs WHERE request_id = ? AND mode = 'reel'", [t.request.id])).toEqual([{ kind: 'plan_effacement', mode: 'reel', output_sha256: sha256 }]);
    const event = (await t.journal.bySubject(`person_request:${t.request.id}`)).at(-1)!;
    expect(event).toMatchObject({ type: 'rgpd.effacement', data: { rule: 'R17', mode: 'reel', sha256, erased: 6, pseudonymized: 1, remaining: 2, objects: 1, complete: false } });
    expect(JSON.stringify(event)).not.toContain('example.test');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    expect(await t.demandes.answer(t.responsable, t.request.id, { answeredOn: '2027-02-11' })).toMatchObject({ ok: true, value: { answerSha256: sha256 } });
    // Noté au registre des effacements, avant l'effacement : une entrée lisible par fiche.
    expect([...t.ledger.parts.keys()].every((k) => k.startsWith('effacements/'))).toBe(true);
    expect(t.ledger.parts.size).toBe(1);
    // Rien n'est parti vers la personne.
    expect(after.send_log).toBe(before.send_log);
    expect(after.messages).toBe(before.messages);
  });

  it('[R17] [R231] refait, l’effacement réel ne change rien de plus, et l’effaceur du rejeu non plus', async () => {
    const t = await setup();
    await t.demandes.prepareErasure(t.responsable, t.request.id);
    t.setClock(LATER);
    await t.reel.erase(t.responsable, t.request.id);
    const once = await countAll(t.db);
    t.setClock(new Date(LATER.getTime() + 60_000));
    const again = await t.reel.erase(t.responsable, t.request.id);
    if (!again.ok) throw new Error(again.code);
    expect(again.value.receipt).toMatchObject({ erased: [], pseudonymized: [], remaining: BLOCKED, objectsRemoved: {}, complete: false });
    const twice = await countAll(t.db);
    expect(Object.keys(twice).filter((k) => twice[k] !== once[k]).sort()).toEqual(['journal', 'person_request_outputs']);
    // Le registre, rejoué par l'effaceur réel, ne trouve plus rien à effacer.
    const eraser = new SqlPersonEraser({ objects: t.objects.eraser });
    // Les lignes du bien que la base refuse d'effacer restent (AU020b) : le rejeu ne se dit pas fait [R231].
    await expect(eraser.erase(t.db, { requestId: t.request.id, networkId: t.network.id, personId: t.personId, erasedAt: LATER.toISOString() })).rejects.toThrow();
    const replay = await replayErasures(t.db, t.ledger.store, t.key, eraser, { copyTakenAt: NOW.toISOString(), now: t.now });
    expect(replay).toEqual({ ok: false, code: 'erase_failed', replayed: 0 });
    // Une personne dont tout peut partir : le rejeu refait ne change rien de plus, et se dit fait.
    const entry = { requestId: 'demande-autre', networkId: t.network.id, personId: t.other.id, erasedAt: LATER.toISOString() };
    expect(await eraser.erase(t.db, entry)).toBeGreaterThan(0);
    expect(await eraser.erase(t.db, entry)).toBe(0);
  });

  it('[R17] une ligne qu’une table en ajout seul refuse d’effacer est dite restante : l’effacement n’est pas dit complet', async () => {
    const t = await setup();
    await t.db.exec(`CREATE TABLE essai_notes (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TRIGGER essai_notes_garde BEFORE DELETE ON essai_notes BEGIN SELECT RAISE(ABORT, 'essai_notes : rien ne s''efface'); END;`);
    await t.db.run("INSERT INTO essai_notes (id, person_id, note) VALUES ('n1', ?, 'Inventée')", [t.personId]);
    const relation = conformite.REGISTRE_TRAITEMENTS.find((x) => x.id === 'relation-clients')!;
    const registre = conformite.REGISTRE_TRAITEMENTS.map((x) => (x === relation ? { ...x, tables: { ...x.tables, essai_notes: ['person_id', 'note'] } } : x));
    const carte = { ...conformite.CARTE_ACCES, essai_notes: { locate: [{ column: 'person_id' }] } };
    const { outcome } = await eraseForReal(t.db, [t.personId], { carte, registre, objects: t.objects.eraser });
    expect(outcome.remaining).toEqual([{ table: 'essai_notes', rows: 1 }, ...BLOCKED]);
    expect(await t.db.all('SELECT id FROM essai_notes')).toEqual([{ id: 'n1' }]);
    // Le reste part quand même, et un second passage dit la même chose.
    expect(await t.db.all('SELECT id FROM call_notes')).toEqual([]);
    expect((await eraseForReal(t.db, [t.personId], { carte, registre, objects: t.objects.eraser })).outcome).toMatchObject({ erased: [], pseudonymized: [], remaining: [{ table: 'essai_notes', rows: 1 }, ...BLOCKED] });
  });

  it('[R17] une ligne changée entre la lecture et l’effacement est dite restante, jamais partie', async () => {
    const t = await setup();
    // La base change la note d'appel juste avant son DELETE : la ligne lue n'est plus celle de la base.
    const db: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      all: (sql, p) => t.db.all(sql, p),
      first: (sql, p) => t.db.first(sql, p),
      run: async (sql, p) => {
        if (/^DELETE FROM "call_notes"/.test(sql)) await t.db.run("UPDATE call_notes SET outcome = 'changed' WHERE id = 'note-a'");
        return t.db.run(sql, p);
      },
    };
    const { outcome } = await eraseForReal(db, [t.personId], { objects: t.objects.eraser });
    expect(outcome.remaining).toEqual(expect.arrayContaining([{ table: 'call_notes', rows: 1 }]));
    expect(outcome.erased.find((c) => c.table === 'call_notes')).toBeUndefined();
    expect(await t.db.all('SELECT id FROM call_notes')).toEqual([{ id: 'note-a' }]);
  });

  it('[R17] [R231] interrompu après la note au registre : refusé, et la trace reste au journal sans donnée de la personne', async () => {
    const t = await setup();
    await t.demandes.prepareErasure(t.responsable, t.request.id);
    const db: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      run: (sql, p) => t.db.run(sql, p),
      first: (sql, p) => t.db.first(sql, p),
      // La relecture des fichiers cités, après les suppressions, échoue.
      all: async (sql, p) => {
        if (/sqlite_master/.test(sql)) throw new Error('base indisponible');
        return t.db.all(sql, p);
      },
    };
    const reel = new EffacementReel(db, t.journal, t.fiche, { mode: 'reel', ledger: { store: t.ledger.store, key: t.key }, objects: t.objects.eraser, now: t.now });
    expect(await reel.erase(t.responsable, t.request.id)).toEqual({ ok: false, rule: 'R17', code: 'interrupted' });
    expect(t.ledger.parts.size).toBeGreaterThan(0);
    const last = (await t.journal.all()).at(-1)!;
    expect(last).toMatchObject({ type: 'rgpd.effacement', data: { rule: 'R17', mode: 'reel', interrupted: true, complete: false } });
    expect(JSON.stringify(last)).not.toContain('lea.vendeuse');
  });

  it('[R17] un fichier dont le retrait a échoué est retiré par l’effacement refait, même quand plus aucune ligne ne le cite', async () => {
    const t = await setup();
    let failing = true;
    const removed: string[] = [];
    const flaky: ObjectEraser = {
      async remove(_storage, key) {
        if (failing) throw new Error('stockage indisponible');
        removed.push(key);
      },
    };
    const target = { requestId: t.request.id, networkId: t.network.id, at: NOW.toISOString() };
    const first = await eraseForReal(t.db, [t.personId], { objects: flaky, target });
    expect(first.outcome.objectsRemaining).toBe(1);
    // L'appel qui le citait est parti : sans la note d'avant, plus rien ne dirait qu'il reste à retirer.
    expect(await t.db.first("SELECT id FROM calls WHERE id = 'appel-a1'")).toBeNull();
    failing = false;
    const again = await eraseForReal(t.db, [t.personId], { objects: flaky, target });
    expect(again.outcome).toMatchObject({ objectsRemaining: 0, objectsRemoved: { PIECES: 1 } });
    expect(removed).toEqual(['boite/appels/seule-a.ogg']);
    expect(await t.db.all("SELECT storage, object_key, removed_at FROM erasure_object_targets WHERE object_key LIKE 'boite/%' ORDER BY object_key")).toEqual([{ storage: 'PIECES', object_key: 'boite/appels/seule-a.ogg', removed_at: NOW.toISOString() }, { storage: 'PIECES', object_key: 'boite/appels/partage.ogg', removed_at: null }].sort((a, b) => (a.object_key < b.object_key ? -1 : 1)));
    // La note ne cite pas un fichier gardé : la sauvegarde ne la lit pas comme une référence.
    expect((await fileReferences(t.db)).map((r) => r.key)).not.toContain('boite/appels/seule-a.ogg');
    // Un troisième passage ne retire rien de plus, et le fichier partagé, encore cité, reste.
    expect((await eraseForReal(t.db, [t.personId], { objects: flaky, target })).outcome.objectsRemoved).toEqual({});
    expect(removed).toEqual(['boite/appels/seule-a.ogg']);
  });

  it('[R17] une personne sans pièce gardée : tout ce qui n’est qu’à elle part, l’effacement est complet', async () => {
    const t = await setup();
    const { plan, outcome } = await eraseForReal(t.db, [t.other.id], { objects: t.objects.eraser });
    expect(plan.lines.filter((l) => l.action === 'effacer').map((l) => l.table)).toEqual(expect.arrayContaining(['persons', 'calls']));
    expect(outcome).toMatchObject({ remaining: [], cited: [], objectsRemaining: 0, objectsRemoved: {} });
    expect(outcome.erased).toEqual([{ table: 'calls', rows: 1 }]);
    // La fiche est citée par ses identifiants, gardés sous empreinte pour respecter son arrêt : son nom est vidé.
    expect(outcome.pseudonymized).toEqual([{ table: 'persons', rows: 1 }]);
    expect(await t.db.first('SELECT first_name, last_name FROM persons WHERE id = ?', [t.other.id])).toEqual({ first_name: null, last_name: null });
    // Le fichier partagé reste : la vendeuse le cite encore.
    expect(t.objects.held.has('PIECES:boite/appels/partage.ogg')).toBe(true);
    expect(await t.db.all('SELECT id FROM calls ORDER BY id')).toEqual([{ id: 'appel-a1' }, { id: 'appel-a2' }, { id: 'appel-a3' }]);
  });
});
