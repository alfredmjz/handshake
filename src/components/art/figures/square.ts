/**
 * Square: a few small cubes on the floor, inside an invisible boundary as wide as the figure. The cursor knocks the
 * cube it runs into the way the cursor is going, as hard as it was moving: a flick sends it far, a nudge barely tips
 * it, and it can go left, right, up (away) or down (towards us). A cube rolls as it travels, knocks into the others
 * and passes some of its speed on, bounces softly off the boundary, slows by friction and settles flat on its nearest
 * face. Their outlines are the one bright mark. The value is the transfer: how much of the cursor's speed a cube
 * takes.
 *
 * Built on Hairline's kernel (src/vendor/hairline). Each cube is squared up to the floor's own axes, so the camera
 * sees it corner-on, three faces at once, and it rolls over its edges along those axes, so every quarter turn lands
 * on a face. They travel in the screen's own directions, across and up-and-down, which on the floor are the axes'
 * diagonals, and meet as discs on the floor. The figure draws one unit to a pixel, so the cubes keep their size and
 * the boundary follows the stage's width. An outline is the hull of a cube's eight corners, rounded with fillet,
 * and its creases are the edges of the faces that face us.
 */
import { HL } from "@/vendor/hairline/kernel";

import type { FigureMount } from "@/components/art/figures/figure";

type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];
type Pair = [number, number];

const { Cam, proj, hull, fillet, poly, open, mk } = HL;
const { register, pointer, disposer, spring, stepS } = HL;

// Half a side, and the room kept clear round the edge of the stage, in pixels.
const H = 18,
	PAD = 8;
// Where each cube rests, as a share of how far it may go across and up-and-down: staggered, none touching.
const RESTS: Pair[] = [
	[-0.62, 0.3],
	[-0.2, -0.42],
	[0.2, 0.38],
	[0.62, -0.28],
];
// Two cubes meet as discs this wide on the floor: between a face's half and a corner's.
const RADIUS = H * 1.25;
const FRICTION = 1.7,
	BOUNCE = 0.42,
	// How much speed two cubes keep along the line between them when they meet.
	KNOCK_ON = 0.7,
	MAX_SPEED = 420,
	SETTLE = 6;
const CORNERS: Vec[] = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z): Vec => [x * H, y * H, z * H])));
// Each face as its four corners, wound outwards, with its outward normal.
const FACES: [number[], Vec][] = [
	[
		[4, 6, 7, 5],
		[1, 0, 0],
	],
	[
		[0, 1, 3, 2],
		[-1, 0, 0],
	],
	[
		[2, 3, 7, 6],
		[0, 1, 0],
	],
	[
		[0, 4, 5, 1],
		[0, -1, 0],
	],
	[
		[1, 5, 7, 3],
		[0, 0, 1],
	],
	[
		[0, 2, 6, 4],
		[0, 0, -1],
	],
];
const QUARTER = Math.PI / 2;

const apply = (m: Mat, v: Vec): Vec => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]) as Vec;
const times = (a: Mat, b: Mat): Mat =>
	[0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c])) as Mat;
// A turn by angle a about the unit axis (x, y, z), Rodrigues' formula.
function turn([x, y, z]: Vec, a: number): Mat {
	const c = Math.cos(a),
		s = Math.sin(a),
		t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

// Rolling along the floor's x turns about its y axis, and along y about x, each tipping the top the way it goes.
const ROLL_X: Vec = [0, 1, 0];
const ROLL_Y: Vec = [-1, 0, 0];
// Across the screen is the floor's (1, -1) diagonal, and down it is (1, 1).
const toFloor = (u: number, v: number): Pair => [(u + v) * Math.SQRT1_2, (v - u) * Math.SQRT1_2];
const toScreen = (x: number, y: number): Pair => [(x - y) * Math.SQRT1_2, (x + y) * Math.SQRT1_2];

type Cube = {
	// Where it is across and up-and-down, how fast, how far it has rolled along the floor's x and y, and where it
	// was at the start of this frame.
	at: Pair;
	speed: Pair;
	roll: Pair;
	before: Pair;
	// Once it slows, it flops onto its nearest face, as Turntable settles on the nearest quarter turn.
	flops: ReturnType<typeof spring>[];
	settling: boolean;
	// Where it stands on screen, for the knock.
	base: Pair;
	drawn: string;
	g: SVGGElement;
	body: Element;
	creases: Element;
	outline: Element;
};

export const square: FigureMount = ({ stage, svg, read }, value) => {
	const bag = disposer();
	const C = Cam(45, 0.5, 1.15);
	const P = proj(C);
	const zf = Math.sqrt(1 - C.k * C.k);
	// Towards the camera, for which faces show.
	const toEye: Vec = [Math.sin(C.az) * zf, Math.cos(C.az) * zf, C.k];
	let transfer = value;

	const cubes: Cube[] = RESTS.map(() => {
		const g = mk("g", {}, svg) as SVGGElement;
		return {
			at: [0, 0],
			speed: [0, 0],
			roll: [0, 0],
			before: [0, 0],
			flops: [spring(0, { eps: 0.002 }), spring(0, { eps: 0.002 })],
			settling: false,
			base: [0, 0],
			drawn: "",
			g,
			body: mk("path", { class: "fo" }, g),
			creases: mk("path", { class: "nf lo" }, g),
			outline: mk("path", { class: "nf sil hi" }, g),
		};
	});

	// The stage in pixels, and how far a cube's middle may go across (u) and up-and-down (v) from the centre.
	let wide = 400,
		tall = 320,
		placed = false;
	const limits: Pair = [0, 0];

	const clamp = (c: Cube) => {
		for (const k of [0, 1]) c.at[k] = Math.max(-limits[k], Math.min(limits[k], c.at[k]));
	};

	function drawCube(c: Cube) {
		const turnBy = times(turn(ROLL_Y, c.roll[1]), turn(ROLL_X, c.roll[0]));
		const local = CORNERS.map((v) => apply(turnBy, v));
		const lift = -Math.min(...local.map((v) => v[2]));
		const [x, y] = toFloor(c.at[0], c.at[1]);
		const pts = local.map((v) => P(x + v[0], y + v[1], v[2] + lift));
		c.base = P(x, y, 0);
		const key = pts.map((p: number[]) => p.join(",")).join(";");
		if (key === c.drawn) return;
		c.drawn = key;
		const edge = poly(fillet(hull(pts), Array(8).fill(2.4)));
		c.body.setAttribute("d", edge);
		c.outline.setAttribute("d", edge);
		const shown = FACES.filter(([, n]) => {
			const w = apply(turnBy, n);
			return w[0] * toEye[0] + w[1] * toEye[1] + w[2] * toEye[2] > 0.02;
		});
		c.creases.setAttribute("d", shown.map(([f]) => open(f.concat(f[0]).map((i) => pts[i]))).join(""));
	}

	// The nearer a cube is to us, the later it is painted, so it covers the ones behind.
	let order = "";
	function draw() {
		cubes.forEach(drawCube);
		const sorted = [...cubes].sort((a, b) => a.at[1] - b.at[1]);
		const next = sorted.map((c) => cubes.indexOf(c)).join();
		if (next === order) return;
		order = next;
		sorted.forEach((c) => svg.appendChild(c.g));
	}

	// One unit to a pixel: the floor spans the stage, less a cube's own half and the clear edge.
	function layout() {
		const r = stage.getBoundingClientRect();
		wide = Math.max(160, Math.round(r.width));
		tall = Math.max(160, Math.round(r.height));
		svg.setAttribute("viewBox", `0 0 ${wide} ${tall}`);
		const halfAcross = H * Math.SQRT2;
		// On screen a cube reaches a corner's depth below where it stands, and that plus its height, and a tip's
		// rise as it rolls, above.
		const above = (halfAcross * C.k + 2.42 * H * zf) * C.S,
			below = halfAcross * C.k * C.S;
		C.ox = wide / 2;
		C.oy = tall / 2 + (above - below) / 2;
		limits[0] = Math.max(0, (wide / 2 - PAD) / C.S - halfAcross);
		limits[1] = Math.max(0, (tall - 2 * PAD - above - below) / 2 / (C.k * C.S));
		if (!placed) {
			placed = true;
			cubes.forEach((c, i) => {
				c.at = [RESTS[i][0] * limits[0], RESTS[i][1] * limits[1]];
			});
		}
		cubes.forEach((c) => {
			clamp(c);
			c.drawn = "";
		});
		draw();
	}

	// Two cubes that meet are pushed apart and trade the speed along the line between them.
	function collide(a: Cube, b: Cube) {
		const d: Pair = [b.at[0] - a.at[0], b.at[1] - a.at[1]];
		const gap = Math.hypot(d[0], d[1]);
		if (gap >= 2 * RADIUS) return;
		const n: Pair = gap > 0.001 ? [d[0] / gap, d[1] / gap] : [1, 0];
		const push = (2 * RADIUS - gap) / 2;
		for (const k of [0, 1]) {
			a.at[k] -= n[k] * push;
			b.at[k] += n[k] * push;
		}
		clamp(a);
		clamp(b);
		const closing = (a.speed[0] - b.speed[0]) * n[0] + (a.speed[1] - b.speed[1]) * n[1];
		// Even two cubes at rest that end up touching get a nudge apart, so both roll on and land flat again.
		const swap = Math.max(closing > 0 ? ((1 + KNOCK_ON) / 2) * closing : 0, SETTLE * 2);
		for (const k of [0, 1]) {
			a.speed[k] -= n[k] * swap;
			b.speed[k] += n[k] * swap;
		}
	}

	function step(c: Cube, dt: number) {
		const keep = Math.exp(-FRICTION * dt);
		c.before = [c.at[0], c.at[1]];
		for (const k of [0, 1]) {
			c.speed[k] *= keep;
			let next = c.at[k] + c.speed[k] * dt;
			// The invisible boundary turns it back, losing some speed.
			if (Math.abs(next) > limits[k]) {
				next = Math.sign(next) * limits[k];
				c.speed[k] = -c.speed[k] * BOUNCE;
			}
			c.at[k] = next;
		}
	}

	// Rolls by how far it went, or, once too slow, lands on a face. Reports whether it is still moving.
	function roll(c: Cube, dt: number) {
		if (Math.hypot(c.speed[0], c.speed[1]) > SETTLE) {
			c.settling = false;
			const [dx, dy] = toFloor(c.at[0] - c.before[0], c.at[1] - c.before[1]);
			c.roll[0] += dx / H;
			c.roll[1] += dy / H;
			return true;
		}
		// Landing carries the cube the distance that last part of a turn rolls it.
		if (!c.settling) {
			c.settling = true;
			c.speed = [0, 0];
			c.flops.forEach((f, k) => {
				f.x = c.roll[k];
				f.t = Math.round(c.roll[k] / QUARTER) * QUARTER;
			});
		}
		let moving = false;
		const was = [c.flops[0].x, c.flops[1].x];
		c.flops.forEach((f, k) => {
			if (stepS(f, dt)) moving = true;
			c.roll[k] = f.x;
		});
		const [du, dv] = toScreen((c.roll[0] - was[0]) * H, (c.roll[1] - was[1]) * H);
		c.at[0] += du;
		c.at[1] += dv;
		clamp(c);
		return moving;
	}

	const loop = register(stage, (dt: number) => {
		cubes.forEach((c) => step(c, dt));
		for (let i = 0; i < cubes.length; i++) for (let j = i + 1; j < cubes.length; j++) collide(cubes[i], cubes[j]);
		let moving = false;
		for (const c of cubes) if (roll(c, dt)) moving = true;
		draw();
		read.textContent = moving ? "rolling" : "rest";
		return moving;
	});
	bag.add(loop.unregister);

	const resized = new ResizeObserver(layout);
	resized.observe(stage);
	bag.add(() => resized.disconnect());

	// The cursor's own velocity across the screen, from its last two positions. The kernel reports points on a
	// 400 by 320 board, so they are scaled back to the stage's pixels.
	let last: { x: number; y: number; t: number } | null = null;
	bag.add(
		pointer(stage, {
			move: (point: number[]) => {
				const p = [(point[0] / 400) * wide, (point[1] / 320) * tall];
				const now = performance.now();
				const was = last;
				last = { x: p[0], y: p[1], t: now };
				if (!was || now <= was.t) return;
				const vx = ((p[0] - was.x) / (now - was.t)) * 1000,
					vy = ((p[1] - was.y) / (now - was.t)) * 1000;
				// A knock: the cursor is on a cube and heading into it, from wherever it came from. The nearest wins.
				const reach = H * 1.6 * C.S;
				let hit: Cube | null = null,
					nearest = Infinity;
				for (const c of cubes) {
					const centre = [c.base[0], c.base[1] - H * zf * C.S];
					const off = [p[0] - centre[0], p[1] - centre[1]];
					if (Math.abs(off[0]) >= reach || Math.abs(off[1]) >= reach) continue;
					if ((centre[0] - was.x) * vx + (centre[1] - was.y) * vy <= 0) continue;
					const distance = Math.hypot(off[0], off[1]);
					if (distance < nearest) {
						hit = c;
						nearest = distance;
					}
				}
				if (!hit) return;
				// Up the screen is further away on the floor, foreshortened by the camera's tilt.
				let knock: Pair = [(vx / C.S) * transfer, (vy / (C.S * C.k)) * transfer];
				const size = Math.hypot(knock[0], knock[1]);
				if (size > MAX_SPEED) knock = [(knock[0] / size) * MAX_SPEED, (knock[1] / size) * MAX_SPEED];
				// A knock only adds: it never slows a cube already going faster.
				if (size > Math.hypot(hit.speed[0], hit.speed[1]) * 0.6)
					hit.speed = [hit.speed[0] * 0.4 + knock[0], hit.speed[1] * 0.4 + knock[1]];
				loop.wake();
			},
			leave: () => {
				last = null;
			},
		})
	);
	layout();
	bag.add(() => svg.replaceChildren());

	return {
		set: (v: number) => {
			transfer = v;
		},
		destroy: bag.dispose,
	};
};
