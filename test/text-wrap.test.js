import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../src/text-wrap.js';

test('指定文字数で字幕を改行する', () => {
  assert.equal(wrapText('あいうえおかきくけこ', 5), 'あいうえお\nかきくけこ');
});

test('句読点の直後を優先して改行する', () => {
  assert.equal(wrapText('これはとても、長い字幕のテスト', 8), 'これはとても、\n長い字幕のテスト');
});

test('既存の改行を維持する', () => {
  assert.equal(wrapText('あいう\nえおかき', 4), 'あいう\nえおかき');
});
