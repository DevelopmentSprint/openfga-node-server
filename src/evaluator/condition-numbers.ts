/** Match the pinned reference's big.ParseFloat(decimal, precision=64) bridge. */
function decimal(value: string): { numerator: bigint, denominator: bigint } {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value)
  if (!match) throw new Error('invalid numeric string')
  const fraction = match[3] ?? match[4] ?? ''
  const exponent = Number(match[5] ?? 0) - fraction.length
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 10000) throw new Error('numeric exponent limit exceeded')
  const sign = match[1] === '-' ? -1n : 1n
  const digits = BigInt((match[2] ?? '0') + fraction)
  let numerator = digits * (exponent >= 0 ? 10n ** BigInt(exponent) : 1n)
  let denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n
  if (!numerator) return { numerator: 0n, denominator: 1n }
  let binaryExponent = numerator.toString(2).length - denominator.toString(2).length
  if (binaryExponent >= 0 ? numerator < (denominator << BigInt(binaryExponent)) : (numerator << BigInt(-binaryExponent)) < denominator) binaryExponent--
  const shift = 63 - binaryExponent
  if (shift >= 0) numerator <<= BigInt(shift)
  else denominator <<= BigInt(-shift)
  let significand = numerator / denominator
  const remainder = numerator % denominator
  if (remainder * 2n > denominator || (remainder * 2n === denominator && significand % 2n !== 0n)) significand++
  return shift >= 0
    ? { numerator: sign * significand, denominator: 1n << BigInt(shift) }
    : { numerator: sign * (significand << BigInt(-shift)), denominator: 1n }
}

export function integerParameter(value: unknown, unsigned: boolean): bigint {
  let n: bigint
  if (typeof value === 'number' && Number.isInteger(value)) n = BigInt(value)
  else if (typeof value === 'string') {
    const { numerator, denominator } = decimal(value)
    if (numerator % denominator !== 0n) throw new Error('expected an integer')
    n = numerator / denominator
  }
  else throw new Error('expected an integer')
  // Both upstream integer types pass through big.Float.Int64, which saturates.
  if (n > (1n << 63n) - 1n) n = (1n << 63n) - 1n
  if (n < -(1n << 63n)) n = -(1n << 63n)
  if (unsigned && n < 0n) throw new Error('expected an unsigned integer')
  return n
}

export function doubleParameter(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') throw new Error('expected a double')
  const { numerator, denominator } = decimal(value)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('double out of range')
  // big.Float.Float64 rejects an inexact conversion. Compare its rounded
  // 64-bit significand with the exact rational represented by the JS double.
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, number)
  const bits = view.getBigUint64(0)
  const exp = Number((bits >> 52n) & 0x7ffn)
  let mantissa = bits & ((1n << 52n) - 1n)
  if (exp !== 0) mantissa += 1n << 52n
  if (bits >> 63n) mantissa = -mantissa
  const shift = (exp === 0 ? -1022 : exp - 1023) - 52
  const actualNumerator = shift >= 0 ? mantissa << BigInt(shift) : mantissa
  const actualDenominator = shift < 0 ? 1n << BigInt(-shift) : 1n
  if (actualNumerator * denominator !== numerator * actualDenominator) throw new Error('number cannot be represented exactly as float64')
  return number
}
