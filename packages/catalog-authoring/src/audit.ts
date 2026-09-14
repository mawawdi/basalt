/**
 * Exact finite-population acceptance design retained independently of any
 * classifier or retrieval implementation.
 */
export function exactAcceptanceSampleSize(input: {
  readonly populationCount: number;
  readonly designDefectCount: number;
  readonly acceptanceNumber: number;
  readonly confidenceMillionths: number;
}): { sampleCount: number; acceptanceProbabilityMillionths: number } {
  const { populationCount: population, designDefectCount: defects, acceptanceNumber } = input;
  if (population === 0) return { sampleCount: 0, acceptanceProbabilityMillionths: 0 };
  if (
    !Number.isInteger(population) ||
    !Number.isInteger(defects) ||
    defects < 0 ||
    defects > population ||
    !Number.isInteger(acceptanceNumber) ||
    acceptanceNumber < 0 ||
    !Number.isInteger(input.confidenceMillionths) ||
    input.confidenceMillionths <= 0 ||
    input.confidenceMillionths >= 1_000_000
  )
    throw new Error("Invalid finite audit design");
  const maximumAcceptanceProbability = 1 - input.confidenceMillionths / 1_000_000;
  for (let sampleCount = 0; sampleCount <= population; sampleCount += 1) {
    const probability = hypergeometricCdf(population, defects, sampleCount, acceptanceNumber);
    if (probability <= maximumAcceptanceProbability + Number.EPSILON)
      return {
        sampleCount,
        acceptanceProbabilityMillionths: Math.round(probability * 1_000_000),
      };
  }
  return { sampleCount: population, acceptanceProbabilityMillionths: 0 };
}

function hypergeometricCdf(
  population: number,
  defects: number,
  sampleCount: number,
  acceptanceNumber: number,
): number {
  let total = 0;
  const maximum = Math.min(acceptanceNumber, defects, sampleCount);
  const minimum = Math.max(0, sampleCount - (population - defects));
  for (let observed = minimum; observed <= maximum; observed += 1)
    total += Math.exp(
      logChoose(defects, observed) +
        logChoose(population - defects, sampleCount - observed) -
        logChoose(population, sampleCount),
    );
  return Math.min(1, total);
}

function logChoose(total: number, selected: number): number {
  if (selected < 0 || selected > total) return Number.NEGATIVE_INFINITY;
  const count = Math.min(selected, total - selected);
  let result = 0;
  for (let index = 1; index <= count; index += 1)
    result += Math.log(total - count + index) - Math.log(index);
  return result;
}
