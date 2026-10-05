import * as THREE from 'three';

const FIREFLY_COUNT = 40;
const FIREFLY_RADIUS = 12; // horizontal distance from the player
const FIREFLY_COLOR = new THREE.Color(0xd4ff70);

const RAIN_COUNT = 800;
const RAIN_AREA = 40; // width/depth of the rain box around the camera
const RAIN_HEIGHT = 24;
const RAIN_SPEED = 18;
const RAIN_LENGTH = 0.7;
const RAIN_WIND = 0.12; // horizontal drift relative to fall speed
const RAIN_FADE_IN = 8; // seconds
const RAIN_FADE_OUT = 15; // seconds

/**
 * Night-time fireflies and occasional rain showers
 */
export class Weather {
  params = {
    fireflies: true,
    rain: true,
    // 1 = rarely (about every 20 min), 10 = often (about every 2 min)
    rainFrequency: 5
  };

  raining = false;
  rainIntensity = 0; // 0..1, eased toward the target
  rainTimer = 0; // seconds until the next state change

  /**
   * @param {THREE.Scene} scene
   * @param {import('./sky').Sky} sky
   */
  constructor(scene, sky) {
    this.sky = sky;
    this.rainTimer = this.nextRainGap();

    this.createFireflies();
    scene.add(this.fireflies);

    this.createRain();
    scene.add(this.rain);
  }

  nextRainGap() {
    const mean = (20 / this.params.rainFrequency) * 60;
    return mean * (0.5 + Math.random());
  }

  createFireflies() {
    // Blocky glow: bright 2x2 core with a dimmer square halo
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(1, 1, 6, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(2, 2, 4, 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(3, 3, 2, 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FIREFLY_COUNT * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FIREFLY_COUNT * 3), 3));

    this.fireflies = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.35,
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    this.fireflies.frustumCulled = false;
    this.fireflies.visible = false;

    // Per-firefly state: home offset, wander phases and twinkle phase
    this.fireflyState = Array.from({ length: FIREFLY_COUNT }, () => ({
      home: new THREE.Vector3(),
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.4,
      twinkle: Math.random() * Math.PI * 2,
      placed: false
    }));
  }

  placeFirefly(state, center) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 2 + Math.random() * (FIREFLY_RADIUS - 2);
    state.home.set(
      center.x + Math.cos(angle) * dist,
      center.y - 1 + Math.random() * 2.5, // roughly head height around the player
      center.z + Math.sin(angle) * dist
    );
    state.placed = true;
  }

  updateFireflies(dt, center, time) {
    // Visible at night, fewer in the rain
    const amount = this.params.fireflies ? (1 - this.sky.day) * (1 - this.rainIntensity) : 0;
    this.fireflies.visible = amount > 0.01;
    if (!this.fireflies.visible) return;

    const positions = this.fireflies.geometry.attributes.position;
    const colors = this.fireflies.geometry.attributes.color;

    this.fireflyState.forEach((s, i) => {
      const dx = s.home.x - center.x;
      const dz = s.home.z - center.z;
      if (!s.placed || dx * dx + dz * dz > FIREFLY_RADIUS * FIREFLY_RADIUS * 1.5) {
        this.placeFirefly(s, center);
      }

      // Slow, lazy wandering around the home point
      const t = time * s.speed + s.phase;
      positions.setXYZ(i,
        s.home.x + Math.sin(t) * 1.2 + Math.sin(t * 2.3) * 0.3,
        s.home.y + Math.sin(t * 1.7) * 0.5,
        s.home.z + Math.cos(t * 0.8) * 1.2
      );

      // Additive blending, so darker color = dimmer
      const glow = amount * (0.4 + 0.6 * Math.max(0, Math.sin(time * 1.5 + s.twinkle)));
      colors.setXYZ(i, FIREFLY_COLOR.r * glow, FIREFLY_COLOR.g * glow, FIREFLY_COLOR.b * glow);
    });

    positions.needsUpdate = true;
    colors.needsUpdate = true;
  }

  createRain() {
    // Each streak is one line segment (2 vertices). Drop offsets are stored once;
    // the box follows the camera and drops wrap around inside it.
    this.rainOffsets = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.rainOffsets[i * 3] = Math.random() * RAIN_AREA;
      this.rainOffsets[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
      this.rainOffsets[i * 3 + 2] = Math.random() * RAIN_AREA;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_COUNT * 6), 3));

    this.rain = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: 0xaab8d0,
      transparent: true,
      opacity: 0,
      depthWrite: false
    }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rainFall = 0;
  }

  updateRainState(dt, running) {
    if (running) {
      this.rainTimer -= dt;
      if (this.rainTimer <= 0) {
        this.raining = !this.raining;
        // Showers last 1-2 minutes
        this.rainTimer = this.raining ? 60 + Math.random() * 60 : this.nextRainGap();
      }
    }

    const target = this.params.rain && this.raining ? 1 : 0;
    const rate = target > this.rainIntensity ? 1 / RAIN_FADE_IN : 1 / RAIN_FADE_OUT;
    if (running || !this.params.rain) {
      this.rainIntensity += THREE.MathUtils.clamp(target - this.rainIntensity, -rate * dt, rate * dt);
    }

    // Darkens the sky and lighting (applied by Sky)
    this.sky.overcast = this.rainIntensity;
  }

  updateRain(dt, camera, running) {
    this.rain.visible = this.rainIntensity > 0.01;
    if (!this.rain.visible) return;

    if (running) this.rainFall += RAIN_SPEED * dt;

    // Fewer, fainter streaks while the shower starts and stops
    const active = Math.ceil(RAIN_COUNT * this.rainIntensity);
    this.rain.geometry.setDrawRange(0, active * 2);
    this.rain.material.opacity = 0.45 * Math.min(1, this.rainIntensity * 1.5);

    const half = RAIN_AREA / 2;
    const top = camera.position.y + RAIN_HEIGHT * 0.6;
    const positions = this.rain.geometry.attributes.position.array;
    const wind = RAIN_LENGTH * RAIN_WIND;

    for (let i = 0; i < active; i++) {
      const ox = this.rainOffsets[i * 3];
      const oy = this.rainOffsets[i * 3 + 1];
      const oz = this.rainOffsets[i * 3 + 2];

      // Wrap each drop into the box around the camera
      const x = camera.position.x - half + THREE.MathUtils.euclideanModulo(ox - camera.position.x, RAIN_AREA);
      const z = camera.position.z - half + THREE.MathUtils.euclideanModulo(oz - camera.position.z, RAIN_AREA);
      const y = top - THREE.MathUtils.euclideanModulo(oy + this.rainFall - camera.position.y, RAIN_HEIGHT);

      const j = i * 6;
      positions[j] = x;
      positions[j + 1] = y;
      positions[j + 2] = z;
      positions[j + 3] = x + wind;
      positions[j + 4] = y + RAIN_LENGTH;
      positions[j + 5] = z;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera The camera currently rendering
   * @param {THREE.Vector3} playerPosition
   * @param {boolean} running Whether the game is running
   */
  update(dt, camera, playerPosition, running) {
    dt = Math.min(dt, 0.1);
    this.updateRainState(dt, running);
    this.updateRain(dt, camera, running);
    this.updateFireflies(dt, playerPosition, performance.now() / 1000);
  }
}
