import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { GEL_REGISTRE_FAILED, GEL_REGISTRE_LOST, GEL_REGISTRE_NONE, GEL_REGISTRE_REFUSALS, GEL_REGISTRE_SCRIPT, GEL_REGISTRE_STALE, GEL_REGISTRE_STATE_LOST, GEL_REGISTRE_STATE_ROLE } from '../app/gel-registre.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement } from './fake-dom.ts';

// BR85. Tout est inventé : réponses, fichier, identifiants d'entrée.
const DGT = '/v1/securite/gel/registre/dgtresor';
const FILE = '/v1/securite/gel/registre/fichier';
const STATE = '/v1/securite/gel/registre';
const INJECTED = '<img src=x onerror="alert(1)">';
type Res = { ok?: boolean; status?: number; body?: unknown; offline?: boolean; gone?: boolean };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const IMPORTED: Res = { ok: true, status: 200, body: { ok: true, data: { versionId: 'v1', entries: 3, sha256: 'a'.repeat(64), checked: 12, publishedAt: '2027-03-01T09:00:00.000Z', vessels: 1 } } };

// BR86 : le registre en service, tel que la route le rend. Empreinte inventée.
const SHA = '0123456789abcdef'.repeat(4);
const IN_SERVICE = { versionId: 'v1', publishedAt: '2027-03-01T09:00:00.000Z', importedAt: '2027-03-02T10:00:00.000Z', entries: 3, sha256: SHA, checkedCases: 12, ageDays: 8, stale: true };
const stateOk = (data: unknown): Res => ({ ok: true, status: 200, body: { ok: true, data } });

function mount(answer: (path: string, body: unknown) => Promise<Res>, state: () => Promise<Res> = async () => stateOk(null)) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const reads: number[] = [];
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
  const send = (path: string, method: string, body?: unknown) => {
    if (method === 'GET' && path === STATE && body === undefined) { reads.push(reads.length + 1); return state(); }
    calls.push({ path, method, body });
    return answer(path, body);
  };
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
  const current = () => inner.all().find((e) => e.className === 'registre-en-service')!.textContent;
  return { calls, reads, inner, press, status, pick, byText, current, leave: () => (session += 1), screen };
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
    // Une panne du serveur ou une réponse illisible : l'import a pu se faire, jamais « rien n'est importé ».
    for (const res of [{ ok: false, status: 500, body: { ok: false, code: 'inconnu_du_code' } }, { ok: false, status: 502, body: null }]) {
      const t = mount(async () => res);
      await t.press('Importer le registre du jour');
      expect(t.status()).toBe(GEL_REGISTRE_FAILED);
      expect(t.status()).not.toMatch(/rien n’est importé/);
    }
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
    expect(new Set(routes)).toEqual(new Set([DGT, FILE, STATE]));
    expect(GEL_REGISTRE_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write/);
    expect(budgetProblems({ html: '', js: GEL_REGISTRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: CONFORMITE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});

describe('BR86 · le registre en service, dit à l’ouverture du bloc', () => {
  it('à l’ouverture : date publiée et d’import, entrées, dossiers contrôlés, âge, « à mettre à jour » et empreinte en groupes (Jamais vu)', async () => {
    const t = mount(async () => IMPORTED, async () => stateOk(IN_SERVICE));
    await settle();
    expect(t.reads).toHaveLength(1);
    expect(t.calls).toHaveLength(0);
    const said = t.current();
    expect(said).toContain('Registre en service : publié le 1 mars 2027, importé le 2 mars 2027. 3 personnes ou sociétés, 12 dossiers contrôlés contre lui.');
    expect(said).toContain('Publié il y a 8 jours. ' + GEL_REGISTRE_STALE);
    expect(said).toContain('Empreinte SHA-256 : 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef');
    // L'alerte est dite en mots, jamais par une couleur seule.
    const fresh = mount(async () => IMPORTED, async () => stateOk({ ...IN_SERVICE, ageDays: 1, stale: false }));
    await settle();
    expect(fresh.current()).toContain('Publié hier.');
    expect(fresh.current()).not.toContain(GEL_REGISTRE_STALE);
    const today = mount(async () => IMPORTED, async () => stateOk({ ...IN_SERVICE, ageDays: 0, stale: false, entries: 1, checkedCases: 0 }));
    await settle();
    expect(today.current()).toContain('1 personne ou société, 0 dossier contrôlé contre lui.');
    expect(today.current()).toContain('Publié aujourd’hui.');
  });

  it('aucun registre : aucun contrôle possible ; refus, réponse perdue ou illisible dits en mots, jamais un code ni un texte reçu', async () => {
    const none = mount(async () => IMPORTED);
    await settle();
    expect(none.current()).toBe(GEL_REGISTRE_NONE);
    const cases: [Res, string][] = [
      [{ ok: false, status: 403, body: { ok: false, rule: 'R16', code: 'role' } }, GEL_REGISTRE_STATE_ROLE],
      [{ offline: true }, GEL_REGISTRE_STATE_LOST],
      [{ ok: false, status: 500, body: null }, GEL_REGISTRE_STATE_LOST],
      [stateOk({ ...IN_SERVICE, sha256: INJECTED }), GEL_REGISTRE_STATE_LOST],
      [stateOk({ ...IN_SERVICE, entries: -1 }), GEL_REGISTRE_STATE_LOST],
      [stateOk({ ...IN_SERVICE, publishedAt: INJECTED }), GEL_REGISTRE_STATE_LOST],
      [stateOk({ ...IN_SERVICE, stale: 'oui' }), GEL_REGISTRE_STATE_LOST],
    ];
    for (const [res, text] of cases) {
      const t = mount(async () => IMPORTED, async () => res);
      await settle();
      expect(t.current()).toBe(text);
      expect(t.current()).not.toContain(INJECTED);
      expect(t.current()).not.toContain('role');
    }
  });

  it('relu après chaque import ; une lecture dépassée ou arrivée après la sortie est jetée', async () => {
    const pending: ((r: Res) => void)[] = [];
    const t = mount(async () => IMPORTED, () => new Promise<Res>((r) => pending.push(r)));
    await t.press('Importer le registre du jour');
    expect(t.reads).toHaveLength(2);
    // La seconde lecture répond d'abord ; la première, dépassée, est jetée.
    pending[1]!(stateOk({ ...IN_SERVICE, ageDays: 0, stale: false }));
    await settle();
    pending[0]!(stateOk(null));
    await settle();
    expect(t.current()).toContain('Publié aujourd’hui.');
    expect(t.current()).not.toContain(GEL_REGISTRE_NONE);
    // Une réponse perdue, un « déjà importé » ou une panne : l'import a pu se faire, le registre en service est relu.
    for (const res of [{ offline: true }, { ok: false, status: 400, body: { ok: false, code: 'already_imported' } }, { ok: false, status: 500, body: null }] as Res[]) {
      const u = mount(async () => res, async () => stateOk(IN_SERVICE));
      await settle();
      await u.press('Importer le registre du jour');
      expect(u.reads).toHaveLength(2);
      expect(u.current()).toContain('Registre en service : publié le 1 mars 2027');
    }
    // Sortie de l'écran : la lecture qui arrive ensuite ne change rien.
    t.screen.show(t.inner);
    expect(t.reads).toHaveLength(3);
    t.leave();
    pending[2]!(stateOk(IN_SERVICE));
    await settle();
    expect(t.current()).toBe('Lecture du registre en service…');
  });
});
