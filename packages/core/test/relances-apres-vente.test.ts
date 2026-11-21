import { expect, it } from 'vitest';
import { AFTER_SALE_PURPOSE } from '../src/apres-vente/relances-apres-vente.ts';
import {
  AFTER_SALE_REMINDER_JOB,
  OLD_CONTACT_QUIET_DAYS,
  RelancesApresVente,
  afterSaleReminderJob,
  afterSaleText,
  anniversary,
  checkAfterSaleUnsubscribeBase,
  newAfterSaleToken,
  type AfterSaleChoice,
  type ClosedSale,
} from '../src/apres-vente/index.ts';
import { FicheClient } from '../src/db/fiche-client.ts';
import { DEFAULT_OLD_CONTACT_SETTINGS } from '../src/mandats/gagner/anciens-contacts.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { checkText } from '../src/envoi/texte.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const BASE = 'https://aimmo.example.test/desinscription/';
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Une heure de Paris, été comme hiver. */
const paris = (day: string, hour: number, minute = 0): Date => {
  for (const offset of [1, 2]) {
    const d = new Date(`${day}T${String(hour - offset).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(d);
    if (Number(local) === hour) return d;
  }
  throw new Error('heure introuvable');
};
const parisDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
const parisHour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(d));
const parisWeekday = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short' }).format(d);

it('[R65] [R08] [R10] le texte d’une relance est écrit par le code : sans proposition, avec la désinscription à la fin', () => {
  for (const side of ['vendeur', 'acquereur'] as const) {
    for (const year of [1, 2, 3, 4, 5]) {
      const text = afterSaleText('Léa', side, year, { city: 'Dijon', reference: 'REF-T-1' }, `${BASE}abcdefghijklmnopqrstuvwxyzabcdef`);
      expect(text.startsWith('Bonjour Léa, il y a ')).toBe(true);
      expect(text.endsWith(`Ne plus recevoir ces messages : ${BASE}abcdefghijklmnopqrstuvwxyzabcdef`)).toBe(true);
      expect(text.replace('REF-T-1', '')).not.toMatch(/\d|[()]|mandataire|gratuit|\bIA\b|intelligence|estimation|estimer|vendre maintenant|profitez|offre|prix/i);
    }
  }
  expect(afterSaleText(null, 'vendeur', 2, { city: null, reference: 'A' }, `${BASE}x`)).toBe(
    `Bonjour, il y a deux ans, vous avez vendu votre bien, référence A. Votre agent immobilier reste là pour toute question sur ce bien : il suffit de répondre à ce message. Ne plus recevoir ces messages : ${BASE}x`,
  );
  expect(afterSaleText('Léa', 'acquereur', 1, { city: 'Dijon', reference: 'A' }, 'x')).toContain('il y a un an, vous avez acheté votre bien à Dijon');
});

it('[R06] [R10] aucun jeton de désinscription ne fait lire au contrôle du texte une mention de l’IA ni un chiffre', () => {
  for (let i = 0; i < 2000; i++) {
    const token = newAfterSaleToken();
    expect(token).toMatch(/^[a-z]{32}$/);
    expect(checkText(afterSaleText('Léa', 'vendeur', 1, { city: 'Dijon', reference: 'REF-T-1' }, `${BASE}${token}`), { audience: 'client', channel: 'email', figures: [1] })).toEqual([]);
  }
  // Les débuts que le contrôle lirait comme l'IA ne sont jamais tirés.
  for (const word of ['gpt', 'robot', 'assistant', 'chatbot', 'automatiquement']) {
    expect(checkText(afterSaleText('Léa', 'vendeur', 1, { city: 'Dijon', reference: 'REF-T-1' }, `${BASE}${word}`), { audience: 'client', channel: 'email', figures: [1] }).map((p) => p.rule)).toContain('R06');
  }
});

it('les dates clés sont les anniversaires de l’acte ; le 29 février devient le 28 les années qui n’en ont pas', () => {
  expect(anniversary('2027-03-14', 1)).toBe('2028-03-14');
  expect(anniversary('2028-02-29', 1)).toBe('2029-02-28');
  expect(anniversary('2028-02-29', 4)).toBe('2032-02-29');
  expect(anniversary('2029-02-28', -1)).toBe('2028-02-28');
  expect(() => checkAfterSaleUnsubscribeBase('http://exemple.test/')).toThrow();
  expect(() => checkAfterSaleUnsubscribeBase('https://exemple.test/d1/')).toThrow();
  expect(() => checkAfterSaleUnsubscribeBase('https://exemple.test/d')).toThrow();
  expect(checkAfterSaleUnsubscribeBase(BASE)).toBe(BASE);
});

it('le passage tourne du lundi au samedi, de 10 h à 18 h [R01]', () => {
  const job = afterSaleReminderJob(undefined as never, undefined as never, new FakeDossiersClos());
  expect(job.name).toBe(AFTER_SALE_REMINDER_JOB);
  expect(job.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
  expect(Math.min(...job.hours)).toBeGreaterThanOrEqual(8);
  expect(Math.max(...job.hours)).toBeLessThan(20);
});

describeWithSqlite('F04 · relance un an après la vente, sans jamais relancer une personne opposée', () => {
  let n = 0;
  async function setup(options: { base?: string | null } = {}) {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const relances = new RelancesApresVente(t.db, t.journal, dossiers, { now: t.now, unsubscribeBase: options.base === undefined ? BASE : options.base });
    /** Un client inventé, avec son mail. */
    const client = async (firstName: string, lastName = 'Exemple') => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `client${n}@example.test` });
      return p.id;
    };
    const close = (fileId: string, closedOn: string, clients: ClosedSale['clients']) => {
      const s: ClosedSale = { fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: `REF-${fileId}`, clients };
      dossiers.sales.push(s);
      return s;
    };
    /** Le choix rangé ; un accord se range le jour de l'acte, à 11 h, l'horloge revenant ensuite où elle était. */
    const choose = async (fileId: string, personId: string, choice: AfterSaleChoice, proof = 'case cochée à l’acte, test') => {
      const before = t.now();
      const sale = dossiers.sales.find((s) => s.fileId === fileId);
      if (choice !== 'non' && sale) t.setClock(paris(sale.closedOn, 11));
      const r = await relances.recordChoice(t.agent, fileId, personId, { choice, proof });
      t.setClock(before);
      if (!r.ok) throw new Error(r.code);
    };
    const inbox = (personId: string) =>
      t.db.all<{ body: string; occurred_at: string }>('SELECT m.body, m.occurred_at FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
    const outboxCount = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n ?? 0;
    /** Un passage par jour, à 10 h 05 et 15 h 05, du premier au dernier jour inclus. */
    const passes = async (from: string, to: string) => {
      for (let day = from; day <= to; day = addDays(day, 1)) {
        for (const hour of [10, 15]) {
          t.setClock(paris(day, hour, 5));
          await relances.run(t.network.id);
        }
      }
    };
    t.setClock(paris('2027-03-01', 9));
    return { ...t, dossiers, relances, client, close, choose, inbox, outboxCount, passes };
  }

  it('[R65] [R05] [R01] [R26] sur 30 dossiers tests à horloge simulée, aucune relance à une personne opposée, une seule par date clé', async () => {
    const t = await setup();
    // Six profils, cinq dossiers chacun : oui, un an seulement, non, aucun choix, oui puis non dit à l'agent, oui puis
    // désinscription par le lien.
    const profiles = ['oui', 'un_an', 'non', 'aucun', 'oui_puis_non', 'oui_puis_lien'] as const;
    const people: { id: string; fileId: string; profile: (typeof profiles)[number]; closedOn: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const profile = profiles[i % 6]!;
      const closedOn = addDays('2027-03-01', i);
      const fileId = `f${i + 1}`;
      const id = await t.client(`Client${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcd'[i]}`);
      t.close(fileId, closedOn, [{ personId: id, side: i % 2 === 0 ? 'vendeur' : 'acquereur' }]);
      t.setClock(paris(closedOn, 11));
      if (profile === 'un_an') await t.choose(fileId, id, 'un_an');
      else if (profile === 'non') await t.choose(fileId, id, 'non');
      else if (profile !== 'aucun') await t.choose(fileId, id, 'oui');
      people.push({ id, fileId, profile, closedOn });
    }
    // Rien avant la première date clé.
    await t.passes('2027-03-01', '2027-04-05');
    expect(await t.outboxCount()).toBe(0);
    // Un an après : passages quotidiens.
    await t.passes('2028-03-01', '2028-04-10');
    // Entre-temps : un client dit « non » à son agent ; un autre se désinscrit par le lien de son message.
    t.setClock(paris('2028-06-01', 11));
    for (const p of people.filter((x) => x.profile === 'oui_puis_non')) await t.choose(p.fileId, p.id, 'non', 'appel du client, test');
    for (const p of people.filter((x) => x.profile === 'oui_puis_lien')) {
      const box = await t.inbox(p.id);
      const token = box[0]!.body.slice(box[0]!.body.indexOf(BASE) + BASE.length);
      expect(await t.relances.unsubscribe(token)).toBe(true);
    }
    for (const year of [2029, 2030, 2031, 2032]) await t.passes(`${year}-03-01`, `${year}-04-10`);

    const expected = { oui: 5, un_an: 1, non: 0, aucun: 0, oui_puis_non: 1, oui_puis_lien: 1 } as const;
    for (const p of people) {
      const box = await t.inbox(p.id);
      expect(box, `${p.profile} ${p.fileId}`).toHaveLength(expected[p.profile]);
      for (const [k, m] of box.entries()) {
        const at = new Date(m.occurred_at);
        const due = anniversary(p.closedOn, k + 1);
        // Le jour de la date clé, ou le premier jour permis après : jamais le dimanche, jamais hors des heures [R01].
        expect(parisDay(at) >= due && parisDay(at) <= addDays(due, 2)).toBe(true);
        expect(parisWeekday(at)).not.toBe('Sun');
        expect(parisHour(at)).toBeGreaterThanOrEqual(10);
        expect(parisHour(at)).toBeLessThan(19);
        // Chaque message porte sa désinscription [R65].
        expect(m.body).toContain(`Ne plus recevoir ces messages : ${BASE}`);
        expect(m.body).toContain(['un an', 'deux ans', 'trois ans', 'quatre ans', 'cinq ans'][k]);
      }
    }
    // Les refus disent leur règle : R65 pour un choix qui ne le permet pas, R03 après la désinscription.
    const list = await t.relances.list(t.agent);
    const rows = list.ok ? list.value : [];
    for (const p of people.filter((x) => x.profile === 'non' || x.profile === 'aucun')) {
      expect(rows.filter((r) => r.personId === p.id).every((r) => r.status === 'refused' && r.rule === 'R65')).toBe(true);
    }
    for (const p of people.filter((x) => x.profile === 'oui_puis_non' || x.profile === 'oui_puis_lien')) {
      const later = rows.filter((r) => r.personId === p.id && r.year > 1);
      expect(later).toHaveLength(4);
      expect(later.every((r) => r.status === 'refused' && r.rule === 'R65')).toBe(true);
    }
    // Rien n'est resté en attente, rien n'est parti deux fois [R05].
    expect(rows.some((r) => r.status === 'waiting')).toBe(false);
    expect(await t.outboxCount()).toBe(5 * 5 + 5 + 5 + 5);
  });

  it('[R65] le lien de désinscription marche en un geste, pour tous les dossiers de la personne ; un jeton inconnu ne fait rien', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.close('f2', '2027-03-09', [{ personId: a, side: 'acquereur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f2', a, 'oui');
    await t.passes('2028-03-08', '2028-03-09');
    const box = await t.inbox(a);
    expect(box).toHaveLength(2);
    const token = box[0]!.body.slice(box[0]!.body.indexOf(BASE) + BASE.length);
    expect(token).toMatch(/^[a-z]{32}$/);
    expect(await t.relances.unsubscribe('abcdefghijklmnopqrstuvwxyzabcdef')).toBe(false);
    expect(await t.relances.unsubscribe('pas-un-jeton')).toBe(false);
    expect(await t.relances.unsubscribe(token)).toBe(true);
    // Servi de nouveau, il ne change rien.
    expect(await t.relances.unsubscribe(token)).toBe(true);
    const consents = await t.db.all<{ withdrawn_at: string | null }>("SELECT withdrawn_at FROM consents WHERE person_id = ? AND purpose = 'relances_apres_vente'", [a]);
    expect(consents.length).toBeGreaterThan(0);
    expect(consents.every((c) => c.withdrawn_at !== null)).toBe(true);
    await t.passes('2029-03-08', '2029-03-12');
    expect(await t.inbox(a)).toHaveLength(2);
    const events = (await t.journal.bySubject(`person:${a}`)).filter((e) => e.type === 'apres_vente.desinscription');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('[R02] [R04] une personne exclue ou qui a demandé l’arrêt ne reçoit rien, même avec un « oui » à l’acte', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: b, side: 'acquereur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f1', b, 'oui');
    await t.store.addExclusion({ networkId: t.network.id, personId: a, reason: 'network_list', notedAt: new Date('2027-06-01T09:00:00.000Z') });
    await t.store.addExclusion({ networkId: t.network.id, personId: b, reason: 'stop', notedAt: new Date('2027-06-01T09:00:00.000Z') });
    await t.passes('2028-03-08', '2028-03-20');
    expect(await t.outboxCount()).toBe(0);
    const list = await t.relances.list(t.direction);
    expect(list.ok && list.value.map((r) => r.status)).toEqual(['refused', 'refused']);
  });

  it('[R143] [R05] une relance d’ancien contact passée dans la période réglée de G09 retient la relance après la vente ; au-delà, elle part', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: b, side: 'acquereur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f1', b, 'oui');
    // Une relance d'ancien contact passée en essai pour Ana, 100 jours avant la date clé ; une autre pour Bea, 200 jours avant.
    const followup = async (id: string, personId: string, decidedAt: string) =>
      t.db.run(
        `INSERT INTO old_contact_followups (id, network_id, agent_id, person_id, month, reason, reason_day, draft, draft_by, status, channel, created_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, 'fin_de_bail', ?, 'Bonjour, texte de test.', 'secours', 'essai', 'email', ?, ?, ?)`,
        [id, t.network.id, t.alexId, personId, decidedAt.slice(0, 7), decidedAt.slice(0, 10), decidedAt, decidedAt, `agent:${t.alexId}`],
      );
    await followup('oc-a', a, new Date(Date.parse('2028-03-08T09:00:00.000Z') - 100 * 86_400_000).toISOString());
    await followup('oc-b', b, new Date(Date.parse('2028-03-08T09:00:00.000Z') - 200 * 86_400_000).toISOString());
    await t.passes('2028-03-08', '2028-03-10');
    expect(await t.inbox(a)).toEqual([]);
    expect(await t.inbox(b)).toHaveLength(1);
    const list = await t.relances.list(t.direction);
    const byPerson = new Map(list.ok ? list.value.map((r) => [r.personId, r]) : []);
    expect(byPerson.get(a)).toMatchObject({ status: 'refused', rule: 'R143' });
    expect(byPerson.get(b)).toMatchObject({ status: 'sent' });
  });

  it('[R143] la période qui retient la relance après la vente est celle de G09', () => {
    expect(OLD_CONTACT_QUIET_DAYS).toBe(DEFAULT_OLD_CONTACT_SETTINGS.periodDays);
  });

  it('sans lien de désinscription réglé, aucune relance ne part, et le passage le dit au journal', async () => {
    const t = await setup({ base: null });
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    await t.choose('f1', a, 'oui');
    await t.passes('2028-03-08', '2028-03-10');
    expect(await t.outboxCount()).toBe(0);
    const all = await t.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE type = 'apres_vente.relance_sans_lien'");
    expect(all[0]!.n).toBeGreaterThan(0);
  });

  it('[R01] une date clé un dimanche attend le lundi ; passé le délai, la relance est close', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    // 2028-03-12 est un dimanche.
    t.close('f1', '2027-03-12', [{ personId: a, side: 'vendeur' }]);
    t.close('f2', '2027-03-13', [{ personId: b, side: 'vendeur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f2', b, 'oui');
    await t.passes('2028-03-12', '2028-03-13');
    const box = await t.inbox(a);
    expect(box).toHaveLength(1);
    expect(parisDay(new Date(box[0]!.occurred_at))).toBe('2028-03-13');
    expect(await t.inbox(b)).toHaveLength(1);
    // Une relance restée en attente, faute de passage pendant le délai, est close et ne part plus.
    const c = await t.client('Cyr');
    t.close('f3', '2027-03-14', [{ personId: c, side: 'vendeur' }]);
    await t.choose('f3', c, 'oui');
    t.setClock(paris('2028-03-14', 7));
    await t.relances.run(t.network.id);
    await t.passes('2028-03-25', '2028-03-25');
    expect(await t.inbox(c)).toHaveLength(0);
    const list = await t.relances.list(t.agent);
    expect(list.ok && list.value.find((r) => r.fileId === 'f3')).toMatchObject({ status: 'closed', rule: 'delai_depasse' });
  });

  it('[R16] seul l’agent du dossier range le choix, pour un client du dossier, avec une preuve', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const other = await t.client('Zoe');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 11));
    expect(await t.relances.recordChoice(t.sam, 'f1', a, { choice: 'oui', proof: 'test' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.relances.recordChoice(t.direction, 'f1', a, { choice: 'oui', proof: 'test' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.relances.recordChoice(t.agent, 'inconnu', a, { choice: 'oui', proof: 'test' })).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    expect(await t.relances.recordChoice(t.agent, 'f1', other, { choice: 'oui', proof: 'test' })).toEqual({ ok: false, rule: null, code: 'not_client' });
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: ' ' })).toEqual({ ok: false, rule: null, code: 'invalid_proof' });
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'peut-être' as AfterSaleChoice, proof: 'test' })).toEqual({ ok: false, rule: null, code: 'invalid_choice' });
    const refusals = (await t.journal.bySubject('sale_file:f1')).filter((e) => e.type === 'acces.refuse');
    expect(refusals).toHaveLength(2);
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'case cochée, test' })).toEqual({ ok: true });
    // Un choix rangé ne s'efface ni ne change : un nouveau s'ajoute.
    await expect(t.db.run('DELETE FROM after_sale_choices')).rejects.toThrow();
    await expect(t.db.run("UPDATE after_sale_choices SET choice = 'non'")).rejects.toThrow();
  });

  it('[R65] un accord ne rouvre jamais une date passée, ni rien après une opposition : aucune relance ne repart', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: b, side: 'acquereur' }]);
    t.setClock(paris('2027-03-08', 11));
    await t.choose('f1', a, 'oui');
    // Avant l'acte, aucun accord ne se range.
    t.setClock(paris('2027-03-07', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', b, { choice: 'oui', proof: 'appel, test' })).toEqual({ ok: false, rule: 'R65', code: 'not_at_signing' });
    // Une saisie en retard de quelques jours reste possible.
    t.setClock(paris('2027-03-12', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', b, { choice: 'un_an', proof: 'case cochée, test' })).toEqual({ ok: true });
    await t.passes('2028-03-08', '2028-03-09');
    const box = await t.inbox(a);
    expect(box).toHaveLength(1);
    const token = box[0]!.body.slice(box[0]!.body.indexOf(BASE) + BASE.length);
    expect(await t.relances.unsubscribe(token)).toBe(true);
    // Après la désinscription, un « oui » est refusé, même dans le délai de saisie ; un « non » passe toujours.
    t.setClock(paris('2027-03-09', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'appel, test' })).toEqual({ ok: false, rule: 'R65', code: 'opposed' });
    t.setClock(paris('2028-06-01', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'appel, test' })).toEqual({ ok: false, rule: 'R65', code: 'opposed' });
    expect(await t.relances.recordChoice(t.agent, 'f1', b, { choice: 'non', proof: 'appel, test' })).toEqual({ ok: true });
    await t.passes('2029-03-08', '2029-03-12');
    expect(await t.inbox(a)).toHaveLength(1);
    expect(await t.inbox(b)).toHaveLength(1);
  });

  it('[R65] un « non » rangé sur une fiche l’emporte après la réunion avec une fiche qui disait « oui »', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const a2 = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: a2, side: 'vendeur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f1', a2, 'non');
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: a, mergedId: a2, reason: 'même personne, test' });
    await t.passes('2028-03-08', '2028-03-12');
    expect(await t.outboxCount()).toBe(0);
    const list = await t.relances.list(t.agent);
    expect(list.ok && list.value).toMatchObject([{ personId: a, year: 1, status: 'refused', rule: 'R65' }]);
  });

  it('[R65] un « non » sur un autre dossier arrête tout, fiches réunies comprises, et empêche un nouvel accord', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const a2 = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.close('f2', '2027-03-09', [{ personId: a2, side: 'acquereur' }]);
    await t.choose('f1', a, 'oui');
    await t.choose('f2', a2, 'non');
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: a, mergedId: a2, reason: 'même personne, test' });
    await t.passes('2028-03-08', '2028-03-12');
    expect(await t.outboxCount()).toBe(0);
    // Un nouveau dossier de la même personne : l'accord est refusé, l'opposition tient.
    t.close('f3', '2028-04-01', [{ personId: a, side: 'acquereur' }]);
    t.setClock(paris('2028-04-01', 11));
    expect(await t.relances.recordChoice(t.agent, 'f3', a, { choice: 'oui', proof: 'case cochée, test' })).toEqual({ ok: false, rule: 'R65', code: 'opposed' });
  });

  it('[R16] [R13] un agent ne voit que les relances de ses dossiers ; le journal ne garde ni texte ni coordonnée', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    await t.choose('f1', a, 'oui');
    await t.passes('2028-03-08', '2028-03-08');
    const sam = await t.relances.list(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    expect(await t.relances.list({ role: 'partner', networkId: t.network.id, userId: 'p-1' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const events = await t.journal.bySubject('sale_file:f1');
    expect(events.some((e) => e.type === 'apres_vente.relance')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/example\.test|Bonjour|desinscription|Ana/);
    await expect(t.db.run('DELETE FROM after_sale_reminders')).rejects.toThrow();
  });

  it('[R03] [R65] un « oui » redit est rangé quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-01', [{ personId: a, side: 'vendeur' }]);
    const store = new FicheClient(t.db);
    const networkId = (await t.db.first<{ network_id: string }>('SELECT network_id FROM persons WHERE id = ?', [a]))!.network_id;
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await store.createPerson({ networkId, firstName: 'Doublon' });
    await store.addConsent({ networkId, personId: twin.id, purpose: AFTER_SALE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await store.addConsent({ networkId, personId: a, purpose: AFTER_SALE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    const unique = new FicheUnique(t.db, new FicheClient(t.db));
    await unique.merge({ survivorId: a, mergedId: twin.id, reason: 'identifiant commun' });
    expect(await unique.hasConsentInForce(a, AFTER_SALE_PURPOSE, 'email')).toBe(false);
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [a, AFTER_SALE_PURPOSE]);
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'case cochée, test' })).toEqual({ ok: true });
    expect(await lines()).toHaveLength(2);
    await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'case cochée, test' });
    expect(await lines()).toHaveLength(2);
    expect(await unique.hasConsentInForce(a, AFTER_SALE_PURPOSE, 'email')).toBe(true);
  });

  it('[R65] AU086 · un accord donné plus tard, daté et prouvé, ouvre les dates clés à venir, jamais une date passée ni un refus', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: b, side: 'acquereur' }]);
    // Aucun choix à l'acte : à un an, rien ne part.
    await t.passes('2028-03-08', '2028-03-09');
    expect(await t.inbox(a)).toHaveLength(0);
    // Le constat : six mois après, Ana dit oui ; avant AU086, rien ne pouvait plus se ranger passé 7 jours.
    t.setClock(paris('2028-09-15', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', a, { choice: 'oui', proof: 'appel du 15 septembre, test' })).toEqual({ ok: true });
    // L'anniversaire passé ne repart pas : rien de rétroactif.
    await t.passes('2028-09-15', '2028-09-20');
    expect(await t.inbox(a)).toHaveLength(0);
    const before = await t.relances.list(t.agent);
    expect(before.ok && before.value.find((r) => r.personId === a && r.year === 1)).toMatchObject({ status: 'refused', rule: 'R65' });
    // Le suivant, oui.
    await t.passes('2029-03-08', '2029-03-09');
    expect(await t.inbox(a)).toHaveLength(1);
    // Un refus ne se transforme pas : Bea a dit non, un oui plus tard reste refusé, et rien ne part.
    t.setClock(paris('2028-10-01', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', b, { choice: 'non', proof: 'appel, test' })).toEqual({ ok: true });
    t.setClock(paris('2028-11-01', 11));
    expect(await t.relances.recordChoice(t.agent, 'f1', b, { choice: 'oui', proof: 'appel, test' })).toEqual({ ok: false, rule: 'R65', code: 'opposed' });
    await t.passes('2030-03-08', '2030-03-09');
    expect(await t.inbox(b)).toHaveLength(0);
    // L'accord tardif est rangé avec sa date et sa preuve.
    const row = await t.db.first<{ proof: string; recorded_at: string }>("SELECT proof, recorded_at FROM after_sale_choices WHERE person_id = ? AND choice = 'oui'", [a]);
    expect(row).toEqual({ proof: 'appel du 15 septembre, test', recorded_at: paris('2028-09-15', 11).toISOString() });
  });
});

