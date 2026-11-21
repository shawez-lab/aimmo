import { expect, it } from 'vitest';
import { ALERT_PURPOSE, PointSemaine, RendezVous, SELLER_UPDATE_PURPOSE, verifyChain } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';
import { enClair } from '../../core/test/boite-essai.ts';

// Tout est inventé : réseau, bien, vendeur, acquéreur et clés de test.
const BASE = 'https://aimmo-api.example.test';
const UNSUBSCRIBE = 'https://aimmo.example.test/alertes/desinscription/';
const KEYS = { alex: 'test-cle-m08-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-m08-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-m08-direction-cccccccccccccccccccccc', compliance: 'test-cle-m08-conformite-dddddddddddddddddddd', ailleurs: 'test-cle-m08-ailleurs-eeeeeeeeeeeeeeeeeeeeeee' };
type Who = keyof typeof KEYS;
const TUESDAY_10H = new Date('2027-03-02T09:00:00.000Z');
const WEDNESDAY_14H = '2027-03-03T13:00:00.000Z';
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';

async function setup() {
  const t = await setupAnnonce();
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: 'direction-1', networkId: t.network.id },
    compliance: { role: 'compliance', userId: 'c-1', networkId: t.network.id },
    ailleurs: { role: 'agent', userId: 'agent-ailleurs', networkId: 'autre-reseau' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const call = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, init), { db: t.db, apiKeys, mode: 'essai', alertUnsubscribeBase: UNSUBSCRIBE, now: t.now });
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null } };
  };
  // Le vendeur accepte le suivi de sa vente par mail ; l'acquéreur d'Alex, ses alertes sur WhatsApp.
  const { store, db, journal } = t;
  await store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea@example.test' });
  await store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: SELLER_UPDATE_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
  const buyer = await store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Inès', lastName: 'Durand' });
  await store.addIdentifier({ networkId: t.network.id, personId: buyer.id, kind: 'phone', value: '+33 6 00 00 00 01' });
  await store.addConsent({ networkId: t.network.id, personId: buyer.id, purpose: ALERT_PURPOSE, channel: 'whatsapp', proof: 'demande écrite', givenAt: new Date('2027-02-01T09:00:00.000Z') });
  const project = await store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: buyer.id, kind: 'buy' });
  await new RendezVous(db, journal, { now: t.now }).setAvailability(ids.alex as never, WEEK);
  const sms = async () => {
    const [m] = await enClair(db.all<{ id: string; body: string }>("SELECT m.id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.channel = 'sms' ORDER BY m.occurred_at DESC, m.rowid DESC LIMIT 1"));
    return /(\d{6})/.exec(m!.body)![1]!;
  };
  const toSeller = () => db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at, m.rowid', [t.personId]);
  return { ...t, call, buyer, project, sms, toSeller };
}

describeWithSqlite('T08 · routes de M08', () => {
  it('parcours complet par les routes : bien diffusable, acquéreurs proposés, alerte WhatsApp, visite sécurisée, compte rendu et point du lundi', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    // L'agent pose la recherche de son acquéreur.
    const search = await t.call('alex', 'POST', `/acquereurs/projets/${t.project.id}/recherche`, { propertyKinds: ['house'], communes: ['Dijon'], budgetMaxEur: 220000, surfaceMinM2: 55 });
    expect(search.status).toBe(200);
    expect((await t.call('alex', 'GET', `/acquereurs/projets/${t.project.id}/recherche`)).body).toMatchObject({ ok: true, data: { current: { version: 1 } } });
    // Le bien est diffusable : l'acquéreur est proposé, avec les raisons, et la carte de la demande le compte.
    const proposed = await t.call('alex', 'GET', `/acquereurs/biens/${t.propertyId}`);
    expect(proposed.body).toMatchObject({ ok: true, data: [{ rank: 1, projectId: t.project.id, firstName: 'Inès', status: 'match' }] });
    expect((await t.call('alex', 'GET', `/acquereurs/biens/${t.propertyId}/carte`)).body).toMatchObject({ ok: true, data: { activeBuyers: 1, matching: 1 } });
    // L'alerte WhatsApp de l'agent : le lien pré-rempli, puis « c'est parti », une seule fois [R18].
    const wa = await t.call('alex', 'POST', `/acquereurs/biens/${t.propertyId}/whatsapp/${t.project.id}`);
    expect(wa.status).toBe(200);
    expect(wa.body.data.link).toMatch(/^https:\/\/wa\.me\/33600000001\?text=/);
    const sent = await t.call('alex', 'POST', `/acquereurs/whatsapp/${wa.body.data.messageId}/envoye`);
    expect(sent.body).toMatchObject({ ok: true, data: { confirmedAt: TUESDAY_10H.toISOString() } });
    // Jamais deux fois le même bien à la même personne [R18].
    expect((await t.call('alex', 'POST', `/acquereurs/biens/${t.propertyId}/whatsapp/${t.project.id}`)).status).toBe(409);

    // La visite, avec son bon [R40].
    expect((await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H })).body).toMatchObject({ ok: false, rule: 'R40', code: 'no_template' });
    const tpl = await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE });
    expect(tpl.status).toBe(200);
    const visit = await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H });
    expect(visit.status).toBe(200);
    const id = visit.body.data.visit.appointment.id as string;
    expect((await t.call('alex', 'GET', `/visites/${id}/bon`)).body).toMatchObject({ ok: true, data: { slip: { appointmentId: id } } });
    const screen = await t.call('alex', 'GET', `/visites/${id}`);
    expect(screen.body).toMatchObject({ ok: true, data: { property: { id: t.propertyId, reference: 'REF-T-1', city: 'Dijon' }, visitor: { firstName: 'Inès' }, safety: 'a_confirmer', report: null, slip: { mode: 'essai' } } });
    expect(JSON.stringify(screen.body)).not.toMatch(/Durand|33600000001/);

    // Visite sécurisée : code par SMS, puis code et nom du visiteur [R54].
    t.setClock(new Date('2027-03-03T12:40:00.000Z'));
    expect((await t.call('alex', 'POST', `/visites/${id}/code`, { consentProof: 'accord oral du visiteur, noté par l’agent' })).status).toBe(200);
    expect((await t.call('alex', 'POST', `/visites/${id}/confirmation`, { code: await t.sms(), lastName: 'Martin' })).body).toMatchObject({ ok: false, rule: 'R54', code: 'bad_identity' });
    expect((await t.call('alex', 'POST', `/visites/${id}/confirmation`, { code: await t.sms(), lastName: 'Durand' })).body).toMatchObject({ ok: true, data: { confirmed: true } });
    expect((await t.call('alex', 'GET', `/visites/${id}`)).body.data.safety).toBe('confirmee');

    // AU075 · Le bon signé sur le téléphone de l'agent : code au visiteur par SMS, bon lu à l'écran, code tapé, sans papier.
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature-en-ligne`, { place: 'distance', consentProof: 'accord' })).body).toMatchObject({ ok: false, code: 'distance_not_served' });
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature-en-ligne`, { place: 'sur_place', consentProof: 'accord oral du visiteur, noté par l’agent', extra: 1 })).status).toBe(400);
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature-en-ligne`, { place: 'sur_place', consentProof: 'accord oral du visiteur, noté par l’agent' })).body).toMatchObject({ ok: true, data: { place: 'sur_place', channel: 'sms', mode: 'essai' } });
    expect((await t.call('alex', 'GET', `/visites/${id}/bon/a-signer`)).body).toMatchObject({ ok: true, data: { paragraphs: expect.arrayContaining([expect.stringContaining('REF-T-1')]) } });
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature-sur-place`, { code: '000000' })).body).toMatchObject({ ok: false, code: 'wrong_code' });
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature-sur-place`, { code: await t.sms(), drawing: 'M0 0 L4 4' })).body).toMatchObject({ ok: true, data: { copy: 'remis', copyLink: false, proof: { method: 'code_et_trace', realSignature: false } } });
    expect((await t.call('alex', 'GET', `/visites/${id}/bon/exemplaire`)).body).toMatchObject({ ok: true, data: { paragraphs: expect.arrayContaining([expect.stringContaining('REF-T-1')]), proof: { place: 'sur_place' } } });
    expect((await t.call('alex', 'GET', `/visites/${id}`)).body.data.slip).toMatchObject({ signed: true, online: { status: 'signee', place: 'sur_place', copy: 'remis' } });
    expect((await t.call('alex', 'POST', `/visites/${id}/bon/signature`, { signedAt: '2027-03-03T12:39:00.000Z', scanRef: 'scans/bon.pdf' })).body).toMatchObject({ ok: false, code: 'signed_online' });

    // Le compte rendu dicté : sans IA branchée, l'agent écrit, valide en un geste, le vendeur le reçoit sans le nom [R52].
    t.setClock(new Date('2027-03-03T14:10:00.000Z'));
    expect((await t.call('alex', 'POST', `/visites/${id}/compte-rendu/dictee`, { dictation: 'Inès a aimé la lumière et le balcon, cuisine à refaire.' })).body).toMatchObject({ ok: true, data: { report: null } });
    const report = { opinion: 'Le visiteur a aimé la lumière du séjour.', strengths: ['séjour lumineux', 'balcon'], reservations: ['cuisine à refaire'], interest: 'fort', readyToOffer: false };
    expect((await t.call('alex', 'POST', `/visites/${id}/compte-rendu/validation`, { report: { ...report, opinion: 'Inès Durand a aimé le séjour.' } })).body).toMatchObject({ ok: false, rule: 'R52' });
    expect((await t.call('alex', 'POST', `/visites/${id}/compte-rendu/validation`, { report })).body).toMatchObject({ ok: true, data: { delivery: 'sent' } });
    const seller = await t.toSeller();
    expect(seller.at(-1)!.body).toContain('compte rendu de la visite');
    expect(JSON.stringify(seller)).not.toMatch(/Inès|Durand/);

    // Le point du lundi : préparé à 8 h, lu et validé par l'agent avec ses prochaines actions [R53].
    const monday = new Date('2027-03-08T07:00:00.000Z');
    t.setClock(monday);
    expect(await new PointSemaine(t.db, t.journal, t.acces, { now: t.now }).prepare(t.network.id)).toBe(1);
    t.setClock(new Date('2027-03-08T08:30:00.000Z'));
    const list = await t.call('alex', 'GET', '/points?semaine=2027-03-01');
    expect(list.body).toMatchObject({ ok: true, data: { week: '2027-03-01', points: [{ mandateId: t.mandateId, status: 'prepare', property: { reference: 'REF-T-1' } }] } });
    expect(list.body.data.points[0].text).toContain('Avis des visiteurs : Le visiteur a aimé la lumière du séjour');
    expect((await t.call('sam', 'GET', '/points?semaine=2027-03-01')).body.data.points).toEqual([]);
    expect((await t.call('alex', 'POST', `/points/${t.mandateId}/2027-03-01/validation`, { actions: ['Revoir le prix ensemble'] })).body).toMatchObject({ ok: false, rule: 'R53' });
    // Une décision de prix : explicite et liée à un rendez-vous tenu avec le vendeur, sinon refusée (AU078) [R53].
    expect((await t.call('alex', 'POST', `/points/${t.mandateId}/2027-03-01/validation`, { actions: [], decisionPrix: 'baisse' })).status).toBe(400);
    expect((await t.call('alex', 'POST', `/points/${t.mandateId}/2027-03-01/validation`, { actions: [], decisionPrix: { rendezVous: 'inconnu', prix: 200000, confirme: true } })).body).toMatchObject({ ok: false, rule: 'R53', code: 'exchange_unknown' });
    expect((await t.call('alex', 'POST', `/points/${t.mandateId}/2027-03-01/validation`, { actions: [], decisionPrix: { rendezVous: 'inconnu', prix: 200000 } })).body).toMatchObject({ ok: false, rule: 'R53', code: 'price_decision_not_confirmed' });
    expect((await t.call('alex', 'POST', `/points/${t.mandateId}/2027-03-01/validation`, { actions: ['Organiser de nouvelles visites cette semaine'] })).body).toMatchObject({ ok: true, data: { delivery: 'sent' } });
    expect((await t.toSeller()).at(-1)!.body).toContain('Organiser de nouvelles visites cette semaine');

    // L'alerte en un geste : sans prévenant branché, la réponse dit le mode essai.
    expect((await t.call('alex', 'POST', '/visites/alertes/alerte-0000001')).body).toMatchObject({ ok: true, data: { recorded: true, notified: false, mode: 'essai', level: 1, trial: true } });
    // AU008 : l'agent lit l'état de son alerte ; la direction l'acquitte.
    expect((await t.call('alex', 'GET', '/visites/alertes/alerte-0000001')).body).toMatchObject({ ok: true, data: { alert: { notified: false, mode: 'essai', acknowledged: false } } });
    expect((await t.call('direction', 'POST', '/visites/alertes/alerte-0000001/acquittement')).body).toMatchObject({ ok: true, data: { already: false, alert: { acknowledged: true } } });
    expect((await t.call('alex', 'GET', '/visites/alertes/alerte-0000001')).body).toMatchObject({ ok: true, data: { alert: { acknowledged: true } } });

    // Rien n'est parti réellement ; ni clé, ni numéro, ni dictée au journal [R13] ; la chaîne tient.
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/test-cle|33600000001|balcon et|wa\.me/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R16] chaque route passe par les droits ; chaque refus rend 403 ou 404 et écrit une ligne au journal', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    await t.call('alex', 'POST', `/acquereurs/projets/${t.project.id}/recherche`, { propertyKinds: ['house'], communes: ['Dijon'], budgetMaxEur: 220000 });
    await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE });
    const wa = await t.call('alex', 'POST', `/acquereurs/biens/${t.propertyId}/whatsapp/${t.project.id}`);
    const id = (await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H })).body.data.visit.appointment.id as string;
    await new PointSemaine(t.db, t.journal, t.acces, { now: t.now }).prepare(t.network.id);
    const week = '2027-02-22';
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const cases: [Who, 'GET' | 'POST', string, unknown?][] = [
      ['sam', 'GET', `/acquereurs/projets/${t.project.id}/recherche`],
      ['sam', 'POST', `/acquereurs/projets/${t.project.id}/recherche`, { roomsMin: 3 }],
      ['compliance', 'GET', `/acquereurs/biens/${t.propertyId}`],
      ['compliance', 'GET', `/acquereurs/biens/${t.propertyId}/carte`],
      ['sam', 'POST', `/acquereurs/biens/${t.propertyId}/whatsapp/${t.project.id}`],
      ['sam', 'POST', `/acquereurs/whatsapp/${wa.body.data.messageId}/envoye`],
      ['sam', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H }],
      ['alex', 'GET', '/visites/alertes'],
      ['direction', 'POST', '/visites/alertes/alerte-0000001'],
      ['sam', 'GET', '/visites/alertes/alerte-0000001'],
      ['alex', 'POST', '/visites/alertes/alerte-0000001/acquittement'],
      ['alex', 'POST', '/visites/modeles', { body: TEMPLATE }],
      ['sam', 'GET', `/visites/${id}`],
      ['sam', 'GET', `/visites/${id}/bon`],
      ['sam', 'POST', `/visites/${id}/bon/signature`, { signedAt: WEDNESDAY_14H, scanRef: 'scans/bon.pdf' }],
      ['sam', 'POST', `/visites/${id}/bon/signature-en-ligne`, { place: 'sur_place', consentProof: 'accord' }],
      ['sam', 'GET', `/visites/${id}/bon/a-signer`],
      ['sam', 'POST', `/visites/${id}/bon/signature-sur-place`, { code: '123456' }],
      ['sam', 'GET', `/visites/${id}/bon/exemplaire`],
      ['sam', 'POST', `/visites/${id}/annulation`],
      ['sam', 'POST', `/visites/${id}/code`, { consentProof: 'accord' }],
      ['sam', 'POST', `/visites/${id}/confirmation`, { code: '123456', lastName: 'Durand' }],
      ['sam', 'POST', `/visites/${id}/compte-rendu/dictee`, { dictation: 'Il a aimé.' }],
      ['sam', 'POST', `/visites/${id}/compte-rendu/validation`],
      ['compliance', 'GET', `/points?semaine=${week}`],
      ['sam', 'GET', `/points/${t.mandateId}/${week}`],
      ['sam', 'POST', `/points/${t.mandateId}/${week}/validation`, { actions: [] }],
    ];
    for (const [who, method, path, body] of cases) {
      const before = await refusals();
      const r = await t.call(who, method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(r.status);
      expect(r.body, `${method} ${path}`).toMatchObject({ ok: false, rule: 'R16' });
      expect((await refusals()) - before, `${method} ${path}`).toBe(1);
    }
    // Le modèle de bon se valide par la direction seule ; un agent d'un autre réseau ne voit rien.
    const tpl = await t.db.first<{ id: string }>('SELECT id FROM visit_slip_templates');
    expect((await t.call('alex', 'POST', `/visites/modeles/${tpl!.id}/validation`)).status).toBe(403);
    // Sa clé ne correspond à aucun agent en activité de son réseau : refusée avant toute lecture (J13) [R16].
    expect((await t.call('ailleurs', 'GET', `/visites/${id}`)).body).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect((await t.call('ailleurs', 'GET', `/acquereurs/projets/${t.project.id}/recherche`)).status).toBe(403);
    // Le bien passe à un autre agent et se vend : l'écran de la visite ne le montre plus [R16].
    await t.db.run("UPDATE properties SET agent_id = ?, status = 'sold' WHERE id = ?", [t.sam.userId, t.propertyId]);
    const screen = await t.call('alex', 'GET', `/visites/${id}`);
    expect(screen.status).toBe(200);
    expect(screen.body.data.property).toBeNull();
    expect(JSON.stringify(screen.body)).not.toMatch(/REF-T-1|Dijon/);
  });

  it('saisies mal formées : 400, rien n’est écrit ; une adresse inconnue rend 404', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    expect((await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: 'demain' })).status).toBe(400);
    expect((await t.call('alex', 'POST', '/visites/x1/compte-rendu/dictee', { dictation: '' })).status).toBe(400);
    expect((await t.call('alex', 'POST', '/visites/x1/compte-rendu/validation', { report: { opinion: 'ok' } })).status).toBe(400);
    expect((await t.call('alex', 'GET', '/points?semaine=lundi')).status).toBe(400);
    expect((await t.call('alex', 'GET', '/acquereurs/inconnu')).status).toBe(404);
    expect(await t.db.all('SELECT * FROM visits')).toEqual([]);
  });

  it('[R32] AU077 · POST /visites avec joinVisit : un second acquéreur rejoint la visite au même créneau ; joinVisit mal formé, 400', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    expect((await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE })).status).toBe(200);
    const first = await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H });
    expect(first.status).toBe(200);
    const leadId = first.body.data.visit.appointment.id as string;
    const leo = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Léo', lastName: 'Martin' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: leo.id, kind: 'buy' });
    expect((await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: project.id, start: WEDNESDAY_14H, joinVisit: 42 })).status).toBe(400);
    expect((await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: project.id, start: WEDNESDAY_14H })).body).toMatchObject({ ok: false, code: 'taken' });
    const joined = await t.call('alex', 'POST', '/visites', { propertyId: t.propertyId, projectId: project.id, start: WEDNESDAY_14H, joinVisit: leadId });
    expect(joined.status).toBe(200);
    expect(joined.body.data.visit.appointment).toMatchObject({ person_id: leo.id, group_id: leadId, status: 'booked' });
  });

  it('[R32] AU056 · POST /rendez-vous : l’agent fixe un rendez-vous chez le notaire de 90 minutes, le conflit se contrôle sur 90 minutes', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    const start = WEDNESDAY_14H;
    const body = { personId: t.buyer.id, kind: 'signature', start, durationMinutes: 90 };
    expect((await t.call('alex', 'POST', '/rendez-vous', { ...body, durationMinutes: 22 })).body).toMatchObject({ ok: false, code: 'invalid_duration' });
    expect((await t.call('alex', 'POST', '/rendez-vous', { ...body, salle: 'B' })).body).toMatchObject({ ok: false, code: 'unknown_field' });
    expect((await t.call('alex', 'POST', '/rendez-vous', { ...body, kind: 'notaire' })).status).toBe(400);
    expect((await t.call('alex', 'POST', '/rendez-vous', { ...body, kind: 'visite', durationMinutes: 20 })).body).toMatchObject({ ok: false, rule: 'R40', code: 'visit_route' });
    expect((await t.call('sam', 'POST', '/rendez-vous', body)).status).toBe(403);
    expect((await t.call('direction', 'POST', '/rendez-vous', body)).status).toBe(403);
    const booked = await t.call('alex', 'POST', '/rendez-vous', body);
    expect(booked.status).toBe(200);
    const a = booked.body.data.appointment;
    expect((Date.parse(a.end_at) - Date.parse(a.start_at)) / 60_000).toBe(90);
    // Un appel 75 minutes après le début tombe dans les 90 minutes : refusé [R32].
    const later = new Date(Date.parse(start) + 75 * 60_000).toISOString();
    expect((await t.call('alex', 'POST', '/rendez-vous', { personId: t.buyer.id, kind: 'appel', start: later })).body).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect((await t.call('alex', 'POST', '/rendez-vous', { personId: t.buyer.id, kind: 'appel', start: new Date(Date.parse(start) + 90 * 60_000).toISOString(), durationMinutes: 10 })).status).toBe(200);
  });

  it('[R32] AU056 · POST /visites : une contre-visite de 20 minutes, durée choisie par l’agent seul', async () => {
    const t = await setup();
    t.setClock(TUESDAY_10H);
    expect((await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE })).status).toBe(200);
    const visit = { propertyId: t.propertyId, projectId: t.project.id, start: WEDNESDAY_14H };
    // La direction fixe une visite à la durée du type, jamais une durée propre.
    expect((await t.call('direction', 'POST', '/visites', { ...visit, durationMinutes: 20 })).body).toMatchObject({ ok: false, code: 'bad_duration' });
    expect((await t.call('alex', 'POST', '/visites', { ...visit, durationMinutes: 7 })).body).toMatchObject({ ok: false, code: 'invalid_duration' });
    const contre = await t.call('alex', 'POST', '/visites', { ...visit, durationMinutes: 20 });
    expect(contre.status).toBe(200);
    const a = contre.body.data.visit.appointment;
    expect((Date.parse(a.end_at) - Date.parse(a.start_at)) / 60_000).toBe(20);
  });
});

describeWithSqlite('AU073 · le secteur par les routes, sans le service DVF', () => {
  it('la Base adresse nationale des secteurs se règle seule : un lieu dit se géocode même sans estimation', async () => {
    const t = await setup();
    const geocoder = { geocode: async (q: string) => (q === 'Gare de Dijon' ? { label: q, lat: 47.3233, lon: 5.0275, postalCode: '21000', inseeCode: '21231' } : null) };
    const apiKeys = JSON.stringify([{ sha256: await sha256Hex(KEYS.alex), role: 'agent', userId: t.alexId, networkId: t.network.id }]);
    const post = async (config: Record<string, unknown>) => {
      const r = await handleRequest(
        new Request(`${BASE}/v1/acquereurs/projets/${t.project.id}/secteur`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.alex}`, 'content-type': 'application/json' }, body: JSON.stringify({ shape: 'cercle', place: 'Gare de Dijon', radiusM: 1500, label: 'Autour de la gare' }) }),
        { db: t.db, apiKeys, mode: 'essai', now: t.now, ...config } as never,
      );
      return (await r.json()) as { ok: boolean; code?: string };
    };
    expect(await post({})).toMatchObject({ ok: false, code: 'geocodage_absent' });
    expect(await post({ secteursGeocoder: geocoder })).toMatchObject({ ok: true });
  });
});

describeWithSqlite('AU073b · la carte des secteurs par les routes : un lieu pour la centrer, des tuiles par le Worker', () => {
  const geocoder = { geocode: async (q: string) => (q === 'Gare de Dijon' ? { label: q, lat: 47.3233, lon: 5.0275, postalCode: '21000', inseeCode: '21231' } : null) };
  async function run(who: Who, path: string, config: Record<string, unknown> = {}) {
    const t = await setup();
    const apiKeys = JSON.stringify(await Promise.all((['alex', 'sam', 'compliance'] as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), role: w === 'compliance' ? 'compliance' : 'agent', userId: w === 'alex' ? t.alexId : w === 'sam' ? t.sam.userId : 'c-1', networkId: t.network.id }))));
    const r = await handleRequest(new Request(`${BASE}/v1${path.replace('{projet}', t.project.id)}`, { headers: { authorization: `Bearer ${KEYS[who]}` } }), { db: t.db, apiKeys, mode: 'essai', now: t.now, ...config } as never);
    return { status: r.status, cache: r.headers.get('cache-control'), body: (await r.json()) as { ok: boolean; data?: any; code?: string } };
  }

  it('[R16] le lieu qui centre la carte : l’agent de la fiche seul ; un lieu inconnu ou sans géocodeur est dit', async () => {
    expect(await run('alex', '/acquereurs/projets/{projet}/secteur/lieu?q=Gare%20de%20Dijon', { secteursGeocoder: geocoder })).toMatchObject({ status: 200, body: { ok: true, data: { lat: 47.3233, lon: 5.0275 } } });
    expect((await run('alex', '/acquereurs/projets/{projet}/secteur/lieu?q=Nulle%20part', { secteursGeocoder: geocoder })).body).toMatchObject({ ok: false, code: 'lieu_introuvable' });
    expect((await run('alex', '/acquereurs/projets/{projet}/secteur/lieu?q=Gare%20de%20Dijon')).body).toMatchObject({ ok: false, code: 'geocodage_absent' });
    expect((await run('sam', '/acquereurs/projets/{projet}/secteur/lieu?q=Gare%20de%20Dijon', { secteursGeocoder: geocoder })).status).toBe(403);
  });

  it('[R16] une tuile passe par le Worker, seuls ses numéros partent ; hors niveaux, sans fournisseur ou hors rôle : refusée', async () => {
    const asked: number[][] = [];
    const tiles = { tile: async (z: number, x: number, y: number) => (asked.push([z, x, y]), { type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }) };
    const r = await run('alex', '/carte/tuiles/15/16841/11706', { mapTiles: tiles });
    expect(r).toMatchObject({ status: 200, cache: 'private, max-age=86400', body: { ok: true, data: { type: 'image/png', base64: 'iVBORw==' } } });
    expect(asked).toEqual([[15, 16841, 11706]]);
    expect(await run('alex', '/carte/tuiles/15/16841/11706')).toMatchObject({ status: 404, body: { code: 'carte_absente' } });
    expect((await run('alex', '/carte/tuiles/20/1/1', { mapTiles: tiles })).status).toBe(400);
    expect((await run('alex', '/carte/tuiles/12/9999/1', { mapTiles: tiles })).status).toBe(400);
    expect((await run('compliance', '/carte/tuiles/15/16841/11706', { mapTiles: tiles })).status).toBe(403);
    expect(asked).toHaveLength(1);
  });
});
