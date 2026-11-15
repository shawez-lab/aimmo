import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { GEL_REGISTRE_LOST, GEL_REGISTRE_REFUSALS, GEL_REGISTRE_SCRIPT } from '../app/gel-registre.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement } from './fake-dom.ts';

// BR85. Tout est inventé : réponses, fichier, identifiants d'entrée.
const DGT = '/v1/securite/gel/registre/dgtresor';
const FILE = '/v1/securite/gel/registre/fichier';
const INJECTED = '<img src=x onerror="alert(1)">';
type Res = { ok?: boolean; status?: number; body?: unknown; offline?: boolean; gone?: boolean };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const IMPORTED: Res = { ok: true, status: 200, body: { ok: true, data: { versionId: 'v1', entries: 3, sha256: 'a'.repeat(64), checked: 12, publishedAt: '2027-03-01T09:00:00.000Z', vessels: 1 } } };

function mount(answer: (path: string, body: unknown) => Promise<Res>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let session = 1;
  const el = (tag: string, text?: unknown, cls?: string) => {
    const e = new FakeElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const clear = (e: FakeElement) => { e.textContent = ''; };
  const button = (label: string, f: () => void) => { const b = el('button', label); b.addEventListener('click', f); return b; };
  const field = (box: FakeElement, id: string, label: string) => {
    const l = el('label', label); l.setAttribute('for', id); box.appendChild(l);
    const f = el('input'); f.setAttribute('id', id); box.appendChild(f); return f;
  };
  const send = (path: string, method: string, body?: unknown) => { calls.push({ path, method, body }); return answer(path, body); };
  const context: Record<string, unknown> = { Date, JSON, Object, String, isNaN };
  context.globalThis = context;
  runInNewContext(GEL_REGISTRE_SCRIPT, context);
  const make = context.AIMMO_GEL_REGISTRE as (t: unknown) => { show: (inner: FakeElement) => void };
  const screen = make({ el, clear, send, button, field, session: () => session });
  const inner = new FakeElement('div');
  screen.show(inner);
  const byText = (text: string) => inner.all().find((e) => e.tagName === 'button' && e.textContent === text)!;
  const press = async (text: string) => { byText(text).listeners.click!({}); await settle(); };
  const status = () => inner.all().find((e) => e.attributes.role === 'status')!.textContent;
  const pick = () => inner.all().find((e) => e.attributes.id === 'gel-registre-fichier') as FakeElement & { files?: unknown[] };
  return { calls, inner, press, status, pick, byText, leave: () => (session += 1), screen };
}

describe('BR85 · écran d’import du registre des gels', () => {
  it('en un appui : téléchargé, importé, et l’écran dit la date, les personnes, les navires et les dossiers recontrôlés (Jamais vu)', async () => {
    const t = mount(async () => IMPORTED);
    await t.press('Importer le registre du jour');
    expect(t.calls).toEqual([{ path: DGT, method: 'POST', body: undefined }]);
    expect(t.status()).toBe('Registre importé.');
    expect(t.inner.textContent).toContain('Registre publié le 1 mars 2027 : 3 personnes ou sociétés lues, 1 navire laissé à part.');
    expect(t.inner.textContent).toContain('12 dossiers en cours recontrôlés contre ce registre.');
  });

  it('[R13] chaque refus dit en mots, l’entrée en cause par son identifiant, jamais un code ni un texte reçu tel quel', async () => {
    for (const [code, entryId] of [['unknown_nature', '9105'], ['duplicate_entry', INJECTED], ['telechargement_echoue', null], ['already_imported', null], ['older_version', null], ['role', null]] as const) {
      const t = mount(async () => ({ ok: false, status: 400, body: { ok: false, code, entryId } }));
      await t.press('Importer le registre du jour');
      const said = t.status();
      expect(said.startsWith(GEL_REGISTRE_REFUSALS[code])).toBe(true);
      expect(said).not.toContain(code);
      if (entryId === '9105') expect(said).toContain('Entrée en cause : 9105.');
      expect(said).not.toContain(INJECTED);
    }
    const t = mount(async () => ({ ok: false, status: 500, body: { ok: false, code: 'inconnu_du_code' } }));
    await t.press('Importer le registre du jour');
    expect(t.status()).toBe('L’import n’a pas abouti : rien n’est importé. Réessayez dans un moment.');
  });

  it('réponse perdue dite incertaine ; deux appuis ne lancent qu’un import ; une réponse arrivée après la sortie est jetée', async () => {
    let release: (r: Res) => void = () => undefined;
    const t = mount(() => new Promise<Res>((r) => (release = r)));
    t.byText('Importer le registre du jour').listeners.click!({});
    t.byText('Importer le registre du jour').listeners.click!({});
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.status()).toBe('Téléchargement et lecture du registre…');
    release({ offline: true });
    await settle();
    expect(t.status()).toBe(GEL_REGISTRE_LOST);
    t.byText('Importer le registre du jour').listeners.click!({});
    t.leave();
    release(IMPORTED);
    await settle();
    expect(t.inner.textContent).not.toContain('Registre importé');
  });

  it('le fichier déposé : lu sur l’appareil, envoyé tel quel ; trop gros ou illisible arrêté avant l’envoi', async () => {
    const t = mount(async () => IMPORTED);
    await t.press('Importer ce fichier');
    expect(t.status()).toBe('Choisissez le fichier JSON publié par la DG Trésor.');
    t.pick().files = [{ size: 40_000_001, text: async () => '{}' }];
    await t.press('Importer ce fichier');
    expect(t.status()).toBe(GEL_REGISTRE_REFUSALS.fichier_trop_gros);
    t.pick().files = [{ size: 20, text: async () => '{pas du json' }];
    await t.press('Importer ce fichier');
    expect(t.status()).toBe(GEL_REGISTRE_REFUSALS.bad_file);
    expect(t.calls).toHaveLength(0);
    const file = { Publications: { DatePublication: '2027-03-01T10:00:00', PublicationDetail: [] } };
    t.pick().files = [{ size: 100, text: async () => '﻿' + JSON.stringify(file) }];
    await t.press('Importer ce fichier');
    expect(t.calls).toEqual([{ path: FILE, method: 'POST', body: file }]);
    expect(t.status()).toBe('Registre importé.');
    expect(t.pick().attributes.type).toBe('file');
  });

  it('[R201] servi à part, chargé depuis l’écran du responsable, deux routes seules, sans innerHTML, budget tenu', () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/gel-registre.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('AIMMO_GEL_REGISTRE');
    expect(CONFORMITE_SCRIPT).toContain("'/app/gel-registre.js'");
    const routes = [...GEL_REGISTRE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(new Set(routes)).toEqual(new Set([DGT, FILE]));
    expect(GEL_REGISTRE_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write/);
    expect(budgetProblems({ html: '', js: GEL_REGISTRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: CONFORMITE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});
