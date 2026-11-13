/**
 * Queue: five people of different heights wait at a locked door, their backs to us. The one under the pointer
 * turns round to face us; the ones beside glance back over a shoulder, less the further they stand, in a wave that
 * spreads out from the pointer. At rest the padlock's shackle is the bright mark; whoever turns takes it, their
 * eyes lit. The value is the reach: how many neighbours look round too.
 *
 * Built on Hairline's kernel (src/vendor/hairline). A turn is a choice between people, so it runs on the kernel's
 * 700ms tween, staggered by distance from the one chosen.
 */
import { HL } from "@/vendor/hairline/kernel";

import type { FigureMount } from "@/components/art/figures/figure";

type Sample = { u: number; v: number; nu: number; nv: number };

const { Cam, fit, proj, rings, prism, facing, rrect, circ, mk, solid, put, place, open, poly } = HL;
const { register, pointer, disposer, tween, tset, tval, tdone } = HL;

const DOOR = { x0: 2, x1: 38, z1: 96 };
const PEOPLE = [
	{ x: 20, y: 22, h: 40 },
	{ x: 16, y: 41, h: 34 },
	{ x: 22, y: 60, h: 44 },
	{ x: 17, y: 79, h: 31 },
	{ x: 21, y: 98, h: 38 },
];
// Facing the door is straight back along y; facing us is towards the camera's corner.
const AWAY = -Math.PI / 2,
	TOWARD = Math.PI / 4;
const STAGGER = 45;

// A ring turned to face angle a and moved to (x, y): u runs along the way the person faces, v across the shoulders.
function placed(ring: Sample[], x: number, y: number, a: number): Sample[] {
	const c = Math.cos(a),
		s = Math.sin(a);
	return ring.map((q) => ({
		u: x + q.u * c - q.v * s,
		v: y + q.u * s + q.v * c,
		nu: q.nu * c - q.nv * s,
		nv: q.nu * s + q.nv * c,
	}));
}

export const queue: FigureMount = ({ stage, svg, read }, value) => {
	const bag = disposer();
	const C = Cam(45, 0.5, 2.05);
	fit(
		C,
		[
			[-6, -10, -4],
			[44, 112, -4],
			[44, -10, -4],
			[-6, 112, -4],
			[0, 0, DOOR.z1],
		],
		200,
		166
	);
	const P = proj(C),
		front = facing(C);
	const eye = { u: Math.sin(C.az), v: Math.cos(C.az) };
	let reach = value;

	const g = mk("g", {}, svg);
	const [fr, fi] = rings(-6, -10, 44, 112, 8, 2);
	put(solid(g), prism(P, front, fr, fi, -4, 0));

	// The door, its panel, and a padlock hung on the hasp.
	const [dr, di] = rings(DOOR.x0, -6, DOOR.x1, 0, 1.6, 0.8);
	put(solid(g), prism(P, front, dr, di, 0, DOOR.z1));
	mk("path", { class: "nf lo", d: poly([P(6, 0, 10), P(34, 0, 10), P(34, 0, 88), P(6, 0, 88)]) }, g);
	const [lr, li] = rings(25, 0.4, 33, 4, 1.2, 0.5);
	put(solid(g), prism(P, front, lr, li, 42, 50));
	const arc = Array.from({ length: 9 }, (_, k) => {
		const t = (k / 8) * Math.PI;
		return P(29 - 2.6 * Math.cos(t), 2.2, 50 + 4.4 * Math.sin(t));
	});
	const shackle = mk("path", { class: "nf hi", d: open(arc) }, g);

	// Legs, then shoulders wider than the legs, then a head on a short neck: a person, not a post.
	const legs = rrect(-2.6, -5, 2.6, 5, 2.4),
		legsIn = rrect(-1.8, -4.2, 1.8, 4.2, 1.6);
	const torso = rrect(-3.8, -8.2, 3.8, 8.2, 3.6),
		torsoIn = rrect(-2.9, -7.3, 2.9, 7.3, 2.7);
	const head = circ(5, 28),
		headIn = circ(4.1, 28);
	const folk = PEOPLE.map((p) => ({
		...p,
		turn: tween(AWAY),
		legs: solid(g),
		body: solid(g),
		head: solid(g),
		eyes: [
			mk("ellipse", { rx: 1.5, ry: 1.5, class: "dot m" }, g),
			mk("ellipse", { rx: 1.5, ry: 1.5, class: "dot m" }, g),
		],
		drawn: NaN,
	}));

	function draw(now: number) {
		let moving = false;
		for (const f of folk) {
			const a = tval(f.turn, now);
			if (!tdone(f.turn, now)) moving = true;
			if (a === f.drawn) continue;
			f.drawn = a;
			const hip = f.h * 0.46;
			put(f.legs, prism(P, front, placed(legs, f.x, f.y, a), placed(legsIn, f.x, f.y, a), 0, hip));
			put(f.body, prism(P, front, placed(torso, f.x, f.y, a), placed(torsoIn, f.x, f.y, a), hip, f.h));
			put(f.head, prism(P, front, placed(head, f.x, f.y, a), placed(headIn, f.x, f.y, a), f.h + 2.5, f.h + 12.5));
			// Eyes only on a face turned towards us.
			const fx = Math.cos(a),
				fy = Math.sin(a),
				seen = fx * eye.u + fy * eye.v > 0.12;
			f.eyes.forEach((el, k) => {
				const side = k === 0 ? -1.9 : 1.9;
				place(el, P(f.x + fx * 5 - fy * side, f.y + fy * 5 + fx * side, f.h + 8.5));
				el.setAttribute("visibility", seen ? "visible" : "hidden");
			});
		}
		return moving;
	}

	const B = register(stage, (_dt: number, now: number) => draw(now));
	bag.add(B.unregister);

	// Rest pose, not the pose on screen: the person whose standing spot is nearest the pointer across the screen.
	const spots = PEOPLE.map((p) => P(p.x, p.y, p.h / 2)[0]);
	function choose(at: number | null, now: number) {
		folk.forEach((f, i) => {
			const share = at === null ? 0 : Math.max(0, 1 - Math.abs(i - at) / (reach + 1));
			tset(f.turn, AWAY + (TOWARD - AWAY) * share, now, at === null ? 0 : Math.abs(i - at) * STAGGER);
			f.eyes.forEach((el) => el.setAttribute("class", i === at ? "dot" : "dot m"));
		});
		shackle.setAttribute("class", at === null ? "nf hi" : "nf sil");
		read.textContent = at === null ? "rest" : `person ${at + 1}`;
		B.wake();
	}

	let chosen: number | null = null;
	bag.add(
		pointer(stage, {
			move: (p: number[]) => {
				let best = 0;
				spots.forEach((x, i) => {
					if (Math.abs(x - p[0]) < Math.abs(spots[best] - p[0])) best = i;
				});
				const at = Math.abs(spots[best] - p[0]) < 22 && p[1] > 40 && p[1] < 300 ? best : null;
				if (at !== chosen) choose((chosen = at), performance.now());
			},
			leave: () => {
				if (chosen !== null) choose((chosen = null), performance.now());
			},
		})
	);
	draw(performance.now());
	bag.add(() => svg.replaceChildren());

	return {
		set: (v: number) => {
			reach = v;
		},
		destroy: bag.dispose,
	};
};
