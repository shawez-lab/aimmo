import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Un test qui rejoue toutes les migrations plusieurs fois dépasse 5 s sur un serveur de vérification chargé, sans
    // rien de faux : 20 s laissent la marge, et un test vraiment bloqué échoue toujours.
    testTimeout: 20_000,
  },
});
