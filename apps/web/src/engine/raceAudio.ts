type AudioContextConstructor = typeof AudioContext;

interface AudioWindow extends Window {
  webkitAudioContext?: AudioContextConstructor;
}

export class RaceAudio {
  private context: AudioContext | undefined;
  private engine: OscillatorNode | undefined;
  private engineGain: GainNode | undefined;
  private tire: OscillatorNode | undefined;
  private tireGain: GainNode | undefined;

  unlock(): void {
    const context = this.ensureContext();
    if (context?.state === "suspended") void context.resume();
  }

  countdown(light: number): void {
    this.tone(220 + light * 36, 0.11, 0.075, "square");
  }

  green(): void {
    this.tone(660, 0.22, 0.12, "sawtooth", 880);
  }

  checkpoint(): void {
    this.tone(740, 0.12, 0.07, "sine", 980);
  }

  collision(): void {
    this.tone(82, 0.18, 0.13, "sawtooth", 42);
  }

  positionGained(): void {
    this.tone(520, 0.1, 0.055, "triangle", 680);
  }

  finish(): void {
    [0, 0.11, 0.22, 0.36].forEach((delay, index) =>
      this.tone(
        [523, 659, 784, 1047][index]!,
        0.24,
        0.08,
        "triangle",
        undefined,
        delay,
      ),
    );
  }

  update(
    speedKph: number,
    throttle: number,
    steering: number,
    braking: boolean,
  ) {
    const context = this.context;
    if (!context || context.state !== "running") return;
    this.ensureLoops(context);
    const now = context.currentTime;
    const engineLevel = 0.012 + Math.min(0.045, Math.abs(throttle) * 0.028);
    this.engine!.frequency.setTargetAtTime(58 + speedKph * 2.2, now, 0.055);
    this.engineGain!.gain.setTargetAtTime(engineLevel, now, 0.045);
    const slip = Math.min(
      1,
      (Math.abs(steering) * Math.max(0, speedKph - 18)) / 46 +
        (braking && speedKph > 14 ? 0.55 : 0),
    );
    this.tire!.frequency.setTargetAtTime(115 + speedKph * 3, now, 0.04);
    this.tireGain!.gain.setTargetAtTime(slip * 0.018, now, 0.04);
  }

  stopRace(): void {
    const now = this.context?.currentTime ?? 0;
    this.engineGain?.gain.setTargetAtTime(0, now, 0.04);
    this.tireGain?.gain.setTargetAtTime(0, now, 0.04);
  }

  dispose(): void {
    this.engine?.stop();
    this.tire?.stop();
    void this.context?.close();
    this.engine = undefined;
    this.tire = undefined;
    this.context = undefined;
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const Constructor =
      window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Constructor) return undefined;
    this.context = new Constructor();
    return this.context;
  }

  private ensureLoops(context: AudioContext): void {
    if (!this.engine) {
      this.engine = context.createOscillator();
      this.engine.type = "sawtooth";
      this.engineGain = context.createGain();
      this.engineGain.gain.value = 0;
      this.engine.connect(this.engineGain).connect(context.destination);
      this.engine.start();
    }
    if (!this.tire) {
      this.tire = context.createOscillator();
      this.tire.type = "square";
      this.tireGain = context.createGain();
      this.tireGain.gain.value = 0;
      this.tire.connect(this.tireGain).connect(context.destination);
      this.tire.start();
    }
  }

  private tone(
    frequency: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    endFrequency?: number,
    delay = 0,
  ): void {
    const context = this.context;
    if (!context || context.state !== "running") return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency)
      oscillator.frequency.exponentialRampToValueAtTime(
        endFrequency,
        start + duration,
      );
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}
