import { hashEntry } from "./hash.ts";
import type {
  JournalEntry,
  JournalInput,
  JournalStore,
  JsonValue,
} from "./types.ts";

const FIRST_HASH = "0".repeat(64);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const FRENCH_PHONE = /(?:^|\D)0[1-9](?:[ .-]*\d{2}){4}(?:\D|$)/;
const INTERNATIONAL_PHONE = /(?:^|\D)(?:\+|00)\d(?:[ ().-]*\d){7,14}(?:\D|$)/;

function containsPersonalData(value: JsonValue): boolean {
  if (typeof value === "string") {
    return (
      EMAIL.test(value) ||
      FRENCH_PHONE.test(value) ||
      INTERNATIONAL_PHONE.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsPersonalData);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsPersonalData);
  }
  return false;
}

export async function appendEvent(
  store: JournalStore,
  input: JournalInput,
  now: () => Date,
): Promise<JournalEntry> {
  const lineText: JsonValue = [
    input.type,
    input.actor,
    input.subject,
    input.data,
  ];
  if (containsPersonalData(lineText)) {
    throw new Error(
      "Le journal refuse toute donnée personnelle en clair : seulement des identifiants internes.",
    );
  }

  const previous = await store.last();
  const entryWithoutHash = {
    ...input,
    seq: previous === null ? 1 : previous.seq + 1,
    at: now().toISOString(),
    prevHash: previous?.hash ?? FIRST_HASH,
  };
  const entry = {
    ...entryWithoutHash,
    hash: await hashEntry(entryWithoutHash),
  };
  await store.append(entry);
  return entry;
}

export type ChainVerification =
  { ok: true } | { ok: false; brokenAt: number; reason: string };

export async function verifyChain(
  entries: JournalEntry[],
): Promise<ChainVerification> {
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
