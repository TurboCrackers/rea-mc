import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as timeline from '../src/renderer/timeline.js';

const clip = (mediaId, start, end) => ({ type: 'clip', id: timeline.newId(), mediaId, in: start, out: end });
const shape = (items) =>
  items.map((item) => (item.type === 'clip' ? `${item.mediaId}:${item.in}-${item.out}` : `gap:${+item.duration.toFixed(3)}`));

test('split cuts a clip in two at the playhead', () => {
  const items = [clip('a', 0, 10), clip('b', 2, 6)];
  const { items: result, right } = timeline.split(items, 13);
  assert.deepEqual(shape(result), ['a:0-10', 'b:2-5', 'b:5-6']);
  assert.equal(right.in, 5);
  assert.equal(timeline.split(items, 10.05), null, 'too close to the clip edge');
  assert.equal(timeline.canSplit(items, 10.05), false);
  assert.equal(timeline.canSplit(items, 13), true);
  assert.equal(timeline.split(items, 30), null, 'past the end');
});

test('deleting a clip leaves a gap, deleting a gap closes it', () => {
  const [a, b, c] = [clip('a', 0, 4), clip('b', 0, 3), clip('c', 0, 2)];
  const withGap = timeline.remove([a, b, c], b.id);
  assert.deepEqual(shape(withGap), ['a:0-4', 'gap:3', 'c:0-2']);
  assert.deepEqual(shape(timeline.remove(withGap, withGap[1].id)), ['a:0-4', 'c:0-2']);
  assert.deepEqual(shape(timeline.removeAndClose([a, b, c], b.id)), ['a:0-4', 'c:0-2']);
  assert.deepEqual(shape(timeline.remove([a, b], b.id)), ['a:0-4'], 'no gap is left at the end');
});

test('neighbouring gaps merge', () => {
  const [a, b, c] = [clip('a', 0, 4), clip('b', 0, 3), clip('c', 0, 2)];
  const items = timeline.remove(timeline.remove([a, b, timeline.gap(1), c], b.id), a.id);
  assert.deepEqual(shape(items), ['gap:8', 'c:0-2']);
});

test('shortening a clip leaves a gap so later clips stay put', () => {
  const [a, b] = [clip('a', 0, 10), clip('b', 0, 5)];
  assert.deepEqual(shape(timeline.trim([a, b], a.id, 'end', -3, 10)), ['a:0-7', 'gap:3', 'b:0-5']);
  assert.deepEqual(shape(timeline.trim([a, b], b.id, 'start', 2, 5)), ['a:0-10', 'gap:2', 'b:2-5']);
  assert.deepEqual(shape(timeline.trim([a, b], b.id, 'end', -2, 5)), ['a:0-10', 'b:0-3']);
});

test('lengthening a clip fills a gap first, then pushes later clips', () => {
  const [a, b] = [clip('a', 2, 6), clip('b', 3, 5)];
  const items = [a, timeline.gap(1), b];
  assert.deepEqual(shape(timeline.trim(items, a.id, 'end', 0.5, 10)), ['a:2-6.5', 'gap:0.5', 'b:3-5']);
  assert.deepEqual(shape(timeline.trim(items, a.id, 'end', 3, 10)), ['a:2-9', 'b:3-5']);
  assert.deepEqual(shape(timeline.trim(items, a.id, 'end', 30, 10)), ['a:2-10', 'b:3-5'], 'stops at the end of the video');
  assert.deepEqual(shape(timeline.trim(items, b.id, 'start', -2, 5)), ['a:2-6', 'b:1-5']);
  assert.deepEqual(shape(timeline.trim(items, b.id, 'start', -9, 5)), ['a:2-6', 'b:0-5'], 'stops at the start of the video');
  assert.deepEqual(shape(timeline.trim(items, a.id, 'start', 30, 10)), ['gap:3.9', 'a:5.9-6', 'gap:1', 'b:3-5'], 'keeps a minimum length');
});

test('a clip dropped into a gap fills it from the left', () => {
  const [a, b] = [clip('a', 0, 4), clip('b', 0, 4)];
  const items = [a, timeline.gap(5), b];
  assert.deepEqual(shape(timeline.insert(items, clip('x', 0, 2), 7)), ['a:0-4', 'x:0-2', 'gap:3', 'b:0-4']);
  assert.deepEqual(shape(timeline.insert(items, clip('x', 0, 5), 7)), ['a:0-4', 'x:0-5', 'b:0-4']);
  assert.deepEqual(shape(timeline.insert(items, clip('x', 0, 8), 7)), ['a:0-4', 'x:0-8', 'b:0-4'], 'longer clips push the rest');
  assert.equal(timeline.insertionPoint(items, 8).time, 4);
});

test('a clip dropped onto a clip goes before or after it', () => {
  const [a, b] = [clip('a', 0, 4), clip('b', 0, 4)];
  assert.deepEqual(shape(timeline.insert([a, b], clip('x', 0, 1), 4.5)), ['a:0-4', 'x:0-1', 'b:0-4']);
  assert.deepEqual(shape(timeline.insert([a, b], clip('x', 0, 1), 3.5)), ['a:0-4', 'x:0-1', 'b:0-4']);
  assert.deepEqual(shape(timeline.insert([a, b], clip('x', 0, 1), 1)), ['x:0-1', 'a:0-4', 'b:0-4']);
  assert.deepEqual(shape(timeline.insert([a, b], clip('x', 0, 1), Infinity)), ['a:0-4', 'b:0-4', 'x:0-1']);
});

test('moving a clip leaves a gap where it was', () => {
  const [a, b, c] = [clip('a', 0, 4), clip('b', 0, 2), clip('c', 0, 4)];
  const items = [a, timeline.gap(3), b, c];
  assert.deepEqual(shape(timeline.move(items, c.id, 5)), ['a:0-4', 'c:0-4', 'b:0-2']);
  assert.deepEqual(shape(timeline.move(items, b.id, 1)), ['b:0-2', 'a:0-4', 'gap:5', 'c:0-4']);
  assert.deepEqual(shape(timeline.move(items, b.id, 7.5)), shape(items), 'dropping a clip on itself changes nothing');
  assert.deepEqual(shape(timeline.move(items, c.id, 50)), shape(items), 'dragging the last clip past the end keeps it there');
  assert.deepEqual(shape(timeline.move(items, a.id, 50)), ['gap:7', 'b:0-2', 'c:0-4', 'a:0-4']);
});
