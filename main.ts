// Room-by-room push-optimal Sokoban solver.
//
// Strategy: the generated levels are a 1-wide hallway with 1-4 rooms off it,
// each room holding 3-4 boxes and as many goals. A box pushed out of a room
// through its door can never come back, so rooms are independent: solve each
// room on its own with a push-based breadth-first search (first solved state
// found is push-optimal for that room) and stitch the room solutions together
// with player walks along the hallway. The level optimum P* is the sum of the
// rooms' optima, so this reaches P* whenever every room search finishes
// inside its deterministic node budget.
//
// Determinism: fixed iteration orders everywhere, no randomness, no wall
// clock. Search is cut off only by a node count, never by time, so two runs
// on the same input produce byte-identical output.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Deterministic work budget per room search (a node count, never time).
const MAX_STATES_PER_ROOM = 250000;
// Smaller budget for the whole-level fallback search, which is only a
// safety net when room decomposition fails.
const MAX_STATES_WHOLE_LEVEL = 50000;

// The four moves: step offsets, walk letter, push letter.
const DIRS = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever the text shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: squares from which a box can still be pushed onto some goal,
 * found by pulling boxes backwards from the goals over open floor. A box on
 * any other square is dead, so states holding one are pruned.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (y < 0 || y >= size || wall[y]) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size || wall[behind]) continue;
      if (!live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether the box just pushed onto `t` sits in a frozen 2x2 block of walls
 * and boxes with a box off its goal: such a block can never move again.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) ||
        (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Box sets pack into one number, base 512 per box (boards here stay under
// 512 squares), little-endian so unpacking returns ascending order.
const PACK_BASE = 512;
const PACK_BASE4 = PACK_BASE * PACK_BASE * PACK_BASE * PACK_BASE;

function packBoxes(boxes: number[]): number {
  let p = 0;
  let mult = 1;
  for (const b of boxes) {
    p += b * mult;
    mult *= PACK_BASE;
  }
  return p;
}

function unpackBoxes(packed: number, n: number): number[] {
  const out: number[] = [];
  let p = packed;
  for (let i = 0; i < n; i++) {
    out.push(p % PACK_BASE);
    p = Math.floor(p / PACK_BASE);
  }
  return out;
}

/**
 * Push-optimal solution of one (sub-)level by breadth-first search over
 * pushes, or null when the search gives up (node budget spent) or the level
 * is unsolvable. States are (player region, sorted boxes); expanding in
 * push order makes the first solved state push-optimal.
 */
function solvePush(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = w * level.h;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const isSolved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);

  // Flood-fill scratch: two stamp arrays so a state's region and a
  // successor's region can be marked without clearing.
  const seen = new Int32Array(size);
  const seenNext = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Lowest square of the region reachable from `from`; marks it in `marks`.
  const regionLow = (occupied: Uint8Array, from: number, marks: Int32Array): number => {
    stamp += 1;
    const here = stamp;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    marks[from] = here;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (q < 0 || q >= size) continue;
        if (wall[q] === 0 && occupied[q] === 0 && marks[q] !== here) {
          marks[q] = here;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  // Shortest walk from `from` to `to` around walls and boxes, lowercase
  // letters, first direction first on ties. Throws if unreachable.
  const walkTo = (occupied: Uint8Array, from: number, to: number): string => {
    if (from === to) return '';
    const prev = new Int32Array(size).fill(-1);
    const how: string[] = new Array(size);
    const queue = [from];
    prev[from] = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      if (p === to) break;
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (q < 0 || q >= size) continue;
        if (wall[q] || occupied[q] || prev[q] !== -1) continue;
        prev[q] = p;
        how[q] = dir.walk;
        queue.push(q);
      }
    }
    if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
    let s = '';
    for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
    return s;
  };

  const occupied = new Uint8Array(size);
  const packedStates: number[] = [packBoxes(level.boxes)];
  const playerStates: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const visited = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(occupied, level.player, seen);
  for (const b of level.boxes) occupied[b] = 0;
  visited.set(startLow * PACK_BASE4 + packedStates[0], 0);

  let found = isSolved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < packedStates.length; head++) {
    const boxes = unpackBoxes(packedStates[head], n);
    for (const b of boxes) occupied[b] = 1;
    regionLow(occupied, playerStates[head], seen);
    const here = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi];
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const t = b + d;
        const behind = b - d;
        if (t < 0 || t >= size || behind < 0 || behind >= size) continue;
        if (seen[behind] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let packed = -1;
        let low = -1;
        if (!frozen) {
          const next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          packed = packBoxes(next);
          // After the push the player stands on the box's old square.
          low = regionLow(occupied, b, seenNext);
          if (visited.has(low * PACK_BASE4 + packed)) {
            occupied[t] = 0;
            occupied[b] = 1;
            continue;
          }
          if (packedStates.length >= maxStates) {
            for (const x of boxes) occupied[x] = 0;
            return null;
          }
          visited.set(low * PACK_BASE4 + packed, packedStates.length);
          packedStates.push(packed);
          playerStates.push(b);
          parent.push(head);
          pushFrom.push(b);
          pushTo.push(t);
          if (next.every((x) => goal[x] === 1)) {
            found = packedStates.length - 1;
            occupied[t] = 0;
            occupied[b] = 1;
            break;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s];
    const to = pushTo[s];
    const d = to - from;
    let dir = DIRS[0];
    for (const cand of DIRS) {
      if (cand.dy * w + cand.dx === d) dir = cand;
    }
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = unpackBoxes(packedStates[s], n);
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * Split a level into rooms: cut the hallway row's dead squares (floor the
 * player walks that no box can ever be pushed from), then each remaining
 * connected floor component holding boxes is one room. Null when the level
 * is not such a set of rooms (a box in the hallway, a goal cut off, or a
 * component whose boxes and goals do not match).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i] + dir.dy * w + dir.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Player square after following `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Solve a level room by room: each room is solved as its own sub-level
 * (other rooms' boxes drawn as walls, on their goals once done), the player
 * walking on from where the last room left them. Falls back to a
 * whole-level search when the level is no set of rooms or a room search
 * gives up.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePush(level, MAX_STATES_WHOLE_LEVEL);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePush(sub, MAX_STATES_PER_ROOM);
    if (solved === null) return solvePush(level, MAX_STATES_WHOLE_LEVEL);
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Replay moves on the level: legality and whether every box ends on a goal. */
function replaySolved(level: Level, moves: string): { solved: boolean; pushes: number } {
  const { w, wall } = level;
  const boxSet = new Set(level.boxes);
  const goalSet = new Set(level.goals);
  let player = level.player;
  let pushes = 0;
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
    const next = player + d;
    if (next < 0 || next >= wall.length || wall[next]) return { solved: false, pushes };
    if (boxSet.has(next)) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || boxSet.has(beyond)) {
        return { solved: false, pushes };
      }
      boxSet.delete(next);
      boxSet.add(beyond);
      pushes++;
    }
    player = next;
  }
  const solved = [...boxSet].every((b) => goalSet.has(b));
  return { solved, pushes };
}

/**
 * Solve one level's text, returning a verified move string. Any failure
 * (unsolved, unverifiable, or an exception) yields the empty answer: a
 * legal empty answer scores 0 on this instance but keeps the other
 * instances' scores, while an illegal one would too and risks nothing else.
 */
function solveLevel(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.player < 0) return '';
    const solved = solveByRooms(level);
    if (solved === null) return '';
    const check = replaySolved(level, solved.moves);
    if (!check.solved) return '';
    return solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    if (!statSync(join(INPUT_DIR, id)).isDirectory()) continue;
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
