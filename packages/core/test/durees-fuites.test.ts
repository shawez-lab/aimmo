import { expect, it } from 'vitest';
import { FicheUnique, conformite, verifyChain, type SqlDatabase, type Viewer } from '../src/index.ts';
import { ArretDossier } from '../src/dossiers/index.ts';
import { REGISTRE_TRAITEMENTS } from '../src/conformite/registre-traitements.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const { DureesProspects, Fuites, consentRequestText, breachDeadline } = conformite;

const countAll = async (db: SqlDatabase, except: readonly string[] = []) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const { name } of tables) if (!except.includes(name)) out[name] = (await db.first<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`))!.n;
  return out;
};

/** Le dossier de vente du jeu (vendeur sous mandat, acquéreur d'un dossier ouvert le 1er mars 2027), et des prospects. */
async function setup() {
  const t = await setupDossier();
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const durees = new DureesProspects(t.db, t.journal, fiche, { now: t.now });
  const fuites = new Fuites(t.db, t.journal, fiche, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const responsable = as('compliance', 'conformite-1');
  const prospect = async (at: string, firstName = 'Prospect') => {
    t.setClock(new Date(at));
    return (await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName: 'Inventé' })).id;
  };
  const message = (personId: string, at: string, direction: 'in' | 'out') =>
    t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId, channel: 'email', direction, authorKind: direction === 'in' ? 'person' : 'agent', body: 'Bonjour', occurredAt: new Date(at) });
  const listed = async () => {
    const r = await durees.list(responsable);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, fiche, durees, fuites, as, responsable, prospect, message, listed };
}

describeWithSqlite('L08 · prospects à 3 ans', () => {
  it('[R97] à 3 ans moins un jour un prospect n’est pas listé, à 3 ans il l’est, en jours de Paris', async () => {
    const t = await setup();
    // Fiche créée le 10 mars 2027 à 23 h 30 à Paris (22 h 30 UTC) : c'est encore le 10 mars à Paris.
    const p = await t.prospect('2027-03-10T22:30:00.000Z');
    expect(DureesProspects.reachedOn('2027-03-10T22:30:00.000Z')).toBe('2030-03-10');
    // Le 9 mars 2030 à 23 h 59 à Paris : 3 ans moins un jour.
    t.setClock(new Date('2030-03-09T22:59:00.000Z'));
    expect((await t.durees.run(t.network.id)).listed).toBe(0);
    expect(await t.listed()).toEqual([]);
    // Le 10 mars 2030 à 0 h 01 à Paris.
    t.setClock(new Date('2030-03-09T23:01:00.000Z'));
    expect((await t.durees.run(t.network.id)).listed).toBe(1);
    const [cycle] = await t.listed();
    expect(cycle).toMatchObject({ personId: p, reachedOn: '2030-03-10', listedOn: '2030-03-10', answerDueOn: '2030-04-09', outcome: null, request: { mode: 'essai', blockedBy: null } });
    // La demande de consentement, sans nom ni rien de la personne, avec l'échéance de sa réponse.
    expect(cycle!.request.text).toBe(consentRequestText('2030-04-09'));
    expect(cycle!.request.text).toContain('09/04/2030');
    expect(cycle!.request.text).not.toContain('Prospect');
    // Le passage repasse : rien de plus.
    expect(await t.durees.run(t.network.id)).toEqual({ listed: 0, closed: 0, erasures: 0 });
  });

  it('[R97] le dernier contact est celui de la personne : un message reçu, un accord, un projet ; jamais un message envoyé', async () => {
    const t = await setup();
    const a = await t.prospect('2027-03-02T10:00:00.000Z', 'Ana');
    const b = await t.prospect('2027-03-02T10:00:00.000Z', 'Bob');
    const c = await t.prospect('2027-03-02T10:00:00.000Z', 'Cléo');
    const d = await t.prospect('2027-03-02T10:00:00.000Z', 'Dan');
    // Ana a écrit en 2028 ; on a écrit à Bob en 2029, sans réponse ; Cléo a donné son accord en 2028 ; Dan a ouvert un projet en 2028.
    await t.message(a, '2028-06-01T10:00:00.000Z', 'in');
    await t.message(b, '2029-06-01T10:00:00.000Z', 'out');
    await t.store.addConsent({ networkId: t.network.id, agentId: t.alexId, personId: c, purpose: 'suivi', channel: 'email', proof: 'formulaire du site', givenAt: new Date('2028-06-01T10:00:00.000Z') });
    t.setClock(new Date('2028-06-01T10:00:00.000Z'));
    await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: d, kind: 'buy' });
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    expect((await t.listed()).map((x) => x.personId)).toEqual([b]);
    t.setClock(new Date('2031-06-01T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    expect((await t.listed()).map((x) => x.personId).sort()).toEqual([a, b, c, d].sort());
  });

  it('[R97] un client sous mandat ou une vente close n’est jamais listé', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    // Une SCI cliente et ses deux associés, déclarés pour la lutte contre le blanchiment (L03).
    const sci = await t.prospect('2027-03-02T10:00:00.000Z', 'SCI');
    const [x, y] = [await t.prospect('2027-03-02T10:00:00.000Z', 'Associé'), await t.prospect('2027-03-02T10:00:00.000Z', 'Associée')];
    await t.db.run("INSERT INTO client_identifications (id, network_id, person_id, entity, owners_count, declared_by, declared_at) VALUES ('ci-1', ?, ?, 'societe', 2, 'agent:a', '2027-03-02T10:00:00.000Z')", [t.network.id, sci]);
    for (const o of [x, y]) await t.db.run("INSERT INTO beneficial_owners (declaration_id, network_id, owner_person_id, share_hundredths) VALUES ('ci-1', ?, ?, 5000)", [t.network.id, o]);
    // Six ans plus tard : le vendeur (mandat) et l'acquéreur (dossier de vente) n'ont plus eu aucun contact.
    for (const at of ['2030-03-02T10:00:00.000Z', '2031-01-01T10:00:00.000Z', '2033-03-02T10:00:00.000Z']) {
      t.setClock(new Date(at));
      await t.durees.run(t.network.id);
    }
    const ids = (await t.listed()).map((x) => x.personId);
    expect(ids).toContain(p);
    expect(ids).not.toContain(t.personId);
    expect(ids).not.toContain(t.buyerId);
    for (const o of [sci, x, y]) expect(ids).not.toContain(o);
  });

  it('[R97] [R233] l’acquéreur d’un dossier arrêté n’entre pas aux prospects : son dossier est gardé 10 ans', async () => {
    const t = await setup();
    const proof = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
    t.storage.refs.add(proof);
    t.setClock(new Date('2027-03-10T10:00:00.000Z'));
    expect(await new ArretDossier(t.db, t.acces, t.journal, t.storage, { now: t.now }).stop(t.agent, t.fileId, { reason: 'pret_refuse', proofRef: proof })).toMatchObject({ ok: true });
    for (const at of ['2030-03-10T10:00:00.000Z', '2030-04-10T10:00:00.000Z', '2033-03-10T10:00:00.000Z']) {
      t.setClock(new Date(at));
      await t.durees.run(t.network.id);
    }
    expect((await t.listed()).map((x) => x.personId)).not.toContain(t.buyerId);
    expect(await t.db.first('SELECT 1 FROM prospect_retention_cycles WHERE person_id = ?', [t.buyerId])).toBeNull();
    expect(REGISTRE_TRAITEMENTS.find((x) => x.id === 'offres-dossiers-vente')?.duree).toContain('abandon du dossier');
  });

  it('[R97] [R17] sans réponse, l’effacement suit la procédure de L07 en essai : rien n’est effacé ni envoyé', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    await t.store.addIdentifier({ networkId: t.network.id, personId: p, kind: 'email', value: 'prospect.ancien@example.test' });
    await t.message(p, '2027-03-02T11:00:00.000Z', 'in');
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    const before = await countAll(t.db, ['journal', 'prospect_retention_cycles', 'prospect_retention_outcomes']);
    // Jour par jour jusqu'à l'échéance de la réponse : l'effacement est préparé le jour de l'échéance, une fois.
    const erased: string[] = [];
    for (let d = Date.parse('2030-03-03T10:00:00.000Z'); d <= Date.parse('2030-04-05T10:00:00.000Z'); d += 86_400_000) {
      t.setClock(new Date(d));
      if ((await t.durees.run(t.network.id)).erasures > 0) erased.push(new Date(d).toISOString().slice(0, 10));
    }
    expect(erased).toEqual(['2030-04-01']);
    const [cycle] = await t.listed();
    expect(cycle).toMatchObject({ personId: p, answerDueOn: '2030-04-01', outcome: 'effacement', decidedOn: '2030-04-01' });
    expect(cycle!.planSha256).toMatch(/^[0-9a-f]{64}$/);
    // Le plan est celui de la procédure de L07 sur la même fiche.
    const plan = conformite.erasurePlan(await conformite.assembleAccessDetail(t.db, [p]));
    expect(plan.mode).toBe('essai');
    expect(plan.lines).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'persons', action: 'effacer' }), expect.objectContaining({ table: 'person_identifiers', action: 'empreinte' })]));
    // Rien n'est effacé, rien n'est envoyé : aucune table ne change, hors le journal et les cycles.
    expect(await countAll(t.db, ['journal', 'prospect_retention_cycles', 'prospect_retention_outcomes'])).toEqual(before);
    expect(await t.store.listIdentifiers(p)).toHaveLength(1);
    // Au journal, l'origine, l'empreinte, et rien de la personne.
    const events = (await t.journal.all()).filter((e) => e.subject === `prospect_retention:${cycle!.id}`);
    expect(events.map((e) => e.type)).toEqual(['rgpd.prospect_3_ans', 'rgpd.effacement_essai']);
    expect(events[1]!.data).toMatchObject({ rule: 'R17', origin: 'duree', mode: 'essai', erased: 0, sha256: cycle!.planSha256 });
    expect(JSON.stringify(events)).not.toContain('example.test');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    // Le cycle reste clos : le passage suivant ne relance rien.
    t.setClock(new Date('2030-06-01T10:00:00.000Z'));
    expect(await t.durees.run(t.network.id)).toEqual({ listed: 0, closed: 0, erasures: 0 });
  });

  it('[R97] une personne qui revient avant l’échéance n’est pas effacée ; ses fiches réunies comptent ensemble', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    const twin = await t.prospect('2027-03-02T10:00:00.000Z', 'Double');
    await t.fiche.merge({ survivorId: p, mergedId: twin, reason: 'même adresse' });
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    // Une seule ligne pour la personne, sous la fiche gardée.
    expect((await t.listed()).map((x) => x.personId)).toEqual([p]);
    // Elle répond depuis la fiche réunie : le cycle est clos, rien n'est préparé.
    await t.message(twin, '2030-03-10T10:00:00.000Z', 'in');
    t.setClock(new Date('2030-03-10T12:00:00.000Z'));
    expect(await t.durees.run(t.network.id)).toEqual({ listed: 0, closed: 1, erasures: 0 });
    t.setClock(new Date('2030-04-02T12:00:00.000Z'));
    expect(await t.durees.run(t.network.id)).toEqual({ listed: 0, closed: 0, erasures: 0 });
    expect((await t.listed())[0]).toMatchObject({ outcome: 'contact_repris', planSha256: null });
    // Trois ans après ce nouveau contact, un nouveau cycle.
    t.setClock(new Date('2033-03-10T12:00:00.000Z'));
    expect((await t.durees.run(t.network.id)).listed).toBe(1);
    expect((await t.listed()).map((x) => [x.personId, x.lastContactAt])).toEqual([[p, '2027-03-02T10:00:00.000Z'], [p, '2030-03-10T10:00:00.000Z']]);
  });

  it('[R97] un rendez-vous pris puis annulé compte du jour où il est pris : la personne ne sort jamais de la procédure', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    // Elle prend un appel pour le mois suivant : le cycle est clos ; puis elle l'annule.
    await t.db.run(
      "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES ('rdv-1', ?, ?, ?, NULL, 'appel', '2030-04-10T08:00:00.000Z', '2030-04-10T08:30:00.000Z', 'booked', 'h', 'agent', '2030-03-05T10:00:00.000Z', '2030-03-05T10:00:00.000Z')",
      [t.network.id, t.alexId, p],
    );
    t.setClock(new Date('2030-03-06T10:00:00.000Z'));
    expect(await t.durees.run(t.network.id)).toMatchObject({ closed: 1 });
    await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = 'rdv-1'");
    // Trois ans après la prise du rendez-vous, elle est listée de nouveau.
    t.setClock(new Date('2033-03-05T10:00:00.000Z'));
    expect((await t.durees.run(t.network.id)).listed).toBe(1);
    expect((await t.listed()).map((x) => x.lastContactAt)).toEqual(['2027-03-02T10:00:00.000Z', '2030-03-05T10:00:00.000Z']);
  });

  it('[R97] une fusion défaite rend la personne à la procédure', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    // Réunie par erreur à une personne qui vient d'écrire : le cycle se clôt.
    const other = await t.prospect('2030-03-03T10:00:00.000Z', 'Autre');
    await t.message(other, '2030-03-03T10:00:00.000Z', 'in');
    const merge = await t.fiche.merge({ survivorId: p, mergedId: other, reason: 'erreur' });
    t.setClock(new Date('2030-03-04T10:00:00.000Z'));
    expect(await t.durees.run(t.network.id)).toMatchObject({ closed: 1 });
    // La fusion est défaite : le lendemain, un nouveau cycle, puis l'effacement préparé à son échéance.
    await t.fiche.undoMerge(merge.id, { journal: t.journal, actor: 'direction:test' });
    t.setClock(new Date('2030-03-05T10:00:00.000Z'));
    expect((await t.durees.run(t.network.id)).listed).toBe(1);
    t.setClock(new Date('2030-04-04T10:00:00.000Z'));
    expect((await t.durees.run(t.network.id)).erasures).toBe(1);
    expect((await t.listed()).filter((x) => x.personId === p).map((x) => x.outcome)).toEqual(['contact_repris', 'effacement']);
  });

  it('[R97] [R04] [R16] une personne arrêtée est signalée sur sa demande ; seul le responsable lit la liste', async () => {
    const t = await setup();
    const p = await t.prospect('2027-03-02T10:00:00.000Z');
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.alexId, personId: p, reason: 'stop', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    t.setClock(new Date('2030-03-02T10:00:00.000Z'));
    await t.durees.run(t.network.id);
    expect((await t.listed())[0]!.request.blockedBy).toBe('R04');
    // La lecture réussie est au journal, avec les fiches lues [R16].
    const read = (await t.journal.all()).filter((e) => e.type === 'rgpd.prospects_lus').at(-1)!;
    expect(read.data).toMatchObject({ rule: 'R16', role: 'compliance', count: 1, persons: [`person:${p}`] });
    for (const viewer of [t.agent, t.direction, t.as('partner', 'partenaire-1')]) {
      expect(await t.durees.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'durees_prospects')).toHaveLength(3);
  });
});

describeWithSqlite('L08 · procédure de fuite', () => {
  it('[R97] l’échéance de 72 heures et ses alertes vérifiées heure par heure, changement d’heure compris', async () => {
    const t = await setup();
    // Connaissance le samedi 30 octobre 2027 à 14 h à Paris (12 h UTC) : l'heure d'hiver arrive dans la nuit.
    t.setClock(new Date('2027-10-30T12:30:00.000Z'));
    const r = await t.fuites.declare(t.responsable, { awareAt: '2027-10-30T14:00:00+02:00' });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ awareAt: '2027-10-30T12:00:00.000Z', deadlineAt: '2027-11-02T12:00:00.000Z', due: { cnil: true, personnes: false } });
    expect(breachDeadline('2027-10-30T12:00:00.000Z')).toBe('2027-11-02T12:00:00.000Z');
    const raised: Record<string, string> = {};
    for (let h = Date.parse('2027-10-30T12:30:00.000Z'); h <= Date.parse('2027-11-02T15:30:00.000Z'); h += 3_600_000) {
      t.setClock(new Date(h));
      await t.fuites.run(t.network.id);
      expect(await t.fuites.run(t.network.id)).toBe(0);
      const alerts = await t.fuites.alerts(t.responsable);
      if (!alerts.ok) throw new Error(alerts.code);
      for (const a of alerts.value) raised[a.kind] ??= new Date(h).toISOString();
    }
    expect(raised).toEqual({
      connaissance: '2027-10-30T12:30:00.000Z',
      h24: '2027-11-01T12:30:00.000Z',
      h6: '2027-11-02T06:30:00.000Z',
      echeance: '2027-11-02T12:30:00.000Z',
    });
    const alerts = await t.fuites.alerts(t.responsable);
    if (!alerts.ok) throw new Error(alerts.code);
    // L'échéance dite à l'heure de Paris : 13 h, à l'heure d'hiver.
    expect(alerts.value.find((a) => a.kind === 'h24')!.text).toContain('02/11/2027 à 13:00');
    // Une notification à la CNIL après l'échéance exige sa raison, et elle est notée en retard.
    expect(await t.fuites.notified(t.responsable, r.value.id, { target: 'cnil', notifiedAt: '2027-11-02T14:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'late_cause_required' });
    const late = await t.fuites.notified(t.responsable, r.value.id, { target: 'cnil', notifiedAt: '2027-11-02T14:00:00.000Z', lateCause: 'evaluation_en_cours' });
    expect(late).toMatchObject({ ok: true, value: { notified: { cnil: { late: true } } } });
  });

  it('[R97] prévenue à temps, ou sans risque : plus d’alerte ; un risque élevé demande aussi les personnes', async () => {
    const t = await setup();
    t.setClock(new Date('2027-04-01T08:00:00.000Z'));
    const a = await t.fuites.declare(t.responsable, { awareAt: '2027-04-01T08:00:00.000Z' });
    const b = await t.fuites.declare(t.responsable, { awareAt: '2027-04-01T08:00:00.000Z' });
    if (!a.ok || !b.ok) throw new Error('fuite');
    expect(await t.fuites.run(t.network.id)).toBe(2);
    // A : sans risque, documentée ; B : risque élevé, prévenue à temps.
    const none = await t.fuites.evaluate(t.responsable, a.value.id, { risk: 'aucun', nature: ['disponibilite'], categories: ['coordonnees'], scope: { kind: 'agent', agentId: t.alexId } });
    expect(none).toMatchObject({ ok: true, value: { due: { cnil: false, personnes: false } } });
    const high = await t.fuites.evaluate(t.responsable, b.value.id, { risk: 'eleve', nature: ['confidentialite'], categories: ['identite', 'coordonnees'], scope: { kind: 'reseau' } });
    expect(high).toMatchObject({ ok: true, value: { due: { cnil: true, personnes: true } } });
    t.setClock(new Date('2027-04-02T08:00:00.000Z'));
    expect(await t.fuites.notified(t.responsable, b.value.id, { target: 'cnil', notifiedAt: '2027-04-02T07:00:00.000Z' })).toMatchObject({ ok: true, value: { notified: { cnil: { late: false } } } });
    expect(await t.fuites.notified(t.responsable, b.value.id, { target: 'cnil', notifiedAt: '2027-04-02T07:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'already_notified' });
    for (const at of ['2027-04-03T09:00:00.000Z', '2027-04-04T09:00:00.000Z', '2027-04-05T09:00:00.000Z']) {
      t.setClock(new Date(at));
      expect(await t.fuites.run(t.network.id)).toBe(0);
    }
    // Entrées refusées.
    expect(await t.fuites.declare(t.responsable, { awareAt: '2027-05-01T08:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'future_date' });
    expect(await t.fuites.declare(t.responsable, { awareAt: 'hier' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.fuites.evaluate(t.responsable, a.value.id, { risk: 'moyen' as never, nature: ['integrite'], categories: ['messages'], scope: { kind: 'reseau' } })).toEqual({ ok: false, rule: null, code: 'bad_risk' });
    expect(await t.fuites.evaluate(t.responsable, a.value.id, { risk: 'risque', nature: [], categories: ['messages'], scope: { kind: 'reseau' } })).toEqual({ ok: false, rule: null, code: 'bad_nature' });
    expect(await t.fuites.evaluate(t.responsable, a.value.id, { risk: 'risque', nature: ['integrite'], categories: ['photos' as never], scope: { kind: 'reseau' } })).toEqual({ ok: false, rule: null, code: 'bad_categories' });
    expect(await t.fuites.evaluate(t.responsable, a.value.id, { risk: 'risque', nature: ['integrite'], categories: ['messages'], scope: { kind: 'personnes', personIds: ['inconnue'] } })).toEqual({ ok: false, rule: null, code: 'bad_scope' });
  });

  it('[R97] la liste des personnes concernées : par agent ou par fiches, fiches réunies comptées une fois, figée par évaluation', async () => {
    const t = await setup();
    const p = await t.prospect('2027-04-01T07:00:00.000Z');
    const twin = await t.prospect('2027-04-01T07:00:00.000Z', 'Double');
    await t.fiche.merge({ survivorId: p, mergedId: twin, reason: 'même adresse' });
    t.setClock(new Date('2027-04-01T08:00:00.000Z'));
    const b = await t.fuites.declare(t.responsable, { awareAt: '2027-04-01T08:00:00.000Z' });
    if (!b.ok) throw new Error(b.code);
    const byAgent = await t.fuites.evaluate(t.responsable, b.value.id, { risk: 'risque', nature: ['confidentialite'], categories: ['coordonnees'], scope: { kind: 'agent', agentId: t.alexId } });
    if (!byAgent.ok) throw new Error(byAgent.code);
    const alexPersons = (await t.db.all<{ id: string }>('SELECT id FROM persons WHERE agent_id = ?', [t.alexId])).map((r) => r.id).filter((id) => id !== twin);
    const first = await t.fuites.concerned(t.responsable, b.value.id);
    expect(first).toMatchObject({ ok: true, value: { version: 1, personIds: [...alexPersons].sort() } });
    expect(first.ok && first.value.personIds).not.toContain(twin);
    // Une nouvelle évaluation, plus étroite : la nouvelle liste ; l'ancienne reste gardée.
    await t.fuites.evaluate(t.responsable, b.value.id, { risk: 'risque', nature: ['confidentialite'], categories: ['coordonnees'], scope: { kind: 'personnes', personIds: [twin, t.buyerId] } });
    expect(await t.fuites.concerned(t.responsable, b.value.id)).toMatchObject({ ok: true, value: { version: 2, personIds: [p, t.buyerId].sort() } });
    expect((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM data_breach_persons WHERE version = 1'))!.n).toBe(alexPersons.length);
    // Une évaluation dont la liste n'a pas été écrite en entier (coupure) n'est jamais lue ; la suivante prend la version d'après.
    await t.db.run("INSERT INTO data_breach_evaluations (breach_id, version, risk, nature, categories, scope, agent_id, concerned_count, persons_sha256, evaluated_by, evaluated_at) VALUES (?, 3, 'aucun', '[]', '[]', 'reseau', NULL, 5, ?, 'compliance:c', 't')", [b.value.id, 'f'.repeat(64)]);
    expect(await t.fuites.concerned(t.responsable, b.value.id)).toMatchObject({ ok: true, value: { version: 2 } });
    const again = await t.fuites.evaluate(t.responsable, b.value.id, { risk: 'eleve', nature: ['confidentialite'], categories: ['coordonnees'], scope: { kind: 'personnes', personIds: [p] } });
    expect(again).toMatchObject({ ok: true, value: { evaluation: { version: 4, risk: 'eleve', personsCount: 1 } } });
    // Au journal : la lecture de la liste nomme les fiches lues [R16] ; les autres gestes, des nombres seulement.
    const events = (await t.journal.all()).filter((e) => e.subject === `breach:${b.value.id}`);
    const reads = events.filter((e) => e.type === 'rgpd.fuite_liste_lue');
    expect(reads.at(-1)!.data).toMatchObject({ rule: 'R16', version: 2, persons: [`person:${p}`, `person:${t.buyerId}`].sort() });
    expect(JSON.stringify(events.filter((e) => e.type !== 'rgpd.fuite_liste_lue'))).not.toContain(p);
    expect(JSON.stringify(events.filter((e) => e.type !== 'rgpd.fuite_liste_lue'))).not.toContain(t.buyerId);
  });

  it('[R97] [R16] les accès coupés d’un geste, sauf le responsable ; rétablis une fois ; personne d’autre ne lit la fuite', async () => {
    const t = await setup();
    t.setClock(new Date('2027-04-01T08:00:00.000Z'));
    // Trois clés remises par invitation : un agent, la direction, le responsable.
    await t.db.run(
      "INSERT INTO access_invitations (id, network_id, token_sha256, grants, expires_at, created_at, used_at) VALUES ('inv-1', ?, ?, ?, '2027-04-02T08:00:00.000Z', '2027-04-01T07:00:00.000Z', '2027-04-01T07:10:00.000Z')",
      [t.network.id, 'a'.repeat(64), JSON.stringify([{ role: 'agent', userId: 'x' }])],
    );
    for (const [sha, role, user] of [['1', 'agent', t.alexId], ['2', 'direction', 'direction-1'], ['3', 'compliance', 'conformite-1']] as const) {
      await t.db.run("INSERT INTO access_keys (sha256, network_id, role, user_id, invitation_id, created_at) VALUES (?, ?, ?, ?, 'inv-1', '2027-04-01T07:10:00.000Z')", [sha.repeat(64), t.network.id, role, user]);
    }
    const b = await t.fuites.declare(t.responsable, { awareAt: '2027-04-01T08:00:00.000Z' });
    if (!b.ok) throw new Error(b.code);
    // Un agent ne coupe rien et ne lit rien.
    expect(await t.fuites.cutAccess(t.agent, b.value.id, { kind: 'tous' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    for (const viewer of [t.agent, t.direction]) {
      expect(await t.fuites.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.fuites.concerned(viewer, b.value.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.fuites.declare(viewer, { awareAt: '2027-04-01T08:00:00.000Z' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.fuites.accessCut(t.network.id, 'agent', t.alexId)).toBe(false);
    // La direction coupe tout d'un geste : chaque clé sauf celle du responsable.
    const cut = await t.fuites.cutAccess(t.direction, b.value.id, { kind: 'tous' });
    if (!cut.ok) throw new Error(cut.code);
    expect(cut.value.cuts).toMatchObject([{ scope: 'tous', keysRevoked: 2, restoredAt: null }]);
    expect(await t.db.all('SELECT role, revoked_at IS NOT NULL AS revoked FROM access_keys ORDER BY role')).toEqual([
      { role: 'agent', revoked: 1 },
      { role: 'compliance', revoked: 0 },
      { role: 'direction', revoked: 1 },
    ]);
    // Les clés du secret aussi, par la lecture du socle.
    expect(await t.fuites.accessCut(t.network.id, 'agent', 'agent-du-secret')).toBe(true);
    expect(await t.fuites.accessCut(t.network.id, 'direction', 'direction-1')).toBe(true);
    expect(await t.fuites.accessCut(t.network.id, 'compliance', 'conformite-1')).toBe(false);
    // Rétablie une fois par le responsable ; les clés retirées le restent.
    expect(await t.fuites.restoreAccess(t.direction, b.value.id, cut.value.cuts[0]!.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.fuites.restoreAccess(t.responsable, b.value.id, cut.value.cuts[0]!.id)).toMatchObject({ ok: true });
    expect(await t.fuites.restoreAccess(t.responsable, b.value.id, cut.value.cuts[0]!.id)).toEqual({ ok: false, rule: null, code: 'already_restored' });
    expect(await t.fuites.accessCut(t.network.id, 'agent', 'agent-du-secret')).toBe(false);
    expect((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM access_keys WHERE revoked_at IS NOT NULL'))!.n).toBe(2);
    // Une seule personne.
    const one = await t.fuites.cutAccess(t.responsable, b.value.id, { kind: 'utilisateur', userId: t.alexId });
    expect(one).toMatchObject({ ok: true });
    expect(await t.fuites.accessCut(t.network.id, 'agent', t.alexId)).toBe(true);
    expect(await t.fuites.accessCut(t.network.id, 'agent', 'autre-agent')).toBe(false);
    // Personne, pas même la direction, ne coupe les clés du responsable.
    expect(await t.fuites.cutAccess(t.direction, b.value.id, { kind: 'utilisateur', userId: 'conformite-1' })).toMatchObject({ ok: true });
    expect(await t.db.first("SELECT revoked_at FROM access_keys WHERE role = 'compliance'")).toEqual({ revoked_at: null });
    // Les refus vont au journal ; rien n'est effacé.
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'fuites').length).toBeGreaterThanOrEqual(8);
    await expect(t.db.run('DELETE FROM data_breach_cuts')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM data_breaches')).rejects.toThrow();
  });
});
