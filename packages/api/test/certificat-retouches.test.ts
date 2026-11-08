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
    { kind: 'ciel' as const, label: 'Ciel remplacé', detail: 'Ciel remplacé par un autre ciel' },
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
  expect(html).toContain('Ciel remplacé par un autre ciel');
  expect(html).toContain('Objet retiré : du linge');
  expect(html).toContain('« Photo retouchée »');
  expect(html).not.toContain('Aucune retouche à un endroit précis');
  // Des retouches sans correction d'ensemble : la page ne dit jamais la photo « telle qu'elle a été prise ».
  expect(html).not.toContain('telle qu’elle a été prise.</p>');
  expect(html).toContain('Aucune correction d’ensemble.');
  // Sans retouche, la page dit comme avant qu'il n'y en a aucune.
  const plain = renderCertificatePage({ ...cert, localEdits: 'aucune', retouches: [], retouchMention: null });
  expect(plain).toContain('Aucune retouche à un endroit précis');
  expect(plain).not.toContain('Retouches à un endroit précis');
  expect(plain).toContain('Aucune correction : la photo est telle qu’elle a été prise.');
});

it('[R492] la page du certificat d’une image aménagée dit ce qui a changé, ligne par ligne', () => {
  const html = renderCertificatePage({
    ...cert,
    localEdits: 'amenagement_virtuel',
    retouches: [],
    retouchMention: null,
    virtualStaging: true,
    mention: 'Aménagement virtuel',
    stagingChanges: [
      { kind: 'meubler', label: 'Pièce meublée', detail: 'Pièce meublée virtuellement, style scandinave : ce mobilier n’est pas dans le bien' },
      { kind: 'murs', label: 'Murs refaits', detail: 'Murs montrés en peinture neuve : travaux simulés, non faits' },
    ],
  });
  expect(html).toContain('<h2>Ce qui a changé</h2>');
  expect(html).toContain('<li>Pièce meublée virtuellement, style scandinave : ce mobilier n’est pas dans le bien</li>');
  expect(html).toContain('<li>Murs montrés en peinture neuve : travaux simulés, non faits</li>');
  expect(html).toContain('La photo réelle du même cliché est publiée juste avant celle-ci.');
  expect(renderCertificatePage({ ...cert, retouches: [], retouchMention: null, localEdits: 'aucune' })).not.toContain('Ce qui a changé');
});
