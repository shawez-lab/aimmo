import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  LOAN_LIMITS,
  LOAN_SIMULATOR_NOTICE,
  LOAN_SIMULATOR_SCRIPT,
  loanSimulatorHeaders,
  renderLoanSimulatorPage,
  simulateLoan,
} from '../src/attirer/simulateur-pret.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { DESIGN_CSS } from '../src/design/systeme.ts';

/**
 * Le calcul de référence, fait à part (formule d'un prêt à mensualités constantes, assurance sur le capital emprunté),
 * en décimales exactes : mensualité du crédit, assurance par mois, mensualité totale, intérêts et assurance sur la durée.
 * Tous les cas sont inventés.
 */
const REFERENCE = [
  { amountEur: 200000, years: 20, ratePct: 3.5, insurancePct: 0.3, credit: 1159.92, insurance: 50.0, total: 1209.92, interest: 78380.66, insuranceTotal: 12000.0 },
  { amountEur: 150000, years: 25, ratePct: 4.1, insurancePct: 0.36, credit: 800.06, insurance: 45.0, total: 845.06, interest: 90018.3, insuranceTotal: 13500.0 },
  { amountEur: 320000, years: 15, ratePct: 3.2, insurancePct: 0.25, credit: 2240.77, insurance: 66.67, total: 2307.44, interest: 83338.93, insuranceTotal: 12000.0 },
  { amountEur: 85000, years: 10, ratePct: 2.9, insurancePct: 0, credit: 816.85, insurance: 0, total: 816.85, interest: 13021.83, insuranceTotal: 0 },
  { amountEur: 1000, years: 1, ratePct: 5, insurancePct: 0.5, credit: 85.61, insurance: 0.42, total: 86.02, interest: 27.29, insuranceTotal: 5.0 },
  { amountEur: 450000, years: 25, ratePct: 3.75, insurancePct: 0.34, credit: 2313.59, insurance: 127.5, total: 2441.09, interest: 244077.12, insuranceTotal: 38250.0 },
  { amountEur: 250000, years: 20, ratePct: 0, insurancePct: 0.3, credit: 1041.67, insurance: 62.5, total: 1104.17, interest: 0, insuranceTotal: 15000.0 },
  { amountEur: 120000, years: 7, ratePct: 4.95, insurancePct: 0.4, credit: 1693.25, insurance: 40.0, total: 1733.25, interest: 22233.1, insuranceTotal: 3360.0 },
  { amountEur: 600000, years: 30, ratePct: 3.9, insurancePct: 0.2, credit: 2830.01, insurance: 100.0, total: 2930.01, interest: 418803.32, insuranceTotal: 36000.0 },
  { amountEur: 178500, years: 22, ratePct: 3.45, insurancePct: 0.28, credit: 965.81, insurance: 41.65, total: 1007.46, interest: 76473.31, insuranceTotal: 10995.6 },
] as const;

const HTML = renderLoanSimulatorPage();
const SOURCE = readFileSync(join(__dirname, '..', 'src', 'attirer', 'simulateur-pret.ts'), 'utf8');

/** Un petit document inventé : les éléments de la page par leur identifiant, et ce que le script y écrit. */
class El {
  value = '';
  textContent = '';
  hidden = false;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: { preventDefault(): void }) => void)[]> = {};
  constructor(readonly id: string) {}
  setAttribute(n: string, v: string): void {
    this.attrs[n] = String(v);
  }
  removeAttribute(n: string): void {
    delete this.attrs[n];
  }
  addEventListener(n: string, f: (e: { preventDefault(): void }) => void): void {
    (this.listeners[n] ??= []).push(f);
  }
  fire(n: string): { prevented: boolean } {
    const r = { prevented: false };
    for (const f of this.listeners[n] ?? []) f({ preventDefault: () => (r.prevented = true) });
    return r;
  }
}

function runScript(): { els: Record<string, El>; touched: string[] } {
  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const els: Record<string, El> = {};
  for (const id of ids) els[id] = new El(id);
  // Les valeurs de départ de la page, telles que le navigateur les montre.
  for (const m of HTML.matchAll(/<input\b[^>]*\sid="([^"]+)"[^>]*\svalue="([^"]*)"/g)) els[m[1]!]!.value = m[2]!;
  const touched: string[] = [];
  const document = {
    getElementById: (id: string) => {
      touched.push(id);
      return els[id] ?? null;
    },
  };
  // Le script ne reçoit que le document : toute autre porte de sortie (réseau, stockage, cookie) n'existe pas ici.
  runInNewContext(LOAN_SIMULATOR_SCRIPT, { document });
  return { els, touched };
}

const set = (els: Record<string, El>, v: { montant: string; duree: string; taux: string; assurance: string }) => {
  for (const [k, val] of Object.entries(v)) {
    els[k]!.value = val;
  }
  els.montant!.fire('input');
};
const amount = (text: string): number => Number(text.replace(/[\s  €]/g, '').replace(',', '.'));

describe('AT08 · simulateur de prêt, sans rien garder', () => {
  it('mensualités égales au calcul de référence à l’euro près, sur 10 cas inventés (calcul du code)', () => {
    for (const c of REFERENCE) {
      const r = simulateLoan(c);
      expect(r.ok, JSON.stringify(c)).toBe(true);
      if (!r.ok) continue;
      expect(r.months).toBe(c.years * 12);
      expect(Math.abs(r.creditMonthlyEur - c.credit)).toBeLessThan(0.01);
      expect(Math.abs(r.insuranceMonthlyEur - c.insurance)).toBeLessThan(0.01);
      expect(Math.abs(r.totalMonthlyEur - c.total)).toBeLessThan(0.01);
      expect(Math.abs(r.totalInterestEur - c.interest)).toBeLessThan(1);
      expect(Math.abs(r.totalInsuranceEur - c.insuranceTotal)).toBeLessThan(1);
      expect(Math.abs(r.totalCostEur - (c.interest + c.insuranceTotal))).toBeLessThan(1);
    }
  });

  it('mensualités égales au calcul de référence à l’euro près, sur 10 cas inventés (calcul de la page, dans le navigateur)', () => {
    const { els } = runScript();
    for (const c of REFERENCE) {
      set(els, { montant: String(c.amountEur), duree: String(c.years), taux: String(c.ratePct).replace('.', ','), assurance: String(c.insurancePct).replace('.', ',') });
      expect(els.erreur!.textContent, JSON.stringify(c)).toBe('');
      expect(Math.abs(amount(els['r-total']!.textContent) - c.total)).toBeLessThan(0.01);
      expect(Math.abs(amount(els['r-credit']!.textContent) - c.credit)).toBeLessThan(0.01);
      expect(Math.abs(amount(els['r-assurance']!.textContent) - c.insurance)).toBeLessThan(0.01);
      expect(Math.abs(amount(els['r-interets']!.textContent) - c.interest)).toBeLessThan(1);
      expect(Math.abs(amount(els['r-cout']!.textContent) - (c.interest + c.insuranceTotal))).toBeLessThan(1);
    }
  });

  it('le calcul de la page et celui du code donnent le même résultat, y compris l’effet de 0,1 point de taux', () => {
    const { els } = runScript();
    for (const c of REFERENCE) {
      set(els, { montant: String(c.amountEur), duree: String(c.years), taux: String(c.ratePct), assurance: String(c.insurancePct) });
      const r = simulateLoan(c);
      if (!r.ok) throw new Error('cas refusé');
      expect(amount(els['r-sensibilite']!.textContent)).toBeCloseTo(r.plusTenthMonthlyEur, 2);
      expect(r.plusTenthMonthlyEur).toBeGreaterThan(0);
    }
  });

  it('un taux presque nul donne la mensualité sans intérêt, sans perte de précision, dans le code comme dans la page', () => {
    const { els } = runScript();
    for (const rate of [1e-12, 1e-13, 1e-9, 0.0001]) {
      const r = simulateLoan({ amountEur: 200000, years: 20, ratePct: rate, insurancePct: 0 });
      if (!r.ok) throw new Error('refusé');
      expect(Math.abs(r.creditMonthlyEur - 833.33), String(rate)).toBeLessThan(0.01);
      expect(r.totalInterestEur, String(rate)).toBeGreaterThanOrEqual(0);
      expect(r.totalInterestEur, String(rate)).toBeLessThan(3);
      set(els, { montant: '200000', duree: '20', taux: rate.toFixed(15), assurance: '0' });
      expect(Math.abs(amount(els['r-credit']!.textContent) - 833.33), String(rate)).toBeLessThan(0.01);
    }
  });

  it('la page montre d’emblée l’exemple calculé par le code, même sans script', () => {
    const r = simulateLoan({ amountEur: 200000, years: 20, ratePct: 3.5, insurancePct: 0.3 });
    if (!r.ok) throw new Error('exemple refusé');
    expect(HTML).toContain('1 209,92 €');
    expect(HTML).toContain('<output id="r-total"');
  });

  it('une saisie hors des bornes ou illisible ne donne aucun chiffre, et dit pourquoi', () => {
    const bad = [
      { amountEur: LOAN_LIMITS.amountEur.min - 1, years: 20, ratePct: 3, insurancePct: 0.3, field: 'amountEur' },
      { amountEur: LOAN_LIMITS.amountEur.max + 1, years: 20, ratePct: 3, insurancePct: 0.3, field: 'amountEur' },
      { amountEur: 200000, years: 0, ratePct: 3, insurancePct: 0.3, field: 'years' },
      { amountEur: 200000, years: 12.5, ratePct: 3, insurancePct: 0.3, field: 'years' },
      { amountEur: 200000, years: LOAN_LIMITS.years.max + 1, ratePct: 3, insurancePct: 0.3, field: 'years' },
      { amountEur: 200000, years: 20, ratePct: -1, insurancePct: 0.3, field: 'ratePct' },
      { amountEur: 200000, years: 20, ratePct: LOAN_LIMITS.ratePct.max + 0.1, insurancePct: 0.3, field: 'ratePct' },
      { amountEur: 200000, years: 20, ratePct: 3, insurancePct: LOAN_LIMITS.insurancePct.max + 0.1, field: 'insurancePct' },
      { amountEur: Number.NaN, years: 20, ratePct: 3, insurancePct: 0.3, field: 'amountEur' },
      { amountEur: 200000, years: 20, ratePct: Number.POSITIVE_INFINITY, insurancePct: 0.3, field: 'ratePct' },
    ] as const;
    for (const b of bad) {
      const r = simulateLoan(b);
      expect(r.ok, JSON.stringify(b)).toBe(false);
      if (!r.ok) expect(r.field).toBe(b.field);
    }
    const { els } = runScript();
    for (const [field, v] of [
      ['montant', { montant: '500', duree: '20', taux: '3', assurance: '0,3' }],
      ['duree', { montant: '200000', duree: '12,5', taux: '3', assurance: '0,3' }],
      ['taux', { montant: '200000', duree: '20', taux: 'trois', assurance: '0,3' }],
      ['assurance', { montant: '200000', duree: '20', taux: '3', assurance: '-1' }],
    ] as const) {
      set(els, v);
      expect(els.erreur!.textContent, field).not.toBe('');
      expect(els[field]!.attrs['aria-invalid'], field).toBe('true');
      for (const out of ['r-total', 'r-credit', 'r-assurance', 'r-interets', 'r-cout', 'r-sensibilite']) expect(els[out]!.textContent, out).toBe('—');
      // Corrigé : l'erreur s'efface, le champ redevient valide.
      set(els, { montant: '200 000', duree: '20', taux: '3,5', assurance: '0,3' });
      expect(els.erreur!.textContent).toBe('');
      expect(els[field]!.attrs['aria-invalid']).toBeUndefined();
    }
  });

  it('[R157] la mention « simulation indicative, ce n’est pas une offre de prêt » est toujours visible', () => {
    expect(LOAN_SIMULATOR_NOTICE).toBe('Simulation indicative : ce n’est pas une offre de prêt.');
    expect(HTML).toContain(LOAN_SIMULATOR_NOTICE);
    // Dans le texte même de la page, hors de tout élément caché, et le script n'y touche jamais.
    const notice = new RegExp(`<p class="avertissement">${LOAN_SIMULATOR_NOTICE}</p>`);
    expect(HTML).toMatch(notice);
    expect(HTML.match(/<p class="avertissement">[^<]*<\/p>/g)).toHaveLength(1);
    expect(/class="avertissement"[^>]*\sid=/.test(HTML)).toBe(false);
    expect(/\shidden\b/.test(HTML)).toBe(false);
    const { els } = runScript();
    set(els, { montant: '500', duree: '20', taux: '3', assurance: '0,3' });
    expect(Object.values(els).some((e) => e.textContent.includes('offre de prêt'))).toBe(false);
  });

  it('[R157] aucune saisie rangée, envoyée ni écrite au journal : ni nom de champ, ni envoi de formulaire, ni réseau, ni stockage', () => {
    // Les champs n'ont pas de nom : un formulaire envoyé malgré tout ne transmettrait rien.
    for (const m of HTML.matchAll(/<input\b[^>]*>/g)) expect(m[0]).not.toMatch(/\sname=/);
    expect(HTML).not.toMatch(/<form\b[^>]*\s(?:action|method)=/);
    // Le script n'a aucune porte de sortie.
    for (const api of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'location', 'history', 'navigator', 'Image', 'src', 'href', 'postMessage', 'import', 'eval', 'Function', 'innerHTML', 'window', 'globalThis']) {
      expect(new RegExp(`\\b${api}\\b`).test(LOAN_SIMULATOR_SCRIPT), api).toBe(false);
    }
    // L'envoi du formulaire est arrêté par le script.
    const { els, touched } = runScript();
    expect(els.sim!.fire('submit').prevented).toBe(true);
    // Il ne lit et n'écrit que les éléments de la page elle-même.
    for (const id of touched) expect(els[id], id).toBeDefined();
    // Le module ne connaît ni la base, ni le journal, ni l'envoi ; la page ne dépend d'aucune saisie.
    expect(SOURCE).not.toMatch(/from '\.\.\/(?:db|journal|envoi|fiche|captation)\//);
    expect(renderLoanSimulatorPage.length).toBe(0);
  });

  it('[R157] les en-têtes interdisent au navigateur toute connexion et tout envoi de formulaire depuis la page', async () => {
    const h = await loanSimulatorHeaders();
    const csp = h['content-security-policy'];
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "img-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    // Seuls le script et la feuille de la page sont permis, par leur empreinte.
    const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)![1]!;
    const style = /<style>([\s\S]*?)<\/style>/.exec(HTML)![1]!;
    const sha = (t: string) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`;
    expect(csp).toContain(`script-src ${sha(script)}`);
    expect(csp).toContain(`style-src ${sha(style)}`);
    expect(script).toBe(LOAN_SIMULATOR_SCRIPT);
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['content-type']).toBe('text/html; charset=utf-8');
    expect(h['cache-control']).toMatch(/^public, max-age=\d+$/);
  });

  it('[R14] aucun avis de solvabilité : ni revenu demandé, ni capacité, ni endettement, ni accord', () => {
    const text = HTML.replace(/<script>[\s\S]*?<\/script>/, '').toLowerCase();
    for (const word of ['revenu', 'salaire', 'capacité', 'endettement', 'solvab', 'éligible', 'accord', 'finançable', 'feu vert', 'emprunter jusqu']) {
      expect(text.includes(word), word).toBe(false);
      expect(LOAN_SIMULATOR_SCRIPT.toLowerCase().includes(word), word).toBe(false);
    }
    expect([...HTML.matchAll(/<input\b/g)]).toHaveLength(4);
  });

  it('[R07] vocabulaire : « agent immobilier », jamais « mandataire » ni « gratuit », aucune mention de l’IA', () => {
    const text = HTML.toLowerCase();
    expect(text).toContain('agent immobilier');
    for (const w of ['mandataire', 'gratuit', ' ia ', 'intelligence artificielle']) expect(text.includes(w), w).toBe(false);
  });

  it('[R201] la page passe le contrôle du système de design, d’accessibilité, et tient dans 14 Ko compressés', () => {
    expect(htmlProblems(HTML)).toEqual([]);
    expect(budgetProblems({ html: HTML }, BUDGETS.page)).toEqual([]);
    const style = /<style>([\s\S]*?)<\/style>/.exec(HTML)![1]!;
    expect(style.startsWith(DESIGN_CSS)).toBe(true);
    expect(HTML).toMatch(/class="marque"/);
    // Les résultats sont annoncés aux lecteurs d'écran quand ils changent.
    expect(HTML).toMatch(/aria-live="polite"/);
    // Les champs de nombres ouvrent le clavier numérique du téléphone.
    for (const m of HTML.matchAll(/<input\b[^>]*>/g)) expect(m[0]).toMatch(/inputmode="(?:decimal|numeric)"/);
  });
});
