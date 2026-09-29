// Local notes and quotes shown in the Pins row. They live only in
// browser.storage.local — no network — so they work without a Pins source.

import { readBundledJson } from './local-config';

const isString = (value: unknown): value is string => typeof value === 'string';

export interface PinNote {
  id: string;
  text: string;
  by?: string; // attribution turns a note into a quote
  color?: NoteColor; // highlighter; absent means the first palette colour
}

/** Fluo highlighter palette, shown as dots on a hovered note. */
export const NOTE_COLORS = {
  lime: '#ccff3d',
  yellow: '#fff23d',
  orange: '#ffa53d',
  pink: '#ff7ad9',
  cyan: '#4df0ff',
} as const;

export type NoteColor = keyof typeof NOTE_COLORS;

export function isNoteColor(value: unknown): value is NoteColor {
  return isString(value) && Object.hasOwn(NOTE_COLORS, value);
}

const NOTES_KEY = 'pinNotes';
const MAX_TEXT = 280;
const MAX_BY = 80;

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Build a note from user or bundled input; null when there is no text. */
export function createNote(text: string, by = ''): PinNote | null {
  const body = text.trim().slice(0, MAX_TEXT);
  const author = by.trim().replace(/^[-—–\s]+/, '').slice(0, MAX_BY);
  if (!body) return null;
  return author ? { id: newId(), text: body, by: author } : { id: newId(), text: body };
}

function normalizeNote(value: unknown): PinNote | null {
  if (typeof value !== 'object' || value === null) return null;
  const note = value as Record<string, unknown>;
  if (!isString(note.id) || !note.id || !isString(note.text) || !note.text.trim()) return null;
  const by = isString(note.by) ? note.by.trim() : '';
  return {
    id: note.id,
    text: note.text.trim(),
    ...(by ? { by } : {}),
    ...(isNoteColor(note.color) ? { color: note.color } : {}),
  };
}

export function normalizeNotes(value: unknown): PinNote[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const note = normalizeNote(entry);
        return note ? [note] : [];
      })
    : [];
}

/** Private local builds may bundle starter notes: strings or { text, by }. */
export function bundledNotes(value: unknown): PinNote[] {
  if (typeof value !== 'object' || value === null) return [];
  const notes = (value as Record<string, unknown>).notes;
  if (!Array.isArray(notes)) return [];
  return notes.flatMap((entry) => {
    const note = isString(entry)
      ? createNote(entry)
      : typeof entry === 'object' && entry !== null && isString((entry as { text?: unknown }).text)
        ? createNote(
            (entry as { text: string }).text,
            isString((entry as { by?: unknown }).by) ? (entry as { by: string }).by : '',
          )
        : null;
    return note ? [note] : [];
  });
}

/** Storage owns notes once the key exists; bundled notes seed it only once, so
 * a removed starter note does not come back. */
export async function loadNotes(): Promise<PinNote[]> {
  const stored = await browser.storage.local.get(NOTES_KEY);
  if (stored[NOTES_KEY] !== undefined) return normalizeNotes(stored[NOTES_KEY]);
  const seeded = bundledNotes(await readBundledJson());
  await saveNotes(seeded);
  return seeded;
}

export async function saveNotes(notes: PinNote[]): Promise<void> {
  await browser.storage.local.set({ [NOTES_KEY]: notes });
}

/** Keep every open new tab in step when another tab edits notes. */
export function watchNotes(onChange: (notes: PinNote[]) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && NOTES_KEY in changes) onChange(normalizeNotes(changes[NOTES_KEY].newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Short notes read as a headline; longer ones step down so they still fit. */
export function noteSize(text: string): 'lg' | 'md' | 'sm' {
  if (text.length <= 40) return 'lg';
  return text.length <= 110 ? 'md' : 'sm';
}
