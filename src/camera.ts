export interface CamControl {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export class Camera {
  stream: MediaStream | null = null;
  private fullCanvas = document.createElement('canvas');
  private smallCanvas = document.createElement('canvas');

  constructor(public video: HTMLVideoElement) {}

  async start(deviceId?: string) {
    this.stop();
    if (new URLSearchParams(location.search).has('demo')) {
      this.stream = demoStream();
      this.video.srcObject = this.stream;
      await this.video.play();
      return;
    }
    // ask for more than most laptop cams have; the browser picks the closest real mode
    const size = { width: { ideal: 2560 }, height: { ideal: 1440 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { ...size, deviceId: { exact: deviceId } } : { ...size, facingMode: 'user' },
      });
    } catch (err) {
      if (!deviceId) throw err;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: size });
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.video.videoWidth) {
      await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
    }
    const track = this.stream.getVideoTracks()[0];
    try {
      const caps: any = track.getCapabilities?.() ?? {};
      const adv: any = {};
      if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
      if (caps.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
      if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
      if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    } catch {
      /* not supported */
    }
  }

  /** Image controls the webcam exposes (exposure, contrast, focus…), with current values. */
  controls(): CamControl[] {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return [];
    const caps: any = track.getCapabilities();
    const cur: any = track.getSettings();
    const out: CamControl[] = [];
    const add = (name: string, label: string) => {
      const c = caps[name];
      if (!c || typeof c.min !== 'number' || typeof c.max !== 'number' || c.max <= c.min) return;
      out.push({ name, label, min: c.min, max: c.max, step: c.step || (c.max - c.min) / 100, value: cur[name] ?? (c.min + c.max) / 2 });
    };
    add('exposureCompensation', 'Exposure');
    if (!caps.exposureCompensation && caps.exposureMode?.includes?.('manual')) add('exposureTime', 'Exposure');
    add('brightness', 'Brightness');
    add('contrast', 'Contrast');
    add('sharpness', 'Sharpness');
    if (caps.focusMode?.includes?.('manual')) add('focusDistance', 'Focus');
    return out;
  }

  async setControl(name: string, value: number) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const adv: any = { [name]: value };
    if (name === 'exposureTime') adv.exposureMode = 'manual';
    if (name === 'focusDistance') adv.focusMode = 'manual';
    await track.applyConstraints({ advanced: [adv] });
  }

  /** Back to automatic exposure / focus. */
  async resetAuto() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return;
    const caps: any = track.getCapabilities();
    const adv: any = {};
    if (caps.exposureMode?.includes?.('continuous')) adv.exposureMode = 'continuous';
    if (caps.focusMode?.includes?.('continuous')) adv.focusMode = 'continuous';
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] }).catch(() => {});
  }

  /** Full-res frame plus a downscaled copy of the *same* frame (for detection). */
  grabPair(maxWidth: number): { full: ImageData; small: ImageData } {
    const full = this.grab();
    const scale = Math.min(1, maxWidth / full.width);
    const w = Math.round(full.width * scale), h = Math.round(full.height * scale);
    const c = this.smallCanvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.fullCanvas, 0, 0, w, h);
    return { full, small: ctx.getImageData(0, 0, w, h) };
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get ready() {
    return !!this.stream && this.video.videoWidth > 0;
  }

  get width() {
    return this.video.videoWidth;
  }

  get height() {
    return this.video.videoHeight;
  }

  get deviceId(): string {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
  }

  /** Grab the current frame (unmirrored). If maxWidth is given the frame is downscaled. */
  grab(maxWidth?: number): ImageData {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = maxWidth && vw > maxWidth ? maxWidth / vw : 1;
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    const c = maxWidth ? this.smallCanvas : this.fullCanvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  static async list(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }
}

/**
 * ?demo — a fake camera (canvas stream) showing a hand-held page that wobbles,
 * leaves the frame every few seconds and comes back as the next page.
 * Used for testing without a webcam.
 */
function demoStream(): MediaStream {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const ctx = c.getContext('2d')!;
  const t0 = performance.now();
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    const cycle = 9;
    const phase = t % cycle;
    const pageNo = Math.floor(t / cycle) + 1;
    const g = ctx.createLinearGradient(0, 0, 1280, 720);
    g.addColorStop(0, '#5b5147');
    g.addColorStop(1, '#2d2a26');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#4a4038';
    ctx.beginPath();
    ctx.arc(1050, 180, 140, 0, Math.PI * 2);
    ctx.fill();
    if (phase < 7.6) {
      const still = phase > 1 ? 0.15 : 1;
      ctx.save();
      ctx.translate(640 + Math.sin(t * 2) * 6 * still, 370 + Math.cos(t * 1.7) * 5 * still);
      ctx.rotate(-0.08 + Math.sin(t) * 0.01 * still);
      ctx.transform(1, 0.03, -0.05, 1, 0, 0);
      const w = 430, h = 560;
      const pg = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      pg.addColorStop(0, '#e9e6df');
      pg.addColorStop(1, '#bdb8ad');
      ctx.fillStyle = pg;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#222';
      ctx.font = 'bold 30px Georgia, serif';
      ctx.fillText(`Demo page ${pageNo}`, -w / 2 + 34, -h / 2 + 64);
      ctx.font = '16px Georgia, serif';
      const lines = [
        'The quick brown fox jumps over the lazy dog.',
        'Hold the page still for one second and it',
        'is captured automatically, flattened and',
        'cleaned into a white document.',
        '',
        'Invoice #2049       Total: $128.40',
      ];
      lines.forEach((l, i) => ctx.fillText(l, -w / 2 + 34, -h / 2 + 120 + i * 28));
      ctx.fillStyle = '#2563eb';
      ctx.fillText('Blue pen note', -w / 2 + 34, -h / 2 + 330);
      ctx.fillStyle = 'rgba(250,204,21,0.55)';
      ctx.fillRect(-w / 2 + 30, -h / 2 + 352, 220, 22);
      ctx.fillStyle = '#222';
      ctx.fillText('Highlighted line', -w / 2 + 34, -h / 2 + 369);
      for (let i = 0; i < 5; i++) ctx.fillRect(-w / 2 + 34, -h / 2 + 410 + i * 24, w - 80 - (i % 2) * 60, 3);
      ctx.restore();
    }
    requestAnimationFrame(draw);
  };
  draw();
  return c.captureStream(30);
}
