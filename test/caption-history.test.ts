import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionHistory } from '../src/caption-history.js';

test('前の発話の訂正は現在字幕へ繰り上げない', () => {
  const history = new CaptionHistory();
  history.update('A', { id: 'a', timestamp: 1 });
  history.update('B', { id: 'b', timestamp: 2 });
  assert.deepEqual(history.update('A訂正', { id: 'a', timestamp: 1 }), { current: 'B', previous: 'A訂正' });
  assert.deepEqual(history.update('B訂正', { id: 'b', timestamp: 2 }), { current: 'B訂正', previous: 'A訂正' });
  assert.equal(history.update('B訂正', { id: 'b', timestamp: 2 }), undefined);
});

test('古い発話が遅れて届いても発話時刻順を保つ', () => {
  const history = new CaptionHistory();
  history.update('B', { id: 'b', timestamp: 2 });
  assert.deepEqual(history.update('A', { id: 'a', timestamp: 1 }), { current: 'B', previous: 'A' });
  history.update('C', { id: 'c', timestamp: 3 });
  assert.equal(history.update('A訂正', { id: 'a' }), undefined);
});

test('時刻がなくても発話IDで訂正を判別し、同じ表示を繰り上げない', () => {
  const history = new CaptionHistory();
  history.update('A', { id: 'a' });
  history.update('B', { id: 'b' });
  assert.equal(history.update('B', { id: 'c' }), undefined);
  assert.deepEqual(history.update('A訂正', { id: 'a' }), { current: 'B', previous: 'A訂正' });
});
