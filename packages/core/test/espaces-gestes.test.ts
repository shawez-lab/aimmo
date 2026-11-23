import { expect, it } from 'vitest';
import { FicheUnique, RendezVous, Visites } from '../src/index.ts';
import { FinancementDossier } from '../src/dossiers/index.ts';
import { EspaceAcquereur, GestesModules, SqlClientParties, SqlSourcesAcquereur, type ClientViewer, type GestesModulesDeps } from '../src/espaces/index.ts';
import type { DiffusionGate } from '../src/acquereurs/rapprochement.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réseau, biens, acquéreurs et offres inventés.
const SIGNED = 'offres/0b6f1d2e-7777-4a2b-8c3d-000000000077.pdf';
const TEMPLATE = 'BON DE VISITE · {{reseau.nom}}\n\nJe soussigné {{visiteur.nom}} reconnais avoir visité le bien {{bien.reference}} le {{visite.date}} à {{visite.heure}}, avec {{agent.nom}}.\n\nFait le {{signature.date}}.';
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
/** Mercredi 3 mars 2027, 10 h à Paris : un créneau libre de l'agent. */
const WEDNESDAY_10H = '2027-03-03T09:00:00.000Z';

async function setup(options: { diffusion?: DiffusionGate; template?: boolean } = {}) {
  const t = await setupDossier();
  await t.annonces.validate(t.agent, t.draftId);
  await t.publication.sync(t.network.id, t.propertyId);
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const rdv = new RendezVous(t.db, t.journal, { now: t.now });
  await rdv.setAvailability(t.agent, WEEK);
  const visites = new Visites(t.db, t.journal, t.acces, { rendezVous: rdv, now: t.now, ...(options.diffusion ? { diffusion: options.diffusion } : {}) });
  if (options.template !== false) {
    const tpl = await visites.createSlipTemplate(t.direction, TEMPLATE);
    if (!tpl.ok) throw new Error(tpl.code);
    await visites.validateSlipTemplate(t.direction, tpl.id);
  }
  const signedOffers = new Set<string>([SIGNED]);
  const deps: GestesModulesDeps = {
    db: t.db,
    journal: t.journal,
    fiche,
    consents: t.store,
    visites,
    offres: t.offres,
    financement: new FinancementDossier(t.db, t.acces, t.journal, { now: t.now }),
    signedOffers: { has: async (ref) => signedOffers.has(ref) },
  };
  const gestes = new GestesModules(deps, { now: t.now });
  const parties = new SqlClientParties(t.db);
  const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
  const sources = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now });
  const espace = new EspaceAcquereur(t.db, sources, gestes, t.journal, { now: t.now });
  const viewer = async (personId: string): Promise<ClientViewer> => ({ kind: 'client', networkId: t.network.id, personId, sessionId: `s-${personId}`, sides: await parties.sidesOf(t.network.id, personId) });
  /** Un acquéreur inventé, avec son mail, son projet d'achat et l'alerte de M08 partie pour le bien. */
  const buyer = async (firstName: string, opts: { email?: boolean; project?: boolean } = {}) => {
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName: 'Exemple' });
    if (opts.email !== false) await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    if (opts.project !== false) await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: p.id, kind: 'buy' });
    await t.db.run('INSERT INTO property_alerts (property_id, person_id, network_id, project_id, channel, status, rule, message_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)', [t.propertyId, p.id, t.network.id, 'email', 'sent', t.now().toISOString(), t.now().toISOString()]);
    return p.id;
  };
  const count = async (sql: string, params: (string | number | null)[] = []) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM (${sql})`, params))?.n ?? 0);
  const sends = () => count('SELECT 1 FROM messages UNION ALL SELECT 1 FROM send_log');
  const events = async (type: string) => (await t.db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => ({ data: JSON.parse(e.data) as Record<string, unknown> }));
  return { ...t, fiche, rdv, visites, deps, gestes, espace, viewer, buyer, count, sends, events, signedOffers };
}

const OFFER = { amountEur: 210000, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }], validUntil: '2027-03-10', downPaymentEur: 60000, loanEur: 150000, signedRef: SIGNED };

describeWithSqlite('EC10 · gestes du client branchés sur les modules', () => {
  it('[R165] une offre écrite depuis l’espace entre au registre de M09, au nom du client, à l’heure du serveur, sans rien d’autre en retour', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const before = await t.count('SELECT 1 FROM offer_register');
    const r = await t.espace.writeOffer(await t.viewer(b), t.propertyId, OFFER);
    expect(r).toEqual({ ok: true, value: { seq: 2, receivedAt: t.now().toISOString(), amountEur: 210000, validUntil: '2027-03-10' } });
    expect(await t.count('SELECT 1 FROM offer_register')).toBe(before + 1);
    const row = await t.db.first<{ buyer_person_id: string; received_at: string; actor: string; agent_id: string }>('SELECT buyer_person_id, received_at, actor, agent_id FROM offer_register WHERE seq = 2 AND property_id = ?', [t.propertyId]);
    expect(row).toMatchObject({ buyer_person_id: b, received_at: t.now().toISOString(), actor: 'direction:system:espace', agent_id: t.alexId });
    // Le registre reste intact, son ancre au journal, et rien ne part [R26].
    expect(await t.offres.check(t.propertyId)).toMatchObject({ ok: true });
    expect(await t.sends()).toBe(0);
  });

  it('[R165] le client ne choisit ni l’acquéreur ni l’heure : tout champ en plus est refusé, rien n’est rangé', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const before = await t.count('SELECT 1 FROM offer_register');
    for (const extra of [{ buyerPersonId: t.buyerId }, { receivedAt: '2027-02-01T10:00:00.000Z' }, { agentId: t.alexId }]) {
      const r = await t.gestes.writeOffer(await t.viewer(b), t.propertyId, { ...OFFER, ...extra });
      expect(r).toMatchObject({ ok: false, code: 'invalid', field: Object.keys(extra)[0] });
    }
    expect(await t.count('SELECT 1 FROM offer_register')).toBe(before);
  });

  it('[R165] une offre sans document signé déposé est refusée avant M09 ; les refus du registre sont rendus tels quels', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const v = await t.viewer(b);
    const before = await t.count('SELECT 1 FROM offer_register');
    expect(await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, signedRef: 'offres/0b6f1d2e-7777-4a2b-8c3d-000000000099.pdf' })).toEqual({ ok: false, rule: null, code: 'not_stored', field: 'signedRef' });
    expect(await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, amountEur: 0 })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'amountEur' });
    expect(await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, validUntil: '2029-06-30' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    // Une clé déjà prise pour une autre offre : le refus de M09 [R56].
    const key = 'cle-espace-0000000001';
    expect((await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, requestKey: key })).ok).toBe(true);
    // Le même envoi, renvoyé plus tard (réponse perdue) : la même offre rendue, rien de plus au registre.
    const first = await t.db.first<{ seq: number }>('SELECT seq FROM offer_register WHERE request_key = ?', [key]);
    t.setClock(new Date(t.now().getTime() + 600_000));
    expect(await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, requestKey: key })).toMatchObject({ ok: true, value: { seq: first!.seq } });
    expect(await t.gestes.writeOffer(v, t.propertyId, { ...OFFER, amountEur: 215000, requestKey: key })).toEqual({ ok: false, rule: 'R56', code: 'request_key_reused' });
    // La clé d'un autre acquéreur ne lui rend jamais son offre.
    const autre = await t.buyer('Chloé');
    expect(await t.gestes.writeOffer(await t.viewer(autre), t.propertyId, { ...OFFER, requestKey: key })).toEqual({ ok: false, rule: 'R56', code: 'request_key_reused' });
    expect(await t.count('SELECT 1 FROM offer_register')).toBe(before + 1);
  });

  it('[R165] [R42] un bien vendu ne reçoit plus d’offre : le refus de M09, sans le contourner', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await t.gestes.writeOffer(await t.viewer(b), t.propertyId, OFFER)).toEqual({ ok: false, rule: 'R42', code: 'not_on_sale' });
  });

  it('[R165] [R40] une visite réservée depuis l’espace est fixée par M05, avec son bon de visite, dans l’agenda de l’agent du client, sans message', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const r = await t.espace.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(['appointmentId', 'end', 'start']);
    expect(r.value.start).toBe(WEDNESDAY_10H);
    const visit = await t.db.first<{ person_id: string; agent_id: string; created_by: string }>('SELECT person_id, agent_id, created_by FROM visits WHERE appointment_id = ?', [r.value.appointmentId as string]);
    const v = await t.viewer(b);
    // Écrite au nom du client qui l'a demandée, jamais d'un agent : source « espace », auteur sa séance.
    expect(visit).toEqual({ person_id: b, agent_id: t.alexId, created_by: `client:${v.sessionId}` });
    expect(await t.db.first('SELECT source FROM appointments WHERE id = ?', [r.value.appointmentId as string])).toEqual({ source: 'espace' });
    expect((await t.db.all<{ actor: string }>("SELECT actor FROM journal WHERE type = 'visite.fixee'")).map((e) => e.actor)).toEqual([`client:${v.sessionId}`]);
    expect(await t.count('SELECT 1 FROM visit_slips WHERE appointment_id = ?', [r.value.appointmentId as string])).toBe(1);
    expect(await t.sends()).toBe(0);
    // Le même créneau, demandé une seconde fois : le refus de l'agenda [R32].
    const again = await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H });
    expect(again.ok).toBe(false);
  });

  it('[R165] la visite prend le seul projet d’achat du client ; plusieurs, il le désigne ; jamais celui d’un autre', async () => {
    const t = await setup();
    const sans = await t.buyer('Sacha', { project: false });
    expect(await t.gestes.bookVisit(await t.viewer(sans), t.propertyId, { start: WEDNESDAY_10H })).toEqual({ ok: false, rule: null, code: 'no_project', field: 'projectId' });
    const b = await t.buyer('Bruno');
    const other = await t.db.first<{ id: string }>("SELECT id FROM projects WHERE person_id = ? AND kind = 'buy'", [b]);
    expect(await t.gestes.bookVisit(await t.viewer(sans), t.propertyId, { start: WEDNESDAY_10H, projectId: other!.id })).toEqual({ ok: false, rule: 'R161', code: 'not_party', field: 'projectId' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: b, kind: 'buy' });
    expect(await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H })).toEqual({ ok: false, rule: null, code: 'project_required', field: 'projectId' });
    const ok = await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H, projectId: other!.id });
    expect(ok.ok).toBe(true);
    expect(await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: '2027-03-03 10:00' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'start' });
    expect(await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H, agentId: t.alexId })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'agentId' });
  });

  it('[R165] [R42] [R40] bien non diffusable, ou aucun modèle de bon de visite : les refus de M05, aucune visite', async () => {
    const blocked: DiffusionGate = { canDiffuse: async () => ({ allowed: false, reason: 'withdrawal_period' }) };
    const t = await setup({ diffusion: blocked });
    const b = await t.buyer('Bruno');
    expect(await t.gestes.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H })).toEqual({ ok: false, rule: 'R42', code: 'withdrawal_period' });
    const u = await setup({ template: false });
    const c = await u.buyer('Chloé');
    expect(await u.gestes.bookVisit(await u.viewer(c), u.propertyId, { start: WEDNESDAY_10H })).toEqual({ ok: false, rule: 'R40', code: 'no_template' });
    expect(await t.count('SELECT 1 FROM visits')).toBe(0);
    expect(await u.count('SELECT 1 FROM visits')).toBe(0);
  });

  it('[R165] [R14] l’acquéreur range une étape de son financement : déclarée par l’acquéreur, écrite à son nom, avec les contrôles de M10', async () => {
    const t = await setup();
    const v = await t.viewer(t.buyerId);
    const r = await t.espace.addFinancingPiece(v, t.fileId, { step: 'demande_deposee', day: '2027-03-01' });
    expect(r).toEqual({ ok: true, value: { steps: [{ step: 'demande_deposee', day: '2027-03-01', declaredBy: 'acquereur' }] } });
    expect(await t.db.first('SELECT declared_by, by FROM sale_file_financing WHERE file_id = ?', [t.fileId])).toEqual({ declared_by: 'acquereur', by: `client:${v.sessionId}` });
    // Le client ne dit pas qui déclare ; un jour futur, une étape inconnue : les refus de M10.
    expect(await t.gestes.addFinancingPiece(v, t.fileId, { step: 'accord_principe', day: '2027-03-01', declaredBy: 'courtier' })).toEqual({ ok: false, rule: null, code: 'bad_input' });
    expect(await t.gestes.addFinancingPiece(v, t.fileId, { step: 'accord_principe', day: '2027-03-09' })).toEqual({ ok: false, rule: null, code: 'future_day' });
    expect(await t.gestes.addFinancingPiece(v, t.fileId, { step: 'taux_obtenu', day: '2027-03-01' })).toEqual({ ok: false, rule: null, code: 'unknown_step' });
    expect(await t.count('SELECT 1 FROM sale_file_financing')).toBe(1);
    // L'agent voit l'étape dans le suivi, telle que déclarée.
    const seen = await new FinancementDossier(t.db, t.acces, t.journal, { now: t.now }).financing(t.agent, t.fileId);
    expect(seen.ok && seen.value.steps.map((s) => s.declaredBy)).toEqual(['acquereur']);
  });

  it('[R165] [R161] le dossier d’un autre est refusé par l’espace puis par M10 ; un dossier clos ne reçoit plus rien', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    expect(await t.espace.addFinancingPiece(await t.viewer(b), t.fileId, { step: 'demande_deposee', day: '2027-03-01' })).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
    // Même appelé sans l'espace, M10 refuse ce qui n'est pas l'acquéreur du dossier, et l'écrit au journal.
    expect(await t.gestes.addFinancingPiece(await t.viewer(b), t.fileId, { step: 'demande_deposee', day: '2027-03-01' })).toEqual({ ok: false, rule: 'R16', code: 'not_buyer' });
    expect((await t.events('acces.refuse')).some((e) => (e.data as { code?: string }).code === 'not_buyer')).toBe(true);
    expect(await t.gestes.addFinancingPiece(await t.viewer(b), 'dossier-inconnu', { step: 'demande_deposee', day: '2027-03-01' })).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    // L'acte signé, rangé comme le fait M10.
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, '2027-03-01', 'actes/x.pdf', 'a_demarrer', ?, 'agent:test')", [t.fileId, t.network.id, t.now().toISOString()]);
    expect(await t.gestes.addFinancingPiece(await t.viewer(t.buyerId), t.fileId, { step: 'demande_deposee', day: '2027-03-01' })).toEqual({ ok: false, rule: null, code: 'closed' });
    expect(await t.count('SELECT 1 FROM sale_file_financing')).toBe(0);
  });

  it('[R49] [R03] [R26] demander les alertes range l’accord avec sa preuve, une seule fois, et rien ne part ; sans case cochée ni mail, aucun accord', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const v = await t.viewer(b);
    expect(await t.espace.requestAlerts(v, {})).toEqual({ ok: false, rule: 'R03', code: 'not_accepted', field: 'accepted' });
    expect(await t.espace.requestAlerts(v, { accepted: 'oui' })).toEqual({ ok: false, rule: 'R03', code: 'not_accepted', field: 'accepted' });
    expect(await t.count("SELECT 1 FROM consents WHERE purpose = 'alertes_biens'")).toBe(0);
    expect(await t.espace.requestAlerts(v, { accepted: true })).toEqual({ ok: true, value: { requested: true } });
    expect(await t.espace.requestAlerts(v, { accepted: true })).toEqual({ ok: true, value: { requested: true } });
    const rows = await t.db.all<{ person_id: string; channel: string; proof: string }>("SELECT person_id, channel, proof FROM consents WHERE purpose = 'alertes_biens'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: b, channel: 'email' });
    expect(rows[0]!.proof).toContain('espace client');
    expect(rows[0]!.proof).not.toContain('@');
    const view = await t.espace.vue(v);
    expect(view.ok && view.value.alerts.requested).toBe(true);
    expect(await t.sends()).toBe(0);
    const sansMail = await t.buyer('Sacha', { email: false });
    expect(await t.espace.requestAlerts(await t.viewer(sansMail), { accepted: true })).toEqual({ ok: false, rule: 'R03', code: 'no_email' });
    expect(await t.espace.requestAlerts(v, { accepted: true, channel: 'sms' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'channel' });
  });

  it('[R165] [R13] une panne d’un module est écrite au journal, en codes, et rendue « indisponible »', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const broken = new GestesModules({ ...t.deps, offres: { record: async () => { throw new Error('bruno@example.test'); } } }, { now: t.now });
    expect(await broken.writeOffer(await t.viewer(b), t.propertyId, OFFER)).toEqual({ ok: false, rule: null, code: 'indisponible' });
    const panne = await t.events('espaces.geste_panne');
    expect(panne).toHaveLength(1);
    expect(JSON.stringify(panne)).not.toContain('@');
    expect(panne[0]!.data).toMatchObject({ rule: 'R165', kind: 'offre', error: 'Error' });
  });

  it('[R702] AU053 · l’agenda relié de l’agent injoignable : la visite n’est pas fixée et le client le sait', async () => {
    const t = await setup();
    const b = await t.buyer('Bruno');
    const down = Object.assign(new Error('agenda injoignable'), { name: 'AgendaUnavailableError' });
    const broken = new GestesModules({ ...t.deps, visites: { schedule: async () => { throw down; } } as never }, { now: t.now });
    expect(await broken.bookVisit(await t.viewer(b), t.propertyId, { start: WEDNESDAY_10H })).toEqual({ ok: false, rule: 'R702', code: 'agenda_indisponible' });
  });
});
