import { expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';

// Une réponse perdue ne prouve pas que rien n'est écrit : l'écriture a pu passer sur le serveur.
it('aucun écran servi ne dit « rien n’est enregistré » quand une réponse se perd', () => {
  const files = Object.entries(AGENT_APP_FILES);
  expect(files.length).toBeGreaterThan(10);
  for (const [path, body] of files) expect(body.includes('Pas de réseau : rien n’est enregistré'), path).toBe(false);
});
