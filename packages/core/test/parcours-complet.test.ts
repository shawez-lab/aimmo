import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyChain } from '../src/index.ts';
import { BUYER_EMAIL, BUYER_LAST_NAME, JOURNEY, SELLER_EMAIL, SELLER_LAST_NAME, journeyWorld, must, runJourney, type JourneyStep } from './parcours-complet.ts';
import { describeWithSqlite } from './sqlite.ts';

const ALL = JOURNEY.map((s) => s.id);
const FIRST = 'premier_message';
const LAST = 'apres_vente';

/** Une table par étape : une panne de cette table doit nommer cette étape. */
const BROKEN_TABLE: Record<string, string> = {
  premier_message: 'messages',
  qualification: 'callback_tasks',
  rendez_vous: 'appointments',
  estimation: 'valuation_reports',
  mandat: 'mandates',
  annonce: 'listing_drafts',
  acquereur: 'qualifications',
  visite: 'visit_slips',
  offre: 'offer_register',
  compromis_acte: 'sale_files',
  apres_vente: 'owner_booklets',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describeWithSqlite('SV04 · le parcours complet fictif, du premier message à l’après-vente', () => {
  it('toutes les étapes passent, chacune vérifiée par ses données et son journal, et la chaîne du journal tient', async () => {
    const w = await journeyWorld();
    const result = await runJourney(w, JOURNEY);
    // En cas de panne, le message de ce test nomme l'étape et sa raison.
    expect(result).toEqual({ ok: true, done: ALL });
    expect(ALL[0]).toBe(FIRST);
    expect(ALL.at(-1)).toBe(LAST);
    expect(JOURNEY.every((s) => s.events.length > 0)).toBe(true);
    expect((await verifyChain(await w.readEntries())).ok).toBe(true);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Parcours complet fictif\n\n${JOURNEY.map((s) => `- ${s.label} : passé`).join('\n')}\n`);
    }
  });

  it('[R26] aucun envoi réel : un vrai canal branché n’est jamais appelé, tout reste dans la boîte d’essai, aucun appel réseau', async () => {
    const network = vi.fn(async () => {
      throw new Error('appel réseau pendant le parcours');
    });
    vi.stubGlobal('fetch', network);
    const w = await journeyWorld();
    expect((await runJourney(w, JOURNEY)).ok).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(w.trap.length).toBeGreaterThan(0);
    expect(w.trap.map((c) => c.calls)).toEqual(w.trap.map(() => 0));
    // Le parcours a bien fait partir des messages : deux réponses et deux demandes d'avis, tous en essai.
    const out = await w.db.all<{ id: string; held: string | null }>("SELECT m.id, o.message_id AS held FROM messages m LEFT JOIN trial_outbox o ON o.message_id = m.id WHERE m.direction = 'out'");
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.filter((m) => m.held === null)).toEqual([]);
  });

  it('[R13] rien de personnel au journal : ni mail, ni nom de famille, tout au long du parcours', async () => {
    const w = await journeyWorld();
    expect((await runJourney(w, JOURNEY)).ok).toBe(true);
    const text = JSON.stringify(await w.readEntries());
    for (const secret of [SELLER_EMAIL, BUYER_EMAIL, SELLER_LAST_NAME, BUYER_LAST_NAME]) expect(text).not.toContain(secret);
  });

  it('le parcours ne dépend pas de la date du jour : il tient encore dans plusieurs années', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2033-08-14T03:00:00.000Z') });
    const w = await journeyWorld();
    expect(await runJourney(w, JOURNEY)).toEqual({ ok: true, done: ALL });
  });

  describe('une étape cassée se nomme', () => {
    it.each(ALL)('une panne de ses données : %s', async (id) => {
      const w = await journeyWorld();
      const result = await runJourney(w, JOURNEY, {
        beforeStep: async (step) => {
          if (step !== id) return;
          const table = BROKEN_TABLE[id]!;
          for (const op of ['INSERT', 'UPDATE']) await w.db.run(`CREATE TRIGGER parcours_panne_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'panne de ${table}'); END`);
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const at = ALL.indexOf(id);
      expect(result.failed.step).toBe(id);
      expect(result.failed.label).toBe(JOURNEY[at]!.label);
      expect(result.done).toEqual(ALL.slice(0, at));
      expect(result.notRun).toEqual(ALL.slice(at + 1));
    });

    it.each(ALL)('un événement absent du journal, alors que l’étape dit avoir réussi : %s', async (id) => {
      const w = await journeyWorld();
      const step = JOURNEY.find((s) => s.id === id)!;
      const event = step.events.at(-1)!;
      const result = await runJourney(w, JOURNEY, {
        beforeStep: async (current) => {
          if (current === id) await w.db.run(`CREATE TRIGGER parcours_oubli BEFORE INSERT ON journal WHEN NEW.type = '${event}' BEGIN SELECT RAISE(IGNORE); END`);
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failed.step).toBe(id);
    });

    it('la vérification d’une étape qui réussit sans ranger ce qu’il faut la nomme, et ne laisse pas jouer la suite', async () => {
      const steps: JourneyStep<{ readEntries(): Promise<readonly never[]> }>[] = [
        { id: 'a', label: 'A', events: [], run: async () => {} },
        { id: 'b', label: 'B', events: [], run: async () => must(false, 'rien de rangé') },
        { id: 'c', label: 'C', events: [], run: vi.fn(async () => {}) },
      ];
      const result = await runJourney({ readEntries: async () => [] }, steps);
      expect(result).toEqual({ ok: false, done: ['a'], failed: { step: 'b', label: 'B', reason: 'rien de rangé' }, notRun: ['c'] });
      expect(steps[2]!.run).not.toHaveBeenCalled();
    });

    it('un journal sans l’événement attendu nomme l’événement', async () => {
      const result = await runJourney({ readEntries: async () => [] }, [{ id: 'a', label: 'A', events: ['x.y'], run: async () => {} }]);
      expect(result).toEqual({ ok: false, done: [], failed: { step: 'a', label: 'A', reason: 'journal sans x.y' }, notRun: [] });
    });
  });
});

describe('SV04 · il tourne aussi chaque mois', () => {
  const FILE = '.github/workflows/parcours-du-mois.yml';

  it('un travail mensuel joue ce parcours, sans secret ni accès à la base', () => {
    expect(existsSync(FILE)).toBe(true);
    const yml = readFileSync(FILE, 'utf8');
    expect(yml).toMatch(/schedule:\n\s+- cron: '\d+ \d+ \d+ \* \*'/);
    expect(yml).toContain('workflow_dispatch');
    expect(yml).toContain('node-version-file: .nvmrc');
    expect(yml).toContain('npx vitest run packages/core/test/parcours-complet.test.ts');
    expect(existsSync('packages/core/test/parcours-complet.test.ts')).toBe(true);
    expect(yml).toMatch(/permissions:\n\s+contents: read/);
    expect(yml).not.toMatch(/secrets\.|wrangler|CLOUDFLARE/);
  });
});
