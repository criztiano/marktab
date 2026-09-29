import { describe, expect, it } from 'vitest';
import { bundledNotes, createNote, noteSize, normalizeNotes } from './notes';

describe('notes', () => {
  it('creates trimmed notes and quotes, and rejects blank text', () => {
    expect(createNote('  Done is NOT Good  ')).toMatchObject({ text: 'Done is NOT Good' });
    expect(createNote('Stay hungry', ' — Steve Jobs ')).toMatchObject({ text: 'Stay hungry', by: 'Steve Jobs' });
    expect(createNote('   ')).toBeNull();
    expect(createNote('x', '')).not.toHaveProperty('by');
  });

  it('keeps only valid stored notes', () => {
    expect(
      normalizeNotes([{ id: 'a', text: 'Hi' }, { id: '', text: 'x' }, { id: 'b', text: ' ' }, 7, { id: 'c', text: 'Q', by: 'Me' }]),
    ).toEqual([{ id: 'a', text: 'Hi' }, { id: 'c', text: 'Q', by: 'Me' }]);
    expect(normalizeNotes('nope')).toEqual([]);
    expect(normalizeNotes([{ id: 'a', text: 'Hi', color: 'pink' }, { id: 'b', text: 'Yo', color: 'toString' }])).toEqual([
      { id: 'a', text: 'Hi', color: 'pink' },
      { id: 'b', text: 'Yo' },
    ]);
  });

  it('seeds from bundled strings and { text, by } entries', () => {
    const seeded = bundledNotes({ notes: ['Done is NOT Good', { text: 'Less, but better', by: 'Dieter Rams' }, 3, ''] });
    expect(seeded.map(({ text, by }) => ({ text, by }))).toEqual([
      { text: 'Done is NOT Good', by: undefined },
      { text: 'Less, but better', by: 'Dieter Rams' },
    ]);
    expect(bundledNotes(null)).toEqual([]);
  });

  it('steps the type size down for longer text', () => {
    expect(noteSize('Done is NOT Good')).toBe('lg');
    expect(noteSize('x'.repeat(80))).toBe('md');
    expect(noteSize('x'.repeat(200))).toBe('sm');
  });
});
