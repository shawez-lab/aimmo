import { expect, it } from 'vitest';
import { newAlertToken } from '../src/acquereurs/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { newBookingToken, reminderText } from '../src/rendezvous/index.ts';

// Z01 : un jeton tiré au hasard suit « / » dans le texte ; il ne doit jamais commencer comme un mot que le contrôle
// du texte lit comme une mention de l'IA, sinon le message est refusé pour R06 au hasard.
const RDV = 'https://rdv.example.test/r/';
const ALERTES = 'https://aimmo.example.test/alertes/';
const start = new Date('2026-11-10T13:30:00.000Z');

it('[R06] [R10] sur 2 000 tirages, le lien d’un rappel de rendez-vous passe toujours le contrôle du texte', () => {
  for (let i = 0; i < 2000; i++) {
    const token = newBookingToken();
    expect(token).toMatch(/^[bdefhjklmnopqstuvwxyz][a-z]{31}$/);
    const { text, figures } = reminderText('veille', 'appel', start, 'Léa', `${RDV}${token}`);
    expect(checkText(text, { audience: 'client', channel: 'email', figures, firstOfConversation: true, firstName: 'Léa' }), text).toEqual([]);
  }
  // Ce que le tirage écarte : un jeton qui commencerait ainsi ferait refuser le message.
  for (const word of ['gpt', 'robot', 'assistant', 'chatbot', 'automatiquement']) {
    const { text, figures } = reminderText('veille', 'appel', start, 'Léa', `${RDV}${word}`);
    expect(checkText(text, { audience: 'client', channel: 'email', figures, firstOfConversation: true, firstName: 'Léa' }).map((p) => p.rule)).toContain('R06');
  }
});

it('[R06] [R10] sur 2 000 tirages, le lien de désinscription d’une alerte passe toujours le contrôle du texte', () => {
  for (let i = 0; i < 2000; i++) {
    const token = newAlertToken();
    expect(token).toMatch(/^[bdefhjklmnopqstuvwxyz][a-z]{31}$/);
    const text = `Bonjour Léa, un bien correspond à votre recherche. Ne plus recevoir ces alertes : ${ALERTES}${token}`;
    expect(checkText(text, { audience: 'client', channel: 'email', figures: [] }), text).toEqual([]);
  }
});
