import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, appendEvent, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { MAX_MINUTES_SAVED, RapportMatin, TempsGagne, isWorkGesture } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Le lundi 7 juin 2027 ouvre la semaine lue ; on est le mardi 15 juin.
const WEEK = '2027-06-07';

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  let clock = new Date('2027-06-15T10:00:00.000Z');
  const now = (): Date => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = async (id: string, createdAt = '2020-01-01T00:00:00.000Z', status = 'active') => {
    await db.run('INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, network.id, 'Prénom', 'Nom', status, createdAt, createdAt]);
    return as('agent', id);
  };
  const at = (iso: string) => () => new Date(iso);
  const gesture = (actor: string, type: string, iso: string) => appendEvent(journal, { type, actor, subject: null, data: {} }, at(iso));
  const t = new TempsGagne(db, journal, { now });
  return { db, journal, as, agent, gesture, t, direction: as('direction', 'd1'), setClock: (iso: string) => { clock = new Date(iso); } };
}

describeWithSqlite('IN08 · temps gagné', () => {
  it('[R217] sans déclaration, « rien » et non zéro : pour l’agent et pour le réseau', async () => {
    const s = await setup();
    const a = await s.agent('a');
    expect(await s.t.mine(a, WEEK)).toEqual({ ok: true, value: { week: WEEK, minutes: null, version: null, gestures: 0 } });
    expect(await s.t.network(s.direction, WEEK)).toEqual({ ok: true, value: { week: WEEK, declared: 0, notDeclared: 1, minutes: null, withoutGesture: 0 } });
  });

  it('[R217] [R17] une nouvelle déclaration ajoute une version, l’ancienne reste ; le même chiffre n’ajoute rien ; rien ne s’efface', async () => {
    const s = await setup();
    const a = await s.agent('a');
    expect(await s.t.declare(a, { week: WEEK, minutes: 120 })).toMatchObject({ ok: true, value: { minutes: 120, version: 1 } });
    expect(await s.t.declare(a, { week: WEEK, minutes: 120 })).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await s.t.declare(a, { week: WEEK, minutes: 90 })).toMatchObject({ ok: true, value: { minutes: 90, version: 2 } });
    const rows = await s.db.all<{ minutes: number }>('SELECT minutes FROM agent_time_saved ORDER BY version');
    expect(rows.map((r) => Number(r.minutes))).toEqual([120, 90]);
    await expect(s.db.run('DELETE FROM agent_time_saved')).rejects.toThrow();
    await expect(s.db.run('UPDATE agent_time_saved SET minutes = 1')).rejects.toThrow();
    expect(await s.t.network(s.direction, WEEK)).toMatchObject({ ok: true, value: { minutes: 90, declared: 1 } });
  });

  it('[R217] le chiffre et la semaine sont bornés : 0 à 80 h, entier, un lundi, une semaine finie à Paris', async () => {
    const s = await setup();
    const a = await s.agent('a');
    for (const minutes of [-1, MAX_MINUTES_SAVED + 1, 1.5, '60', null, undefined]) expect(await s.t.declare(a, { week: WEEK, minutes })).toEqual({ ok: false, rule: null, code: 'bad_minutes' });
    expect(await s.t.declare(a, { week: WEEK, minutes: 0 })).toMatchObject({ ok: true, value: { minutes: 0 } });
    expect(await s.t.declare(a, { week: WEEK, minutes: MAX_MINUTES_SAVED })).toMatchObject({ ok: true });
    for (const week of ['2027-06-08', '2027-13-01', '2027-02-30', 'lundi', null]) expect(await s.t.declare(a, { week, minutes: 1 })).toEqual({ ok: false, rule: null, code: 'bad_week' });
    expect(await s.t.declare(a, { week: '2027-06-14', minutes: 1 })).toEqual({ ok: false, rule: 'R217', code: 'week_not_finished' });
    // Le dimanche 13 à 23 h 30 à Paris, la semaine n'est pas finie ; le lundi 14 à 0 h 30, si.
    s.setClock('2027-06-13T21:30:00.000Z');
    expect(await s.t.declare(a, { week: WEEK, minutes: 1 })).toEqual({ ok: false, rule: 'R217', code: 'week_not_finished' });
    s.setClock('2027-06-13T22:30:00.000Z');
    expect(await s.t.declare(a, { week: WEEK, minutes: 1 })).toMatchObject({ ok: true });
  });

  it('[R217] le contrôle compte les gestes de la semaine de Paris, hors lectures, refus et déclarations', async () => {
    const s = await setup();
    const a = await s.agent('a');
    await s.gesture('agent:a', 'visite.compte_rendu', '2027-06-06T22:00:00.000Z'); // lundi 7 à minuit à Paris
    await s.gesture('agent:a', 'mandat.signe', '2027-06-13T21:59:59.000Z'); // dimanche 13, 23 h 59 à Paris
    await s.gesture('agent:a', 'mandat.signe', '2027-06-13T22:00:00.000Z'); // la semaine suivante
    await s.gesture('agent:a', 'mandat.signe', '2027-06-06T21:59:59.000Z'); // la semaine d'avant
    await s.gesture('agent:b', 'mandat.signe', '2027-06-08T10:00:00.000Z'); // un autre agent
    await s.gesture('agent:a', 'pilotage.lecture', '2027-06-08T10:00:00.000Z');
    await s.gesture('agent:a', 'acces.refuse', '2027-06-08T10:00:00.000Z');
    await s.gesture('agent:a', 'dossier_presentation.rendez_vous_lus', '2027-06-08T10:00:00.000Z');
    expect(await s.t.declare(a, { week: WEEK, minutes: 60 })).toMatchObject({ ok: true, value: { gestures: 2 } });
    await s.t.declare(a, { week: WEEK, minutes: 70 });
    expect(await s.t.mine(a, WEEK)).toMatchObject({ ok: true, value: { gestures: 2 } });
  });

  it('[R217] les lectures et les refus du code ne sont pas des gestes, les gestes de travail si', () => {
    const notGestures = ['fiche.lue', 'fiches.listees', 'demande.lue', 'location.lue', 'candidature.lue', 'candidatures.lues', 'alertes_agent.lues', 'dossier.alertes_lues', 'dossier.taches_lues', 'mesure_sources.lue', 'anciens_contacts.liste_lue', 'lettres_quartier.liste_lue', 'recommandations.file_lue', 'mandat.chronologie_lue', 'alerte_agent.vue', 'studio.guide.vue', 'dossier_presentation.rendez_vous_lus', 'pilotage.lecture', 'acces.refuse', 'visite.refusee', 'dossier.piece_refusee', 'lettres_quartier.refusee', 'annonce.ia_refusee', 'envoi.texte_refuse', 'pieces.depot.refuse', 'dossier.ouvert', 'coffre.ouvert', 'remuneration.montree', 'pilotage.temps_gagne'];
    for (const type of notGestures) expect([type, isWorkGesture(type)]).toEqual([type, false]);
    for (const type of ['mandat.signe', 'visite.compte_rendu', 'rappel.fait', 'annonce.validee', 'offre.transmise', 'valeur.lue_par_personne_morale_x']) expect([type, isWorkGesture(type)]).toEqual([type, true]);
  });

  it('[R217] le rapport du matin lit au nom de l’agent : ce n’est pas un geste, et 10 heures sans geste se voient', async () => {
    const s = await setup();
    const a = await s.agent('a');
    s.setClock('2027-06-08T05:30:00.000Z');
    await new RapportMatin(s.db, s.journal, { now: () => new Date('2027-06-08T05:30:00.000Z') }).run(s.direction.networkId);
    const written = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE actor = 'agent:a'");
    expect(Number(written?.n)).toBeGreaterThan(0);
    s.setClock('2027-06-15T10:00:00.000Z');
    expect(await s.t.declare(a, { week: WEEK, minutes: 600 })).toMatchObject({ ok: true, value: { gestures: 0 } });
    expect(await s.t.network(s.direction, WEEK)).toMatchObject({ ok: true, value: { withoutGesture: 1 } });
  });

  it('[R217] déclarer une semaine finie avant son entrée est refusé ; la semaine où l’agent entre se déclare', async () => {
    const s = await setup();
    const a = await s.agent('new', '2027-06-14T10:00:00.000Z');
    s.setClock('2027-06-22T10:00:00.000Z');
    expect(await s.t.declare(a, { week: WEEK, minutes: 4800 })).toEqual({ ok: false, rule: 'R217', code: 'week_before_entry' });
    expect(await s.t.declare(a, { week: '2027-06-14', minutes: 60 })).toMatchObject({ ok: true, value: { minutes: 60 } });
  });

  it('[R217] les présents sans déclaration se comptent eux-mêmes : la déclaration d’un agent parti depuis n’en cache pas un autre', async () => {
    const s = await setup();
    const left = await s.agent('left-after');
    await s.t.declare(left, { week: WEEK, minutes: 60 });
    await s.db.run("UPDATE agents SET status = 'left' WHERE id = 'left-after'");
    await s.agent('here');
    expect(await s.t.network(s.direction, WEEK)).toMatchObject({ ok: true, value: { declared: 1, notDeclared: 1, minutes: 60 } });
  });

  it('[R217] [R14] la direction lit des comptes, aucune ligne par agent ; sans geste en face : un compte, sans nom ; zéro n’a rien à contrôler', async () => {
    const s = await setup();
    const [a, b, c] = [await s.agent('agent-aa'), await s.agent('agent-bb'), await s.agent('agent-cc')];
    await s.agent('agent-dd'); // n'a pas déclaré
    await s.agent('agent-ee', '2027-06-14T10:00:00.000Z'); // entré après la semaine
    await s.agent('agent-ff', '2020-01-01T00:00:00.000Z', 'left'); // parti, sans date
    await s.gesture('agent:agent-aa', 'mandat.signe', '2027-06-08T10:00:00.000Z');
    await s.t.declare(a, { week: WEEK, minutes: 60 });
    await s.t.declare(b, { week: WEEK, minutes: 30 }); // aucun geste
    await s.t.declare(c, { week: WEEK, minutes: 0 }); // rien à contrôler
    const r = await s.t.network(s.direction, WEEK);
    expect(r).toEqual({ ok: true, value: { week: WEEK, declared: 3, notDeclared: 1, minutes: 90, withoutGesture: 1 } });
    expect(JSON.stringify(r)).not.toMatch(/agent-/);
  });

  it('[R217] un agent parti pendant la semaine compte encore ; parti avant, non', async () => {
    const s = await setup();
    await s.agent('during', '2020-01-01T00:00:00.000Z', 'left');
    await s.agent('before', '2020-01-01T00:00:00.000Z', 'left');
    const leave = (id: string, on: string) => s.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES (?, ?, ?, '2027-01-01', ?, 'demission_agent', 1, 'd', ?)", [`dep-${id}`, s.direction.networkId, id, on, on]);
    await leave('during', '2027-06-09');
    await leave('before', '2027-06-01');
    expect(await s.t.network(s.direction, WEEK)).toMatchObject({ ok: true, value: { notDeclared: 1 } });
  });

  it('[R16] [R68] chacun à sa place : l’agent lit et déclare pour lui, la direction le réseau, les autres rien, au journal ; un agent parti ne déclare plus', async () => {
    const s = await setup();
    const a = await s.agent('a');
    const gone = await s.agent('g', '2020-01-01T00:00:00.000Z', 'left');
    await s.t.declare(a, { week: WEEK, minutes: 60 });
    expect(await s.t.network(a, WEEK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.t.declare(s.direction, { week: WEEK, minutes: 1 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.t.mine(s.direction, WEEK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.t.network(s.as('compliance', 'c'), WEEK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.t.declare(gone, { week: WEEK, minutes: 1 })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    const other = await s.agent('o');
    expect(await s.t.mine(other, WEEK)).toMatchObject({ ok: true, value: { minutes: null } });
    const refused = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE type = 'acces.refuse'");
    expect(Number(refused?.n)).toBe(5);
  });
});
