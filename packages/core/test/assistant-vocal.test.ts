import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, applyMigrations, fromSyncSqlite, parisInstant, type SqlDatabase, type Viewer } from '../src/index.ts';
import { FicheBien } from '../src/annonces/index.ts';
import { numbersIn } from '../src/envoi/texte.ts';
import { ReservationEnLigne } from '../src/rendezvous/en-ligne.ts';
import { appointmentWhen } from '../src/rendezvous/reservation.ts';
import { Appels, type CallSegment, type CallTranscriber } from '../src/voix/appels.ts';
import { AssistantVocal, chosenSlot, figuresFromSheet, propertyFacts, saysYes, topicsIn, type AssistantState, type ForwardedCall, type Turn } from '../src/voix/assistant.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Le 9 novembre 2026 est un lundi.
const WEEK = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) };
const AGENT_PHONE = '06 00 00 09 01';
const CALLER = '06 00 00 03 07';
const SHEET = {
  characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['balcon'], landM2: null, parkingSpaces: 1, elevator: true },
  energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2026-09-15' },
  coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
  risks: { inRiskZone: false },
  media: [],
};

const SEGMENTS: CallSegment[] = [
  { speaker: 'agent', startS: 0, endS: 8, text: 'Cet appel est enregistré, êtes-vous d’accord ?' },
  { speaker: 'appelant', startS: 8, endS: 10, text: 'Oui.' },
  { speaker: 'appelant', startS: 11, endS: 20, text: 'Je cherche à acheter à Dijon, mon budget est de 220 000 €.' },
];

function fakeTranscriber(): CallTranscriber & { calls: number } {
  const t = { calls: 0, async transcribe() {
    t.calls += 1;
    return { segments: SEGMENTS, language: 'fr', confidence: 0.9 };
  } };
  return t;
}

async function setup(options: { listed?: boolean; sheet?: unknown; status?: 'available' | 'under_offer' | 'draft' } = {}) {
  let clock = parisInstant('2026-11-09', 8 * 60)!.getTime();
  const now = (): Date => new Date((clock += 1));
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: network.id, firstName: 'Lise', lastName: 'Essai' });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: network.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: network.id };
  const rdvOptions = { now, linkBase: 'https://essai.example.test/' };
  await new RendezVous(db, journal, rdvOptions).setAvailability(asPaul, WEEK);
  const property = await store.createProperty({ networkId: network.id, agentId: paul.id, reference: 'REF-V-7', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 210000, status: options.status ?? 'available' });
  const other = await store.createProperty({ networkId: network.id, agentId: lise.id, reference: 'REF-V-8', kind: 'home', city: 'Talant', surfaceM2: 90, rooms: 4, priceEur: 330000, status: 'available' });
  const sheet = options.sheet === undefined ? SHEET : options.sheet;
  if (sheet !== null) {
    const saved = await new FicheBien(db, acces, journal, { now }).save(asPaul, property.id, sheet);
    if (!saved.ok) throw new Error('fiche');
  }
  // L'annonce publiée, avec un prix changé par avenant : c'est lui qui se dit, pas le prix de la fiche de base [R44].
  if (options.listed !== false) {
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run(
      "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, ?, 1, 'en_vente', 'brouillon-1', 215000, '{}', 'h', 'test', ?)",
      ['annonce-1', property.id, network.id, now().toISOString()],
    );
    await db.run('PRAGMA foreign_keys = ON');
  }
  const transcriber = fakeTranscriber();
  const appels = new Appels(db, journal, store, fiche, transcriber, { now });
  const reservation = new ReservationEnLigne(db, journal, rdvOptions);
  const assistant = new AssistantVocal(db, journal, acces, reservation, appels, { now });
  expect(await assistant.setLine(asPaul, { agentId: paul.id, phone: AGENT_PHONE, enabled: true })).toEqual({ ok: true });
  let n = 0;
  const call = (over: Partial<ForwardedCall> = {}): ForwardedCall => ({
    provider: 'essai',
    callId: `RENVOI-${++n}`,
    from: CALLER,
    forwardedFrom: AGENT_PHONE,
    forwardReason: 'no_answer',
    startedAt: now(),
    propertyId: property.id,
    originCode: null,
    ...over,
  });
  /** Une conversation entière : chaque phrase dite par l'assistant, dans l'ordre. */
  const talk = async (c: ForwardedCall, lines: string[]): Promise<{ state: AssistantState; said: string[]; turns: Turn[] }> => {
    const s = await assistant.start(c);
    if (!s.ok) throw new Error(s.code);
    let state = s.state;
    const said = [...s.say];
    const turns: Turn[] = [];
    for (const line of lines) {
      const t = await assistant.hear(state, line);
      turns.push(t);
      state = t.state;
      said.push(...t.say);
    }
    return { state, said, turns };
  };
  return { db, journal, assistant, reservation, transcriber, network, paul, lise, asPaul, asLise, property, other, call, talk, now, setClock: (ms: number) => (clock = ms) };
}

/** Les nombres que la fiche porte : le bien, sa fiche, et rien d'autre. */
function sheetNumbers(property: { price_eur: number | null; surface_m2: number | null; rooms: number | null }, sheet: unknown): Set<string> {
  const all = new Set<string>(numbersIn(JSON.stringify(sheet)));
  for (const v of [property.price_eur, property.surface_m2, property.rooms]) if (v !== null) all.add(String(v));
  return all;
}

const appointments = (db: SqlDatabase) => db.all<{ start_at: string; source: string; kind: string; property_id: string | null }>("SELECT start_at, source, kind, property_id FROM appointments WHERE status = 'booked' ORDER BY start_at");

describeWithSqlite('HX22 · assistant vocal quand l’agent ne peut pas répondre', () => {
  it('[R246] la mention de l’assistant est la première phrase de chaque appel, avant l’annonce de l’enregistrement', async () => {
    const t = await setup();
    for (const forwardReason of ['no_answer', 'busy', 'unreachable'] as const) {
      for (const over of [{}, { from: null }, { propertyId: null }]) {
        const s = await t.assistant.start(t.call({ forwardReason, ...over }));
        if (!s.ok) throw new Error(s.code);
        expect(s.say[0]).toMatch(/^Bonjour, vous êtes sur l’assistant automatique de Paul, agent immobilier AIMMO/);
        expect(s.say[1]).toMatch(/enregistré.*d’accord \?$/);
        // L'annonce est rangée dès le décroché, l'accord seulement après un oui.
        expect(s.state.announcedAt).not.toBeNull();
        expect(s.state.consentAt).toBeNull();
      }
    }
  });

  it('[R246] l’agent garde son seul numéro : seul un appel renvoyé depuis sa ligne allumée est pris, et aucun numéro n’est dit', async () => {
    const t = await setup();
    expect(await t.assistant.start(t.call({ forwardedFrom: '06 00 00 09 99' }))).toEqual({ ok: false, code: 'no_line' });
    expect(await t.assistant.start(t.call({ forwardedFrom: 'pas un numéro' }))).toEqual({ ok: false, code: 'not_forwarded' });
    expect(await t.assistant.start(t.call({ forwardReason: 'transfert' as never }))).toEqual({ ok: false, code: 'bad_call' });
    // Une autre personne que l'agent ne règle pas sa ligne ; un numéro déjà pris par un autre agent est refusé.
    expect(await t.assistant.setLine(t.asLise, { agentId: t.paul.id, phone: '06 00 00 09 02', enabled: false })).toEqual({ ok: false, code: 'forbidden' });
    expect(await t.assistant.setLine(t.asLise, { agentId: t.lise.id, phone: AGENT_PHONE, enabled: true })).toEqual({ ok: false, code: 'taken' });
    // Le même numéro dans un autre réseau est refusé aussi : l'appel renvoyé ne peut aller qu'à un seul agent.
    const store = new FicheClient(t.db, { now: t.now });
    const elsewhere = await store.createNetwork('Autre réseau');
    const nina = await store.createAgent({ networkId: elsewhere.id, firstName: 'Nina', lastName: 'Essai' });
    expect(await t.assistant.setLine({ role: 'agent', userId: nina.id, networkId: elsewhere.id }, { agentId: nina.id, phone: '+33600000901', enabled: true })).toEqual({ ok: false, code: 'taken' });
    expect(await t.assistant.setLine(t.asPaul, { agentId: t.paul.id, phone: AGENT_PHONE, enabled: false })).toEqual({ ok: true });
    expect(await t.assistant.start(t.call())).toEqual({ ok: false, code: 'line_off' });
    await t.assistant.setLine(t.asPaul, { agentId: t.paul.id, phone: AGENT_PHONE, enabled: true });

    const { said } = await t.talk(t.call(), ['oui', 'C’est combien et il y a combien de pièces ?', 'Je voudrais un rendez-vous pour le visiter', 'le premier', 'oui']);
    // Ni numéro de téléphone ni autre moyen de joindre l'agent : aucun nombre de plus de 6 chiffres.
    for (const s of said) for (const n of numbersIn(s)) expect(n.replace('.', '').length).toBeLessThanOrEqual(6);
    // Le numéro de l'agent et celui de l'appelant ne sont jamais au journal [R13].
    const journal = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(journal).not.toContain('600000901');
    expect(journal).not.toContain('600000307');
  });

  it('[R247] aucun chiffre dit qui ne vienne de la fiche du bien ou d’un créneau proposé', async () => {
    const t = await setup();
    const { said, state, turns } = await t.talk(t.call(), [
      'oui',
      'Quel est le prix ? Et la surface, le nombre de pièces et de chambres ?',
      'À quel étage, et le DPE ?',
      'Les charges de copropriété, le chauffage, il y a un parking, un balcon ? Il a été construit quand ?',
      'Où se trouve le bien, quelle est l’adresse exacte ?',
      'Le prix est négociable ?',
      'D’accord, je voudrais visiter',
      'le deuxième',
      'oui, c’est parfait',
    ]);
    const allowed = sheetNumbers({ price_eur: 215000, surface_m2: 62, rooms: 3 }, SHEET);
    // Tous les créneaux proposés pendant l'appel.
    const slots = new Set(turns.flatMap((x) => x.state.offered));
    expect(state.booked).not.toBeNull();
    for (const s of said) for (const n of numbersIn(s)) {
      const fromSlot = [...slots].some((start) => numbersIn(appointmentWhen(new Date(start)).text).includes(n));
      expect(allowed.has(n) || fromSlot, `« ${n} » dans « ${s} »`).toBe(true);
    }
    // Les faits demandés sont dits, tels que la fiche les porte.
    const all = said.join(' ');
    for (const piece of ['Le prix de l’annonce est de 215 000 €.', '62 m²', '3 pièces', '2 chambres', '3e étage sur 5, avec ascenseur', 'classe énergie est D', 'entre 1 100 et 1 550 €', '1 800 € de charges', 'collectif', '1 place de stationnement', 'un balcon', '1965', 'à Dijon.']) {
      expect(all).toContain(piece);
    }
    // Jamais l'adresse ni la référence ; une question hors fiche passe à l'agent, sans réponse inventée.
    expect(all).not.toMatch(/REF-V-7|rue/);
    expect(all).toContain('Je ne peux pas répondre à cette question ; Paul vous répondra lui-même.');
    expect(state.unanswered).toEqual(['autre']);
  });

  it('[R247] ce qui manque à la fiche n’est pas deviné ; un nombre étranger ou en lettres fait taire la phrase', async () => {
    const t = await setup({ sheet: { ...SHEET, coownership: null, energy: null } });
    const { said, state } = await t.talk(t.call(), ['oui', 'Le prix et la surface ?', 'Et les charges, et le DPE ?']);
    const all = said.join(' ');
    expect(all).toContain('Le prix de l’annonce est de 215 000 €.');
    expect(all).toContain('La surface est de 62 m².');
    expect(all).toContain('Je n’ai pas cette information dans la fiche ; Paul vous la donnera.');
    expect(state.unanswered).toEqual(['energie', 'charges']);

    // Le contrôle lui-même : un nombre étranger, ou un nombre écrit en lettres, fait taire la phrase.
    const facts = propertyFacts({ city: 'Dijon', surface_m2: 62, rooms: 3, price_eur: 210000 }, null);
    const allowed = new Set(Object.values(facts).flatMap((f) => numbersIn(f ?? '')));
    expect(figuresFromSheet(facts.prix!, allowed)).toBe(true);
    expect(figuresFromSheet('Le prix est de 199 000 €.', allowed)).toBe(false);
    expect(figuresFromSheet('Le prix est de 210 000 €, avec une surface de cent mètres carrés.', allowed)).toBe(false);
    expect(figuresFromSheet('Il y a deux chambres.', allowed)).toBe(false);
    expect(figuresFromSheet('Le bien a un balcon et une terrasse.', allowed)).toBe(true);
  });

  it('[R247] [R44] le prix dit est celui de l’annonce publiée ; sans annonce en ligne, aucun prix n’est dit', async () => {
    const listed = await setup();
    expect((await listed.talk(listed.call(), ['oui', 'Quel est le prix ?'])).said.join(' ')).not.toContain('210');
    const t = await setup({ listed: false });
    const { said, state } = await t.talk(t.call(), ['oui', 'Quel est le prix ?']);
    const all = said.join(' ');
    expect(all).not.toMatch(/210|215/);
    expect(all).toContain('Je n’ai pas cette information dans la fiche ; Paul vous la donnera.');
    expect(state.unanswered).toEqual(['prix']);
  });

  it('[R247] un bien d’un autre agent, ou qui n’est pas en vente, ne donne aucun chiffre', async () => {
    const t = await setup({ status: 'draft' });
    const draft = await t.talk(t.call(), ['oui', 'Quel est le prix et la surface ?']);
    expect(draft.state.propertyId).toBeNull();
    expect(draft.said.join(' ')).not.toMatch(/210|62/);
    const other = await t.talk(t.call({ propertyId: t.other.id }), ['oui', 'Quel est le prix ?']);
    expect(other.state.propertyId).toBeNull();
    expect(other.said.join(' ')).not.toMatch(/330|90/);
    expect(other.said.join(' ')).toContain('Je n’ai pas cette information dans la fiche');
  });

  it('[R248] un rendez-vous n’est pris que sur un créneau libre proposé pendant l’appel', async () => {
    const t = await setup();
    const s = await t.assistant.start(t.call());
    if (!s.ok) throw new Error(s.code);
    let turn = await t.assistant.hear(s.state, 'oui');
    turn = await t.assistant.hear(turn.state, 'Je voudrais visiter le bien');
    expect(turn.state.phase).toBe('choose');
    expect(turn.state.offered).toHaveLength(3);
    const [first, second] = turn.state.offered as [string, string];
    // Un créneau qui n'a pas été proposé ne se réserve pas, même libre.
    const unknown = await t.assistant.hear(turn.state, 'vendredi à 17 h');
    expect(unknown.state.booked).toBeNull();
    expect(await appointments(t.db)).toHaveLength(0);

    // Le premier créneau est pris par quelqu'un d'autre pendant l'appel : refusé, d'autres créneaux sont proposés.
    const taken = await t.reservation.book({ networkId: t.network.id, agentId: t.paul.id, kind: 'visite', start: new Date(first), source: 'site', email: 'autre.personne@example.test', consentProof: 'case cochée (test)' });
    expect(taken.ok).toBe(true);
    const asked = await t.assistant.hear(unknown.state, 'le premier');
    expect(asked.state.phase).toBe('confirm');
    expect(asked.say[0]).toBe(`Je réserve une visite ${appointmentWhen(new Date(first)).text}. C’est bien cela ?`);
    // Désigner un créneau ne réserve rien : seul le rendez-vous de l'autre personne existe.
    expect((await appointments(t.db)).map((r) => r.source)).toEqual(['site']);
    const refused = await t.assistant.hear(asked.state, 'oui');
    expect(refused.state.booked).toBeNull();
    expect(refused.say.join(' ')).toContain('Ce créneau vient d’être pris.');
    expect(refused.state.offered).not.toContain(first);
    expect(refused.state.phase).toBe('choose');

    const again = await t.assistant.hear(refused.state, 'le premier');
    const booked = await t.assistant.hear(again.state, 'oui');
    expect(booked.done).toBe(true);
    expect(booked.state.booked).toEqual({ kind: 'visite', start: refused.state.offered[0] });
    const rows = await appointments(t.db);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.source === 'assistant')).toEqual([{ start_at: refused.state.offered[0], source: 'assistant', kind: 'visite', property_id: t.property.id }]);
    expect(booked.say[0]).toContain(appointmentWhen(new Date(refused.state.offered[0]!)).text);
    expect(second).toBeDefined();
  });

  it('[R248] « non, pas le premier » ne réserve rien : une négation ne vaut jamais choix', async () => {
    const t = await setup();
    for (const refusal of ['non, pas le premier', 'pas le deuxième', 'je ne veux pas le dernier', 'aucun, le premier ne me va pas']) {
      const { state } = await t.talk(t.call(), ['oui', 'je voudrais visiter', refusal]);
      expect(state.booked, refusal).toBeNull();
    }
    expect(await appointments(t.db)).toHaveLength(0);
    // Après un refus, un choix franc réserve.
    const { state } = await t.talk(t.call(), ['oui', 'je voudrais visiter', 'non, pas le premier', 'le deuxième', 'oui']);
    expect(state.booked).not.toBeNull();
    expect(await appointments(t.db)).toHaveLength(1);
  });

  it('[R248] une question sur un créneau ne le réserve pas ; seul un oui franc au créneau répété réserve', async () => {
    const t = await setup();
    for (const lines of [
      ['le premier est à quelle heure ?'],
      ['quel jour est le deuxième'],
      ['le premier', 'euh, c’est à quelle heure ?'],
      ['le premier', 'oui mais pas avant midi'],
      ['le premier', 'le deuxième plutôt'],
      ['le premier', 'Merci.'],
    ]) {
      const { state } = await t.talk(t.call(), ['oui', 'je voudrais visiter', ...lines]);
      expect(state.booked, lines.join(' / ')).toBeNull();
    }
    expect(await appointments(t.db)).toHaveLength(0);
  });

  it('[R242] un accord à l’enregistrement assorti d’une réserve n’en est pas un', async () => {
    const t = await setup();
    for (const answer of ['Oui pour parler, mais pas pour enregistrer', 'oui, enfin non', 'oui ? c’est enregistré pourquoi', 'ok mais sans enregistrement', 'je ne sais pas', 'Bonjour.', 'Merci.']) {
      const { state } = await t.talk(t.call(), [answer]);
      expect(state.consentAt, answer).toBeNull();
    }
    const { state } = await t.talk(t.call(), ['Oui, d’accord.']);
    expect(state.consentAt).not.toBeNull();
  });

  it('[R248] un numéro masqué ne réserve rien ; un refus de rendez-vous ne réserve rien', async () => {
    const t = await setup();
    const masked = await t.talk(t.call({ from: null }), ['oui', 'Je voudrais un rendez-vous']);
    expect(masked.state.booked).toBeNull();
    expect(masked.said.join(' ')).toContain('Votre numéro est masqué');
    const no = await t.talk(t.call(), ['oui', 'Je voudrais visiter', 'non merci, au revoir']);
    expect(no.state.booked).toBeNull();
    expect(await appointments(t.db)).toHaveLength(0);
  });

  it('[R242] [R244] [R18] la main passe à l’agent avec le résumé de HX21, une seule fois ; sans accord, rien de ce qui est dit n’est gardé', async () => {
    const t = await setup();
    const { state } = await t.talk(t.call(), ['oui', 'Le prix est négociable ?', 'je voudrais visiter', 'le deuxième', 'oui']);
    expect(state.booked).not.toBeNull();
    const end = { endedAt: new Date(Date.parse(state.startedAt) + 120_000), recordingRef: 'REC-ASSISTANT-1' };
    const h = await t.assistant.finish(state, end);
    expect(h.already).toBe(false);
    expect(h.appointment).toEqual(state.booked);
    expect(h.unanswered).toEqual(['autre']);
    expect(h.call).toMatchObject({ status: 'traite', needsAgent: false });
    expect(h.call!.summary.map((l) => l.key)).toContain('budgetMaxEur');
    const again = await t.assistant.finish(state, end);
    expect(again).toMatchObject({ already: true, appointment: state.booked, unanswered: ['autre'] });
    expect(t.transcriber.calls).toBe(1);
    expect((await t.db.all('SELECT id FROM voice_assistant_calls')).length).toBe(1);

    const refused = await t.talk(t.call(), ['non, pas d’enregistrement', 'Le prix est négociable ?']);
    expect(refused.state.consentAt).toBeNull();
    const h2 = await t.assistant.finish(refused.state, { endedAt: new Date(Date.parse(refused.state.startedAt) + 60_000), recordingRef: 'REC-ASSISTANT-2' });
    expect(h2.unanswered).toEqual([]);
    expect(h2.call).toMatchObject({ status: 'sans_enregistrement', recordingRef: null, transcript: [] });
    expect(t.transcriber.calls).toBe(1);

    // [R244] Numéro masqué, même avec l'accord : rien de ce qui est dit n'est gardé, pas même les sujets.
    const masked = await t.talk(t.call({ from: null }), ['oui', 'Le prix est négociable ?']);
    expect(masked.state.consentAt).not.toBeNull();
    expect(masked.state.unanswered).toEqual(['autre']);
    const h3 = await t.assistant.finish(masked.state, { endedAt: new Date(Date.parse(masked.state.startedAt) + 60_000), recordingRef: 'REC-ASSISTANT-3' });
    expect(h3.unanswered).toEqual([]);
    expect(h3.call).toMatchObject({ status: 'masque' });
    const rows = await t.db.all<{ unanswered: string | null }>('SELECT unanswered FROM voice_assistant_calls ORDER BY created_at');
    expect(rows.map((r) => r.unanswered)).toEqual(['["autre"]', null, null]);
  });
});

it('HX22 · les intentions se lisent par des règles fixes', () => {
  expect(saysYes('Oui, d’accord')).toBe(true);
  expect(saysYes('Non')).toBe(false);
  expect(saysYes('oui... enfin non')).toBe(false);
  expect(saysYes('euh')).toBe(false);
  expect(saysYes('Oui pour parler, mais pas pour enregistrer')).toBe(false);
  expect(saysYes('Oui, bien sûr, allez-y.')).toBe(true);
  expect(saysYes('Bonjour, oui, merci.')).toBe(true);
  // Une politesse seule n'est pas un accord.
  for (const courtesy of ['Bonjour.', 'Merci.', 'Monsieur', 'merci bonjour', '']) expect(saysYes(courtesy), courtesy).toBe(false);
  expect(topicsIn('Il y a combien de pièces ?')).toEqual(['pieces']);
  expect(topicsIn('Combien coûte-t-il ?')).toEqual(['prix']);
  expect(topicsIn('Le vendeur est pressé ?')).toEqual(['autre']);
  expect(topicsIn('Je voudrais visiter')).toEqual([]);
  const offered = ['2026-11-10T08:00:00.000Z', '2026-11-10T13:00:00.000Z', '2026-11-11T08:00:00.000Z'];
  expect(chosenSlot('le deuxième', offered)).toBe(offered[1]);
  expect(chosenSlot('le dernier', offered)).toBe(offered[2]);
  expect(chosenSlot('mercredi', offered)).toBe(offered[2]);
  expect(chosenSlot('mardi', offered)).toBeNull();
  expect(chosenSlot('mardi à 14 h', offered)).toBe(offered[1]);
  expect(chosenSlot('jeudi', offered)).toBeNull();
});
