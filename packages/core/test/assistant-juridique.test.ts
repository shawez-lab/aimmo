import { describe, expect, it } from 'vitest';
import { MemoryJournalStore } from '../src/index.ts';
import {
  DEFAULT_LEGAL_LIBRARY,
  DISPUTE,
  DONT_KNOW,
  LAWYER_NOTICE,
  NOT_VALIDATED,
  STALE,
  TOO_LONG,
  TO_CHECK,
  UNCHECKED,
  askLegal,
  checkDraft,
  coveringSources,
  quantitiesIn,
  scrubQuestion,
  type LegalFacts,
  type LegalSource,
  type LegalWriter,
} from '../src/juridique/index.ts';

const NOW = new Date('2026-12-08T10:00:00.000Z');
const now = (): Date => NOW;

/** Une bibliothèque inventée pour les tests : deux textes fictifs. */
const LIB: LegalSource[] = [
  {
    id: 'loi-a-3',
    title: 'Loi d’essai n° 1 du 4 mai 2001',
    article: 'article 3',
    origin: 'loi d’essai n° 1 du 4 mai 2001',
    textDate: '2001-05-04',
    wording: 'loi d’essai n° 1 du 4 mai 2001',
    wordingDate: '2001-05-04',
    summary: 'Le délai de réflexion de l’acheteur est de 10 jours.',
    match: [['reflexion'], ['acheteur', 'acquereur']],
    exclude: ['professionnel'],
    url: 'https://www.legifrance.gouv.fr/essai',
    checkedOn: '2026-10-01',
    validatedBy: 'avocat:essai',
  },
  {
    id: 'loi-b-7',
    title: 'Loi d’essai n° 2 du 9 juin 2010',
    article: 'article 7',
    origin: 'loi d’essai n° 2 du 9 juin 2010',
    textDate: '2010-06-09',
    wording: 'loi d’essai n° 2 du 9 juin 2010',
    wordingDate: '2010-06-09',
    summary: 'Le panneau doit être retiré dans les quinze jours après la fin du mandat.',
    match: [['panneau'], ['retirer', 'retire', 'enlever']],
    exclude: [],
    url: null,
    checkedOn: '2024-01-01',
    validatedBy: null,
  },
];

const asFact = (s: LegalSource): LegalFacts['sources'][number] => ({
  id: s.id,
  title: s.title,
  article: s.article,
  origin: s.origin,
  textDate: s.textDate,
  wording: s.wording,
  wordingDate: s.wordingDate,
  summary: s.summary,
});

function writer(answer: (f: LegalFacts) => unknown): LegalWriter & { seen: LegalFacts[] } {
  const seen: LegalFacts[] = [];
  return {
    seen,
    async write(f) {
      seen.push(f);
      return answer(f);
    },
  };
}

describe('assistant juridique (HX03)', () => {
  it('[R250] aucune réponse sans source citée : la réponse du code cite chaque texte, son article et sa date', async () => {
    const a = await askLegal('Quel est le délai de réflexion de l’acheteur ?', { library: LIB, now });
    expect(a.status).toBe('reponse');
    if (a.status !== 'reponse') return;
    expect(a.writtenBy).toBe('textes');
    expect(a.paragraphs.length).toBeGreaterThan(0);
    for (const p of a.paragraphs) expect(p.sources.length).toBeGreaterThan(0);
    expect(a.citations).toEqual([
      expect.objectContaining({ id: 'loi-a-3', title: 'Loi d’essai n° 1 du 4 mai 2001', article: 'article 3', textDate: '2001-05-04', checkedOn: '2026-10-01', warnings: [] }),
    ]);
    expect(a.notice).toBe(LAWYER_NOTICE);
  });

  it('[R250] refus explicite quand aucun texte ne couvre la question, et l’IA n’est jamais appelée', async () => {
    const w = writer(() => ({ kind: 'answer', paragraphs: [{ text: 'Le préavis est de 3 mois.', sources: ['loi-a-3'] }] }));
    const a = await askLegal('Quel préavis pour un bail meublé ?', { library: LIB, writer: w, now });
    expect(a).toEqual({ status: 'je_ne_sais_pas', text: DONT_KNOW, citations: [], notice: LAWYER_NOTICE });
    expect(a.status === 'je_ne_sais_pas' && a.text).toMatch(/je ne sais pas/i);
    expect(a.status === 'je_ne_sais_pas' && a.text).toMatch(/avocat/);
    expect(w.seen).toHaveLength(0);
  });

  it('[R250] un seul groupe de termes ne suffit pas : « acheteur » seul ne couvre rien', () => {
    expect(coveringSources('Comment trouver un acheteur ?', LIB)).toEqual([]);
    expect(coveringSources('', LIB)).toEqual([]);
    expect(coveringSources('réflexion de l’acquéreur', LIB).map((s) => s.id)).toEqual(['loi-a-3']);
  });

  it('[R250] une question vide ou qui n’est pas un texte : je ne sais pas', async () => {
    expect((await askLegal('   ', { library: LIB, now })).status).toBe('je_ne_sais_pas');
    expect((await askLegal(undefined as unknown as string, { library: LIB, now })).status).toBe('je_ne_sais_pas');
  });

  it('[R250] l’IA qui dit ne pas savoir donne le refus, jamais une réponse', async () => {
    const a = await askLegal('Délai de réflexion de l’acheteur ?', { library: LIB, writer: writer(() => ({ kind: 'unknown' })), now });
    expect(a.status).toBe('je_ne_sais_pas');
    expect(a.citations).toEqual([]);
  });

  it('[R251] une réponse de l’IA fidèle à ses textes est gardée, avec ses citations', async () => {
    const w = writer((f) => ({ kind: 'answer', paragraphs: [{ text: 'L’acheteur a dix jours pour réfléchir (article 3, loi de 2001).', sources: [f.sources[0]!.id] }] }));
    const a = await askLegal('Délai de réflexion de l’acheteur ?', { library: LIB, writer: w, now });
    expect(a.status === 'reponse' && a.writtenBy).toBe('ia');
    expect(a.citations.map((c) => c.id)).toEqual(['loi-a-3']);
  });

  it('[R251] un paragraphe sans source, avec une source non reçue, un nombre inventé ou une promesse est refusé : les textes répondent', async () => {
    const facts: LegalFacts = { question: 'q', sources: [asFact(LIB[0]!)] };
    const bad = (text: string, sources: string[]) => checkDraft({ kind: 'answer', paragraphs: [{ text, sources }] }, facts);
    expect(bad('Dix jours.', [])).toEqual({ ok: false, problems: ['sans_source', 'nombre_sans_source'] });
    expect(bad('Dix jours.', ['loi-b-7'])).toEqual({ ok: false, problems: ['source_non_fournie', 'nombre_sans_source'] });
    expect(bad('Le délai est court.', [])).toEqual({ ok: false, problems: ['sans_source'] });
    expect(bad('Le délai est court.', ['loi-b-7'])).toEqual({ ok: false, problems: ['source_non_fournie'] });
    expect(bad('L’acheteur a 14 jours.', ['loi-a-3'])).toEqual({ ok: false, problems: ['nombre_sans_source'] });
    expect(bad('L’acheteur a quatorze jours.', ['loi-a-3'])).toEqual({ ok: false, problems: ['nombre_sans_source'] });
    expect(bad('Dix jours, je vous garantis.', ['loi-a-3'])).toEqual({ ok: false, problems: ['tournure_interdite'] });
    expect(bad('', ['loi-a-3'])).toEqual({ ok: false, problems: ['vide'] });
    expect(bad('x'.repeat(801), ['loi-a-3'])).toEqual({ ok: false, problems: ['trop_long'] });
    expect(checkDraft({ kind: 'answer', paragraphs: [] }, facts)).toEqual({ ok: false, problems: ['vide'] });
    expect(checkDraft('Dix jours', facts)).toEqual({ ok: false, problems: ['format'] });
    expect(checkDraft({ kind: 'answer', paragraphs: [{ text: 'Dix jours.', sources: [3] }] }, facts)).toEqual({ ok: false, problems: ['format'] });

    for (const raw of [
      { kind: 'answer', paragraphs: [{ text: 'Il a 14 jours.', sources: ['loi-a-3'] }] },
      { kind: 'answer', paragraphs: [{ text: 'Dix jours.', sources: [] }] },
      'texte libre',
      null,
    ]) {
      const a = await askLegal('Délai de réflexion de l’acheteur ?', { library: LIB, writer: writer(() => raw), now });
      expect(a.status === 'reponse' && a.writtenBy).toBe('textes');
      expect(a.status === 'reponse' && a.paragraphs[0]!.text).toContain(LIB[0]!.summary);
    }
  });

  it('[R251] une IA en panne ne fait jamais tomber la réponse', async () => {
    const w: LegalWriter = {
      async write() {
        throw new Error('panne');
      },
    };
    const a = await askLegal('Délai de réflexion de l’acheteur ?', { library: LIB, writer: w, now });
    expect(a.status === 'reponse' && a.writtenBy).toBe('textes');
  });

  it('[R251] les nombres d’un texte se lisent en chiffres ou en lettres, avec leur unité', () => {
    const q = quantitiesIn('10 jours, quinze jours, 10 000 €, plus d’un vingtième, dans un délai d’un an, 8 m², 3,5 %, article 6');
    expect([...q.withUnit].sort()).toEqual(['10|jour', '15|jour', '10000|eur', '1|vingtieme', '1|an', '8|m2', '3.5|pct'].sort());
    expect([...q.bare]).toEqual(['6']);
  });

  it('[R251] un nombre pris dans la référence ou la date d’un texte, ou une unité changée, ne passe jamais', () => {
    const facts = (id: string): LegalFacts => {
      const s = DEFAULT_LEGAL_LIBRARY.find((x) => x.id === id)!;
      return { question: 'q', sources: [asFact(s)] };
    };
    const one = (id: string, text: string) => checkDraft({ kind: 'answer', paragraphs: [{ text, sources: [id] }] }, facts(id));
    expect(one('hoguet-6', 'Vos honoraires sont plafonnés à 9 % du prix et payables 2 jours après la signature du mandat.').ok).toBe(false);
    expect(one('cch-l271-1', 'L’acheteur dispose de 6 jours ouvrés, ou un mois s’il paie comptant.').ok).toBe(false);
    expect(one('cch-l271-1', 'La rétractation coûte 1 % du prix.').ok).toBe(false);
    expect(one('cch-l271-1', 'L’acquéreur a dix jours, depuis le lendemain de la première présentation de la lettre (article L271-1).').ok).toBe(true);
    expect(one('copro-46', 'L’acquéreur doit agir dans un délai de deux ans.').ok).toBe(false);
    expect(one('copro-46', 'L’action en diminution du prix se forme dans un délai d’un an après l’acte authentique.').ok).toBe(true);
    expect(one('hoguet-6', 'La loi du 2 janvier 1970 impose un mandat écrit.').ok).toBe(true);
    expect(one('hoguet-6', 'La loi n° 70-9, article 6, impose un mandat écrit.').ok).toBe(true);
    expect(one('copro-46', 'La mention n’est pas obligatoire pour un lot de moins de 10 mètres.').ok).toBe(false);
    expect(one('hoguet-6', 'Les honoraires peuvent atteindre 2 fois le montant prévu au mandat.').ok).toBe(false);
    expect(one('hoguet-6', 'Voyez aussi l’article 7 de la loi.').ok).toBe(false);
    expect(one('cch-l271-1', 'Depuis la loi du 6 août 2015, l’acquéreur a 10 jours (article L271-1).').ok).toBe(true);
    expect(one('cch-l271-1', 'Depuis 2017, l’acquéreur a 10 jours.').ok).toBe(false);
    expect(one('cch-l271-1', 'Depuis 2015, l’acquéreur a 10 jours.').ok).toBe(true);
    expect(one('cch-l271-1', 'L’acquéreur qui se rétracte perd jusqu’à 2000 euros.').ok).toBe(false);
    expect(one('cch-l271-1', 'Le délai est de 2015 heures.').ok).toBe(false);
    expect(one('cch-l271-1', 'Le délai est de 2015 jours depuis la loi de 2015.').ok).toBe(false);
    expect(one('copro-46', 'Au-delà de 1997 m² la mention n’est plus due.').ok).toBe(false);
    expect(one('cch-l271-1', 'Il paie une pénalité de 2000 dollars.').ok).toBe(false);
    expect(one('hoguet-6', 'Les honoraires sont plafonnés à un million d’euros.').ok).toBe(false);
    expect(one('hoguet-6', 'Les honoraires sont au plus le double du prix.').ok).toBe(false);
    expect(one('hoguet-6', 'Il faut une dizaine de mandats.').ok).toBe(false);
    expect(one('cch-l271-1', 'Aucun frais : l’acquéreur a dix jours.').ok).toBe(false);
    expect(one('cch-l271-1', 'Il perd un dépôt de 2000, en euros.').ok).toBe(false);
    expect(one('copro-46', 'Au-delà d’un lot de 1997 m la mention n’est plus due.').ok).toBe(false);
    expect(one('copro-46', 'Le seuil de 8 m² vient du décret de 1997.').ok).toBe(true);
    expect(one('cch-l271-1', 'Le délai est passé à 10 jours en 2015.').ok).toBe(true);
    expect(one('cch-l271-1', 'Selon la loi de 2000, l’acquéreur a 10 jours.').ok).toBe(true);
    expect(one('cch-l271-1', 'La loi n° 2000-1208 a créé ce délai, porté à 10 jours en 1208.').ok).toBe(false);
  });

  it('[R15] un nom dit en passant, une date de naissance ou de signature ne partent jamais à l’IA', async () => {
    const w = writer(() => ({ kind: 'unknown' }));
    await askLegal('Mon client Jean Martin, né le 3 mai 1960, a signé le 12/10/2026 : délai de réflexion de l’acheteur selon la loi Carrez ?', { library: LIB, writer: w, now });
    const sent = w.seen[0]!.question;
    for (const leak of ['Jean', 'Martin', '1960', '3 mai', '12/10/2026']) expect(sent).not.toContain(leak);
    expect(sent).toContain('Carrez');
    for (const [q, name] of [
      ['Mon client M. Dupont peut-il se rétracter ?', 'Dupont'],
      ['Le vendeur DUPONT peut-il se rétracter ?', 'DUPONT'],
      ['Martin veut se rétracter du compromis.', 'Martin'],
      ['mon client jean martin peut-il se rétracter ?', 'martin'],
      ['Gérard Dumont veut savoir si le DPE est obligatoire. Mme Lefort aussi.', 'Lefort'],
    ] as const) {
      const out = scrubQuestion(q);
      expect(out).not.toContain(name);
      expect(out.toLowerCase()).not.toContain('jean');
      expect(out).not.toContain('Gérard');
    }
    expect(scrubQuestion('Mon client M. Dupont peut-il se rétracter ?')).toBe('Mon client M. … peut-il se rétracter ?');
    // Une date sans jour, un mois seul ou une année ne partent pas non plus.
    expect(scrubQuestion('Signé le 12/10, peut-il se rétracter ?')).toBe('Signé le [date], peut-il se rétracter ?');
    expect(scrubQuestion('Signé le 3.11 ou le 4-11 ?')).toBe('Signé le [date] ou le [date] ?');
    for (const q of ['Mon client a signé le compromis en janvier 2026, peut-il se rétracter ?', 'Signé en mars dernier, peut-il se rétracter ?', 'Compromis de 2025 : peut-il se rétracter ?']) {
      const out = scrubQuestion(q);
      for (const leak of ['janvier', '2026', 'mars', '2025']) expect(out).not.toContain(leak);
      expect(out).toContain('[date]');
    }
    // Un nom mis entre crochets par l'agent n'est pas une marque du filtre.
    expect(scrubQuestion('Mon client [Dupont] veut se rétracter du compromis.')).not.toContain('Dupont');
    expect(scrubQuestion('Mon client [Dupont] veut se rétracter du compromis.')).toBe('Mon client […] veut se rétracter du compromis.');
  });

  it('[R15] l’IA ne reçoit ni nom ni coordonnée, et seulement les textes retenus', async () => {
    const w = writer(() => ({ kind: 'unknown' }));
    await askLegal('M. Dupontel (06 00 00 09 09, test@exemple.fr) : délai de réflexion de l’acheteur ?', { library: LIB, writer: w, knownNames: ['Dupontel'], now });
    const sent = JSON.stringify(w.seen);
    expect(sent).not.toContain('Dupontel');
    expect(sent).not.toContain('06 00 00 09 09');
    expect(sent).not.toContain('test@exemple.fr');
    expect(w.seen[0]!.sources.map((s) => s.id)).toEqual(['loi-a-3']);
  });

  it('[R252] AU090 · un texte jamais vérifié, vérifié il y a plus d’un an ou pas relu ne fonde aucune réponse : ses références seules, avec la raison', async () => {
    const w = writer(() => ({ kind: 'answer', paragraphs: [{ text: 'Le panneau doit être retiré dans les quinze jours après la fin du mandat.', sources: ['loi-b-7'] }] }));
    const a = await askLegal('Quand retirer le panneau ?', { library: LIB, writer: w, now });
    expect(a).toMatchObject({ status: 'a_verifier', text: TO_CHECK, notice: LAWYER_NOTICE });
    expect(a.citations.map((c) => [c.id, c.warnings])).toEqual([['loi-b-7', [STALE, NOT_VALIDATED]]]);
    // Rien n'est demandé à l'IA, aucun paragraphe n'est écrit.
    expect(w.seen).toHaveLength(0);
    expect('paragraphs' in a).toBe(false);
    const never = await askLegal('Quand retirer le panneau ?', { library: [{ ...LIB[1]!, checkedOn: null }], now });
    expect(never.status === 'a_verifier' && never.citations[0]!.warnings).toEqual([UNCHECKED, NOT_VALIDATED]);
    // Vérifié et relu : la réponse revient.
    const fresh = await askLegal('Quand retirer le panneau ?', { library: [{ ...LIB[1]!, checkedOn: '2026-11-01', validatedBy: 'avocat:essai' }], now });
    expect(fresh.status === 'reponse' && fresh.citations[0]!.warnings).toEqual([]);
    // Relu mais vérifié il y a plus d'un an : à revérifier, rien n'en est tiré.
    const old = await askLegal('Quand retirer le panneau ?', { library: [{ ...LIB[1]!, checkedOn: '2025-10-01', validatedBy: 'avocat:essai' }], now });
    expect(old.status).toBe('a_verifier');
    // Une date de vérification à venir ou mal écrite ne prouve rien.
    for (const checkedOn of ['2099-01-01', '2026-12-09', 'hier']) {
      const bad = await askLegal('Quand retirer le panneau ?', { library: [{ ...LIB[1]!, checkedOn, validatedBy: 'avocat:essai' }], now });
      expect(bad.status === 'a_verifier' && bad.citations[0]!.warnings, checkedOn).toEqual([UNCHECKED]);
    }
  });

  it('[R253] une question sur un litige va toujours à l’avocat, même couverte par un texte', async () => {
    const w = writer(() => ({ kind: 'unknown' }));
    const a = await askLegal('L’acheteur menace d’aller au tribunal sur son délai de réflexion, que faire ?', { library: LIB, writer: w, now });
    expect(a).toEqual({ status: 'litige', text: DISPUTE, citations: [], notice: LAWYER_NOTICE });
    expect(w.seen).toHaveLength(0);
    for (const q of [
      'Je suis poursuivi devant les tribunaux, puis-je toucher mes honoraires avant l’acte ?',
      'Le vendeur m’a assigné : puis-je toucher mes honoraires avant l’acte ?',
      'L’acquéreur a déposé plainte, peut-il se rétracter du compromis ?',
      'Après une mise en demeure, l’acquéreur peut-il se rétracter du compromis ?',
      'Le juge peut-il annuler le compromis si l’acquéreur veut se rétracter ?',
    ]) {
      expect((await askLegal(q, { writer: w, now })).status).toBe('litige');
    }
    // Un litige dit après la limite de longueur compte aussi.
    const long = `L’acquéreur peut-il se rétracter du compromis ?${' Merci.'.repeat(400)} Il menace d’aller au tribunal.`;
    expect((await askLegal(long, { writer: w, now })).status).toBe('litige');
    // Une question trop longue n'est jamais coupée : elle est refusée entière, et l'IA n'est pas appelée.
    const outside = await askLegal(`Mon acheteur peut-il se rétracter du compromis ?${' Merci.'.repeat(400)} Il s’agit d’un local commercial.`, { writer: w, now });
    expect(outside).toEqual({ status: 'je_ne_sais_pas', text: TOO_LONG, citations: [], notice: LAWYER_NOTICE });
    expect(w.seen).toHaveLength(0);
  });

  it('[R13] le journal garde l’issue et les textes cités, jamais la question ni la réponse', async () => {
    const journal = new MemoryJournalStore();
    await askLegal('Délai de réflexion de l’acheteur ?', { library: LIB, journal, actor: 'agent:a1', now });
    await askLegal('Quel préavis pour un bail meublé ?', { library: LIB, journal, actor: 'agent:a1', now });
    const entries = await journal.all();
    expect(entries.map((e) => [e.type, (e.data as { outcome: string }).outcome, (e.data as { sources: string[] }).sources])).toEqual([
      ['juridique.question', 'textes', ['loi-a-3']],
      ['juridique.question', 'aucun_texte', []],
    ]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('réflexion');
    expect(text).not.toContain('préavis');
  });

  it('[R250] la bibliothèque de départ : chaque texte a sa référence, sa date et ses termes ; ses vraies questions trouvent leur texte', () => {
    const ids = new Set<string>();
    for (const s of DEFAULT_LEGAL_LIBRARY) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.article).toMatch(/^article /);
      expect(s.textDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.origin.length).toBeGreaterThan(0);
      expect(s.wording.length).toBeGreaterThan(0);
      expect(s.wordingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.wordingDate >= s.textDate).toBe(true);
      expect(s.match.length).toBeGreaterThan(0);
      // Pas encore relue par l'avocat (H54) : rien ne doit prétendre le contraire.
      expect(s.validatedBy).toBeNull();
    }
    const first = (q: string) => coveringSources(q)[0]?.id;
    expect(first('Combien de jours l’acquéreur a-t-il pour se rétracter après le compromis ?')).toBe('cch-l271-1');
    expect(first('Mon vendeur a signé le mandat chez lui, peut-il se rétracter ?')).toBe('conso-l221-18');
    expect(first('Puis-je toucher mes honoraires avant l’acte ?')).toBe('hoguet-6');
    expect(first('Quels diagnostics le vendeur doit-il fournir ?')).toBe('cch-l271-4');
    expect(first('La surface Carrez est fausse sur un appartement en copropriété')).toBe('copro-46');
    expect(coveringSources('Quel préavis pour un bail meublé ?')).toEqual([]);
    expect(coveringSources('Comment calculer la plus-value ?')).toEqual([]);
    // Des questions voisines que la bibliothèque ne couvre pas : je ne sais pas, jamais un texte hors sujet.
    expect(coveringSources('Quand le vendeur peut-il annuler son mandat exclusif signé en agence ?')).toEqual([]);
    expect(coveringSources('Mon acheteur veut annuler le compromis après la fin des conditions suspensives')).toEqual([]);
    expect(coveringSources('Mon acheteur veut se rétracter du compromis après la fin des conditions suspensives')).toEqual([]);
    expect(coveringSources('Le vendeur peut-il résilier son mandat exclusif signé chez lui, et se rétracter ?')).toEqual([]);
    expect(coveringSources('Quelle TVA sur mes honoraires, et quand les toucher ?')).toEqual([]);
    expect(coveringSources('Quelle est la durée de validité des diagnostics pour une location ?')).toEqual([]);
  });

  it('[R251] AU090 · la bibliothèque de départ, jamais relue par l’avocat (H54), ne donne aucune réponse ; relue, la réponse du code passe son propre contrôle', async () => {
    const q = 'Combien de jours l’acquéreur a-t-il pour se rétracter après le compromis ?';
    const before = await askLegal(q, { now });
    expect(before.status).toBe('a_verifier');
    expect(before.citations[0]!.warnings).toEqual([UNCHECKED, NOT_VALIDATED]);
    const reviewed = DEFAULT_LEGAL_LIBRARY.map((s) => ({ ...s, checkedOn: '2026-11-15', validatedBy: 'avocat:essai' }));
    const a = await askLegal(q, { library: reviewed, now });
    expect(a.status).toBe('reponse');
    if (a.status !== 'reponse') return;
    const facts: LegalFacts = {
      question: 'q',
      sources: DEFAULT_LEGAL_LIBRARY.map(asFact),
    };
    expect(checkDraft({ kind: 'answer', paragraphs: a.paragraphs }, facts).ok).toBe(true);
    expect(a.citations[0]!.warnings).toEqual([]);
    // La date citée est celle du texte qui a donné les 10 jours, pas celle de la loi SRU qui en donnait 7.
    expect(a.citations[0]).toEqual(expect.objectContaining({ id: 'cch-l271-1', wordingDate: '2015-08-06' }));
  });
});
