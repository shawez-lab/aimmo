import { expect, it } from 'vitest';
import {
  DemandesAvis,
  REVIEW_PURPOSE,
  REVIEW_REQUEST_JOB,
  isReviewLink,
  mentionsReward,
  reviewRequestJob,
  reviewText,
  type ClosedSale,
} from '../src/apres-vente/index.ts';
import { DecisionEnvoi } from '../src/envoi/service.ts';
import { FicheClient } from '../src/db/fiche-client.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Les heures sont données à Paris : mars 2027, avant le passage à l'heure d'été (UTC+1).
const paris = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
const LINK = 'https://g.page/r/CexempleAgent42/review';

it('[R64] [R08] [R10] le texte de la demande est écrit par le code : sans promesse, sans parenthèse, un avis bienvenu quel qu’il soit', () => {
  for (const side of ['vendeur', 'acquereur'] as const) {
    const text = reviewText('Léa', side, { city: 'Dijon', reference: 'REF-T-1' }, LINK);
    expect(text.startsWith('Bonjour Léa,')).toBe(true);
    expect(text).toContain(LINK);
    expect(text).toContain('que l’expérience vous ait plu ou non'.replace('’', "'"));
    expect(text).toContain('référence REF-T-1');
    // Aucune contrepartie ni promesse [R64], aucun mot interdit [R07], rien sur l'IA [R06].
    expect(mentionsReward(text.replace(LINK, ''))).toBe(false);
    expect(text).not.toMatch(/[()]|mandataire|gratuit|\bIA\b|intelligence|gagne|offert|tirage|concours|réduction/i);
    // Seuls chiffres : ceux de la référence et du lien [R10].
    expect(text.replace(LINK, '').replace('REF-T-1', '')).not.toMatch(/\d/);
  }
  expect(reviewText('Léa', 'vendeur', { city: 'Dijon', reference: 'A' }, LINK)).toContain('la vente de votre bien à Dijon');
  expect(reviewText('Léa', 'acquereur', { city: 'Dijon', reference: 'A' }, LINK)).toContain("l'achat de votre bien à Dijon");
  expect(reviewText(null, 'vendeur', { city: null, reference: 'A' }, LINK).startsWith('Bonjour, merci encore de nous avoir confié la vente de votre bien, référence A.')).toBe(true);
});

it('seul un lien https de fiche Google est accepté', () => {
  for (const ok of [LINK, 'https://maps.app.goo.gl/AbCdEf123', 'https://search.google.com/local/writereview?placeid=ChIJexemple', 'https://www.google.com/maps/place/Agence']) {
    expect(isReviewLink(ok)).toBe(true);
  }
  for (const ko of [
    'http://g.page/r/CexempleAgent42/review',
    'https://g.page.example.test/r/x',
    'https://exemple.test/avis',
    'https://user:pass@g.page/r/x/review',
    'https://g.page:8443/r/x/review',
    'https://g.page/r/x review',
    'https://g.page/r/(x)',
    'javascript:alert(1)',
    'https://www.google.com/',
    'https://www.google.com/search?q=agence',
    'https://g.page/',
    'https://maps.app.goo.gl/',
    'https://search.google.com/local/writereview',
    'https://maps.google.com/',
    'g.page/r/x',
    `https://g.page/r/${'x'.repeat(300)}`,
  ]) {
    expect(isReviewLink(ko)).toBe(false);
  }
});

it('le passage tourne du lundi au samedi, à partir de 10 h, dans les heures des demandes d’avis [R01] [R11]', () => {
  const job = reviewRequestJob(undefined as never, undefined as never, { closedBetween: async () => [], byId: async () => null });
  expect(job.name).toBe(REVIEW_REQUEST_JOB);
  expect(Math.min(...job.hours)).toBe(10);
  expect(Math.max(...job.hours)).toBeLessThan(19);
  expect(job.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
});

describeWithSqlite('F02 · demande d’avis le lendemain de l’acte, à tous, en mode essai', () => {
  let n = 0;
  async function setup(options: { link?: boolean } = {}) {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const avis = new DemandesAvis(t.db, t.journal, dossiers, { now: t.now });
    const envoi = new DecisionEnvoi(t.db, t.store, new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }), { now: t.now });
    /** Un client inventé, avec son mail et son accord pour le suivi de la vente. */
    const client = async (firstName: string, lastName: string, consent = true) => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `client${n}@example.test` });
      if (consent) await t.store.addConsent({ networkId: t.network.id, personId: p.id, purpose: REVIEW_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
      return p.id;
    };
    /** Un dossier clos ce jour-là, avec ses clients. */
    const close = (fileId: string, closedOn: string, clients: ClosedSale['clients']) => {
      const s: ClosedSale = { fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: `REF-${fileId}`, clients };
      dossiers.sales.push(s);
      return s;
    };
    const inbox = (personId: string) =>
      t.db.all<{ body: string; occurred_at: string }>('SELECT m.body, m.occurred_at FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
    const outboxCount = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n ?? 0;
    /** Les passages du planificateur, d'heure en heure, de 8 h à 20 h, du premier au dernier jour inclus. */
    const passes = async (from: string, to: string) => {
      for (let day = from; day <= to; day = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        for (let hour = 8; hour <= 20; hour++) {
          t.setClock(paris(day, hour, 5));
          await avis.run(t.network.id);
        }
      }
    };
    if (options.link !== false) {
      t.setClock(paris('2027-03-01', 9));
      const r = await avis.setReviewLink(t.agent, t.alexId, LINK);
      if (!r.ok) throw new Error(r.code);
    }
    return { ...t, dossiers, avis, envoi, client, close, inbox, outboxCount, passes };
  }

  it('[R64] [R05] [R18] [R26] sur 5 dossiers tests clos, chaque client reçoit sa demande le lendemain, aucun deux fois', async () => {
    const t = await setup();
    const days = ['2027-03-08', '2027-03-09', '2027-03-10', '2027-03-11', '2027-03-12'];
    const people: { id: string; due: string; side: 'vendeur' | 'acquereur' }[] = [];
    for (const [i, day] of days.entries()) {
      const seller = await t.client(`Vendeur${'ABCDE'[i]}`, 'Exemple');
      const buyer = await t.client(`Acheteur${'ABCDE'[i]}`, 'Essai');
      t.close(`f${i + 1}`, day, [{ personId: seller, side: 'vendeur' }, { personId: buyer, side: 'acquereur' }]);
      const due = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      people.push({ id: seller, due, side: 'vendeur' }, { id: buyer, due, side: 'acquereur' });
    }
    await t.passes('2027-03-08', '2027-03-16');
    for (const p of people) {
      const box = await t.inbox(p.id);
      expect(box).toHaveLength(1);
      const at = new Date(box[0]!.occurred_at);
      // Le lendemain de l'acte, à 10 h passées, heure de Paris.
      expect(at.toISOString().slice(0, 10)).toBe(p.due);
      expect(at.getUTCHours() + 1).toBe(10);
      expect(box[0]!.body).toContain(LINK);
      // Chacun est remercié pour son côté de la vente, sans le nom d'un client de l'autre côté [R19].
      expect(box[0]!.body).toContain(p.side === 'vendeur' ? 'la vente de votre bien' : "l'achat de votre bien");
      expect(box[0]!.body).not.toMatch(p.side === 'vendeur' ? /Acheteur|Essai/ : /Vendeur|Exemple/);
    }
    // Rien ne part réellement : tout est dans la boîte d'essai, et rien de plus [R26].
    expect(await t.outboxCount()).toBe(10);
    const list = await t.avis.list(t.agent);
    expect(list.ok && list.value).toHaveLength(10);
    expect(list.ok && list.value.every((r) => r.status === 'sent' && r.rule === null)).toBe(true);
    // Un nouveau passage, même le jour même, ne renvoie rien.
    t.setClock(paris('2027-03-09', 15));
    expect(await t.avis.run(t.network.id)).toBe(0);
    expect(await t.outboxCount()).toBe(10);
  });

  it('[R64] la demande ne dépend d’aucune note : rien à lire de la satisfaction, rien à trier, à tous les clients du dossier', async () => {
    const t = await setup();
    const columns = await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('review_requests')");
    expect(columns.map((c) => c.name).some((c) => /note|score|satisf|rating|grade|stars/i.test(c))).toBe(false);
    // Un dossier à deux vendeurs et deux acquéreurs : quatre demandes, sur deux jours à cause du plafond de R11.
    const ids = [await t.client('Ana', 'Un'), await t.client('Bea', 'Deux'), await t.client('Cyr', 'Trois'), await t.client('Dan', 'Quatre')];
    t.close('f9', '2027-03-08', ids.map((personId, i) => ({ personId, side: i < 2 ? 'vendeur' : 'acquereur' })));
    await t.passes('2027-03-09', '2027-03-11');
    for (const id of ids) expect(await t.inbox(id)).toHaveLength(1);
  });

  it('[R11] au plus 2 demandes d’avis par jour : les suivantes attendent le lendemain, sans repartir deux fois', async () => {
    const t = await setup();
    const ids = [await t.client('Ana', 'Un'), await t.client('Bea', 'Deux'), await t.client('Cyr', 'Trois')];
    t.close('f1', '2027-03-08', [{ personId: ids[0]!, side: 'vendeur' }, { personId: ids[1]!, side: 'vendeur' }, { personId: ids[2]!, side: 'acquereur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(2);
    const day1 = await t.avis.list(t.agent);
    const waiting = day1.ok ? day1.value.filter((r) => r.status === 'waiting') : [];
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.rule).toBe('R11');
    // Le reste de la journée : rien, le plafond est atteint et la demande attend le lendemain.
    for (let h = 11; h <= 18; h++) {
      t.setClock(paris('2027-03-09', h, 5));
      expect(await t.avis.run(t.network.id)).toBe(0);
    }
    t.setClock(paris('2027-03-10', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(1);
    for (const id of ids) expect(await t.inbox(id)).toHaveLength(1);
  });

  it('[R01] jamais avant 10 h le lendemain, ni la nuit, ni le dimanche : la demande attend le premier passage permis', async () => {
    const t = await setup();
    const a = await t.client('Ana', 'Un');
    const b = await t.client('Bea', 'Deux');
    // L'acte le lundi : rien le lundi, rien le mardi avant 10 h.
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    for (const at of [paris('2027-03-08', 18), paris('2027-03-09', 8), paris('2027-03-09', 9, 59)]) {
      t.setClock(at);
      expect(await t.avis.run(t.network.id)).toBe(0);
    }
    t.setClock(paris('2027-03-09', 10));
    expect(await t.avis.run(t.network.id)).toBe(1);
    // L'acte le samedi : le dimanche, elle attend ; elle part le lundi.
    t.close('f2', '2027-03-13', [{ personId: b, side: 'acquereur' }]);
    t.setClock(paris('2027-03-14', 11));
    expect(await t.avis.run(t.network.id)).toBe(0);
    const sunday = await t.avis.list(t.agent);
    expect(sunday.ok && sunday.value.find((r) => r.fileId === 'f2')).toMatchObject({ status: 'waiting', rule: 'R01' });
    t.setClock(paris('2027-03-15', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(1);
    expect(await t.inbox(b)).toHaveLength(1);
  });

  it('[R02] [R04] [R03] [R11] une personne exclue, arrêtée, sans accord ou proche de l’agent ne reçoit rien, et rien n’est retenté', async () => {
    const t = await setup();
    const excluded = await t.client('Ana', 'Un');
    const stopped = await t.client('Bea', 'Deux');
    const noConsent = await t.client('Cyr', 'Trois', false);
    const relative = await t.client('Dan', 'Quatre');
    await t.store.addExclusion({ networkId: t.network.id, personId: excluded, reason: 'network_list', notedAt: new Date('2027-02-01T09:00:00.000Z') });
    await t.store.addExclusion({ networkId: t.network.id, personId: stopped, reason: 'stop', notedAt: new Date('2027-02-01T09:00:00.000Z') });
    await t.envoi.addRelation({ networkId: t.network.id, personId: relative, relation: 'relative', notedAt: new Date('2027-02-01T09:00:00.000Z') });
    t.close('f1', '2027-03-08', [excluded, stopped, noConsent, relative].map((personId) => ({ personId, side: 'vendeur' as const })));
    await t.passes('2027-03-09', '2027-03-20');
    expect(await t.outboxCount()).toBe(0);
    const list = await t.avis.list(t.direction);
    const byPerson = new Map(list.ok ? list.value.map((r) => [r.personId, r]) : []);
    expect(byPerson.get(excluded)).toMatchObject({ status: 'refused', rule: 'R02' });
    expect(byPerson.get(stopped)?.status).toBe('refused');
    expect(['R02', 'R04']).toContain(byPerson.get(stopped)?.rule);
    expect(byPerson.get(noConsent)).toMatchObject({ status: 'refused', rule: 'R03' });
    expect(byPerson.get(relative)).toMatchObject({ status: 'refused', rule: 'R11' });
    // Un refus pour de bon n'est tenté qu'une fois : une seule ligne de refus par personne au journal.
    const events = (await t.journal.bySubject('sale_file:f1')).filter((e) => e.type === 'apres_vente.demande_avis');
    expect(events).toHaveLength(4);
  });

  it('sans lien réglé, rien ne part et l’agent reçoit une tâche ; le lien réglé, la demande part dans le délai', async () => {
    const t = await setup({ link: false });
    const a = await t.client('Ana', 'Un');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(0);
    t.setClock(paris('2027-03-09', 11, 5));
    expect(await t.avis.run(t.network.id)).toBe(0);
    expect(await t.outboxCount()).toBe(0);
    const tasks = await t.avis.openTasks(t.agent);
    expect(tasks.ok && tasks.value).toEqual([{ fileId: 'f1', agentId: t.alexId, kind: 'lien_avis', createdAt: paris('2027-03-09', 10, 5).toISOString() }]);
    expect((await t.journal.bySubject('sale_file:f1')).filter((e) => e.type === 'apres_vente.lien_avis_manquant')).toHaveLength(1);
    // Un autre agent ne voit pas la tâche [R16].
    const sam = await t.avis.openTasks(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    // L'agent règle son lien : la tâche est faite, la demande part au passage suivant.
    t.setClock(paris('2027-03-10', 9));
    expect(await t.avis.setReviewLink(t.agent, t.alexId, LINK)).toEqual({ ok: true });
    const after = await t.avis.openTasks(t.agent);
    expect(after.ok && after.value).toEqual([]);
    t.setClock(paris('2027-03-10', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(1);
  });

  it('[R11] [R64] AU087 · plus de clients que de places : les plus anciens d’abord, et chacun finit par recevoir sa demande, sans délai qui la close pour le seul plafond', async () => {
    const t = await setup();
    // Cinq dossiers de deux clients clos chaque jour du lundi au mercredi : 30 demandes pour 2 places par jour.
    // Le faux M10 rend les plus récents d'abord.
    const days = ['2027-03-08', '2027-03-09', '2027-03-10'];
    const firstFile: string[] = [];
    for (const day of days) {
      for (let i = 0; i < 5; i++) {
        const fileId = `${day}-${i}`;
        if (i === 0) firstFile.push(fileId);
        t.close(fileId, day, [{ personId: await t.client(`Ven${i}`, 'Un'), side: 'vendeur' }, { personId: await t.client(`Ach${i}`, 'Deux'), side: 'acquereur' }]);
      }
    }
    t.dossiers.sales.reverse();
    t.setClock(paris('2027-03-09', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(2);
    let list = await t.avis.list(t.agent);
    expect(list.ok && list.value.filter((r) => r.status === 'sent').map((r) => r.fileId)).toEqual([firstFile[0], firstFile[0]]);
    // Le constat : au 20 mars, avant AU087, douze demandes étaient closes pour le seul plafond du jour.
    await t.passes('2027-03-10', '2027-03-20');
    list = await t.avis.list(t.agent);
    expect(list.ok && list.value.filter((r) => r.status === 'closed')).toEqual([]);
    // Elles partent à leur tour, deux par jour, jusqu'à la dernière.
    await t.passes('2027-03-21', '2027-03-27');
    list = await t.avis.list(t.agent);
    const rows = list.ok ? list.value : [];
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    // Les plus anciens d'abord : aucun client d'un jour plus récent ne passe avant un plus ancien.
    const lastOf = (due: string) => Math.max(...rows.filter((r) => r.dueDay === due).map((r) => Date.parse(r.updatedAt)));
    const firstOf = (due: string) => Math.min(...rows.filter((r) => r.dueDay === due).map((r) => Date.parse(r.updatedAt)));
    expect(firstOf('2027-03-10')).toBeGreaterThan(lastOf('2027-03-09'));
    expect(firstOf('2027-03-11')).toBeGreaterThan(lastOf('2027-03-10'));
    // Aucune tâche « demande d'avis non partie » : rien n'a été clos.
    const tasks = await t.avis.openTasks(t.agent);
    expect(tasks.ok && tasks.value.filter((x) => x.kind === 'avis_non_parti')).toEqual([]);
    // Personne ne reçoit deux demandes.
    expect(await t.outboxCount()).toBe(30);
  });

  it('passé le délai de 7 jours, une demande qui n’a pas pu partir est close et ne part plus', async () => {
    const t = await setup({ link: false });
    const a = await t.client('Ana', 'Un');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    // L'agent ne règle son lien qu'après le délai : la demande, rangée dès le lendemain, est close au passage suivant.
    await t.passes('2027-03-09', '2027-03-09');
    const pending = await t.avis.list(t.agent);
    expect(pending.ok && pending.value).toMatchObject([{ fileId: 'f1', status: 'waiting', rule: 'lien_avis' }]);
    t.setClock(paris('2027-03-20', 9));
    await t.avis.setReviewLink(t.agent, t.alexId, LINK);
    await t.passes('2027-03-20', '2027-03-22');
    expect(await t.outboxCount()).toBe(0);
    const closed = await t.avis.list(t.agent);
    expect(closed.ok && closed.value).toMatchObject([{ fileId: 'f1', status: 'closed', rule: 'delai_depasse' }]);
    // L'agent garde une tâche : la demande non partie, à faire lui-même ; celle du lien est faite.
    const tasks = await t.avis.openTasks(t.agent);
    expect(tasks.ok && tasks.value.map((x) => [x.fileId, x.kind])).toEqual([['f1', 'avis_non_parti']]);
  });

  it('[R16] le lien se règle par l’agent lui-même ou la direction ; un lien qui n’est pas une fiche Google est refusé', async () => {
    const t = await setup({ link: false });
    expect(await t.avis.setReviewLink(t.sam, t.alexId, LINK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.avis.setReviewLink({ role: 'partner', networkId: t.network.id, userId: 'p-1' }, t.alexId, LINK)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.avis.setReviewLink({ ...t.direction, networkId: 'autre-reseau' }, t.alexId, LINK)).toEqual({ ok: false, rule: null, code: 'unknown_agent' });
    expect(await t.avis.setReviewLink(t.agent, t.alexId, 'https://exemple.test/avis')).toEqual({ ok: false, rule: null, code: 'invalid_link' });
    expect(await t.avis.setReviewLink(t.direction, t.alexId, 'https://maps.app.goo.gl/AbCdEf123')).toEqual({ ok: true });
    const refusals = (await t.journal.bySubject(`agent:${t.alexId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals).toHaveLength(3);
    // Un lien réglé ne s'efface ni ne se modifie : un nouveau s'ajoute.
    await expect(t.db.run('DELETE FROM agent_review_links')).rejects.toThrow();
    await expect(t.db.run("UPDATE agent_review_links SET url = 'https://g.page/r/autre'")).rejects.toThrow();
  });

  it('[R05] deux fiches réunies d’un même client ne reçoivent qu’une demande par dossier ; deux dossiers, deux demandes différentes', async () => {
    const t = await setup();
    const a = await t.client('Ana', 'Un');
    const a2 = await t.client('Ana', 'Un');
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: a, mergedId: a2, reason: 'même personne, test' });
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }, { personId: a2, side: 'acquereur' }]);
    t.close('f2', '2027-03-09', [{ personId: a, side: 'acquereur' }]);
    await t.passes('2027-03-09', '2027-03-11');
    const box = await t.inbox(a);
    expect(box).toHaveLength(2);
    expect(box[0]!.body).not.toBe(box[1]!.body);
  });

  it('[R05] une demande en attente d’une fiche réunie ensuite à une autre ne laisse ni doublon ni fausse tâche', async () => {
    const t = await setup({ link: false });
    const a = await t.client('Ana', 'Un');
    const a2 = await t.client('Ana', 'Un');
    t.close('f1', '2027-03-08', [{ personId: a2, side: 'vendeur' }]);
    await t.passes('2027-03-09', '2027-03-09');
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: a, mergedId: a2, reason: 'même personne, test' });
    t.setClock(paris('2027-03-10', 9));
    await t.avis.setReviewLink(t.agent, t.alexId, LINK);
    await t.passes('2027-03-10', '2027-03-20');
    expect(await t.outboxCount()).toBe(1);
    const list = await t.avis.list(t.agent);
    expect(list.ok && list.value.map((r) => [r.personId === a ? 'gardée' : 'réunie', r.status, r.rule]).sort()).toEqual([
      ['gardée', 'sent', null],
      ['réunie', 'closed', 'fiche_reunie'],
    ]);
    const tasks = await t.avis.openTasks(t.agent);
    expect(tasks.ok && tasks.value).toEqual([]);
  });

  it('[R64] une réunion de fiches défaite dans le délai laisse repartir la demande du client', async () => {
    const t = await setup({ link: false });
    const a = await t.client('Ana', 'Un');
    const b = await t.client('Bea', 'Deux');
    t.close('f1', '2027-03-08', [{ personId: b, side: 'vendeur' }]);
    await t.passes('2027-03-09', '2027-03-09');
    const unique = new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now });
    const m = await unique.merge({ survivorId: a, mergedId: b, reason: 'erreur de test' });
    await t.passes('2027-03-10', '2027-03-10');
    await unique.undoMerge(m.id, { journal: t.journal, actor: 'direction:test' });
    t.setClock(paris('2027-03-11', 9));
    await t.avis.setReviewLink(t.agent, t.alexId, LINK);
    await t.passes('2027-03-11', '2027-03-20');
    expect(await t.inbox(b)).toHaveLength(1);
    expect(await t.inbox(a)).toHaveLength(0);
    // La ligne rangée sous la fiche gardée pendant la réunion est close sans tâche : l'autre n'est pas un client du dossier.
    const list = await t.avis.list(t.agent);
    expect(list.ok && list.value.map((r) => [r.personId === b ? 'client' : 'autre', r.status, r.rule]).sort()).toEqual([
      ['autre', 'closed', 'plus_client'],
      ['client', 'sent', null],
    ]);
    const tasks = await t.avis.openTasks(t.agent);
    expect(tasks.ok && tasks.value).toEqual([]);
  });

  it('[R16] [R13] un agent ne voit que les demandes de ses dossiers ; le journal ne garde ni texte ni coordonnée', async () => {
    const t = await setup();
    const a = await t.client('Ana', 'Un');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    await t.passes('2027-03-09', '2027-03-09');
    const sam = await t.avis.list(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    expect(await t.avis.list({ role: 'partner', networkId: t.network.id, userId: 'p-1' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const events = await t.journal.bySubject('sale_file:f1');
    expect(events.some((e) => e.type === 'apres_vente.demande_avis')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/example\.test|Bonjour|g\.page|Ana/);
    // Une demande partie ne change plus et ne s'efface pas.
    await expect(t.db.run('DELETE FROM review_requests')).rejects.toThrow();
    await expect(t.db.run("UPDATE review_requests SET status = 'waiting'")).rejects.toThrow();
  });
});
