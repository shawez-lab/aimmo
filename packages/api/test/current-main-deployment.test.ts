import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error script du dépôt, sans déclaration de types
import { requireCurrentMain } from '../../../scripts/require-current-main.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const environment = {
  GITHUB_REPOSITORY: 'example/aimmo',
  GITHUB_SHA: sha,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_TOKEN: 'test-only',
};
const event = { repository: { full_name: 'example/aimmo' }, ref: 'refs/heads/main', after: sha };
const response = (status: number, body: unknown) => ({
  ok: status === 200, status, json: async () => body,
});
const setup = () => {
  const request = vi.fn(async () => response(200, { object: { sha } }));
  return { environment: { ...environment }, event: structuredClone(event), checkoutSha: sha, request };
};

describe('CI · seul le commit actuel et vérifié de main peut être déployé', () => {
  it('accepte le SHA exact du push main et un checkout identique', async () => {
    const input = setup();
    await expect(requireCurrentMain(input)).resolves.toBe(sha);
    expect(input.request).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/aimmo/git/ref/heads/main',
      expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer test-only' }) }),
    );
  });

  it('accepte un lancement manuel sur le commit actuel de main', async () => {
    const input = setup();
    input.environment.GITHUB_EVENT_NAME = 'workflow_dispatch';
    await expect(requireCurrentMain({ ...input, event: { repository: event.repository, ref: 'main' } })).resolves.toBe(sha);
  });

  it.each(['pull_request', 'pull_request_target', 'workflow_run', 'workflow_call', 'schedule'])(
    'refuse le type d’événement %s avant tout appel réseau', async (eventName) => {
      const input = setup();
      input.environment.GITHUB_EVENT_NAME = eventName;
      await expect(requireCurrentMain(input)).rejects.toThrow(/événement/);
      expect(input.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['branche différente', { GITHUB_REF: 'refs/heads/topic' }],
    ['SHA invalide', { GITHUB_SHA: 'main; exit 0' }],
    ['dépôt invalide', { GITHUB_REPOSITORY: '../other' }],
    ['jeton absent', { GITHUB_TOKEN: '' }],
  ])('refuse %s', async (_name, values) => {
    const input = setup();
    await expect(requireCurrentMain({ ...input, environment: { ...input.environment, ...values } })).rejects.toThrow();
    expect(input.request).not.toHaveBeenCalled();
  });

  it.each([
    ['dépôt étranger', { ...event, repository: { full_name: 'fork/aimmo' } }],
    ['push d’une autre branche', { ...event, ref: 'refs/heads/topic' }],
    ['SHA du push différent', { ...event, after: other }],
  ])('refuse %s dans le payload', async (_name, payload) => {
    const input = setup();
    await expect(requireCurrentMain({ ...input, event: payload })).rejects.toThrow();
    expect(input.request).not.toHaveBeenCalled();
  });

  it('refuse un checkout qui ne correspond pas au SHA attendu', async () => {
    const input = setup();
    await expect(requireCurrentMain({ ...input, checkoutSha: other })).rejects.toThrow(/checkout/);
    expect(input.request).not.toHaveBeenCalled();
  });

  it('refuse un commit dépassé pendant l’attente ou avant une mutation', async () => {
    const input = setup();
    input.request.mockResolvedValue(response(200, { object: { sha: other } }));
    await expect(requireCurrentMain(input)).rejects.toThrow(/main a avancé/);
  });

  it('refait la lecture à chaque garde, sans réutiliser une autorisation périmée', async () => {
    const input = setup();
    await requireCurrentMain(input);
    input.request.mockResolvedValue(response(200, { object: { sha: other } }));
    await expect(requireCurrentMain(input)).rejects.toThrow(/main a avancé/);
    expect(input.request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 429, 500])('ferme le passage sur HTTP %s sans exposer de corps serveur', async (status) => {
    const input = setup();
    input.request.mockResolvedValue(response(status, { token: 'do-not-log-server-body' }));
    await expect(requireCurrentMain(input)).rejects.toThrow(`HTTP ${status}`);
    await expect(requireCurrentMain(input)).rejects.not.toThrow('do-not-log-server-body');
  });

  it('ferme le passage en cas de réponse incomplète ou de panne réseau', async () => {
    const input = setup();
    input.request.mockResolvedValue(response(200, {}));
    await expect(requireCurrentMain(input)).rejects.toThrow(/réponse/);
    input.request.mockRejectedValue(new Error('network'));
    await expect(requireCurrentMain(input)).rejects.toThrow(/lecture GitHub/);
  });
});

// A change le code ; B avance main avec chantier/PLAN.md seul. B doit porter le code de A.
describe('CI · un push chantier ne perd pas le déploiement précédent', () => {
  it('refuse A dépassé puis autorise B courant, sans filtre de fichiers', async () => {
    const input = setup();
    input.request.mockResolvedValue(response(200, { object: { sha: other } }));
    await expect(requireCurrentMain(input)).rejects.toThrow(/main a avancé/);
    await expect(requireCurrentMain({
      ...input,
      environment: { ...input.environment, GITHUB_SHA: other },
      event: { ...input.event, after: other },
      checkoutSha: other,
    })).resolves.toBe(other);
  });
});
