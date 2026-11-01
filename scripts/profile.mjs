// Builds the app twice (with and without dynamic holes) under Node's CPU
// profiler, then reports how much of the static-generation workers' CPU runs
// under React's DetermineComponentFrameRoot (component stack construction).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = join(import.meta.dirname, '..');
const nextBin = join(root, 'node_modules/next/dist/bin/next');
const preload = join(import.meta.dirname, 'sigint-exit.cjs');
const TARGET = 'DetermineComponentFrameRoot';

const runs = [
  { name: 'with holes', holes: '1' },
  { name: 'without holes', holes: '0' },
];

const results = [];
for (const run of runs) {
  const profileDir = join(root, 'profiles', run.name.replace(' ', '-'));
  rmSync(join(root, '.next'), { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });

  console.log(`\n> HOLES=${run.holes} next build`);
  // Its own process group, so we can wait for the workers too: they write
  // their profiles while exiting, after `next build` itself has returned.
  const build = spawn(process.execPath, [nextBin, 'build'], {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: {
      ...process.env,
      HOLES: run.holes,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)} --cpu-prof --cpu-prof-dir=${JSON.stringify(profileDir)}`,
    },
  });
  const forwardInterrupt = () => process.kill(-build.pid, 'SIGINT');
  process.on('SIGINT', forwardInterrupt);
  const exitCode = await new Promise((resolve) => build.on('exit', resolve));
  while (isGroupAlive(build.pid)) await sleep(100);
  process.off('SIGINT', forwardInterrupt);
  if (exitCode !== 0) throw new Error(`next build failed (${run.name})`);

  const workers = readdirSync(profileDir)
    .filter((file) => file.endsWith('.cpuprofile'))
    .map((file) => analyze(JSON.parse(readFileSync(join(profileDir, file), 'utf8'))))
    .filter((profile) => profile.isStaticWorker);
  if (workers.length === 0) throw new Error(`no static generation worker profiles in ${profileDir}`);

  results.push({
    name: run.name,
    workers: workers.length,
    cpuUs: sum(workers.map((w) => w.cpuUs)),
    targetUs: sum(workers.map((w) => w.targetUs)),
    callers: merge(workers.map((w) => w.callers)),
    selfUnderTarget: merge(workers.map((w) => w.selfUnderTarget)),
  });
}

console.log('\nStatic generation workers (CPU from Node --cpu-prof, idle excluded)\n');
console.log(
  table([
    ['build', 'workers', 'worker CPU', `under ${TARGET}`, 'share'],
    ...results.map((r) => [r.name, String(r.workers), ms(r.cpuUs), ms(r.targetUs), pct(r.targetUs, r.cpuUs)]),
  ]),
);

const [withHoles] = results;
console.log(`\nCallers of ${TARGET} (${withHoles.name}), innermost first:\n`);
printTop(withHoles.callers, withHoles.targetUs, Infinity);
console.log(`\nSelf time under ${TARGET} (${withHoles.name}), share of all worker CPU:\n`);
printTop(withHoles.selfUnderTarget, withHoles.cpuUs, 6);

function analyze(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

  const isStaticWorker = profile.nodes.some((node) => node.callFrame.url.includes('/next/dist/export/worker.js'));

  // For each node: the outermost TARGET frame above it (or itself), if any.
  const targetAncestor = new Map();
  const visit = (id, current) => {
    const node = byId.get(id);
    const found = current ?? (node.callFrame.functionName === TARGET ? id : undefined);
    targetAncestor.set(id, found);
    for (const child of node.children ?? []) visit(child, found);
  };
  visit(profile.nodes[0].id, undefined);

  const describe = (id) => {
    const { functionName, url, lineNumber, columnNumber } = byId.get(id).callFrame;
    const where = url ? ` (${basename(url)}:${lineNumber + 1}:${columnNumber + 1})` : '';
    return `${functionName || '(anonymous)'}${where}`;
  };

  let cpuUs = 0;
  let targetUs = 0;
  const callers = new Map();
  const selfUnderTarget = new Map();
  profile.samples.forEach((id, i) => {
    const us = profile.timeDeltas[i] ?? 0;
    if (byId.get(id).callFrame.functionName === '(idle)') return;
    cpuUs += us;
    const target = targetAncestor.get(id);
    if (target === undefined) return;
    targetUs += us;
    add(selfUnderTarget, describe(id), us);
    // Up to the first onError, with recursive frames collapsed.
    const chain = [];
    for (let p = parent.get(target); p !== undefined && chain.length < 8; p = parent.get(p)) {
      const frame = describe(p);
      if (frame !== chain.at(-1)) chain.push(frame);
      if (byId.get(p).callFrame.functionName === 'onError') break;
    }
    add(callers, chain.join(' <- '), us);
  });

  return { isStaticWorker, cpuUs, targetUs, callers, selfUnderTarget };
}

function add(map, key, us) {
  map.set(key, (map.get(key) ?? 0) + us);
}

function merge(maps) {
  const merged = new Map();
  for (const map of maps) for (const [key, us] of map) add(merged, key, us);
  return merged;
}

function printTop(map, whole, limit) {
  const top = [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [key, us] of top) console.log(`  ${pct(us, whole).padStart(6)}  ${key}`);
}

function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function ms(us) {
  return `${(us / 1000).toFixed(0)} ms`;
}

function pct(part, whole) {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()).join('\n');
}
