# BlockCraft

A Minecraft-style voxel sandbox in your browser, with a living sky, weather and fully synthesized sound.

**Live demo:** [blockcraft-rosy.vercel.app](https://blockcraft-rosy.vercel.app)



## Features

- **Procedural world:** chunked terrain with biomes, trees, ores and clouds that you can break and build on
- **Day/night cycle:** the sky colour, fog and lighting shift smoothly over an adjustable cycle, and nights stay bright enough to play
- **Sun, moon, stars and clouds:** a blocky square sun and moon cross the sky, stars fade in at night and a layer of flat blocky clouds drifts overhead
- **Rain and fireflies:** occasional light rain showers darken the sky, and glowing fireflies drift around you at night
- **Synthesized audio system:** every sound is generated live with the Web Audio API, with no audio files. It covers block, footstep, jump and landing sounds per material, birds, crickets, wind, rain, thunder and a quiet ambient pad
- **Game-feel effects:** sprint FOV, subtle head bob, a target-block outline, a pop when blocks are placed and textured break particles
- **Adjustable settings panel:** press U to tune the world, sky, weather, effects and audio volumes

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Shift | Sprint |
| Space | Jump |
| Click | Break / place block |
| 1-8 | Select block |
| 0 | Pickaxe |
| M | Mute |
| U | Toggle UI |
| R | Reset camera |
| F1 | Save game |
| F2 | Load game |
| F10 | Debug camera |

## Tech stack

- [Three.js](https://threejs.org/) for rendering
- [Vite](https://vitejs.dev/) for development and builds
- [Vercel](https://vercel.com/) for hosting

## What I changed

Everything below was added on top of the original project:

- **Start screen:** shows only the essential controls (move, jump, break/place, select block), with the full key list behind a "? Controls" toggle. Also fixed a missing line break in the original key list.
- **Day/night cycle:** sky colour, fog colour and light intensity change over an adjustable cycle (1-15 min, default 5), with a dim moonlight and raised ambient light at night.
- **Sun and moon:** blocky pixel-art squares that cross the sky, with the scene's light following them.
- **Stars:** fade in at night and turn slowly with the sky.
- **Drifting clouds:** a layer of flat, blocky clouds drifting at a fixed height, drawn as one instanced mesh. The original terrain clouds now dim at night too.
- **Rain:** showers every few minutes lasting 1-2 minutes, with falling streaks and a darker sky. They start and stop gradually.
- **Fireflies:** glowing points that drift near the player at night.
- **Game feel:** sprint FOV, head bob, a black outline on the targeted block, a scale pop on placed blocks and break particles that use the block's texture.
- **Audio:** a Web Audio system with master, effects, ambient and music volumes. It has per-material block and footstep sounds, jump and landing thuds, a sprint rustle, birds and crickets that follow the day/night cycle, wind, rain with distant thunder, UI blips and an occasional ambient pad. Press M to mute.
- **Settings panel:** new Sky, Feel and Audio folders with toggles and sliders for all of the above.
- **Sharing:** page description plus Open Graph and Twitter card tags with a preview image.

## Running locally

Requires [Node.js](https://nodejs.org/) (18 or later recommended).

```bash
npm install
npm run dev       # start the dev server
npm run build     # build for production into dist/
npm run preview   # preview the production build
```

## Credits

Based on [dgreenheck/minecraft-threejs-clone](https://github.com/dgreenheck/minecraft-threejs-clone), used with the author's permission.
