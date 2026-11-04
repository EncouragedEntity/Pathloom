import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CANVAS_KEYMAP, buildChordLookup, chordFromEvent, findConflicts, formatChord, mergeKeymap, type Keymap,
} from '../src/keymap';

const ev = (o: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;

describe('chordFromEvent', () => {
  it('uses code, not key (Ukrainian layout)', () => {
    expect(chordFromEvent(ev({ key: 'у', code: 'KeyE' }), 'other')).toBe('KeyE');
    expect(chordFromEvent(ev({ key: 'ы', code: 'KeyS', ctrlKey: true, shiftKey: true }), 'other')).toBe('Mod+Shift+KeyS');
  });
  it('orders modifiers Mod+Alt+Shift', () => {
    expect(chordFromEvent(ev({ code: 'KeyZ', shiftKey: true, altKey: true, ctrlKey: true }), 'other')).toBe('Mod+Alt+Shift+KeyZ');
  });
  it('Mod is Ctrl on other, Meta on mac', () => {
    expect(chordFromEvent(ev({ code: 'KeyZ', ctrlKey: true }), 'other')).toBe('Mod+KeyZ');
    expect(chordFromEvent(ev({ code: 'KeyZ', metaKey: true }), 'other')).toBe('KeyZ');
    expect(chordFromEvent(ev({ code: 'KeyZ', metaKey: true }), 'mac')).toBe('Mod+KeyZ');
    expect(chordFromEvent(ev({ code: 'KeyZ', ctrlKey: true }), 'mac')).toBe('KeyZ');
  });
  it('null for bare modifiers', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'OSLeft', '']) {
      expect(chordFromEvent(ev({ code, shiftKey: true }), 'other')).toBeNull();
    }
  });
});

describe('formatChord', () => {
  it('labels', () => {
    expect(formatChord('Mod+Shift+KeyS', 'other')).toBe('Ctrl+Shift+S');
    expect(formatChord('Mod+Shift+KeyS', 'mac')).toBe('⌘⇧S');
    expect(formatChord('Digit1', 'other')).toBe('1');
    expect(formatChord('Mod+BracketRight', 'other')).toBe('Ctrl+]');
    expect(formatChord('Mod+Equal', 'mac')).toBe('⌘=');
    expect(formatChord('Mod+Minus', 'other')).toBe('Ctrl+-');
    expect(formatChord('ArrowUp', 'other')).toBe('↑');
    expect(formatChord('Escape', 'other')).toBe('Esc');
  });
});

describe('keymap', () => {
  it('default map has no conflicts', () => expect(findConflicts(DEFAULT_CANVAS_KEYMAP)).toEqual([]));
  it('findConflicts reports shared chords', () => {
    const m: Keymap = { ...DEFAULT_CANVAS_KEYMAP, 'tool.hand': ['KeyV'] };
    expect(findConflicts(m)).toEqual([{ chord: 'KeyV', commands: ['tool.select', 'tool.hand'] }]);
  });
  it('merges a partial map over the defaults', () => {
    const m = mergeKeymap({ 'tool.hand': ['KeyG'], 'edit.undo': [] });
    expect(m['tool.hand']).toEqual(['KeyG']);
    expect(m['edit.undo']).toEqual([]);
    expect(m['tool.rect']).toEqual(DEFAULT_CANVAS_KEYMAP['tool.rect']);
    expect(DEFAULT_CANVAS_KEYMAP['tool.hand']).toEqual(['KeyH']);
  });
  it('reverse lookup resolves alternatives', () => {
    const l = buildChordLookup(DEFAULT_CANVAS_KEYMAP);
    expect(l.get('KeyV')).toBe('tool.select');
    expect(l.get('Digit1')).toBe('tool.select');
    expect(l.get('Mod+Shift+KeyZ')).toBe('edit.redo');
    expect(l.get('Mod+KeyY')).toBe('edit.redo');
    expect(l.get('Backspace')).toBe('edit.delete');
    expect(l.get('Mod+KeyO')).toBeUndefined();
    expect(l.get('KeyE')).toBeUndefined();
  });
});
