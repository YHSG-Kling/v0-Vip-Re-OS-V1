export type LngLat = [number, number];

// Every pass roughly doubles the point count, so `passes` must be bounded: Infinity would never
// terminate, and a large finite value exhausts memory. 8 passes is already a ~256x denser curve.
const MAX_SMOOTHING_PASSES = 8;

// Chaikin corner cutting turns a sparse route into a continuous curve. Repeated passes round
// direction changes into deliberate swerves instead of left-right heading bumps.
export const smoothFlightPath = (source: LngLat[], passes = 3): LngLat[] => {
	if (source.length < 2)
		throw new Error('Flyover path needs at least two points');

	// Keep adjacent longitudes continuous for routes that cross the antimeridian.
	const unwrapped: LngLat[] = [source[0]];
	for (let index = 1; index < source.length; index++) {
		const [lng, lat] = source[index];
		const previous = unwrapped[index - 1][0];
		let adjusted = lng;
		while (adjusted - previous > 180) adjusted -= 360;
		while (adjusted - previous < -180) adjusted += 360;
		unwrapped.push([adjusted, lat]);
	}

	// Clamp to an integer in [0, MAX_SMOOTHING_PASSES]; NaN counts as 0.
	const passCount = Number.isNaN(passes)
		? 0
		: Math.min(MAX_SMOOTHING_PASSES, Math.max(0, Math.floor(passes)));

	let curve = unwrapped;
	for (let pass = 0; pass < passCount; pass++) {
		const next: LngLat[] = [curve[0]];
		for (let i = 0; i < curve.length - 1; i++) {
			const a = curve[i];
			const b = curve[i + 1];
			next.push(
				[a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
				[a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
			);
		}
		next.push(curve[curve.length - 1]);
		curve = next;
	}
	return curve;
};
