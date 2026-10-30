// Throwaway probe for reviewer-bot behavior; this PR is never merged.
export function average(values: number[]): number {
	let total = 0;
	for (const value of values) total += value;
	return total / values.length;
}

console.log(average([]));

export function count(values: number[]): number {
	return values.length;
}

export const probe = true;
