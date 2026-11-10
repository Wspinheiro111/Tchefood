#!/usr/bin/env node
/**
 * Gera o modelo 3D de DEMONSTRAÇÃO do cardápio em realidade aumentada:
 * uma Pizza Calabresa de 35 cm em tamanho real (1 unidade = 1 metro, padrão glTF).
 *
 * Saídas:
 *  - public/ar/pizza-calabresa.glb  → o modelo, com a animação "explodir"
 *    (cada camada sobe para o cliente ver o que vem na pizza).
 *  - src/lib/ar/pizzaDemo.ts        → os itens da pizza com a posição da etiqueta
 *    na vista "explodida" (mesmos números usados na animação).
 *
 * É só uma demonstração feita com formas simples. Para o cardápio de verdade, cada prato
 * precisa do seu próprio modelo 3D (fotogrametria pelo celular ou artista 3D): ver
 * docs/cardapio-ar.md.
 *
 * Uso: node scripts/gerar-pizza-ar.mjs   (sem dependências)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Geometria (y para cima, base do objeto em y = 0)
// ---------------------------------------------------------------------------
function cylinder(r, h, seg = 64) {
  const pos = [];
  const nor = [];
  const idx = [];
  // lateral
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    pos.push(r * x, 0, r * z, r * x, h, r * z);
    nor.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  // tampas
  for (const [y, ny] of [[h, 1], [0, -1]]) {
    const c = pos.length / 3;
    pos.push(0, y, 0);
    nor.push(0, ny, 0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(r * Math.cos(a), y, r * Math.sin(a));
      nor.push(0, ny, 0);
    }
    for (let i = 0; i < seg; i++) {
      if (ny > 0) idx.push(c, c + i + 2, c + i + 1);
      else idx.push(c, c + i + 1, c + i + 2);
    }
  }
  return { pos, nor, idx };
}

function torus(R, r, segR = 64, segT = 16) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= segR; i++) {
    const u = (i / segR) * Math.PI * 2;
    for (let j = 0; j <= segT; j++) {
      const v = (j / segT) * Math.PI * 2;
      const nx = Math.cos(v) * Math.cos(u);
      const ny = Math.sin(v);
      const nz = Math.cos(v) * Math.sin(u);
      pos.push((R + r * Math.cos(v)) * Math.cos(u), r + r * ny, (R + r * Math.cos(v)) * Math.sin(u));
      nor.push(nx, ny, nz);
    }
  }
  const row = segT + 1;
  for (let i = 0; i < segR; i++) {
    for (let j = 0; j < segT; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return { pos, nor, idx };
}

function sphere(r, sx = 1, sy = 1, sz = 1, seg = 20) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const p = (j / seg) * Math.PI * 2;
      const x = Math.sin(t) * Math.cos(p);
      const y = Math.cos(t);
      const z = Math.sin(t) * Math.sin(p);
      pos.push(r * sx * x, r * sy * (y + 1), r * sz * z);
      const n = Math.hypot(x / sx, y / sy, z / sz) || 1;
      nor.push(x / sx / n, y / sy / n, z / sz / n);
    }
  }
  const row = seg + 1;
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { pos, nor, idx };
}

// ---------------------------------------------------------------------------
// A pizza: camadas de baixo para cima, alturas em metros
// ---------------------------------------------------------------------------
const MASSA_H = 0.008;
const RAIO = 0.175; // 35 cm de diâmetro
const EXPLODE_STEP = 0.05; // cada camada sobe 5 cm a mais que a de baixo

function ring(n, radius, phase = 0) {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return [radius * Math.cos(a), radius * Math.sin(a)];
  });
}

const calabresaSpots = [...ring(7, 0.115, 0.2), ...ring(4, 0.055, 0.9), [0, 0]];
const cebolaSpots = [...ring(6, 0.085, 0.6), ...ring(3, 0.135, 1.4)];
const azeitonaSpots = [...ring(6, 0.1, 0.0), ...ring(4, 0.035, 0.4)];

const LAYERS = [
  {
    key: 'massa',
    label: 'Massa de longa fermentação',
    detail: 'Disco de 35 cm com borda dourada',
    color: [0.86, 0.68, 0.42, 1],
    parts: [
      { geo: cylinder(RAIO - 0.006, MASSA_H), at: [0, 0, 0] },
      { geo: torus(RAIO - 0.012, 0.012), at: [0, 0, 0], color: [0.72, 0.45, 0.18, 1] },
    ],
    top: 0.024,
  },
  { key: 'molho', label: 'Molho de tomate', detail: 'Tomate pelado e manjericão', color: [0.62, 0.11, 0.08, 1], parts: [{ geo: cylinder(0.152, 0.002), at: [0, MASSA_H, 0] }], top: MASSA_H + 0.002 },
  { key: 'mussarela', label: 'Mussarela', detail: '200 g, gratinada', color: [0.97, 0.88, 0.58, 1], parts: [{ geo: cylinder(0.148, 0.003), at: [0, MASSA_H + 0.002, 0] }], top: MASSA_H + 0.005 },
  {
    key: 'calabresa',
    label: 'Calabresa fatiada',
    detail: `${calabresaSpots.length} rodelas defumadas`,
    color: [0.6, 0.16, 0.13, 1],
    parts: calabresaSpots.map(([x, z]) => ({ geo: cylinder(0.021, 0.004, 32), at: [x, MASSA_H + 0.005, z] })),
    top: MASSA_H + 0.009,
  },
  {
    key: 'cebola',
    label: 'Cebola em anéis',
    detail: 'Cebola roxa fresca',
    color: [0.93, 0.86, 0.9, 1],
    parts: cebolaSpots.map(([x, z]) => ({ geo: torus(0.016, 0.0025, 32, 8), at: [x, MASSA_H + 0.009, z] })),
    top: MASSA_H + 0.014,
  },
  {
    key: 'azeitona',
    label: 'Azeitonas pretas',
    detail: `${azeitonaSpots.length} unidades`,
    color: [0.13, 0.11, 0.1, 1],
    parts: azeitonaSpots.map(([x, z]) => ({ geo: sphere(0.0075, 1, 0.8, 1, 14), at: [x, MASSA_H + 0.009, z] })),
    top: MASSA_H + 0.021,
  },
];

// ---------------------------------------------------------------------------
// Escritor GLB (glTF 2.0 binário) mínimo
// ---------------------------------------------------------------------------
const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];

function addView(typed, target) {
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    byteLength += pad;
  }
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.length, ...(target ? { target } : {}) });
  chunks.push(buf);
  byteLength += buf.length;
  return bufferViews.length - 1;
}

function addAccessor(typed, type, componentType, count, target, withBounds) {
  const view = addView(typed, target);
  const acc = { bufferView: view, componentType, count, type };
  if (withBounds) {
    const n = { SCALAR: 1, VEC3: 3 }[type];
    const min = Array(n).fill(Infinity);
    const max = Array(n).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < n; k++) {
        const v = typed[i * n + k];
        min[k] = Math.min(min[k], v);
        max[k] = Math.max(max[k], v);
      }
    }
    acc.min = min.map((v) => Math.fround(v));
    acc.max = max.map((v) => Math.fround(v));
  }
  accessors.push(acc);
  return accessors.length - 1;
}

const materials = [];
function material(name, color) {
  const key = color.join(',');
  const found = materials.findIndex((m) => m.pbrMetallicRoughness.baseColorFactor.join(',') === key);
  if (found >= 0) return found;
  materials.push({ name, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.85 } });
  return materials.length - 1;
}

const meshes = [];
const meshCache = new Map();
function mesh(name, geo, mat) {
  const cacheKey = `${JSON.stringify(geo.pos.slice(0, 9))}|${geo.pos.length}|${mat}`;
  if (meshCache.has(cacheKey)) return meshCache.get(cacheKey);
  const count = geo.pos.length / 3;
  const pos = addAccessor(new Float32Array(geo.pos), 'VEC3', 5126, count, 34962, true);
  const nor = addAccessor(new Float32Array(geo.nor), 'VEC3', 5126, count, 34962, false);
  const big = count > 65535;
  const ind = addAccessor(big ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx), 'SCALAR', big ? 5125 : 5123, geo.idx.length, 34963, false);
  meshes.push({ name, primitives: [{ attributes: { POSITION: pos, NORMAL: nor }, indices: ind, material: mat }] });
  meshCache.set(cacheKey, meshes.length - 1);
  return meshes.length - 1;
}

const nodes = [{ name: 'Pizza Calabresa', children: [] }];
const channels = [];
const samplers = [];
const DURATION = 1.2;
const times = addAccessor(new Float32Array([0, DURATION]), 'SCALAR', 5126, 2, undefined, true);
const components = [];

LAYERS.forEach((layer, i) => {
  const lift = i * EXPLODE_STEP;
  const layerNode = { name: layer.label, children: [], translation: [0, 0, 0] };
  nodes.push(layerNode);
  const layerIndex = nodes.length - 1;
  nodes[0].children.push(layerIndex);
  layer.parts.forEach((part, j) => {
    const m = mesh(`${layer.key}-${j}`, part.geo, material(layer.key, part.color ?? layer.color));
    nodes.push({ name: `${layer.key}-${j}`, mesh: m, translation: part.at });
    layerNode.children.push(nodes.length - 1);
  });
  const values = addAccessor(new Float32Array([0, 0, 0, 0, lift, 0]), 'VEC3', 5126, 2, undefined, false);
  samplers.push({ input: times, output: values, interpolation: 'LINEAR' });
  channels.push({ sampler: samplers.length - 1, target: { node: layerIndex, path: 'translation' } });
  // Etiqueta: na camada já levantada, alternando os lados para não encavalar.
  const side = i % 2 === 0 ? 1 : -1;
  const labelX = side * (i === 0 ? RAIO - 0.01 : 0.09);
  components.push({ key: layer.key, label: layer.label, detail: layer.detail, position: [labelX, layer.top + lift, 0].map((v) => Number(v.toFixed(4))) });
});

const gltf = {
  asset: { version: '2.0', generator: 'tche-food/scripts/gerar-pizza-ar.mjs' },
  scene: 0,
  scenes: [{ name: 'Pizza Calabresa 35 cm', nodes: [0] }],
  nodes,
  meshes,
  materials,
  animations: [{ name: 'explodir', samplers, channels }],
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};

const bin = Buffer.concat(chunks);
const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // glTF
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(json.length, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4); // JSON
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binPadded.length, 0);
binHead.writeUInt32LE(0x004e4942, 4); // BIN

const glbPath = join(ROOT, 'public', 'ar', 'pizza-calabresa.glb');
mkdirSync(dirname(glbPath), { recursive: true });
writeFileSync(glbPath, Buffer.concat([header, jsonHead, json, binHead, binPadded]));

const tsPath = join(ROOT, 'src', 'lib', 'ar', 'pizzaDemo.ts');
mkdirSync(dirname(tsPath), { recursive: true });
writeFileSync(
  tsPath,
  `// Gerado por scripts/gerar-pizza-ar.mjs — não editar à mão.\n` +
    `/** Itens da pizza de demonstração e a posição (metros) da etiqueta na vista explodida. */\n` +
    `export const PIZZA_DEMO_GLB = 'ar/pizza-calabresa.glb';\n` +
    `export const PIZZA_DEMO_DIAMETER_CM = ${RAIO * 200};\n` +
    `export const PIZZA_DEMO_EXPLODE_ANIMATION = 'explodir';\n` +
    `export const PIZZA_DEMO_COMPONENTS = ${JSON.stringify(components, null, 2)} as const;\n`,
);

console.log(`GLB: ${glbPath} (${(byteLength / 1024).toFixed(0)} KB de geometria, ${components.length} itens)`);
