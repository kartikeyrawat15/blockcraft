import { blocks } from './blocks';

/**
 * Synthesized game audio using only the Web Audio API (no audio files).
 *
 * Graph:
 *   effects bus ─┐
 *   ambient bus ─┼─> master gain ─> compressor ─> destination
 *   music bus ───┘
 *
 * Long-running sounds (wind, rain, sprint rustle, pad) use persistent node chains.
 * One-shot sounds play through pooled voices (filter + gains + panner) that are
 * reused; only the source nodes are created per sound, since Web Audio sources
 * can only be started once.
 */

// Per-material sound character: noise filter shape, crunchiness and optional tonal knock
const MATERIALS = {
  soil: { type: 'lowpass', freq: 1100, Q: 0.8, grains: 3, decay: 0.09 },
  grass: { type: 'lowpass', freq: 1600, Q: 0.7, grains: 3, decay: 0.08 },
  stone: { type: 'bandpass', freq: 2200, Q: 1.5, grains: 2, decay: 0.06, tone: { type: 'triangle', freq: 170, freqEnd: 140, decay: 0.08, gain: 0.25 } },
  wood: { type: 'bandpass', freq: 700, Q: 2, grains: 1, decay: 0.08, tone: { type: 'triangle', freq: 260, freqEnd: 200, decay: 0.12, gain: 0.4 } },
  sand: { type: 'highpass', freq: 1800, Q: 0.5, grains: 4, decay: 0.12 },
  snow: { type: 'lowpass', freq: 1800, Q: 3, grains: 3, decay: 0.1 },
  leaves: { type: 'highpass', freq: 2800, Q: 0.7, grains: 4, decay: 0.07 },
  soft: { type: 'lowpass', freq: 500, Q: 0.5, grains: 1, decay: 0.25 }
};

const blocksById = Object.fromEntries(Object.values(blocks).map((b) => [b.id, b]));

function materialFor(blockId) {
  const name = blocksById[blockId]?.name.toLowerCase() ?? '';
  if (name.includes('leaves')) return MATERIALS.leaves;
  if (name.includes('tree') || name.includes('cactus')) return MATERIALS.wood;
  if (name.includes('stone') || name.includes('ore')) return MATERIALS.stone;
  if (name.includes('sand')) return MATERIALS.sand;
  if (name.includes('snow')) return MATERIALS.snow;
  if (name.includes('grass')) return MATERIALS.grass;
  if (name.includes('cloud')) return MATERIALS.soft;
  return MATERIALS.soil;
}

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

/**
 * A reusable voice: noise -> filter -> noiseGain ─┐
 *                   tone ---------> toneGain  ────┴─> panner -> destination
 */
class Voice {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.filter = ctx.createBiquadFilter();
    this.noiseGain = ctx.createGain();
    this.toneGain = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.noiseGain.gain.value = 0;
    this.toneGain.gain.value = 0;
    this.filter.connect(this.noiseGain);
    this.noiseGain.connect(this.panner);
    this.toneGain.connect(this.panner);
    this.panner.connect(destination);
    this.endTime = 0;
    this.sources = [];
  }

  /** Stops anything still playing so the voice can be reused */
  reset(now) {
    for (const source of this.sources) {
      try { source.stop(now); } catch (e) { /* already stopped */ }
    }
    this.sources = [];
    for (const g of [this.noiseGain.gain, this.toneGain.gain]) {
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
    }
    this.filter.frequency.cancelScheduledValues(now);
    this.panner.pan.cancelScheduledValues(now);
    this.panner.pan.setValueAtTime(0, now);
  }

  track(source, stopTime) {
    this.sources.push(source);
    source.onended = () => {
      const i = this.sources.indexOf(source);
      if (i >= 0) this.sources.splice(i, 1);
    };
    this.endTime = Math.max(this.endTime, stopTime);
  }
}

class VoicePool {
  constructor(ctx, destination, size) {
    this.ctx = ctx;
    this.voices = Array.from({ length: size }, () => new Voice(ctx, destination));
  }

  /** Returns a free voice, or steals the one that finishes soonest */
  acquire() {
    const now = this.ctx.currentTime;
    let voice = this.voices.find((v) => v.endTime <= now);
    if (!voice) voice = this.voices.reduce((a, b) => (a.endTime < b.endTime ? a : b));
    voice.reset(now);
    voice.endTime = now;
    return voice;
  }
}

export class GameAudio {
  params = {
    master: 0.8,
    effects: 0.8,
    ambient: 0.4,
    music: 0.3,
    muted: false
  };

  // Movement tracking
  stepDistance = 0;
  lastPosition = null;
  wasOnGround = true;
  airMaxY = 0;

  // Schedulers (in AudioContext time)
  nextBird = 0;
  nextCricket = 0;
  nextThunder = 0;
  nextPad = 0;
  padPlaying = false;

  /**
   * @param {import('./player').Player} player
   * @param {import('./world').World} world
   * @param {import('./sky').Sky} sky
   * @param {import('./weather').Weather} weather
   */
  constructor(player, world, sky, weather) {
    this.player = player;
    this.world = world;
    this.sky = sky;
    this.weather = weather;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.ctx = new AudioContextClass();

    this.createGraph();
    this.createLoops();
    this.applyVolumes();

    const now = this.ctx.currentTime;
    this.nextBird = now + 2;
    this.nextCricket = now + 1;
    this.nextThunder = now + rand(20, 40);
    this.nextPad = now + rand(60, 120);

    // Browsers only allow audio to start after a user gesture
    const resume = () => {
      if (this.ctx.state === 'suspended') this.ctx.resume();
    };
    document.addEventListener('keydown', resume);
    document.addEventListener('mousedown', resume);

    document.addEventListener('keydown', (event) => {
      if (event.code === 'KeyM' && !event.repeat) {
        this.params.muted = !this.params.muted;
        this.applyVolumes();
      }
    });

    // Block interaction hooks (chained so other listeners keep working)
    const prevPlaced = player.onBlockPlaced;
    player.onBlockPlaced = (x, y, z, id) => {
      prevPlaced?.(x, y, z, id);
      this.playPlace(id);
    };
    const prevBroken = player.onBlockBroken;
    player.onBlockBroken = (x, y, z, id) => {
      prevBroken?.(x, y, z, id);
      this.playBreak(id);
    };

    player.controls.addEventListener('lock', () => this.playBlip(true));
    player.controls.addEventListener('unlock', () => this.playBlip(false));
  }

  createGraph() {
    const ctx = this.ctx;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.ratio.value = 4;
    this.compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(this.compressor);

    this.effectsBus = ctx.createGain();
    this.ambientBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.effectsBus.connect(this.master);
    this.ambientBus.connect(this.master);
    this.musicBus.connect(this.master);

    // Day/night creature layers crossfade through these gains
    this.birdGain = ctx.createGain();
    this.cricketGain = ctx.createGain();
    this.birdGain.gain.value = 0;
    this.cricketGain.gain.value = 0;
    this.birdGain.connect(this.ambientBus);
    this.cricketGain.connect(this.ambientBus);

    this.effectsPool = new VoicePool(ctx, this.effectsBus, 16);
    this.birdPool = new VoicePool(ctx, this.birdGain, 10);
    this.cricketPool = new VoicePool(ctx, this.cricketGain, 10);
    this.thunderPool = new VoicePool(ctx, this.ambientBus, 2);

    // Shared 2s white noise buffer used by every noise source
    const length = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  loopNoise() {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.start(0, Math.random() * 2);
    return source;
  }

  createLoops() {
    const ctx = this.ctx;

    // Wind: lowpassed noise with slow filter and gust LFOs
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 350;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise().connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.ambientBus);

    const filterLfo = ctx.createOscillator();
    filterLfo.frequency.value = 0.06;
    const filterLfoDepth = ctx.createGain();
    filterLfoDepth.gain.value = 150;
    filterLfo.connect(filterLfoDepth).connect(this.windFilter.frequency);
    filterLfo.start();

    const gustLfo = ctx.createOscillator();
    gustLfo.frequency.value = 0.13;
    this.gustDepth = ctx.createGain();
    this.gustDepth.gain.value = 0;
    gustLfo.connect(this.gustDepth).connect(this.windGain.gain);
    gustLfo.start();

    // Rain: band-limited hiss
    const rainHigh = ctx.createBiquadFilter();
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 700;
    const rainLow = ctx.createBiquadFilter();
    rainLow.type = 'lowpass';
    rainLow.frequency.value = 6000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.loopNoise().connect(rainHigh).connect(rainLow).connect(this.rainGain).connect(this.ambientBus);

    // Sprint rustle: very quiet bandpassed noise on the effects bus
    const rustleFilter = ctx.createBiquadFilter();
    rustleFilter.type = 'bandpass';
    rustleFilter.frequency.value = 900;
    rustleFilter.Q.value = 0.7;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    this.loopNoise().connect(rustleFilter).connect(this.rustleGain).connect(this.effectsBus);

    // Ambient pad chain (oscillators are created per pad)
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain).connect(this.musicBus);
  }

  applyVolumes() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const p = this.params;
    this.master.gain.setTargetAtTime(p.muted ? 0 : p.master, now, 0.03);
    this.effectsBus.gain.setTargetAtTime(p.effects, now, 0.03);
    this.ambientBus.gain.setTargetAtTime(p.ambient, now, 0.03);
    this.musicBus.gain.setTargetAtTime(p.music, now, 0.03);
  }

  // ---------------------------------------------------------------------------
  // Primitive one-shots
  // ---------------------------------------------------------------------------

  noise(voice, { when, type, freq, freqEnd, Q = 1, attack = 0.003, decay, gain }) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    voice.filter.type = type;
    voice.filter.Q.setValueAtTime(Q, when);
    voice.filter.frequency.setValueAtTime(freq, when);
    if (freqEnd) voice.filter.frequency.exponentialRampToValueAtTime(freqEnd, when + attack + decay);

    const g = voice.noiseGain.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(gain, when + attack);
    g.setTargetAtTime(0, when + attack, decay / 3);

    const stop = when + attack + decay * 1.5;
    source.connect(voice.filter);
    source.start(when, Math.random() * 1.5);
    source.stop(stop);
    voice.track(source, stop);
  }

  tone(voice, { when, type = 'sine', freq, freqEnd, attack = 0.003, decay, gain }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, when + attack + decay);

    const g = voice.toneGain.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(gain, when + attack);
    g.setTargetAtTime(0, when + attack, decay / 3);

    const stop = when + attack + decay * 1.5;
    osc.connect(voice.toneGain);
    osc.start(when);
    osc.stop(stop);
    voice.track(osc, stop);
  }

  /** A single filtered-noise grain (plus optional tonal knock) in a material's character */
  grain(material, when, gain, { freqScale = 1, decayScale = 1, withTone = true } = {}) {
    const voice = this.effectsPool.acquire();
    voice.panner.pan.setValueAtTime(rand(-0.1, 0.1), when);
    this.noise(voice, {
      when,
      type: material.type,
      freq: material.freq * freqScale * rand(0.85, 1.15),
      Q: material.Q,
      decay: material.decay * decayScale,
      gain
    });
    if (withTone && material.tone) {
      const t = material.tone;
      this.tone(voice, {
        when,
        type: t.type,
        freq: t.freq * freqScale * rand(0.95, 1.05),
        freqEnd: t.freqEnd * freqScale,
        decay: t.decay * decayScale,
        gain: t.gain * gain
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Game sounds
  // ---------------------------------------------------------------------------

  ready() {
    return this.ctx && this.ctx.state === 'running';
  }

  playBreak(blockId) {
    if (!this.ready()) return;
    const material = materialFor(blockId);
    const now = this.ctx.currentTime;
    let t = now;
    for (let i = 0; i < material.grains; i++) {
      this.grain(material, t, 0.5 * (1 - i * 0.15), { withTone: i === 0 });
      t += rand(0.025, 0.045);
    }
  }

  playPlace(blockId) {
    if (!this.ready()) return;
    const material = materialFor(blockId);
    const now = this.ctx.currentTime;
    this.grain(material, now, 0.45, { freqScale: 0.7, decayScale: 0.8 });

    // Soft low thump shared by all placements
    const voice = this.effectsPool.acquire();
    this.tone(voice, { when: now, freq: 110, freqEnd: 70, decay: 0.07, gain: 0.25 });
  }

  playFootstep(blockId, sprinting) {
    if (!this.ready()) return;
    const material = materialFor(blockId);
    this.grain(material, this.ctx.currentTime, sprinting ? 0.15 : 0.12, { decayScale: 0.8, withTone: false });
  }

  playJump(blockId) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const voice = this.effectsPool.acquire();
    this.noise(voice, { when: now, type: 'bandpass', freq: 400, freqEnd: 900, Q: 0.8, attack: 0.02, decay: 0.12, gain: 0.08 });
    this.grain(materialFor(blockId), now, 0.1, { withTone: false });
  }

  playLand(blockId, fallHeight) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const s = clamp(fallHeight / 8, 0.15, 1);
    const voice = this.effectsPool.acquire();
    this.noise(voice, { when: now, type: 'lowpass', freq: 300 + 300 * s, Q: 0.7, decay: 0.12 + 0.15 * s, gain: 0.5 * s });
    this.tone(voice, { when: now, freq: 95, freqEnd: 50, decay: 0.12 + 0.12 * s, gain: 0.4 * s });
    this.grain(materialFor(blockId), now, 0.2 + 0.2 * s, { withTone: false });
  }

  playBlip(start) {
    if (!this.ctx) return;
    // The start blip can arrive while the context is still resuming from the key press
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().then(() => this.playBlip(start));
      return;
    }
    const now = this.ctx.currentTime;
    const [a, b] = start ? [660, 990] : [990, 660];
    this.tone(this.effectsPool.acquire(), { when: now, type: 'triangle', freq: a, decay: 0.06, gain: 0.12 });
    this.tone(this.effectsPool.acquire(), { when: now + 0.07, type: 'triangle', freq: b, decay: 0.08, gain: 0.12 });
  }

  scheduleBirdPhrase(now) {
    const pan = rand(-0.8, 0.8);
    const base = rand(2200, 3600);
    const notes = 2 + Math.floor(Math.random() * 4);
    let t = now;
    for (let i = 0; i < notes; i++) {
      const voice = this.birdPool.acquire();
      voice.panner.pan.setValueAtTime(pan, t);
      const f = base * rand(0.9, 1.15);
      const dur = rand(0.05, 0.11);
      this.tone(voice, { when: t, freq: f, freqEnd: f * (Math.random() < 0.5 ? 1.35 : 0.75), attack: 0.01, decay: dur, gain: 0.5 });
      t += dur + rand(0.04, 0.09);
    }
  }

  scheduleCricketChirp(now) {
    const pan = rand(-0.9, 0.9);
    const freq = rand(4200, 4800);
    const pulses = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pulses; i++) {
      const voice = this.cricketPool.acquire();
      const t = now + i * 0.05;
      voice.panner.pan.setValueAtTime(pan, t);
      this.tone(voice, { when: t, freq, attack: 0.004, decay: 0.03, gain: 0.5 });
    }
  }

  scheduleThunder(now) {
    const voice = this.thunderPool.acquire();
    const when = now + rand(0, 0.5);
    voice.panner.pan.setValueAtTime(rand(-0.6, 0.6), when);
    this.noise(voice, { when, type: 'lowpass', freq: rand(220, 320), freqEnd: 70, Q: 0.7, attack: rand(0.3, 0.8), decay: rand(3, 5), gain: 0.5 });
  }

  /** A slow generative chord: random root and voicing from a pentatonic set */
  schedulePad(now) {
    const roots = [130.81, 146.83, 164.81, 196.0, 220.0];
    const root = roots[Math.floor(Math.random() * roots.length)];
    // Semitone offsets: root, fifth, plus a random colour tone or two
    const colours = [2, 4, 9, 14, 16];
    const intervals = [0, 7, colours[Math.floor(Math.random() * colours.length)]];
    if (Math.random() < 0.5) intervals.push(12);

    const attack = 6;
    const hold = rand(8, 14);
    const release = 8;
    const end = now + attack + hold + release;

    for (const semis of intervals) {
      const freq = root * Math.pow(2, semis / 12);
      for (const detune of [-4, 4]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = detune + rand(-2, 2);
        osc.connect(this.padFilter);
        osc.start(now);
        osc.stop(end + 0.1);
      }
    }

    const g = this.padGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(0.03, now + attack);
    g.setValueAtTime(0.03, now + attack + hold);
    g.linearRampToValueAtTime(0, end);

    const f = this.padFilter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(500, now);
    f.linearRampToValueAtTime(1200, now + attack + hold / 2);
    f.linearRampToValueAtTime(500, end);

    this.padPlaying = true;
    this.padEnd = end;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /** Id of the block under the player's feet */
  blockUnderPlayer() {
    const p = this.player.position;
    const feetY = p.y - this.player.height;
    return this.world.getBlock(Math.round(p.x), Math.round(feetY - 0.5), Math.round(p.z))?.id ?? blocks.empty.id;
  }

  /**
   * @param {number} dt
   * @param {boolean} running Whether the game is running
   */
  update(dt, running) {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const player = this.player;
    const day = this.sky.day;
    const rain = this.weather.rainIntensity;

    // --- Movement sounds ---
    const moving = player.input.x !== 0 || player.input.z !== 0;
    const sprinting = player.sprinting && moving;
    const onGround = player.onGround;

    if (running) {
      const pos = player.position;
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dz = pos.z - this.lastPosition.z;
        if (onGround && moving) {
          this.stepDistance += Math.hypot(dx, dz);
          const stride = sprinting ? 1.9 : 1.6;
          if (this.stepDistance >= stride) {
            this.stepDistance -= stride;
            this.playFootstep(this.blockUnderPlayer(), sprinting);
          }
        }
      }
      this.lastPosition = pos.clone();

      // Jumps and landings
      if (!onGround) {
        if (this.wasOnGround && player.velocity.y > 0) this.playJump(this.blockUnderPlayer());
        this.airMaxY = Math.max(this.airMaxY, pos.y);
      } else {
        if (!this.wasOnGround) {
          const fall = this.airMaxY - pos.y;
          if (fall > 0.3) this.playLand(this.blockUnderPlayer(), fall);
        }
        this.airMaxY = pos.y;
      }
      this.wasOnGround = onGround;
    } else {
      this.lastPosition = null;
    }

    this.rustleGain.gain.setTargetAtTime(running && sprinting && onGround ? 0.02 : 0, now, 0.15);

    // --- Ambient layers (kept well below action sounds) ---
    this.windGain.gain.setTargetAtTime(0.1 + 0.08 * rain, now, 1);
    this.gustDepth.gain.setTargetAtTime(0.04 + 0.04 * rain, now, 1);
    this.rainGain.gain.setTargetAtTime(0.3 * rain, now, 0.5);

    const birdLevel = day * (1 - rain) * 0.12;
    const cricketLevel = (1 - day) * (1 - 0.7 * rain) * 0.05;
    this.birdGain.gain.setTargetAtTime(birdLevel, now, 1.5);
    this.cricketGain.gain.setTargetAtTime(cricketLevel, now, 1.5);

    if (now >= this.nextBird) {
      if (birdLevel > 0.005) this.scheduleBirdPhrase(now);
      this.nextBird = now + rand(1.5, 5);
    }
    if (now >= this.nextCricket) {
      if (cricketLevel > 0.002) this.scheduleCricketChirp(now);
      this.nextCricket = now + rand(0.5, 1.2);
    }
    if (now >= this.nextThunder) {
      if (rain > 0.5) this.scheduleThunder(now);
      this.nextThunder = now + rand(25, 70);
    }

    // --- Music: occasional quiet pad ---
    if (this.padPlaying && now >= this.padEnd) this.padPlaying = false;
    if (!this.padPlaying && now >= this.nextPad) {
      this.schedulePad(now);
      this.nextPad = this.padEnd + rand(90, 240);
    }
  }
}
