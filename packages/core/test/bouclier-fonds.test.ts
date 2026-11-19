import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BouclierFonds, PIECES, RelancesPieces, SALE_FOLLOW_UP_PURPOSE, fundSignals, fundsInOutgoing, fundsReminderText, reminderText } from '../src/dossiers/index.ts';
import type { JournalStore } from '../src/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { migrationsDir } from './migrations.ts';
import { describeWithSqlite } from './sqlite.ts';

// Un IBAN inventé, au bon format, qui n'existe pas.
const IBAN = 'FR76 3000 1007 9412 3456 7890 185';
// Mars 2027, avant l'heure d'été : Paris est à UTC+1.
const paris = (day: string, hour: number, minute = 0) => new Date(Date.parse(`${day}T00:00:00.000Z`) + (hour - 1) * 3_600_000 + minute * 60_000);

it('[R62] un message reçu qui parle d’argent est reconnu, sans rien garder du texte', () => {
  expect(fundSignals(`Bonjour, le notaire a changé de banque, voici le nouveau RIB : ${IBAN}`)).toEqual(['iban', 'coordonnees_bancaires']);
  expect(fundSignals('Pouvez-vous me confirmer le virement de l’acompte sur le compte séquestre ?')).toEqual(['coordonnees_bancaires', 'virement', 'acompte', 'sequestre']);
  expect(fundSignals('Il faut régler la somme avant vendredi, merci de payer par carte')).toEqual(['paiement']);
  expect(fundSignals('Bonjour, je vous envoie le titre de propriété demain. Bonne journée')).toEqual([]);
  expect(fundSignals('Le règlement de copropriété est joint')).toEqual([]);
  // De vrais tours de la fraude au faux RIB : pluriels, impératifs, « fonds », « sur le compte », coordonnées changées.
  for (const t of [
    'Bonjour, suite à un contrôle, nos coordonnées ont changé. Merci d’effectuer les virements sur le compte ci-joint.',
    'Virez les fonds sur ce compte avant vendredi svp',
    'Versez la somme de 25 000 € sur le compte de l’étude',
    'Les fonds doivent être envoyés sur le compte ci-dessous',
    'Réglez le dépôt de 10 % au plus vite',
    'Payez les frais de notaire sur ce lien',
    'Nos nouvelles coordonnées sont en pièce jointe, merci de les utiliser pour les acomptes',
    'Voici notre numéro de compte',
    `IBAN : ${IBAN.replace(/ /g, '')}`,
  ]) expect([t, fundSignals(t).length > 0]).toEqual([t, true]);
  expect(fundSignals('Le fonds de commerce n’est pas concerné, je vous envoie le titre')).toEqual([]);
});

it('[R62] aucun texte d’AIMMO ne porte de coordonnée bancaire ni ne demande un paiement', () => {
  for (const t of [`Voici nos coordonnées bancaires : ${IBAN}`, 'Merci de virer le dépôt sur le compte du notaire', 'Notre RIB est joint', 'Vous pouvez payer à l’ordre de AIMMO', `IBAN ${IBAN.replace(/ /g, '')}`, 'Veuillez effectuer un virement de 10 000 €', 'Payez les frais de notaire sur ce lien', 'Versez la somme avant vendredi', 'Merci de bien vouloir effectuer le virement', 'Réglez le solde au plus vite', 'Le virement du dépôt est attendu']) {
    expect([t, fundsInOutgoing(t)]).toEqual([t, true]);
  }
  // Le rappel du bouclier et toutes les relances de pièces passent.
  expect(fundsInOutgoing(fundsReminderText('Léa'))).toBe(false);
  expect(fundsInOutgoing(fundsReminderText('Léa', { city: 'Dijon', reference: 'REF-T-1' }))).toBe(false);
  // Une référence d'agence n'est pas un IBAN.
  expect(fundsInOutgoing('Le bien réf. AB12 CDEF GHIJ KL est à Dijon')).toBe(false);
  expect(fundsInOutgoing('Pour la vente de votre bien à Dijon, référence DJ21-2027-0045,')).toBe(false);
  for (const p of PIECES) expect(fundsInOutgoing(reminderText('Léa', p, '2027-03-11', { city: 'Dijon', reference: 'REF-T-1' }))).toBe(false);
});

it('[R62] aucune table de M10 ne reçoit ni ne suit de fonds', () => {
  for (const f of readdirSync(migrationsDir).filter((x) => /^03\d\d_/.test(x))) {
    const sql = readFileSync(migrationsDir + f, 'utf8').replace(/--.*$/gm, '').toLowerCase();
    expect([f, /iban|\brib\b|sequestre|escrow|acompte|deposit|payment|paiement|virement|balance|amount_received/.test(sql)]).toEqual([f, false]);
  }
});

describeWithSqlite('N05 · aucun fonds, bouclier contre le faux RIB', () => {
  async function setup() {
    const t = await setupDossier();
    for (const [personId, email] of [[t.personId, 'vendeuse@example.test'], [t.buyerId, 'acheteur@example.test']] as const) {
      await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value: email });
      await t.store.addConsent({ networkId: t.network.id, personId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    }
    const bouclier = new BouclierFonds(t.db, t.acces, t.journal, { now: t.now });
    const receive = (personId: string, body: string) => t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId, channel: 'email', direction: 'in', authorKind: 'person', body, occurredAt: t.now() });
    const inbox = (personId: string) => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
    return { ...t, bouclier, receive, inbox };
  }

  it('[R62] [R18] un message suspect alerte l’agent aussitôt, une seule fois ; l’IBAN n’est rangé nulle part par le bouclier [R15]', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    const m = await t.receive(t.buyerId, `Bonjour, voici le nouveau RIB de l'étude pour l'acompte : ${IBAN}`);
    const started = Date.now();
    expect(await t.bouclier.scan(m.id)).toEqual(['iban', 'coordonnees_bancaires', 'acompte']);
    expect(Date.now() - started).toBeLessThan(60_000);
    // Lu deux fois, par la réception et par le filet : une seule alerte.
    expect(await t.bouclier.scan(m.id)).toEqual(['iban', 'coordonnees_bancaires', 'acompte']);
    expect(await t.bouclier.run(t.network.id, paris('2027-03-08', 0))).toBe(0);
    const a = await t.bouclier.alertsOf(t.agent);
    expect(a).toMatchObject({ ok: true, alerts: [{ messageId: m.id, fileId: t.fileId, side: 'acquereur', signals: ['iban', 'coordonnees_bancaires', 'acompte'], reminder: 'sent' }] });
    // Ni l'IBAN ni le texte dans l'alerte ni au journal.
    const stored = JSON.stringify(await t.db.all('SELECT * FROM sale_file_fund_alerts'));
    const journal = JSON.stringify(await t.journal.bySubject(`sale_file:${t.fileId}`));
    // Identifiants et empreintes, tirés au hasard, peuvent contenir ces chiffres : ils sont retirés avant de chercher.
    const random = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g;
    for (const s of [stored, journal, JSON.stringify(a)].map((x) => x.replace(random, ''))) {
      expect(s).not.toContain('3000');
      expect(s).not.toMatch(/FR76|nouveau RIB/);
    }
    // Le rappel au client : par le contrôle central, en mode essai, sans coordonnée bancaire.
    const sent = await t.inbox(t.buyerId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('ne vous demandera jamais de virement');
    expect(fundsInOutgoing(sent[0]!.body)).toBe(false);
  });

  it('[R01] [R05] le rappel au client attend les heures d’envoi, et ne part qu’une fois par dossier ; chaque message suspect a son alerte', async () => {
    const t = await setup();
    // Dimanche soir : l'alerte de l'agent tout de suite, le rappel attend lundi.
    t.setClock(paris('2027-03-07', 22, 30));
    const m1 = await t.receive(t.personId, 'Le notaire demande un virement sur un autre compte, pouvez-vous confirmer ?');
    expect(await t.bouclier.scan(m1.id)).toEqual(['coordonnees_bancaires', 'virement']);
    expect(await t.inbox(t.personId)).toEqual([]);
    let a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.side, x.reminder, x.reminderRule])).toEqual([['vendeur', 'waiting', 'R01']]);
    t.setClock(paris('2027-03-08', 6));
    await t.bouclier.run(t.network.id, paris('2027-03-07', 0));
    expect(await t.inbox(t.personId)).toEqual([]);
    t.setClock(paris('2027-03-08', 9));
    expect(await t.bouclier.run(t.network.id, paris('2027-03-07', 0))).toBe(0);
    expect(await t.inbox(t.personId)).toHaveLength(1);
    // Un second message suspect : une seconde alerte, sans second rappel [R05].
    const m2 = await t.receive(t.personId, 'Je fais le versement demain ?');
    expect(await t.bouclier.run(t.network.id, paris('2027-03-08', 0))).toBe(1);
    a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.messageId, x.reminder, x.reminderRule])).toEqual([[m2.id, 'refused', 'R05'], [m1.id, 'sent', null]]);
    expect(await t.inbox(t.personId)).toHaveLength(1);
  });

  it('[R02] un message d’une personne hors d’un dossier en cours, ou sans signal, ne fait rien ; une personne exclue n’a pas de rappel', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    const stranger = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Autre', lastName: 'Contact' });
    expect(await t.bouclier.scan((await t.receive(stranger.id, `Mon RIB : ${IBAN}`)).id)).toBeNull();
    expect(await t.bouclier.scan((await t.receive(t.buyerId, 'Merci pour la visite, à bientôt')).id)).toBeNull();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.buyerId, reason: 'network_list', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    const m = await t.receive(t.buyerId, 'Je vire l’acompte ce soir');
    expect(await t.bouclier.scan(m.id)).toEqual(['virement', 'acompte']);
    const a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.reminder, x.reminderRule])).toEqual([['refused', 'R02']]);
    expect(await t.inbox(t.buyerId)).toEqual([]);
    await expect(t.db.run('DELETE FROM sale_file_fund_alerts')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_fund_alerts SET signals = '[]'")).rejects.toThrow(/rien ne change/);
  });

  it('[R62] une personne qui achète et vend à la fois : chaque agent reçoit l’alerte de son dossier', async () => {
    const t = await setup();
    // La vendeuse du jeu achète aussi un autre bien, suivi par Sam : son dossier d'achat, inventé, inscrit directement.
    const b2 = await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.userId, reference: 'REF-T-9', kind: 'land', city: 'Talant', priceEur: 90000, status: 'under_offer' });
    await t.db.run(
      "INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES ('offre-9', ?, ?, 1, ?, 90000, '[]', '2027-03-10', 90000, 0, 'offres/x.pdf', '2027-03-01T09:00:00.000Z', ?, '2027-03-01T09:00:00.000Z', 'test', '', 'h-offre-9')",
      [t.network.id, b2.id, t.personId, t.sam.userId],
    );
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('dossier-9', ?, ?, 'offre-9', ?, 90000, '2027-03-01T13:00:00.000Z', 'test')", [t.network.id, b2.id, t.personId]);
    t.setClock(paris('2027-03-08', 10));
    const m = await t.receive(t.personId, 'Merci de faire le virement sur notre nouveau compte');
    expect(await t.bouclier.scan(m.id)).toBeTruthy();
    expect(await t.bouclier.scan(m.id)).toBeTruthy();
    const alex = await t.bouclier.alertsOf(t.agent);
    const sam = await t.bouclier.alertsOf(t.sam);
    expect(alex.ok && alex.alerts.map((x) => [x.fileId, x.side])).toEqual([[t.fileId, 'vendeur']]);
    expect(sam.ok && sam.alerts.map((x) => [x.fileId, x.side])).toEqual([['dossier-9', 'acquereur']]);
    // Un rappel par dossier, chacun nommant son bien : deux messages différents.
    const sent = await t.inbox(t.personId);
    expect(sent.map((x) => /REF-T-\d/.exec(x.body)?.[0]).sort()).toEqual(['REF-T-1', 'REF-T-9']);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_fund_alerts'))?.n).toBe(2);
  });

  it('un rappel resté sans issue après une panne repart au passage suivant', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    const m = await t.receive(t.buyerId, 'Voici mon RIB');
    // Une panne entre l'alerte et l'envoi : l'alerte est rangée, le rappel n'a pas d'issue.
    const j = t.journal;
    const failing: JournalStore = {
      append: async (e) => { if (e.type === 'dossier.alerte_fonds') throw new Error('panne'); return j.append(e); },
      last: () => j.last(), all: () => j.all(), bySubject: (x) => j.bySubject(x), byPeriod: (a, b) => j.byPeriod(a, b),
    };
    const broken = new BouclierFonds(t.db, t.acces, failing, { now: t.now });
    await expect(broken.scan(m.id)).rejects.toThrow('panne');
    expect((await t.db.first<{ reminder_status: string | null }>('SELECT reminder_status FROM sale_file_fund_alerts WHERE message_id = ?', [m.id]))?.reminder_status).toBe('waiting');
    expect(await t.inbox(t.buyerId)).toEqual([]);
    await t.bouclier.run(t.network.id, paris('2027-03-08', 9));
    expect(await t.inbox(t.buyerId)).toHaveLength(1);
  });

  it('[R62] une relance de pièce dont le texte porterait un signal bancaire est refusée, sans rien envoyer', async () => {
    const t = await setup();
    await t.db.run("UPDATE properties SET reference = 'RIB-7' WHERE id = ?", [t.propertyId]);
    t.setClock(paris('2027-03-08', 10));
    const r = new RelancesPieces(t.db, t.acces, t.journal, t.storage, { now: t.now });
    expect(await r.run(t.network.id)).toBe(0);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n).toBe(0);
    const rows = await r.ofFile(t.agent, t.fileId);
    expect(rows.ok && rows.value.map((x) => [x.status, x.rule])).toEqual(Array(5).fill(['refused', 'R62']));
    expect(JSON.stringify(await t.journal.bySubject(`sale_file:${t.fileId}`))).not.toContain('RIB-7');
  });

  it('[R16] les alertes à l’agent du bien seul, chaque lecture au journal', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    await t.bouclier.scan((await t.receive(t.buyerId, 'Voici mon RIB')).id);
    expect(await t.bouclier.alertsOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await t.bouclier.alertsOf(t.sam)).toEqual({ ok: true, alerts: [] });
    expect((await t.journal.bySubject(`agent:${t.alexId}`)).filter((e) => e.type === 'dossier.alertes_fonds_lues')).toEqual([]);
    await t.bouclier.alertsOf(t.agent);
    expect((await t.journal.bySubject(`agent:${t.alexId}`)).map((e) => e.type).filter((x) => x !== 'attirer.agent.mentions')).toEqual(['dossier.alertes_fonds_lues']);
  });
});
