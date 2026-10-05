import * as THREE from 'three';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { RNG } from './rng';
import { blocks } from './blocks';

const DAY_SKY = new THREE.Color(0x80a0e0);
const NIGHT_SKY = new THREE.Color(0x0c1430);
const SUNSET_SKY = new THREE.Color(0xe0905a);
const RAIN_SKY = new THREE.Color(0x6a7280);
const DAY_AMBIENT = new THREE.Color(0xffffff);
const NIGHT_AMBIENT = new THREE.Color(0x8090c0);
const SUN_LIGHT = new THREE.Color(0xffffff);
const MOON_LIGHT = new THREE.Color(0x9db4ff);
const DAY_CLOUD = new THREE.Color(0xffffff);
const NIGHT_CLOUD = new THREE.Color(0x3a4258);
// Daytime color of the terrain cloud blocks (shared material across all chunks)
const BLOCK_CLOUD_DAY = blocks.cloud.material.color.clone();

// Light direction used when the day/night cycle is off (matches the original fixed sun)
const FIXED_SUN_DIR = new THREE.Vector3(1, 1, 1).normalize();

// Distances must stay inside the player camera's far plane (100)
const SUN_DISTANCE = 85;
const STAR_DISTANCE = 92;
const CLOUD_HEIGHT = 48;
const CLOUD_CELL = 8;
const CLOUD_RADIUS = 10; // cells in each direction around the player
const CLOUD_SPEED = 1; // units per second along +X

/**
 * Builds a NearestFilter canvas texture for a blocky sun/moon
 * @param {(ctx: CanvasRenderingContext2D) => void} draw Draws on a 16x16 canvas
 */
function pixelTexture(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  draw(canvas.getContext('2d'));
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Day/night cycle, sun and moon, stars and drifting clouds
 */
export class Sky {
  params = {
    dayNight: true,
    cycleLength: 5,
    clouds: true,
    stars: true
  };

  /**
   * Time of day in [0, 1): 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight
   */
  time = 0.05;

  /**
   * 0 at night, 1 during the day (read by other systems, e.g. fireflies)
   */
  day = 1;

  /**
   * 0..1 amount of rain cover, set by Weather. Darkens the sky and sunlight.
   */
  overcast = 0;

  cloudDrift = 0;
  cloudAnchor = { x: NaN, z: NaN };

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.DirectionalLight} sunLight
   * @param {THREE.AmbientLight} ambientLight
   */
  constructor(scene, renderer, sunLight, ambientLight) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.ambientLight = ambientLight;

    // Sun, moon and stars follow the camera so they always appear infinitely far away
    this.celestial = new THREE.Group();
    scene.add(this.celestial);

    this.sun = this.createBody(20, pixelTexture((ctx) => {
      ctx.fillStyle = '#ffd84a';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#fff3a0';
      ctx.fillRect(3, 3, 10, 10);
      ctx.fillStyle = '#ffffe8';
      ctx.fillRect(5, 5, 6, 6);
    }));

    this.moon = this.createBody(14, pixelTexture((ctx) => {
      ctx.fillStyle = '#d8dce8';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#a8aec0';
      ctx.fillRect(3, 3, 4, 4);
      ctx.fillRect(10, 6, 3, 3);
      ctx.fillRect(5, 10, 4, 3);
      ctx.fillRect(12, 12, 2, 2);
    }));

    this.stars = this.createStars(700);
    this.celestial.add(this.stars);

    this.clouds = this.createClouds();
    scene.add(this.clouds);
  }

  createBody(size, texture) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: texture, fog: false })
    );
    this.celestial.add(mesh);
    return mesh;
  }

  createStars(count) {
    const rng = new RNG(1337);
    const positions = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // Uniformly distributed points on a sphere
      const y = rng.random() * 2 - 1;
      const theta = rng.random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      v.set(r * Math.cos(theta), y, r * Math.sin(theta)).multiplyScalar(STAR_DISTANCE);
      v.toArray(positions, i * 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Points render as squares, which suits the blocky style
    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2 * window.devicePixelRatio,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false
    });
    return new THREE.Points(geometry, material);
  }

  createClouds() {
    const geometry = new THREE.BoxGeometry(CLOUD_CELL, 2, CLOUD_CELL);

    // Bake simple face shading (top brightest, bottom darkest) into vertex colors
    // Face order: +x, -x, +y, -y, +z, -z (4 vertices each)
    const shades = [0.9, 0.9, 1.0, 0.75, 0.85, 0.85];
    const colors = [];
    for (const shade of shades) {
      for (let i = 0; i < 4; i++) colors.push(shade, shade, shade);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const size = CLOUD_RADIUS * 2 + 1;
    this.cloudMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(geometry, this.cloudMaterial, size * size);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.position.y = CLOUD_HEIGHT;

    this.cloudNoise = new SimplexNoise(new RNG(4242));
    return mesh;
  }

  /**
   * Rebuilds cloud instances around the given cell (in cloud space, which drifts along +X)
   */
  rebuildClouds(anchorX, anchorZ) {
    const matrix = new THREE.Matrix4();
    let count = 0;
    for (let dx = -CLOUD_RADIUS; dx <= CLOUD_RADIUS; dx++) {
      for (let dz = -CLOUD_RADIUS; dz <= CLOUD_RADIUS; dz++) {
        const cx = anchorX + dx;
        const cz = anchorZ + dz;
        if (this.cloudNoise.noise(cx / 6, cz / 6) > 0.35) {
          matrix.makeTranslation(cx * CLOUD_CELL, 0, cz * CLOUD_CELL);
          this.clouds.setMatrixAt(count++, matrix);
        }
      }
    }
    this.clouds.count = count;
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {number} dt Seconds since last frame
   * @param {THREE.Camera} camera The camera currently rendering
   * @param {boolean} running Whether the game is running (time only advances while playing)
   */
  update(dt, camera, running) {
    if (running && this.params.dayNight) {
      this.time = (this.time + dt / (this.params.cycleLength * 60)) % 1;
    }

    // Sun travels east (+X) -> overhead -> west, tilted slightly toward +Z
    const angle = this.time * Math.PI * 2;
    const sunDir = this.params.dayNight
      ? new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.35).normalize()
      : FIXED_SUN_DIR.clone();
    const moonDir = sunDir.clone().negate();
    const h = sunDir.y;

    // 0 at night, 1 during the day, smooth transition around the horizon
    const day = THREE.MathUtils.smoothstep(h, -0.2, 0.2);
    this.day = day;
    const sunset = Math.max(0, 1 - Math.abs(h) / 0.3) * 0.6;

    const skyColor = NIGHT_SKY.clone().lerp(DAY_SKY, day).lerp(SUNSET_SKY, sunset);
    const rainSky = NIGHT_SKY.clone().lerp(RAIN_SKY, day);
    skyColor.lerp(rainSky, this.overcast * 0.6);
    this.renderer.setClearColor(skyColor);
    if (this.scene.fog) this.scene.fog.color.copy(skyColor);

    // A single directional light follows the sun by day and the moon by night,
    // fading out near the horizon so the direction swap isn't visible
    const lightDir = h >= 0 ? sunDir : moonDir;
    const horizonFade = THREE.MathUtils.smoothstep(Math.abs(h), 0, 0.15);
    this.sunLight.intensity = (h >= 0 ? 1.5 : 0.4) * horizonFade * (1 - 0.35 * this.overcast);
    this.sunLight.color.copy(h >= 0 ? SUN_LIGHT : MOON_LIGHT);
    this.sunLight.position.copy(camera.position).addScaledVector(lightDir, 70);
    this.sunLight.target.position.copy(camera.position);

    // Ambient stays fairly high at night so the world remains playable
    this.ambientLight.intensity = THREE.MathUtils.lerp(0.5, 0.2, day);
    this.ambientLight.color.copy(NIGHT_AMBIENT).lerp(DAY_AMBIENT, day);

    // Sun, moon and stars
    this.celestial.position.copy(camera.position);
    this.placeBody(this.sun, sunDir, camera);
    this.placeBody(this.moon, moonDir, camera);
    this.moon.visible = this.params.dayNight && moonDir.y > -0.1;

    this.stars.visible = this.params.stars && this.params.dayNight;
    this.stars.material.opacity = (1 - THREE.MathUtils.smoothstep(h, -0.25, 0.05)) * (1 - this.overcast);
    this.stars.rotation.z = angle;

    // Clouds
    this.clouds.visible = this.params.clouds;
    this.cloudMaterial.color.copy(NIGHT_CLOUD).lerp(DAY_CLOUD, day);
    blocks.cloud.material.color.copy(NIGHT_CLOUD).lerp(BLOCK_CLOUD_DAY, day);
    // Rain clouds are a bit greyer
    this.cloudMaterial.color.multiplyScalar(1 - 0.25 * this.overcast);
    blocks.cloud.material.color.multiplyScalar(1 - 0.25 * this.overcast);
    if (running) this.cloudDrift += CLOUD_SPEED * dt;
    this.clouds.position.x = this.cloudDrift;
    const anchorX = Math.floor((camera.position.x - this.cloudDrift) / CLOUD_CELL);
    const anchorZ = Math.floor(camera.position.z / CLOUD_CELL);
    if (anchorX !== this.cloudAnchor.x || anchorZ !== this.cloudAnchor.z) {
      this.cloudAnchor = { x: anchorX, z: anchorZ };
      this.rebuildClouds(anchorX, anchorZ);
    }
  }

  placeBody(mesh, dir, camera) {
    mesh.visible = dir.y > -0.1;
    mesh.position.copy(dir).multiplyScalar(SUN_DISTANCE);
    mesh.lookAt(camera.position);
  }
}
