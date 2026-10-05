# BlockCraft

A Minecraft-style voxel sandbox that runs in the browser, built with [Three.js](https://threejs.org/) and [Vite](https://vitejs.dev/). Explore procedurally generated terrain, mine resources and build with blocks.

## Live demo

_Coming soon: link to be added after deployment._

## Controls

Press any key on the start screen to begin.

| Input | Action |
| --- | --- |
| Mouse | Look around |
| Left click | Break a block (pickaxe) / place the selected block |
| W A S D | Move |
| Shift | Sprint |
| Space | Jump |
| 0 | Select pickaxe |
| 1-8 | Select block (grass, dirt, stone, coal ore, iron ore, wood, leaves, sand) |
| R | Reset position |
| U | Toggle the settings panel |
| F1 | Save game |
| F2 | Load game |
| F10 | Debug (orbit) camera |

## Features

- Procedural world generation
- Biomes
- Resources (coal and iron)
- Trees and clouds
- Terrain chunking
- Terraforming (break and place blocks)
- Save/load to browser local storage
- Settings panel for tweaking world generation

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
