import { hashEntry } from './hash.ts';
import type { JournalEntry, JournalInput, JournalStore, JsonValue } from './types.ts';

const FIRST_HASH = '0'.repeat(64);
const MAX_APPEND_ATTEMPTS = 20;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const FRENCH_PHONE = /(?:^|\D)0[1-9](?:[ .-]*\d{2}){4}(?:\D|$)/;
const INTERNATIONAL_PHONE = /(?:^|\D)(?:\+|00)\d(?:[ ().-]*\d){7,14}(?:\D|$)/;
// Un identifiant interne au format UUID (32 chiffres hexadécimaux en 8-4-4-4-12) n'est jamais un numéro
// de téléphone, qui a 15 chiffres au plus : on l'écarte avant de chercher, sinon ses groupes de chiffres
// séparés par des tirets passeraient pour un numéro.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function containsPersonalData(value: JsonValue): boolean {
  if (typeof value === 'string') {
    const text = value.replace(UUID, ' ');
    return EMAIL.test(text) || FRENCH_PHONE.test(text) || INTERNATIONAL_PHONE.test(text);
  }
  if (Array.isArray(value)) return value.some(containsPersonalData);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, item]) => containsPersonalData(key) || containsPersonalData(item),
    );
  }
  return false;
}

export async function appendEvent(
  store: JournalStore,
  original: JournalInput,
  now: () => Date,
): Promise<JournalEntry> {
  // Copie figée : un appelant qui modifie son objet pendant l'ajout ne change rien.
  const input = structuredClone(original);
  const lineText: JsonValue = [input.type, input.actor, input.subject, input.data];
  if (containsPersonalData(lineText)) {
    throw new Error(
      'Le journal refuse toute donnée personnelle en clair : seulement des identifiants internes.',
    );
  }

  // Deux ajouts simultanés peuvent viser le même numéro : le stockage refuse le second,
  // qui repart de la nouvelle tête de chaîne.
  for (let attempt = 1; ; attempt += 1) {
    const previous = await store.last();
    const entryWithoutHash = {
      ...input,
      seq: previous === null ? 1 : previous.seq + 1,
      at: now().toISOString(),
      prevHash: previous?.hash ?? FIRST_HASH,
    };
    const entry = { ...entryWithoutHash, hash: await hashEntry(entryWithoutHash) };
    try {
      await store.append(entry);
      return entry;
    } catch (error) {
      const head = await store.last();
      const taken = head !== null && head.seq >= entry.seq;
      if (!taken || attempt >= MAX_APPEND_ATTEMPTS) throw error;
    }
  }
}

export type ChainVerification =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: string };

export async function verifyChain(entries: JournalEntry[]): Promise<ChainVerification> {
  let expectedPreviousHash = FIRST_HASH;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.seq !== expectedSequence) {
      return {
        ok: false,
        brokenAt: entry.seq,
        reason: `Séquence attendue ${expectedSequence}, reçue ${entry.seq}.`,
      };
    }
    if (entry.prevHash !== expectedPreviousHash) {
      return {
        ok: false,
        brokenAt: entry.seq,
        reason: "L'empreinte de la ligne précédente ne correspond pas.",
      };
    }
    if (entry.hash !== (await hashEntry(entry))) {
      return {
        ok: false,
        brokenAt: entry.seq,
        reason: "L'empreinte de la ligne ne correspond pas à son contenu.",
      };
    }
    expectedPreviousHash = entry.hash;
    expectedSequence += 1;
  }

  return { ok: true };
}
