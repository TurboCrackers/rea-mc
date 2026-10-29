// Plays the timeline back with two <video> elements: one on screen and one
// already loaded at the start of the next clip, so cuts switch instantly.
// While a clip plays, the video drives the clock; during gaps a timer does.

import { itemAt, layout, totalDuration } from './timeline.js';

// How close two cut points must be to count as one continuous piece of video.
const CONTINUOUS = 0.05;
// Stop a clip this close to its out point; one frame of the next shot is worse.
const END_SLACK = 0.02;

export class Player {
  constructor({ screens, message, getItems, getMedia, onTime, onPlayingChange }) {
    [this.active, this.standby] = screens;
    this.screens = screens;
    this.message = message;
    this.getItems = getItems;
    this.getMedia = getMedia;
    this.onTime = onTime;
    this.onPlayingChange = onPlayingChange;
    this.time = 0;
    this.playing = false;
    this.current = null;
    this.lastFrame = 0;
    this.tick = this.tick.bind(this);
  }

  urlOf(item) {
    return item?.type === 'clip' ? this.getMedia(item.mediaId)?.previewUrl ?? null : null;
  }

  seek(time) {
    const items = this.getItems();
    this.time = Math.min(Math.max(0, time), totalDuration(items));
    this.current = itemAt(items, this.time);
    this.present();
    this.onTime(this.time);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    const items = this.getItems();
    if (!items.length) return;
    if (this.time >= totalDuration(items) - 0.01) this.time = 0;
    this.current = itemAt(items, this.time);
    this.playing = true;
    this.onPlayingChange(true);
    this.present();
    this.prepareNext(layout(items));
    this.lastFrame = performance.now();
    requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const screen of this.screens) screen.pause();
    this.onPlayingChange(false);
  }

  // Shows the current item at the current time.
  present() {
    const item = this.current;
    const url = this.urlOf(item);
    this.setMessage(item?.type === 'clip' && !url ? this.getMedia(item.mediaId)?.status || 'No preview' : '');
    if (!url) {
      this.active.pause();
      this.show(null);
      return;
    }
    load(this.active, url);
    this.active.currentTime = item.in + (this.time - item.start);
    this.show(this.active);
    if (this.playing) this.active.play().catch(() => {});
    else this.active.pause();
  }

  tick(now) {
    if (!this.playing) return;
    const elapsed = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const item = this.current;
    if (this.urlOf(item)) {
      const position = this.active.currentTime;
      this.time = item.start + Math.max(0, position - item.in);
      if (position >= item.out - END_SLACK || this.active.ended) this.advance();
    } else {
      this.time += elapsed;
      if (this.time >= item.end) this.advance();
    }
    this.onTime(this.time);
    if (this.playing) requestAnimationFrame(this.tick);
  }

  advance() {
    const items = layout(this.getItems());
    const previous = this.current;
    const next = items[items.findIndex((item) => item.id === previous.id) + 1];
    this.time = previous.end;
    if (!next) {
      this.pause();
      return;
    }
    this.current = next;
    const url = this.urlOf(next);
    if (url && continues(previous, next) && this.urlOf(previous) === url) return;
    if (url && this.standby.dataset.item === next.id && this.standby.dataset.url === url) {
      this.active.pause();
      [this.active, this.standby] = [this.standby, this.active];
      this.show(this.active);
      this.active.play().catch(() => {});
      this.setMessage('');
    } else {
      this.present();
    }
    this.prepareNext(items);
  }

  // Loads the next clip that needs a different shot into the hidden screen.
  prepareNext(items) {
    let index = items.findIndex((item) => item.id === this.current?.id);
    let next = items[++index];
    while (next && (next.type === 'gap' || continues(items[index - 1], next))) next = items[++index];
    const url = this.urlOf(next);
    if (!url) return;
    load(this.standby, url);
    this.standby.dataset.item = next.id;
    this.standby.currentTime = next.in;
    this.standby.pause();
  }

  show(screen) {
    for (const each of this.screens) each.classList.toggle('visible', each === screen);
  }

  setMessage(text) {
    this.message.textContent = text;
    this.message.hidden = !text;
  }
}

function continues(previous, next) {
  return (
    previous?.type === 'clip' &&
    next.type === 'clip' &&
    previous.mediaId === next.mediaId &&
    Math.abs(previous.out - next.in) < CONTINUOUS
  );
}

function load(screen, url) {
  if (screen.dataset.url === url) return;
  screen.dataset.url = url;
  screen.src = url;
}
