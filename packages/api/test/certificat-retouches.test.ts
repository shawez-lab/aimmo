import { expect, it } from 'vitest';
import { renderCertificatePage } from '../src/certificat-photo.ts';

const cert = {
  token: '0'.repeat(32),
  issuedOn: '2027-11-02',
  resultSha256: '1'.repeat(64),
  originalSha256: '2'.repeat(64),
  originalKept: true as const,
  localEdits: 'retouches_declarees' as const,
  retouches: [
    { kind: 'ciel' as const, label: 'Ciel remplacé', detail: 'Ciel remplacé : seul le ciel a changé, le reste de l’image est tel qu’il a été pris' },
    { kind: 'objet_retire' as const, label: 'Objet retiré', detail: 'Objet retiré : du linge, qui ne fait pas partie du bien' },
  ],
  retouchMention: 'Photo retouchée' as const,
  corrections: [],
  virtualStaging: false,
  mention: null,
  statement: 'Retouches locales déclarées : ciel remplacé, objet retiré (du linge).',
  path: `/certificat-photo/${'0'.repeat(32)}`,
};

it('[R490] la page du certificat dit chaque retouche locale et la mention, jamais « aucune retouche »', () => {
  const html = renderCertificatePage(cert);
  expect(html).toContain('Retouches à un endroit précis');
  expect(html).toContain('Ciel remplacé : seul le ciel a changé');
  expect(html).toContain('Objet retiré : du linge');
  expect(html).toContain('« Photo retouchée »');
  expect(html).not.toContain('Aucune retouche à un endroit précis');
  // Sans retouche, la page dit comme avant qu'il n'y en a aucune.
  const plain = renderCertificatePage({ ...cert, localEdits: 'aucune', retouches: [], retouchMention: null });
  expect(plain).toContain('Aucune retouche à un endroit précis');
  expect(plain).not.toContain('Retouches à un endroit précis');
});
