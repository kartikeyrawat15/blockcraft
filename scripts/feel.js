import * as THREE from 'three';
import { blocks } from './blocks';

const SPRINT_FOV_BOOST = 8; // degrees
const BOB_AMPLITUDE = 0.04; // world units at strength 1
const BOB_FREQUENCY = 1.4; // bob phase advanced per world unit travelled
const POP_DURATION = 0.15; // seconds
const PARTICLE_POOL_SIZE = 48;
const PARTICLE_SIZE = 0.15;
const PARTICLE_GRAVITY = 18;

const blocksById = Object.fromEntries(Object.values(blocks).map((b) => [b.id, b]));

/**
 * Small "game feel" effects: sprint FOV, head bob, target outline,
 * placement pop and break particles
 */
export class Feel {
  params = {
    sprintFov: true,
    headBob: true,
    headBobStrength: 1,
    outline: true,
    placePop: true,
    breakParticles: true
  };

  bobPhase = 0;
  bobAmount = 0; // 0..1 envelope, eases in/out with movement
  bobOffset = new THREE.Vector3();

  pops = [];

  /**
   * @param {THREE.Scene} scene
   * @param {import('./player').Player} player
   * @param {import('./world').World} world
   */
  constructor(scene, player, world) {
    this.player = player;
    this.world = world;
    this.baseFov = player.camera.fov;

    // Thin black outline around the targeted block
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000 })
    );
    this.outline.visible = false;
    scene.add(this.outline);

    // Pool of particle meshes; each has its own geometry (for per-particle UVs)
    // and material (for per-particle fading)
    this.particles = [];
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(PARTICLE_SIZE, PARTICLE_SIZE, PARTICLE_SIZE),
        new THREE.MeshLambertMaterial({ transparent: true })
      );
      mesh.visible = false;
      scene.add(mesh);
      const baseUv = mesh.geometry.attributes.uv.array.slice();
      this.particles.push({ mesh, baseUv, velocity: new THREE.Vector3(), age: 0, life: 0 });
    }
    this.nextParticle = 0;

    player.onBlockPlaced = (x, y, z) => {
      if (this.params.placePop) this.pops.push({ x, y, z, age: 0 });
    };
    player.onBlockBroken = (x, y, z, blockId) => {
      if (this.params.breakParticles) this.spawnParticles(x, y, z, blockId);
    };
  }

  /**
   * Updates effects. Only called while the game is running.
   * @param {number} dt
   */
  update(dt) {
    dt = Math.min(dt, 0.1);
    this.updateFov(dt);
    this.updateBob(dt);
    this.updateOutline();
    this.updatePops(dt);
    this.updateParticles(dt);
  }

  get isMoving() {
    return this.player.input.x !== 0 || this.player.input.z !== 0;
  }

  updateFov(dt) {
    const camera = this.player.camera;
    const sprinting = this.params.sprintFov && this.player.sprinting && this.isMoving;
    const target = this.baseFov + (sprinting ? SPRINT_FOV_BOOST : 0);
    if (Math.abs(camera.fov - target) > 0.01) {
      camera.fov += (target - camera.fov) * (1 - Math.exp(-10 * dt));
      camera.updateProjectionMatrix();
    }
  }

  updateBob(dt) {
    const player = this.player;
    const walking = this.params.headBob && this.isMoving && player.onGround;
    this.bobAmount += ((walking ? 1 : 0) - this.bobAmount) * (1 - Math.exp(-8 * dt));

    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    this.bobPhase += speed * dt * BOB_FREQUENCY;

    // Vertical bounce twice per stride, gentle sideways sway once per stride
    const amplitude = BOB_AMPLITUDE * this.params.headBobStrength * this.bobAmount;
    // Sway along the camera's horizontal right axis
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(player.camera.quaternion);
    right.y = 0;
    right.normalize();
    this.bobOffset.copy(right).multiplyScalar(Math.sin(this.bobPhase) * amplitude * 0.5);
    this.bobOffset.y = Math.abs(Math.sin(this.bobPhase)) * amplitude;
  }

  /**
   * Temporarily offsets the player camera for head bob. The camera position is
   * also the player's physics position, so the offset is only applied for rendering.
   */
  beginRender() {
    this.player.camera.position.add(this.bobOffset);
  }

  endRender() {
    this.player.camera.position.sub(this.bobOffset);
  }

  updateOutline() {
    const target = this.player.targetCoords;
    this.outline.visible = this.params.outline && !!target;
    if (target) this.outline.position.copy(target);
  }

  updatePops(dt) {
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    this.pops = this.pops.filter((pop) => {
      pop.age += dt;
      const t = Math.min(pop.age / POP_DURATION, 1);

      // Ease-out-back from 0.6 to 1 with a slight overshoot
      const c = 1.7;
      const e = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
      const s = 0.6 + 0.4 * e;

      // Look the instance up every frame since instance ids can be swapped
      const coords = this.world.worldToChunkCoords(pop.x, pop.y, pop.z);
      const chunk = this.world.getChunk(coords.chunk.x, coords.chunk.z);
      const block = chunk?.getBlock(coords.block.x, coords.block.y, coords.block.z);
      if (!block || block.instanceId === null || block.id === blocks.empty.id) return false;

      const mesh = chunk.children.find((m) => m.name === block.id);
      if (!mesh) return false;

      scale.setScalar(t >= 1 ? 1 : s);
      matrix.compose(new THREE.Vector3(coords.block.x, coords.block.y, coords.block.z), quaternion, scale);
      mesh.setMatrixAt(block.instanceId, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      return t < 1;
    });
  }

  spawnParticles(x, y, z, blockId) {
    const block = blocksById[blockId];
    if (!block?.material) return;

    // Use the side texture for multi-material blocks
    const source = Array.isArray(block.material) ? block.material[0] : block.material;
    const count = 8 + Math.floor(Math.random() * 5);

    for (let i = 0; i < count; i++) {
      const p = this.particles[this.nextParticle];
      this.nextParticle = (this.nextParticle + 1) % this.particles.length;

      const material = p.mesh.material;
      const map = source.map ?? null;
      if (!!material.map !== !!map) material.needsUpdate = true;
      material.map = map;
      material.color.copy(source.color);
      material.opacity = 1;

      // Show a random 4x4-pixel patch of the 16px texture on every face
      const u = Math.floor(Math.random() * 4) / 4;
      const v = Math.floor(Math.random() * 4) / 4;
      const uv = p.mesh.geometry.attributes.uv;
      for (let j = 0; j < uv.count; j++) {
        uv.setXY(j, u + p.baseUv[j * 2] * 0.25, v + p.baseUv[j * 2 + 1] * 0.25);
      }
      uv.needsUpdate = true;

      p.mesh.position.set(
        x + (Math.random() - 0.5) * 0.6,
        y + (Math.random() - 0.5) * 0.6,
        z + (Math.random() - 0.5) * 0.6
      );
      p.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      p.velocity.set(
        (Math.random() - 0.5) * 3,
        2 + Math.random() * 3,
        (Math.random() - 0.5) * 3
      );
      p.age = 0;
      p.life = 0.6 + Math.random() * 0.4;
      p.mesh.visible = true;
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      if (!p.mesh.visible) continue;

      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.visible = false;
        continue;
      }

      p.velocity.y -= PARTICLE_GRAVITY * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);

      // Rest on top of solid blocks (blocks are centered on integer coordinates)
      const pos = p.mesh.position;
      const below = this.world.getBlock(Math.round(pos.x), Math.round(pos.y - PARTICLE_SIZE / 2), Math.round(pos.z));
      if (below && below.id !== blocks.empty.id && p.velocity.y < 0) {
        pos.y = Math.round(pos.y - PARTICLE_SIZE / 2) + 0.5 + PARTICLE_SIZE / 2;
        p.velocity.set(p.velocity.x * 0.5, 0, p.velocity.z * 0.5);
      }

      // Fade out over the last 40% of the lifetime
      p.mesh.material.opacity = Math.min(1, (p.life - p.age) / (p.life * 0.4));
    }
  }
}
