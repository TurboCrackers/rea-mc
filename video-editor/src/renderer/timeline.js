// The timeline is one track: an ordered list of clips and gaps, played back to back.
//   clip: { type: 'clip', id, mediaId, in, out }   (in/out are seconds in the source video)
//   gap:  { type: 'gap', id, duration }            (black screen and silence)
//
// Edits never overwrite another clip. Shortening or deleting a clip leaves a gap
// where it was; a clip dropped into a gap fills it and only pushes later clips
// along if it is longer than the gap. All functions return a new list.

export const MIN_CLIP = 0.1;
const MIN_GAP = 0.001;

let lastId = 0;
export const newId = () => `item${++lastId}`;

export const gap = (duration) => ({ type: 'gap', id: newId(), duration });

export function itemDuration(item) {
  return item.type === 'clip' ? item.out - item.in : item.duration;
}

export function totalDuration(items) {
  return items.reduce((sum, item) => sum + itemDuration(item), 0);
}

// Adds each item's position on the timeline.
export function layout(items) {
  let time = 0;
  return items.map((item) => {
    const start = time;
    time += itemDuration(item);
    return { ...item, start, end: time };
  });
}

export function itemAt(items, time) {
  return layout(items).find((item) => time >= item.start && time < item.end) ?? null;
}

// Merges neighbouring gaps and drops empty ones. A gap at the very end would just
// be black frames after the video finishes, so it is removed too.
export function normalize(items) {
  const result = [];
  for (const item of items) {
    if (item.type === 'gap') {
      if (item.duration < MIN_GAP) continue;
      const previous = result[result.length - 1];
      if (previous?.type === 'gap') {
        result[result.length - 1] = { ...previous, duration: previous.duration + item.duration };
        continue;
      }
    }
    result.push(item);
  }
  while (result[result.length - 1]?.type === 'gap') result.pop();
  return result;
}

// The clip under `time`, if cutting there leaves two usable pieces.
function splitTarget(items, time) {
  const target = itemAt(items, time);
  const usable = target?.type === 'clip' && time - target.start >= MIN_CLIP && target.end - time >= MIN_CLIP;
  return usable ? target : null;
}

export function canSplit(items, time) {
  return splitTarget(items, time) !== null;
}

// Cuts the clip under `time` in two. Returns null when there is nothing to cut.
export function split(items, time) {
  const target = splitTarget(items, time);
  if (!target) return null;
  const cutAt = target.in + (time - target.start);
  const left = { ...withoutLayout(target), out: cutAt };
  const right = { ...withoutLayout(target), id: newId(), in: cutAt };
  const index = items.findIndex((item) => item.id === target.id);
  return { items: [...items.slice(0, index), left, right, ...items.slice(index + 1)], right };
}

// Deleting a clip leaves a gap; deleting a gap closes it.
export function remove(items, id) {
  const target = items.find((item) => item.id === id);
  if (target?.type !== 'clip') return removeAndClose(items, id);
  return normalize(vacate(items, id));
}

// Swaps a clip for a gap of the same length. The result is deliberately not
// normalized: while a clip is being moved, its empty slot stays separate from
// neighbouring gaps, so dropping it back where it was leaves it there.
export function vacate(items, id) {
  return items.map((item) => (item.id === id ? gap(itemDuration(item)) : item));
}

// Removes an item and pulls everything after it back.
export function removeAndClose(items, id) {
  return normalize(items.filter((item) => item.id !== id));
}

// Moves one edge of a clip by `delta` seconds. Shrinking leaves a gap beside the
// clip; growing first uses up a neighbouring gap, then pushes later items.
export function trim(items, id, edge, delta, sourceDuration) {
  const index = items.findIndex((item) => item.id === id);
  const clip = items[index];
  const result = items.slice();
  if (edge === 'end') {
    const out = clamp(clip.out + delta, clip.in + MIN_CLIP, sourceDuration);
    const change = out - clip.out;
    result[index] = { ...clip, out };
    if (change < 0) result.splice(index + 1, 0, gap(-change));
    else consumeGap(result, index + 1, change);
  } else {
    const start = clamp(clip.in + delta, 0, clip.out - MIN_CLIP);
    const change = start - clip.in;
    result[index] = { ...clip, in: start };
    if (change > 0) result.splice(index, 0, gap(change));
    else consumeGap(result, index - 1, -change);
  }
  return normalize(result);
}

// Where something dropped at `time` would land: the start of a gap it falls in,
// or the nearest edge of the clip it falls on. A gap at the end reaches forever.
export function insertionPoint(items, time) {
  const laidOut = layout(items);
  for (let index = 0; index < laidOut.length; index++) {
    const item = laidOut[index];
    const last = index === laidOut.length - 1;
    if (time >= item.end && !(last && item.type === 'gap')) continue;
    if (item.type === 'gap' || time < (item.start + item.end) / 2) return { index, time: item.start };
    return { index: index + 1, time: item.end };
  }
  return { index: laidOut.length, time: totalDuration(items) };
}

export function insert(items, clip, time) {
  const { index } = insertionPoint(items, time);
  const result = [...items.slice(0, index), clip, ...items.slice(index)];
  consumeGap(result, index + 1, itemDuration(clip));
  return normalize(result);
}

// Picks a clip up (leaving a gap behind) and drops it at `time`.
export function move(items, id, time) {
  const clip = items.find((item) => item.id === id);
  return insert(vacate(items, id), clip, time);
}

function consumeGap(items, index, amount) {
  const neighbour = items[index];
  if (neighbour?.type === 'gap' && amount > 0) {
    items[index] = { ...neighbour, duration: neighbour.duration - Math.min(amount, neighbour.duration) };
  }
}

function withoutLayout({ start, end, ...item }) {
  return item;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
