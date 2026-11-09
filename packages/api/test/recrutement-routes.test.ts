import { expect, it } from 'vitest';
import { breakEvenBp } from '../../core/src/reseau/index.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { handleCandidature } from '../src/candidature.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, vidéos, candidats, factures et clés inventés. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br02-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br02-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br02-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const VIDEO = { kind: 'video', title: 'Une journée d’agent à Dijon', url: 'https://www.youtube.com/watch?v=exemple123', description: 'Ce que fait un agent du réseau, du matin au soir.', publishedOn: '2027-03-01' };
const CANDIDAT = { firstName: 'Lina', email: 'lina@exemple.test', currentStatus: 'autre_metier', experience: 'aucune', source: 'page' };

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  const page = async (path: string, form?: Record<string, string>) => {
    const init: RequestInit = form ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() } : {};
    const res = await handleCandidature(new Request(`https://aimmo.exemple.test${path}`, init), { db: t.db, networkId: t.network.id, now: t.now });
    return { status: res!.status, html: await res!.text() };
  };
  /** Une facture fournisseur rangée, qui se recompte au centime (TVA à 20 %). */
  const invoice = async (id: string, issuedOn: string, htCents: number) => {
    const vat = htCents / 5;
    await t.db.run("INSERT INTO supplier_invoice_reads (id, network_id, document_ref, read, problems, read_by, created_at) VALUES (?, ?, 'doc', '{}', '[]', 'direction:dir-1', 'x')", [`r-${id}`, t.network.id]);
    await t.db.run(
      "INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at) VALUES (?, ?, ?, 'Fournisseur test', ?, ?, ?, ?, ?, ?, '[]', 'direction:dir-1', 'x')",
      [id, t.network.id, `r-${id}`, `F-${id}`, issuedOn, htCents, vat, htCents + vat, JSON.stringify([{ baseCents: htCents, rateBp: 2000, vatCents: vat }])],
    );
  };
  let n = 0;
  /** Une vente dont la commission est rangée et encaissée, ses parts écrites à la main, comme dans K01. */
  const sale = async (receivedAt: string, parts: { reseau: number; agent: number }) => {
    const file = `f-${++n}`;
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, 'm', '2027-01-05', ?, NULL, 'g', 'x')", [file, t.network.id, t.alexId, parts.reseau + parts.agent]);
    await t.db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 1, 'reseau', NULL, NULL, ?)", [file, parts.reseau]);
    await t.db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 2, 'agent', ?, NULL, ?)", [file, t.alexId, parts.agent]);
    await t.db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, ?, 'preuve', ?, 'direction:dir-1', 'x')", [file, t.network.id, receivedAt, receivedAt]);
    await t.db.exec('PRAGMA foreign_keys = ON');
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  return { ...t, http, page, invoice, sale, refusals };
}

describeWithSqlite('BR02 · routes du recrutement : contenus et coût de l’agent moyen', () => {
  it('[R16] chaque route est à la direction seule : 403 et refus au journal pour l’agent et la conformité', async () => {
    const t = await setup();
    const routes: [string, string, unknown?][] = [
      ['GET', '/recrutement/contenus'],
      ['POST', '/recrutement/contenus', VIDEO],
      ['POST', '/recrutement/contenus/c-1/retrait'],
      ['POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'ia' }],
      // Un corps refusé ne passe jamais avant le rôle : le refus est écrit quand même [R16].
      ['POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'ia', htCents: 1 }],
      ['POST', '/recrutement/contenus', 'pas un objet'], // un corps JSON qui n'est pas un objet : le rôle d'abord
      ['POST', '/recrutement/cout-agent/reglages', { validFrom: '2027-04', provisionBp: 1000, marginBp: 1000, reason: 'Essai' }],
      ['GET', '/recrutement/cout-agent?mois=2027-02'],
    ];
    for (const who of ['alex', 'conformite'] as Who[]) {
      for (const [method, path, body] of routes) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
        expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
      }
    }
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM recruiting_contents')).toEqual({ n: 0 });
  });

  it('[R620] [R621] [R622] une vidéo rangée par la route a son lien marqué ; la page de candidature le suit jusqu’au compte rendu', async () => {
    const t = await setup();
    // Une promesse de revenus est refusée [R80, R620].
    const promise = await t.http('direction', 'POST', '/recrutement/contenus', { ...VIDEO, title: 'Gagnez 10 000 € par mois' });
    expect(promise).toMatchObject({ status: 409, body: { ok: false, rule: 'R80', code: 'promesse' } });
    const created = await t.http('direction', 'POST', '/recrutement/contenus', VIDEO);
    expect(created.status).toBe(200);
    const { id, code, link } = created.body.data as { id: string; code: string; link: string };
    expect(link).toBe(`/rejoindre?c=${code}`);
    // La page reprend le code dans le formulaire, et la candidature lui est rattachée [R621].
    const form = await t.page(link);
    expect(form.status).toBe(200);
    expect(form.html).toContain(`<input type="hidden" name="contenu" value="${code}">`);
    expect((await t.page('/rejoindre?c=%22%3E%3Cscript%3E')).html).not.toMatch(/name="contenu"|<script>/);
    expect((await t.page('/rejoindre', { ...CANDIDAT, consent: 'oui', contenu: code })).status).toBe(200);
    // Un code inconnu ne change rien pour le candidat : même réponse, candidature rangée.
    expect((await t.page('/rejoindre', { ...CANDIDAT, email: 'noe@exemple.test', consent: 'oui', contenu: 'inconnu42' })).status).toBe(200);
    expect(await t.db.all<{ email: string; source: string }>('SELECT email, source FROM candidates ORDER BY email')).toEqual([
      { email: 'lina@exemple.test', source: 'video' },
      { email: 'noe@exemple.test', source: 'page' },
    ]);
    // Le compte rendu : des nombres seulement [R622].
    const report = await t.http('direction', 'GET', '/recrutement/contenus');
    expect(report.body.data).toHaveLength(1);
    expect(report.body.data[0].funnel).toMatchObject({ candidatures: 1, interviewsHeld: 0, entered: 0 });
    expect(JSON.stringify(report.body.data)).not.toMatch(/Lina|lina@exemple/);
    // Retiré, jamais effacé ; un code retiré est ignoré.
    expect((await t.http('direction', 'POST', `/recrutement/contenus/${id}/retrait`)).status).toBe(200);
    expect((await t.http('direction', 'GET', '/recrutement/contenus')).body.data[0].content.withdrawnAt).not.toBeNull();
    expect((await t.http('direction', 'POST', '/recrutement/contenus/inconnu/retrait')).status).toBe(404);
    expect(await t.http('direction', 'POST', '/recrutement/contenus', { ...VIDEO, auteur: 'x' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
  });

  it('[R623] [R624] le poste d’une facture par versions, aucun montant saisi, mois en cours refusé, mois sans réglage incomplet', async () => {
    const t = await setup();
    await t.invoice('inv-1', '2027-02-12', 10_000);
    expect(await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-02')).toMatchObject({ status: 200, body: { data: { complete: false, covered: false } } });
    const first = await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'ia' });
    expect(first.body.data).toMatchObject({ invoiceId: 'inv-1', version: 1, category: 'ia' });
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'diffusion' })).body.data).toMatchObject({ version: 2 });
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'loisirs' })).body).toMatchObject({ ok: false, rule: 'R623' });
    expect(await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-1/poste', { category: 'ia', htCents: 1 })).toMatchObject({ status: 400, body: { rule: 'R624', code: 'amount_refused' } });
    expect((await t.journal.all()).filter((e) => e.type === 'recrutement.montant_refuse')).toHaveLength(1);
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inconnue/poste', { category: 'ia' })).status).toBe(404);
    const month = await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-02');
    expect(month.body.data).toMatchObject({ month: '2027-02', complete: false, missing: ['reglage'], covered: false });
    expect(month.body.data.lines.invoices).toEqual([{ invoiceId: 'inv-1', category: 'diffusion', htCents: 10_000 }]);
    const current = await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-03');
    expect(current.status).toBe(409);
    expect(current.body).toMatchObject({ ok: false, rule: 'R624' });
    expect((await t.http('direction', 'GET', '/recrutement/cout-agent')).status).toBe(400);
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/reglages', { validFrom: '2027-04', provisionBp: 1000, marginBp: 1000, reason: 'Réglage du pilote' })).status).toBe(200);
  });

  it('[R625] pour un mois complet, la part du réseau, le coût avec sa marge et le seuil qui le couvre tout juste ; inatteignable dit tel', async () => {
    const t = await setup();
    // Le réglage est rangé en janvier, valable depuis janvier : il vaut pour février.
    t.setClock(new Date('2027-01-20T09:00:00.000Z'));
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/reglages', { validFrom: '2027-01', provisionBp: 1000, marginBp: 1000, reason: 'Réglage du pilote' })).status).toBe(200);
    t.setClock(NOW);
    await t.sale('2027-02-03T10:00:00.000Z', { reseau: 600_000, agent: 600_000 });
    await t.invoice('inv-a', '2027-02-05', 50_000);
    await t.invoice('inv-b', '2027-02-20', 30_000);
    // Une facture non classée : le mois est incomplet, jamais « couvert » [R623].
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-a/poste', { category: 'ia' })).status).toBe(200);
    expect((await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-02')).body.data).toMatchObject({ complete: false, missing: ['factures_non_classees'], covered: false });
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-b/poste', { category: 'diffusion' })).status).toBe(200);
    const m = (await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-02')).body.data;
    expect(m).toMatchObject({ complete: true, missing: [], costs: { ia: 50_000, diffusion: 30_000 }, breakEvenUnreachable: false });
    expect(m.covered).toBe(m.networkShareCents >= m.requiredCents);
    expect(m.covered).toBe(true);
    // Le seuil rendu par la route est celui du calcul, recompté depuis les chiffres du mois.
    const expected = breakEvenBp({ feesCents: m.feesCents, sponsorSharesCents: m.sponsorSharesCents, costsCents: 80_000, provisionBp: 1000, marginBp: 1000 });
    expect(m.breakEvenNetworkBp).toBe(expected.bp);
    expect(m.breakEvenNetworkBp).toBeGreaterThan(0);
    expect(m.breakEvenNetworkBp).toBeLessThanOrEqual(m.networkBp);
    // Des coûts plus grands que tous les honoraires : aucun seuil ne couvre, et c'est dit.
    await t.invoice('inv-c', '2027-02-25', 5_000_000);
    expect((await t.http('direction', 'POST', '/recrutement/cout-agent/factures/inv-c/poste', { category: 'accompagnement' })).status).toBe(200);
    expect((await t.http('direction', 'GET', '/recrutement/cout-agent?mois=2027-02')).body.data).toMatchObject({ complete: true, covered: false, breakEvenNetworkBp: null, breakEvenUnreachable: true });
  });
});
