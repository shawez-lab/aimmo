import { describe, expect, it } from 'vitest';
import { MemoryJournalStore } from '../src/index.ts';
import {
  DEFAULT_LEGAL_LIBRARY,
  DISPUTE,
  DONT_KNOW,
  LAWYER_NOTICE,
  NOT_VALIDATED,
  STALE,
  UNCHECKED,
  askLegal,
  checkDraft,
  coveringSources,
  numbersIn,
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
    textDate: '2001-05-04',
    summary: 'Le délai de réflexion de l’acheteur est de 10 jours.',
    match: [['reflexion'], ['acheteur', 'acquereur']],
    url: 'https://www.legifrance.gouv.fr/essai',
    checkedOn: '2026-10-01',
    validatedBy: 'avocat:essai',
  },
  {
    id: 'loi-b-7',
    title: 'Loi d’essai n° 2 du 9 juin 2010',
    article: 'article 7',
    textDate: '2010-06-09',
    summary: 'Le panneau doit être retiré dans les quinze jours après la fin du mandat.',
    match: [['panneau'], ['retirer', 'retire', 'enlever']],
    url: null,
    checkedOn: '2024-01-01',
    validatedBy: null,
  },
];

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
    const facts: LegalFacts = { question: 'q', sources: [{ id: 'loi-a-3', title: LIB[0]!.title, article: 'article 3', textDate: '2001-05-04', summary: LIB[0]!.summary }] };
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

  it('[R251] les nombres d’un texte se lisent en chiffres ou en lettres', () => {
    expect([...numbersIn('10 jours, quinze jours, 10 000 €, un vingtième')].sort()).toEqual(['0.05', '10', '10000', '15'].sort());
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

  it('[R252] la réponse dit si la version citée est jamais vérifiée, trop ancienne ou pas relue par l’avocat', async () => {
    const a = await askLegal('Quand retirer le panneau ?', { library: LIB, now });
    expect(a.status === 'reponse' && a.citations[0]!.warnings).toEqual([STALE, NOT_VALIDATED]);
    const never = await askLegal('Quand retirer le panneau ?', { library: [{ ...LIB[1]!, checkedOn: null }], now });
    expect(never.status === 'reponse' && never.citations[0]!.warnings).toEqual([UNCHECKED, NOT_VALIDATED]);
  });

  it('[R253] une question sur un litige va toujours à l’avocat, même couverte par un texte', async () => {
    const w = writer(() => ({ kind: 'unknown' }));
    const a = await askLegal('L’acheteur menace d’aller au tribunal sur son délai de réflexion, que faire ?', { library: LIB, writer: w, now });
    expect(a).toEqual({ status: 'litige', text: DISPUTE, citations: [], notice: LAWYER_NOTICE });
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
  });

  it('[R251] la réponse du code sur la bibliothèque de départ passe son propre contrôle', async () => {
    const a = await askLegal('Combien de jours l’acquéreur a-t-il pour se rétracter après le compromis ?', { now });
    expect(a.status).toBe('reponse');
    if (a.status !== 'reponse') return;
    const facts: LegalFacts = {
      question: 'q',
      sources: DEFAULT_LEGAL_LIBRARY.map((s) => ({ id: s.id, title: s.title, article: s.article, textDate: s.textDate, summary: s.summary })),
    };
    expect(checkDraft({ kind: 'answer', paragraphs: a.paragraphs }, facts).ok).toBe(true);
    expect(a.citations[0]!.warnings).toEqual([UNCHECKED, NOT_VALIDATED]);
  });
});
