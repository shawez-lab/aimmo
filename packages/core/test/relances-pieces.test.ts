import { expect, it } from 'vitest';
import { CLIENT_PIECES, PIECE_LABELS, PIECES, RelancesPieces, SALE_FOLLOW_UP_PURPOSE, reminderText, type Piece } from '../src/dossiers/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Les heures sont données à Paris : mars 2027, avant le passage à l'heure d'été (UTC+1).
const paris = (day: string, hour: number) => new Date(`${day}T${String(hour - 1).padStart(2, '0')}:00:00.000Z`);

it('[R08] [R10] le texte d’une relance est écrit par le code : il nomme la pièce, sans chiffre ni parenthèse', () => {
  for (const piece of PIECES) {
    const text = reminderText('Léa', piece);
    expect(text.startsWith('Bonjour Léa,')).toBe(true);
    expect(text).toContain(PIECE_LABELS[piece]);
    expect(text).not.toMatch(/[()\d]|mandataire|gratuit|IA\b|intelligence/);
  }
  expect(reminderText(null, 'titre_propriete').startsWith('Bonjour,')).toBe(true);
  // Un rappel porte sa date, et seulement elle : jamais deux fois le même texte.
  expect(reminderText('Léa', 'dpe', '2027-03-11')).toBe(`Bonjour Léa, petit rappel du 11/03 : pour préparer la vente chez le notaire, il manque encore ${PIECE_LABELS.dpe}. Il vous suffit de répondre à ce message avec la pièce jointe, votre agent immobilier la range dans le dossier. Merci !`);
});

describeWithSqlite('N03 · relances des pièces manquantes, en mode essai', () => {
  async function setup() {
    const t = await setupDossier();
    for (const [personId, email] of [[t.personId, 'vendeuse@example.test'], [t.buyerId, 'acheteur@example.test']] as const) {
      await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value: email });
      await t.store.addConsent({ networkId: t.network.id, personId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    }
    const relances = new RelancesPieces(t.db, t.acces, t.journal, t.storage, { now: t.now });
    const inbox = (personId: string) => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at, m.body', [personId]);
    return { ...t, relances, inbox };
  }
  const clientPieces = (side: 'vendeur' | 'acquereur') => (Object.entries(CLIENT_PIECES) as [Piece, string][]).filter(([, s]) => s === side).map(([p]) => p);

  it('[R01] [R26] aucune relance hors des heures d’envoi, de la nuit au dimanche ; rien ne part réellement', async () => {
    const t = await setup();
    // Samedi 22 h, dimanche 10 h, lundi 7 h : rien ne part, les relances attendent.
    for (const at of [paris('2027-03-06', 22), paris('2027-03-07', 10), paris('2027-03-08', 7)]) {
      t.setClock(at);
      expect(await t.relances.run(t.network.id)).toBe(0);
    }
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n).toBe(0);
    const waiting = await t.relances.ofFile(t.agent, t.fileId);
    expect(waiting.ok && waiting.value.every((r) => r.status === 'waiting' && r.rule === 'R01')).toBe(true);
    // Lundi 9 h : une relance par pièce du client, rangée dans la boîte d'essai.
    t.setClock(paris('2027-03-08', 9));
    expect(await t.relances.run(t.network.id)).toBe(5);
    const seller = await t.inbox(t.personId);
    expect(seller).toHaveLength(4);
    for (const p of clientPieces('vendeur')) expect(seller.some((m) => m.body.includes(PIECE_LABELS[p]))).toBe(true);
    const buyer = await t.inbox(t.buyerId);
    expect(buyer).toHaveLength(1);
    expect(buyer[0]!.body).toContain(PIECE_LABELS.fiche_renseignements_acquereur);
    // Le nom de l'autre partie n'apparaît jamais [R19].
    expect(seller.some((m) => /Acheteur|Exemple/.test(m.body.replace(/^Bonjour Léa,/, '')))).toBe(false);
    expect(buyer.some((m) => /Léa/.test(m.body))).toBe(false);
    // Les diagnostics et les pièces du syndic ne sont pas relancés par message : ils restent des tâches de l'agent.
    const all = [...seller, ...buyer].map((m) => m.body).join('\n');
    for (const p of ['dpe', 'amiante', 'pre_etat_date', 'fiche_synthetique'] as const) expect(all).not.toContain(PIECE_LABELS[p]);
    // Le journal dit la pièce et l'issue, jamais le texte ni la coordonnée [R13].
    const events = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.relance');
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(events)).not.toMatch(/example\.test|Bonjour/);
  });

  it('[R05] une relance par pièce et par période ; une pièce reçue arrête ses relances', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 9));
    expect(await t.relances.run(t.network.id)).toBe(5);
    t.setClock(paris('2027-03-08', 15));
    expect(await t.relances.run(t.network.id)).toBe(0);
    t.setClock(paris('2027-03-10', 10));
    expect(await t.relances.run(t.network.id)).toBe(0);
    // Le titre de propriété arrive.
    await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: t.upload(), issuedOn: '2027-03-09' });
    t.setClock(paris('2027-03-11', 10));
    expect(await t.relances.run(t.network.id)).toBe(4);
    const seller = await t.inbox(t.personId);
    expect(seller.filter((m) => m.body.includes(PIECE_LABELS.titre_propriete))).toHaveLength(1);
    const reglement = seller.filter((m) => m.body.includes(PIECE_LABELS.reglement_copropriete));
    expect(reglement).toHaveLength(2);
    expect(reglement.some((m) => m.body.includes('petit rappel du 11/03'))).toBe(true);
    // Trois jours plus tard, encore un rappel, à son tour daté.
    t.setClock(paris('2027-03-13', 10));
    expect(await t.relances.run(t.network.id)).toBe(0);
    t.setClock(paris('2027-03-15', 10));
    expect(await t.relances.run(t.network.id)).toBe(4);
  });

  it('[R04] [R03] jamais à une personne arrêtée ou sans accord ; le refus est vu par l’agent avec sa règle', async () => {
    const t = await setup();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.personId, reason: 'stop', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    t.setClock(paris('2027-03-08', 9));
    expect(await t.relances.run(t.network.id)).toBe(1);
    expect(await t.inbox(t.personId)).toEqual([]);
    const r = await t.relances.ofFile(t.agent, t.fileId);
    expect(r.ok && r.value.filter((x) => x.side === 'vendeur').map((x) => [x.status, x.rule])).toEqual(Array(4).fill(['refused', 'R04']));
    // Un refus ne repart pas le même jour.
    t.setClock(paris('2027-03-08', 12));
    expect(await t.relances.run(t.network.id)).toBe(0);
    // L'acquéreur retire son accord pour le suivi : plus de relance [R03].
    const buyerConsent = await t.db.first<{ id: string }>('SELECT id FROM consents WHERE person_id = ?', [t.buyerId]);
    await t.store.withdrawConsent(buyerConsent!.id, new Date('2027-03-09T10:00:00.000Z'));
    t.setClock(paris('2027-03-12', 9));
    expect(await t.relances.run(t.network.id)).toBe(0);
    const later = await t.relances.ofFile(t.agent, t.fileId);
    expect(later.ok && later.value.filter((x) => x.side === 'acquereur' && x.day === '2027-03-12').map((x) => [x.status, x.rule])).toEqual([['refused', 'R03']]);
    await expect(t.db.run('DELETE FROM sale_file_reminders')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_reminders SET status = 'waiting'")).rejects.toThrow(/ne change plus/);
  });

  it('[R02] jamais à une personne de la liste d’exclusion', async () => {
    const t = await setup();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.buyerId, reason: 'network_list', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    t.setClock(paris('2027-03-08', 9));
    expect(await t.relances.run(t.network.id)).toBe(4);
    expect(await t.inbox(t.buyerId)).toEqual([]);
    const r = await t.relances.ofFile(t.agent, t.fileId);
    expect(r.ok && r.value.filter((x) => x.side === 'acquereur').map((x) => [x.status, x.rule])).toEqual([['refused', 'R02']]);
  });

  it('[R16] les relances d’un dossier : l’agent du bien, la direction, la conformité ; pas un autre agent', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 9));
    await t.relances.run(t.network.id);
    expect(await t.relances.ofFile(t.direction, t.fileId)).toMatchObject({ ok: true });
    expect(await t.relances.ofFile({ role: 'compliance', networkId: t.network.id, userId: 'c-1' }, t.fileId)).toMatchObject({ ok: true });
    expect(await t.relances.ofFile(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.relances.ofFile(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
  });
});
