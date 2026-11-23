// 音频系统：Web Audio API 程序化生成音效 + 简易BGM

import { GAME_CONFIG } from '../data/config';

type Polarity = 'RED' | 'BLUE';

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicBpm = 100;
  private musicStep = 0;
  private _enabled = true;
  private _volume = GAME_CONFIG.MASTER_VOLUME;
  private _muted = false;
  /** 保存在 init() 之前请求的 BPM，待音频上下文就绪后补播 */
  private pendingMusicBpm: number | null = null;

  get enabled() { return this._enabled; }

  /** 必须在用户手势后调用 */
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
      this.masterGain.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.18;
      this.musicGain.connect(this.masterGain);
    } catch {
      this._enabled = false;
    }
    // 就绪后补播「在交互前」就已请求的 BGM
    if (this.pendingMusicBpm !== null) this.startMusic(this.pendingMusicBpm);
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && !this._muted) this.masterGain.gain.value = this._volume;
  }

  setMuted(muted: boolean) {
    this._muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : this._volume;
  }

  get muted(): boolean { return this._muted; }

  /** 应用存档中的静音 / 主音量（启动时与设置变更时调用） */
  applySettings(muted: boolean, volume: number) {
    this._volume = Math.max(0, Math.min(1, volume));
    this._muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : this._volume;
  }

  private get ready(): boolean {
    return this._enabled && !!this.ctx && !!this.masterGain;
  }

  /** 基础音调播放 */
  private tone(opts: {
    type: OscillatorType;
    freq: number;
    freqEnd?: number;
    duration: number;
    volume?: number;
    delay?: number;
  }) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(this.masterGain!);
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t0 + opts.duration);
    }
    const vol = opts.volume ?? 0.3;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.01, t0 + opts.duration);
    osc.start(t0);
    osc.stop(t0 + opts.duration + 0.02);
  }

  /** 噪声播放 */
  private noise(opts: {
    duration: number;
    volume?: number;
    filterFreq?: number;
    filterEnd?: number;
    filterType?: BiquadFilterType;
    delay?: number;
  }) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * opts.duration));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.volume ?? 0.25, t0);
    gain.gain.exponentialRampToValueAtTime(0.01, t0 + opts.duration);

    if (opts.filterFreq) {
      const filter = ctx.createBiquadFilter();
      filter.type = opts.filterType ?? 'bandpass';
      filter.frequency.setValueAtTime(opts.filterFreq, t0);
      if (opts.filterEnd) {
        filter.frequency.exponentialRampToValueAtTime(opts.filterEnd, t0 + opts.duration);
      }
      src.connect(filter);
      filter.connect(gain);
    } else {
      src.connect(gain);
    }
    gain.connect(this.masterGain!);
    src.start(t0);
  }

  playSwitch(polarity: Polarity) {
    if (polarity === 'RED') {
      this.tone({ type: 'sine', freq: 800, freqEnd: 1200, duration: 0.15, volume: 0.3 });
    } else {
      this.tone({ type: 'triangle', freq: 400, freqEnd: 600, duration: 0.15, volume: 0.3 });
    }
  }

  playJump() {
    this.noise({ duration: 0.15, volume: 0.15, filterFreq: 200, filterEnd: 600 });
    this.tone({ type: 'sine', freq: 300, freqEnd: 600, duration: 0.12, volume: 0.15 });
  }

  playSlide() {
    this.noise({ duration: 0.25, volume: 0.12, filterFreq: 1500, filterType: 'bandpass' });
  }

  playDeath() {
    this.noise({ duration: 0.3, volume: 0.35 });
    this.tone({ type: 'sawtooth', freq: 200, freqEnd: 50, duration: 0.3, volume: 0.25 });
  }

  playPortal() {
    this.tone({ type: 'sine', freq: 400, freqEnd: 1200, duration: 0.12, volume: 0.25 });
    this.tone({ type: 'sine', freq: 1200, freqEnd: 400, duration: 0.12, volume: 0.25, delay: 0.1 });
  }

  playComboMilestone() {
    const notes = [261.6, 329.6, 392.0, 523.3]; // C-E-G-C
    notes.forEach((f, i) => {
      this.tone({ type: 'square', freq: f, duration: 0.1, volume: 0.12, delay: i * 0.06 });
    });
  }

  playFlip() {
    this.tone({ type: 'sine', freq: 600, freqEnd: 150, duration: 0.25, volume: 0.25 });
    this.tone({ type: 'sine', freq: 150, freqEnd: 500, duration: 0.15, volume: 0.15, delay: 0.18 });
  }

  playBoost() {
    this.noise({ duration: 0.4, volume: 0.15, filterFreq: 300, filterEnd: 3000 });
    this.tone({ type: 'sawtooth', freq: 100, freqEnd: 400, duration: 0.35, volume: 0.12 });
  }

  playLand() {
    this.tone({ type: 'sine', freq: 120, freqEnd: 60, duration: 0.08, volume: 0.2 });
  }

  playWin() {
    const notes = [523.3, 659.3, 784.0, 1046.5];
    notes.forEach((f, i) => {
      this.tone({ type: 'triangle', freq: f, duration: 0.3, volume: 0.2, delay: i * 0.09 });
    });
  }

  playUIClick() {
    this.tone({ type: 'sine', freq: 600, freqEnd: 900, duration: 0.06, volume: 0.15 });
  }

  /** 成就解锁：C-E-G-C 上行琶音 + 高频闪光 */
  playAchievement() {
    const notes = [523.3, 659.3, 784.0, 1046.5];
    notes.forEach((f, i) => {
      this.tone({ type: 'triangle', freq: f, duration: 0.35, volume: 0.22, delay: i * 0.09 });
    });
    this.tone({ type: 'sine', freq: 2093, duration: 0.5, volume: 0.08, delay: 0.36 });
  }

  playPolarityZone() {
    this.tone({ type: 'square', freq: 500, freqEnd: 1000, duration: 0.12, volume: 0.15 });
  }

  /** 拾取普通晶片：清脆高频叮 */
  playCollect() {
    this.tone({ type: 'triangle', freq: 1318, freqEnd: 1760, duration: 0.14, volume: 0.22 });
  }

  /** 拾取特殊物品：华丽上行琶音 + 铃音 */
  playSpecialItem() {
    const notes = [523.3, 659.3, 784.0, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      this.tone({ type: 'triangle', freq: f, duration: 0.3, volume: 0.2, delay: i * 0.07 });
    });
    this.tone({ type: 'sine', freq: 2637, duration: 0.6, volume: 0.08, delay: 0.35 });
  }

  /** 终点未解锁：低沉短促 buzz */
  playLocked() {
    this.tone({ type: 'square', freq: 170, freqEnd: 110, duration: 0.18, volume: 0.18 });
  }

  /** 进入特殊星门：神秘竖琴式上行 */
  playSpecialDoor() {
    const notes = [392, 523.3, 659.3, 880, 1174.7];
    notes.forEach((f, i) => {
      this.tone({ type: 'sine', freq: f, duration: 0.35, volume: 0.16, delay: i * 0.08 });
    });
  }

  // ---- 简易程序化BGM：节拍器式电子音 ----
  startMusic(bpm: number) {
    this.stopMusic();
    // 音频上下文需用户手势后才能创建。先把 BPM 记下来，
    // 否则主菜单首次进入（尚未交互）时的 BGM 会永久丢失。
    this.pendingMusicBpm = bpm;
    if (!this.ready) return;
    this.musicBpm = bpm;
    this.musicStep = 0;
    const stepDur = 60 / bpm / 2; // 八分音符
    const bassLine = [55, 55, 82.4, 55, 65.4, 55, 82.4, 98]; // A1 A1 E2 A1 C2 A1 E2 G2
    this.musicTimer = window.setInterval(() => {
      if (!this.musicGain) return;
      const step = this.musicStep % 8;
      // 低音
      const t0 = this.ctx!.currentTime;
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = bassLine[step];
      g.gain.setValueAtTime(0.5, t0);
      g.gain.exponentialRampToValueAtTime(0.01, t0 + stepDur * 0.9);
      osc.connect(g); g.connect(this.musicGain);
      osc.start(t0); osc.stop(t0 + stepDur);
      // 踩镲（噪声）
      if (step % 2 === 1) {
        const len = Math.floor(this.ctx!.sampleRate * 0.03);
        const buf = this.ctx!.createBuffer(1, len, this.ctx!.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const s = this.ctx!.createBufferSource();
        s.buffer = buf;
        const hg = this.ctx!.createGain();
        hg.gain.value = 0.25;
        const f = this.ctx!.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = 8000;
        s.connect(f); f.connect(hg); hg.connect(this.musicGain);
        s.start(t0);
      }
      this.musicStep++;
    }, stepDur * 1000);
  }

  stopMusic() {
    this.pendingMusicBpm = null;
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }
}
