import { expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';

it('[R201] deux boutons sur un rang d’une liste ont un écart, sans changer de taille, et le budget tient', () => {
  const css = AGENT_APP_FILES['/app/app.css']!;
  expect(css).toContain('.liste button + button { margin-inline-start: var(--e-2); }');
  expect(budgetProblems({ html: AGENT_APP_FILES['/app/']!, css, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
});
