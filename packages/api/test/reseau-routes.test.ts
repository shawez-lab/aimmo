import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase, type Viewer } from '@aimmo/core';
import { AGENT_FILE_PIECES, checkRecruitingText, type AgentPieceStore } from '../../core/src/reseau/index.ts';
import { handleCandidature } from '../src/candidature.ts';
import { handleSortiePublic, reseauRoutes, type ReseauServices } from '../src/reseau.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, direction, candidats, agents, pièces.
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakePieces implements AgentPieceStore {
  readonly refs = new Set<string>();
  put(agentId: string): string {
    const ref = `agents/${agentId}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
  async putDraft(agentId: string): Promise<string> {
    return this.put(agentId);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-07-12T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const pieces = new FakePieces();
  const s: ReseauServices = { db, journal, now };
  const routes = reseauRoutes({ pieces });
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const bare = path.split('?')[0]!;
    const route = routes.find((r) => r.method === method && r.pattern.test(bare));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(bare) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null; [k: string]: any } };
  };
  /** Un candidat dépose sa candidature sur la page publique, comme une personne. */
  const applyOnPage = async (fields: Record<string, string>) => {
    const res = await handleCandidature(new Request('https://aimmo.exemple.test/rejoindre', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }), { db, networkId: network.id, now });
    return { status: res!.status, html: await res!.text() };
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const today = (): string => new Date(clock).toISOString().slice(0, 10);
  /** Un candidat déposé sur la page, reçu en entretien, retenu et admis : son identifiant d'agent. */
  const admitted = async (firstName: string, email: string): Promise<string> => {
    const page = await applyOnPage({ firstName, email, currentStatus: 'autre_metier', experience: 'aucune', source: 'page' });
    if (page.status !== 200) throw new Error('candidature');
    const id = (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [email]))!.id;
    const iv = await call(direction, 'POST', `/reseau/candidatures/${id}/entretien`, { at: new Date(clock + 3_600_000).toISOString(), interviewer: 'Shawez' });
    clock += 2 * 3_600_000;
    await call(direction, 'POST', `/reseau/entretiens/${iv.body.interviewId}/tenu`, { heldByName: 'Shawez' });
    await call(direction, 'POST', `/reseau/candidatures/${id}/decision`, { decision: 'oui', reason: 'Projet clair', deciderName: 'Shawez' });
    const r = await call(direction, 'POST', `/reseau/candidatures/${id}/admettre`, {});
    if (r.status !== 200) throw new Error(`admission : ${r.body.code}`);
    return r.body.agentId as string;
  };
  const plusDays = (d: number): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  return { db, journal, network, other, pieces, call, direction, applyOnPage, advance, today, plusDays, now, admitted };
}

describeWithSqlite('J12 · routes de M14', () => {
  /** L'adresse d'une route, ses identifiants remplacés par `id`. */
  const pathOf = (pattern: RegExp, id: string): string => pattern.source.replace(/\(\[A-Za-z0-9_-\]\{1,64\}\)/g, id).replace(/^\^/, '').replace(/\$$/, '');
  /** Les routes où l'appelant agit seulement sur ce qui est à lui : le rôle d'agent suffit, la couche métier fait le reste. */
  const OWN = ['reseau.mon_dossier', 'reseau.import', 'reseau.academie', 'reseau.module_fait', 'reseau.ma_formation', 'reseau.entrainement_cas', 'reseau.entrainement', 'reseau.assistance', 'reseau.mes_primes', 'reseau.mon_referent', 'reseau.mon_bac_a_sable'];
  /** Les routes d'agent sur la chose d'un autre : la couche métier refuse un agent tiers. */
  const OTHERS = ['reseau.dossiers_couverts', 'reseau.entrainement_tour', 'reseau.entrainement_fin'];
  const refusals = async (t: Awaited<ReturnType<typeof setup>>) => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
  /** Un appel sans corps lisible : le refus de droits doit venir avant toute lecture du corps. */
  const raw = async (t: Awaited<ReturnType<typeof setup>>, route: ReturnType<typeof reseauRoutes>[number], viewer: Viewer, id: string) => {
    const path = pathOf(route.pattern, id);
    const res = await route.handle({ db: t.db, journal: t.journal, now: t.now }, viewer, (route.pattern.exec(path) ?? []).slice(1), new Request(`https://api.exemple.test/v1${path}`, route.method === 'POST' ? { method: 'POST', body: 'pas du json' } : {}));
    return { status: res.status, body: (await res.json()) as { rule?: string | null; code?: string } };
  };

  it('[R16] un partenaire est refusé sur chaque route de M14, avant tout corps, et chaque refus est au journal', async () => {
    const t = await setup();
    const partner: Viewer = { role: 'partner', userId: 'partenaire-1', networkId: t.network.id };
    const routes = reseauRoutes({ pieces: t.pieces });
    expect(routes.length).toBeGreaterThanOrEqual(45);
    for (const route of routes) {
      const before = await refusals(t);
      const r = await raw(t, route, partner, 'agent-cible');
      expect([route.name, r.status, r.body.rule]).toEqual([route.name, 403, 'R16']);
      expect([route.name, (await refusals(t)) - before]).toEqual([route.name, 1]);
    }
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R16] un agent tiers est refusé sur chaque route de la direction et sur chaque route d’un autre agent, avant tout corps', async () => {
    const t = await setup();
    const routes = reseauRoutes({ pieces: t.pieces });
    const names = routes.map((r) => r.name);
    // Chaque route est classée : une route ajoutée sans décision fait échouer ce test.
    expect(new Set([...OWN, ...OTHERS]).size).toBe(OWN.length + OTHERS.length);
    for (const n of [...OWN, ...OTHERS]) expect(names).toContain(n);
    const tiers: Viewer = { role: 'agent', userId: 'agent-tiers', networkId: t.network.id };
    for (const route of routes.filter((r) => !OWN.includes(r.name) && !OTHERS.includes(r.name))) {
      const before = await refusals(t);
      const r = await raw(t, route, tiers, 'agent-cible');
      expect([route.name, r.status, r.body.rule]).toEqual([route.name, 403, 'R16']);
      expect([route.name, (await refusals(t)) - before]).toEqual([route.name, 1]);
    }
    // Sur la chose d'un autre agent, la couche métier refuse : dossiers d'un absent qu'il ne couvre pas, séance d'entraînement d'un autre.
    const cover = await t.call(tiers, 'GET', '/reseau/agents/agent-cible/dossiers-couverts');
    expect([cover.status, cover.body.rule]).toEqual([403, 'R16']);
    for (const path of ['/reseau/entrainement/seance-autre/tour', '/reseau/entrainement/seance-autre/fin']) {
      const r = await t.call(tiers, 'POST', path, path.endsWith('tour') ? { text: 'Bonjour' } : undefined);
      expect([path, r.status]).toEqual([path, expect.toBeOneOf([403, 404])]);
      expect(r.body.ok).toBe(false);
    }
    // La conformité lit le départ et le dossier, n'écrit rien.
    const compliance: Viewer = { role: 'compliance', userId: 'conformite-1', networkId: t.network.id };
    for (const route of routes.filter((r) => r.method === 'POST' && !OWN.includes(r.name) && !OTHERS.includes(r.name))) {
      expect([route.name, (await raw(t, route, compliance, 'agent-cible')).status]).toEqual([route.name, 403]);
    }
    expect((await t.call(compliance, 'GET', '/reseau/candidatures')).status).toBe(403);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R16] binôme et absence : le binôme lit les dossiers de l’absent pendant l’absence, et plus rien après [R17]', async () => {
    const t = await setup();
    const paul = await t.admitted('Paul', 'paul@exemple.test');
    const lea = await t.admitted('Léa', 'lea@exemple.test');
    const asPaul: Viewer = { role: 'agent', userId: paul, networkId: t.network.id };
    const asLea: Viewer = { role: 'agent', userId: lea, networkId: t.network.id };
    expect((await t.call(asPaul, 'POST', '/reseau/binomes', { agentA: paul, agentB: lea, coverSharePct: 90 })).status).toBe(403);
    expect((await t.call(t.direction, 'POST', '/reseau/binomes', { agentA: paul, agentB: lea, coverSharePct: 30 })).status).toBe(200);
    t.advance(60_000);
    // Léa ne déclare pas l'absence de Paul.
    expect((await t.call(asLea, 'POST', `/reseau/agents/${paul}/absence`, { from: t.today(), until: t.plusDays(2), coverAgentId: lea })).status).toBe(403);
    const absence = await t.call(asPaul, 'POST', `/reseau/agents/${paul}/absence`, { from: t.today(), until: t.plusDays(2), coverAgentId: lea });
    expect(absence.body).toMatchObject({ ok: true, coverSharePct: 30 });
    expect((await t.call(asLea, 'GET', `/reseau/agents/${paul}/dossiers-couverts`)).status).toBe(200);
    t.advance(4 * DAY);
    const after = await t.call(asLea, 'GET', `/reseau/agents/${paul}/dossiers-couverts`);
    expect([after.status, after.body.rule]).toEqual([403, 'R16']);
  });

  it('[R83] parrainage par les routes : règles et parrain par la direction, primes lues par le parrain seul, sans promesse', async () => {
    const t = await setup();
    const parrain = await t.admitted('Sam', 'sam@exemple.test');
    const filleul = await t.admitted('Eva', 'eva@exemple.test');
    const asParrain: Viewer = { role: 'agent', userId: parrain, networkId: t.network.id };
    expect((await t.call(asParrain, 'POST', '/reseau/parrainage/regles', { rateBp: 5000 })).status).toBe(403);
    expect((await t.call(t.direction, 'POST', '/reseau/parrainage/regles', { rateBp: 1000 })).status).toBe(200);
    expect((await t.call(t.direction, 'POST', `/reseau/agents/${filleul}/parrain`, { sponsorId: parrain })).status).toBe(200);
    // Aucune prime à l'arrivée : rien tant que le filleul n'a encaissé aucune commission.
    const mine = await t.call(asParrain, 'GET', '/reseau/mes-primes');
    expect(mine.body.data).toMatchObject({ primes: [], totalCents: 0 });
    expect(checkRecruitingText(mine.body.data.text).ok).toBe(true);
    expect((await t.call({ ...asParrain, userId: filleul }, 'GET', `/reseau/agents/${parrain}/primes`)).status).toBe(403);
    expect((await t.call(t.direction, 'GET', `/reseau/agents/${parrain}/primes`)).status).toBe(200);
  });

  it('[R86] départ par les routes : rangé par la direction, lu par la conformité, refusé à l’agent, annulable', async () => {
    const t = await setup();
    const leaver = await t.admitted('Tom', 'tom@exemple.test');
    const asLeaver: Viewer = { role: 'agent', userId: leaver, networkId: t.network.id };
    const input = { noticeGivenOn: t.today(), leavesOn: t.plusDays(60), reason: 'demission_agent', contractStartedOn: t.today() };
    expect((await t.call(asLeaver, 'POST', `/reseau/agents/${leaver}/depart`, input)).status).toBe(403);
    const ranged = await t.call(t.direction, 'POST', `/reseau/agents/${leaver}/depart`, input);
    expect(ranged.status).toBe(200);
    const compliance: Viewer = { role: 'compliance', userId: 'conformite-1', networkId: t.network.id };
    expect((await t.call(compliance, 'GET', `/reseau/agents/${leaver}/depart`)).body.data).toMatchObject({ agentId: leaver });
    expect((await t.call(compliance, 'GET', `/reseau/agents/${leaver}/solde`)).status).toBe(200);
    expect((await t.call(t.direction, 'GET', '/reseau/reprises')).status).toBe(200);
    expect((await t.call(t.direction, 'POST', `/reseau/agents/${leaver}/depart/annuler`)).status).toBe(200);
    expect((await t.call(t.direction, 'GET', `/reseau/agents/${leaver}/depart`)).body.data).toBeNull();
    // Aucun agent n'est effacé [R17].
    expect(await t.db.all('SELECT id FROM agents WHERE id = ?', [leaver])).toHaveLength(1);
  });

  it('[R16, R86] AU111 · l’accès de sortie : donné par la direction, ouvert par le lien seul, la pièce remise, puis retiré', async () => {
    const t = await setup();
    const leaver = await t.admitted('Tom', 'tom@exemple.test');
    const asLeaver: Viewer = { role: 'agent', userId: leaver, networkId: t.network.id };
    expect((await t.call(t.direction, 'POST', `/reseau/agents/${leaver}/acces-sortie`, {})).body).toMatchObject({ ok: false, code: 'not_gone' });
    expect((await t.call(t.direction, 'POST', `/reseau/agents/${leaver}/depart`, { noticeGivenOn: t.today(), leavesOn: t.today(), reason: 'faute_grave', contractStartedOn: t.today() })).status).toBe(200);
    expect((await t.call(asLeaver, 'POST', `/reseau/agents/${leaver}/acces-sortie`, {})).status).toBe(403);
    const given = await t.call(t.direction, 'POST', `/reseau/agents/${leaver}/acces-sortie`, { days: 30 });
    expect(given.status).toBe(200);
    const token = given.body.data.token as string;
    await t.db.run("INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES ('k-sortie', ?, ?, 'assurance_rcp', 1, ?, ?, NULL, 0, 'test', ?)", [t.network.id, leaver, t.pieces.put(leaver), t.today(), t.now().toISOString()]);
    const s = { db: t.db, journal: t.journal, now: t.now };
    const open = async (path: string, pieces: AgentPieceStore | null = t.pieces) => {
      const r = (await handleSortiePublic(new Request(`https://api.exemple.test/v1${path}`), path, s, pieces))!;
      return { status: r.status, type: r.headers.get('content-type'), body: r.headers.get('content-type')?.startsWith('application/json') ? ((await r.json()) as any) : await r.text() };
    };
    const seen = await open(`/sortie/${token}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.statement).toMatchObject({ format: 'aimmo-sortie-agent/1', agentId: leaver });
    const kind = 'assurance_rcp';
    expect(seen.body.data.statement.pieces).toEqual([{ kind, version: 1 }]);
    // Sans relecture possible du stockage : « indisponible », jamais un faux fichier.
    expect((await open(`/sortie/${token}/pieces/${kind}`)).status).toBe(503);
    const readable: AgentPieceStore = { has: t.pieces.has.bind(t.pieces), putDraft: t.pieces.putDraft.bind(t.pieces), read: async () => ({ body: new TextEncoder().encode('pièce inventée'), contentType: 'application/pdf' }) };
    const file = await open(`/sortie/${token}/pieces/${kind}`, readable);
    expect([file.status, file.type, file.body]).toEqual([200, 'application/pdf', 'pièce inventée']);
    // Un lien faux, ou retiré : la même réponse.
    expect((await open('/sortie/abcdefghijklmnopqrstuvwxyz234567')).status).toBe(404);
    expect((await open('/sortie/pas-un-lien')).status).toBe(404);
    expect((await t.call(t.direction, 'POST', `/reseau/acces-sortie/${given.body.data.accessId}/retrait`)).status).toBe(200);
    expect((await open(`/sortie/${token}`)).status).toBe(404);
    expect(await handleSortiePublic(new Request('https://api.exemple.test/v1/autre'), '/autre', s, null)).toBeNull();
  });

  it('un corps illisible ou porteur d’une clé de plus est refusé sans rien ranger', async () => {
    const t = await setup();
    const bad = await t.call(t.direction, 'POST', '/reseau/reponses', { topic: 'frais', body: 'Aucun frais d’entrée.', score: 3 });
    expect(bad).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.db.all('SELECT id FROM recruiting_answers')).toEqual([]);
  });

  it('[R80] une réponse écrite qui promet un revenu est refusée par la route', async () => {
    const t = await setup();
    const r = await t.call(t.direction, 'POST', '/reseau/reponses', { topic: 'remuneration', body: 'Nos agents touchent 5 000 € par mois dès la première année.' });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe('R80');
    const ok = await t.call(t.direction, 'POST', '/reseau/reponses', { topic: 'remuneration', body: 'La part de l’agent suit la grille écrite, remise avant de signer.' });
    expect(ok.status).toBe(200);
    expect((await t.call(t.direction, 'GET', '/reseau/reponses')).body.data.map((a: { topic: string }) => a.topic)).toEqual(['remuneration']);
  });

  it('[R81] la liste des candidatures se lit dans l’ordre d’arrivée, sans note ni rang, et aucune décision ne porte de score', async () => {
    const t = await setup();
    const firsts = ['Zoé', 'Adam', 'Mia'];
    for (const [i, firstName] of firsts.entries()) {
      const r = await t.applyOnPage({ firstName, email: `cand-${i}@exemple.test`, currentStatus: 'autre_metier', experience: 'aucune', source: 'page', consent: 'oui' });
      expect(r.status).toBe(200);
    }
    const list = await t.call(t.direction, 'GET', '/reseau/candidatures');
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { firstName: string }) => c.firstName)).toEqual(firsts);
    for (const c of list.body.data) for (const k of Object.keys(c)) expect(k).not.toMatch(/score|note|rank|rang|priorit/i);
    // Aucun paramètre de tri n'existe : la liste reste la même.
    const sorted = await t.call(t.direction, 'GET', '/reseau/candidatures?tri=experience');
    expect(sorted.body.data.map((c: { firstName: string }) => c.firstName)).toEqual(firsts);
    const id = list.body.data[0].id;
    const withScore = await t.call(t.direction, 'POST', `/reseau/candidatures/${id}/decision`, { decision: 'non', reason: 'Pas de secteur libre', deciderName: 'Shawez', score: 2 });
    expect(withScore.status).toBe(400);
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toEqual([]);
  });

  it('parcours de bout en bout : 3 candidats inventés, de la page de candidature au dossier d’agent complet [R82]', async () => {
    const t = await setup();
    const people = [
      { firstName: 'Lina', email: 'lina@exemple.test', currentStatus: 'salarie_immobilier', experience: 'de_2_a_5_ans', source: 'video' },
      { firstName: 'Hugo', phone: '06 00 00 00 01', currentStatus: 'autre_metier', experience: 'aucune', source: 'podcast' },
      { firstName: 'Nora', email: 'nora@exemple.test', currentStatus: 'agent_commercial', experience: 'plus_de_5_ans', source: 'page', question: 'Faut-il payer quelque chose pour entrer ?' },
    ];
    for (const p of people) expect((await t.applyOnPage({ ...p, consent: 'oui' })).status).toBe(200);
    const list = await t.call(t.direction, 'GET', '/reseau/candidatures');
    expect(list.body.data).toHaveLength(3);
    for (const c of list.body.data as { id: string; firstName: string; contactable: boolean }[]) {
      expect(c.contactable).toBe(true);
      const sheet = await t.call(t.direction, 'GET', `/reseau/candidatures/${c.id}/entretien`);
      expect(sheet.status).toBe(200);
      expect(sheet.body.data.declared.firstName).toBe(c.firstName);
      const at = new Date(t.now().getTime() + 3_600_000).toISOString();
      const planned = await t.call(t.direction, 'POST', `/reseau/candidatures/${c.id}/entretien`, { at, interviewer: 'Shawez' });
      expect(planned.status).toBe(200);
      // Une décision « oui » avant l'entretien tenu est refusée [R81].
      expect((await t.call(t.direction, 'POST', `/reseau/candidatures/${c.id}/decision`, { decision: 'oui', reason: 'Projet clair', deciderName: 'Shawez' })).body.rule).toBe('R81');
      t.advance(2 * 3_600_000);
      expect((await t.call(t.direction, 'POST', `/reseau/entretiens/${planned.body.interviewId}/tenu`, { heldByName: 'Shawez' })).status).toBe(200);
      expect((await t.call(t.direction, 'POST', `/reseau/candidatures/${c.id}/decision`, { decision: 'oui', reason: 'Projet clair et secteur libre', deciderName: 'Shawez' })).body).toMatchObject({ ok: true, decision: 'oui', opensOnboarding: true });
      const admitted = await t.call(t.direction, 'POST', `/reseau/candidatures/${c.id}/admettre`, { zone: 'Dijon' });
      expect(admitted.status).toBe(200);
      const agentId: string = admitted.body.agentId;
      const me: Viewer = { role: 'agent', userId: agentId, networkId: t.network.id };
      const empty = await t.call(me, 'GET', '/reseau/mon-dossier');
      expect(empty.body.data).toMatchObject({ complete: false });
      // Un autre agent ne lit pas ce dossier [R16].
      expect((await t.call({ ...me, userId: 'agent-autre' }, 'GET', `/reseau/agents/${agentId}/dossier`)).status).toBe(403);
      for (const p of AGENT_FILE_PIECES) {
        const longLived = p.kind === 'contrat_agent_commercial' || p.kind === 'attestation_vigilance';
        const r = await t.call(me, 'POST', `/reseau/agents/${agentId}/pieces`, { kind: p.kind, ref: t.pieces.put(agentId), issuedOn: t.today(), ...(longLived ? {} : { validUntil: t.plusDays(365) }) });
        expect([p.kind, r.status]).toEqual([p.kind, 200]);
      }
      const full = await t.call(me, 'GET', '/reseau/mon-dossier');
      expect([c.firstName, full.body.data.complete]).toEqual([c.firstName, true]);
      // La direction lit le même dossier, complet.
      expect((await t.call(t.direction, 'GET', `/reseau/agents/${agentId}/dossier`)).body.data.complete).toBe(true);
    }
    expect(await t.db.all("SELECT id FROM agents WHERE network_id = ? AND status = 'active'", [t.network.id])).toHaveLength(3);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R82] sans stockage des pièces, les routes du dossier disent « indisponible » au lieu de faire semblant', async () => {
    const t = await setup();
    const route = reseauRoutes().find((r) => r.name === 'reseau.mon_dossier')!;
    const res = await route.handle({ db: t.db, journal: t.journal, now: t.now }, { role: 'agent', userId: 'a', networkId: t.network.id }, [], new Request('https://api.exemple.test/v1/reseau/mon-dossier'));
    expect(res.status).toBe(503);
  });

  it('[R85] l’académie : la direction range un module, l’agent le fait, le compteur vient du code', async () => {
    const t = await setup();
    const agentId = await t.admitted('Iris', 'iris@exemple.test');
    const me: Viewer = { role: 'agent', userId: agentId, networkId: t.network.id };
    const mod = await t.call(t.direction, 'POST', '/reseau/academie/modules', { title: 'Déontologie du mandat', track: 'entree', position: 1, videoId: 'abcdefghijk', durationMinutes: 120, topic: 'deontologie' });
    expect(mod.status).toBe(200);
    // Un agent ne range pas de module, ni d'horaire.
    expect((await t.call(me, 'POST', '/reseau/academie/modules', { title: 'Autre', track: 'entree', position: 2, videoId: 'abcdefghijk', durationMinutes: 30 })).status).toBe(403);
    expect((await t.call(me, 'GET', '/reseau/academie')).body.data[0].modules.map((m: { title: string }) => m.title)).toEqual(['Déontologie du mandat']);
    expect((await t.call(me, 'POST', `/reseau/academie/modules/${mod.body.moduleId}/fait`)).body).toMatchObject({ ok: true, already: false });
    const counter = await t.call(me, 'GET', '/reseau/ma-formation');
    expect(counter.status).toBe(200);
    expect(JSON.stringify(counter.body.data)).toContain('120');
    // Un autre agent ne lit pas ce compteur.
    expect((await t.call({ ...me, userId: 'agent-autre' }, 'GET', `/reseau/agents/${agentId}/formation`)).status).toBe(403);
  });

  it('[R84] l’import d’un agent par la route range sans rien envoyer', async () => {
    const t = await setup();
    const agentId = await t.admitted('Remi', 'remi@exemple.test');
    const me: Viewer = { role: 'agent', userId: agentId, networkId: t.network.id };
    const csv = 'Prénom,Nom,Mail,Tel,Vente,Date consentement,Preuve consentement,Finalité accord\nPaul,Inventé,paul@exemple.test,+33 6 20 00 00 01,2025-06-01,,,\nJade,Inventée,jade@exemple.test,,,,,';
    const r = await t.call(me, 'POST', '/reseau/import', { format: 'excel', contacts: csv });
    expect(r.status).toBe(200);
    expect(r.body.data.contacts).toMatchObject({ read: 2, created: 2 });
    for (const table of ['send_log', 'trial_outbox', 'outbound_refs', 'send_reservations']) expect([table, await t.db.all(`SELECT * FROM ${table}`)]).toEqual([table, []]);
    expect(await t.db.all("SELECT id FROM messages WHERE direction = 'out'")).toEqual([]);
    // Un agent n'importe que pour lui-même : la route prend son identifiant, jamais un autre.
    expect(r.body.data.format).toBe('excel');
    // Un format inconnu est refusé.
    expect((await t.call(me, 'POST', '/reseau/import', { format: 'minitel', contacts: csv })).status).toBe(400);
  });

  it('[R16] [R85] J14 : l’agent lit son référent, ses modules faits et son premier parcours, sans l’identifiant d’un autre', async () => {
    const t = await setup();
    const a = await t.admitted('Aline', 'aline@exemple.test');
    const b = await t.admitted('Bérénice', 'berenice@exemple.test');
    const meA: Viewer = { role: 'agent', userId: a, networkId: t.network.id };
    const meB: Viewer = { role: 'agent', userId: b, networkId: t.network.id };
    // Aucun référent : null, jamais une erreur.
    expect((await t.call(meA, 'GET', '/reseau/mon-referent')).body).toMatchObject({ ok: true, data: null });
    expect((await t.call(t.direction, 'POST', `/reseau/agents/${a}/referent`, { referentId: b })).status).toBe(200);
    const ref = await t.call(meA, 'GET', '/reseau/mon-referent');
    expect(ref.body.data).toEqual({ firstName: 'Bérénice', until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), phone: null, email: null });
    // AU112 · sa carte d'agent réglée, ses coordonnées professionnelles servent à le joindre, rien d'autre.
    await t.db.run("INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES ('carte-b', ?, ?, '06 00 00 00 02', 'berenice.pro@exemple.test', 'direction:d', '2026-01-01T00:00:00.000Z')", [b, t.network.id]);
    expect((await t.call(meA, 'GET', '/reseau/mon-referent')).body.data).toEqual({ firstName: 'Bérénice', until: expect.any(String), phone: '06 00 00 00 02', email: 'berenice.pro@exemple.test' });
    // Le référent lui-même n'a pas de référent ; la direction n'a pas de « mon référent » [R16].
    expect((await t.call(meB, 'GET', '/reseau/mon-referent')).body.data).toBeNull();
    const dir = await t.call(t.direction, 'GET', '/reseau/mon-referent');
    expect([dir.status, dir.body.rule]).toEqual([403, 'R16']);
    // Chaque agent voit ses seuls modules faits [R85, R16].
    const mod = await t.call(t.direction, 'POST', '/reseau/academie/modules', { title: 'Déontologie du mandat', track: 'entree', position: 1, videoId: 'abcdefghijk', durationMinutes: 120, topic: 'deontologie' });
    await t.call(t.direction, 'POST', '/reseau/academie/modules', { title: 'Premier rendez-vous', track: 'entree', position: 2, videoId: 'abcdefghijk', durationMinutes: 30 });
    await t.call(meA, 'POST', `/reseau/academie/modules/${mod.body.moduleId}/fait`);
    const doneOf = async (v: Viewer) => (await t.call(v, 'GET', '/reseau/academie')).body.data[0].modules.map((m: { title: string; done: boolean }) => [m.title, m.done]);
    expect(await doneOf(meA)).toEqual([['Déontologie du mandat', true], ['Premier rendez-vous', false]]);
    expect(await doneOf(meB)).toEqual([['Déontologie du mandat', false], ['Premier rendez-vous', false]]);
    expect(await doneOf(t.direction)).toEqual([['Déontologie du mandat', false], ['Premier rendez-vous', false]]);
    // Sans bac à sable en service, le premier parcours le dit, sans rien inventer.
    const run = await t.call(meA, 'GET', '/reseau/mon-bac-a-sable');
    expect([run.status, run.body.code]).toEqual([503, 'unavailable']);
  });
});
