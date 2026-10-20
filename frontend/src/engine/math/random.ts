// numpy's default random generator: SeedSequence → PCG64 → Generator, ported so a seeded
// stream matches Python draw for draw (uniform, integers, choice, permutation, shuffle).

const MASK32 = 0xffffffff
const MASK64 = (1n << 64n) - 1n
const MASK128 = (1n << 128n) - 1n
const PCG_MULTIPLIER = (2549297995355413924n << 64n) + 4865540595714422341n

const mul32 = (a: number, b: number) => Math.imul(a, b) >>> 0

/** High 32 bits of the 64-bit product of two uint32 values. */
function mulHi32(a: number, b: number): number {
  const low = (a & 0xffff) * b
  return Math.floor(((a >>> 16) * b + Math.floor(low / 0x10000)) / 0x10000)
}

/** Little-endian uint32 words of a non-negative integer (at least one word). */
function uint32Words(n: bigint): number[] {
  const words = [Number(n & 0xffffffffn)]
  for (n >>= 32n; n > 0n; n >>= 32n) words.push(Number(n & 0xffffffffn))
  return words
}

/**
 * numpy.random.SeedSequence: hashes entropy (plus a spawn key) into a 4-word pool from which
 * independent generator states are drawn. Without entropy it draws 128 bits from the OS.
 */
export class SeedSequence {
  readonly entropy: bigint
  readonly spawnKey: readonly number[]
  readonly pool: number[]
  private spawned = 0

  constructor(entropy?: number | bigint, spawnKey: readonly number[] = []) {
    if (entropy === undefined) {
      const words = crypto.getRandomValues(new Uint32Array(4))
      entropy = words.reduce((acc, w, i) => acc | (BigInt(w) << BigInt(32 * i)), 0n)
    }
    if (entropy < 0) throw new RangeError('SeedSequence expects non-negative integers')
    this.entropy = BigInt(entropy)
    this.spawnKey = spawnKey
    const run = uint32Words(this.entropy)
    const spawn = spawnKey.flatMap((k) => uint32Words(BigInt(k)))
    // Pad short entropy when a spawn key follows (numpy ≥ 1.19, gh-16539).
    while (spawn.length && run.length < 4) run.push(0)
    this.pool = mixEntropy([...run, ...spawn])
  }

  /** `n` uint32 words of generator state (generate_state(n, np.uint32)). */
  generateState(n: number): number[] {
    let hashConst = 0x8b51f9dd
    return Array.from({ length: n }, (_, i) => {
      let v = (this.pool[i % 4] ^ hashConst) >>> 0
      hashConst = mul32(hashConst, 0x58f38ded)
      v = mul32(v, hashConst)
      return (v ^ (v >>> 16)) >>> 0
    })
  }

  /** Child sequences with spawn keys extended by 0, 1, … (continuing after earlier spawns). */
  spawn(n: number): SeedSequence[] {
    const children = Array.from({ length: n }, (_, i) => new SeedSequence(this.entropy, [...this.spawnKey, this.spawned + i]))
    this.spawned += n
    return children
  }
}

function mixEntropy(entropy: number[]): number[] {
  let hashConst = 0x43b0d7e5
  const hashmix = (value: number) => {
    value = (value ^ hashConst) >>> 0
    hashConst = mul32(hashConst, 0x931e8875)
    value = mul32(value, hashConst)
    return (value ^ (value >>> 16)) >>> 0
  }
  const mix = (x: number, y: number) => {
    const r = (mul32(0xca01f9dd, x) - mul32(0x4973f715, y)) >>> 0
    return (r ^ (r >>> 16)) >>> 0
  }
  const pool = [0, 1, 2, 3].map((i) => hashmix(entropy[i] ?? 0))
  for (let src = 0; src < 4; src++) for (let dst = 0; dst < 4; dst++) if (src !== dst) pool[dst] = mix(pool[dst], hashmix(pool[src]))
  for (let src = 4; src < entropy.length; src++) for (let dst = 0; dst < 4; dst++) pool[dst] = mix(pool[dst], hashmix(entropy[src]))
  return pool
}

/** PCG64 (128-bit LCG with the XSL-RR output function), seeded as numpy seeds it. */
class PCG64 {
  private state = 0n
  private readonly inc: bigint
  private hasUint32 = false
  private uinteger = 0

  constructor(seed: SeedSequence) {
    const w = seed.generateState(8).map(BigInt)
    const u64 = [0, 1, 2, 3].map((k) => w[2 * k] | (w[2 * k + 1] << 32n))
    this.inc = ((((u64[2] << 64n) + u64[3]) << 1n) | 1n) & MASK128
    this.step()
    this.state = (this.state + (u64[0] << 64n) + u64[1]) & MASK128
    this.step()
  }

  private step(): void {
    this.state = (this.state * PCG_MULTIPLIER + this.inc) & MASK128
  }

  nextUint64(): bigint {
    this.step()
    const value = ((this.state >> 64n) ^ this.state) & MASK64
    const rot = this.state >> 122n
    return ((value >> rot) | (value << ((64n - rot) & 63n))) & MASK64
  }

  /** Low then high half of one 64-bit draw. */
  nextUint32(): number {
    if (this.hasUint32) {
      this.hasUint32 = false
      return this.uinteger
    }
    const next = this.nextUint64()
    this.hasUint32 = true
    this.uinteger = Number(next >> 32n)
    return Number(next & 0xffffffffn)
  }

  nextDouble(): number {
    return Number(this.nextUint64() >> 11n) / 9007199254740992
  }
}

/**
 * numpy.random.Generator on PCG64 (np.random.default_rng). Array-valued numpy calls draw
 * element by element, so e.g. rng.uniform(-1, 1, n) equals n calls of uniform(-1, 1).
 */
export class Generator {
  private readonly bits: PCG64

  constructor(seed?: number | bigint | SeedSequence) {
    this.bits = new PCG64(seed instanceof SeedSequence ? seed : new SeedSequence(seed))
  }

  /** Uniform on [0, 1) with 53 random bits. */
  random(): number {
    return this.bits.nextDouble()
  }

  uniform(low = 0, high = 1): number {
    return low + (high - low) * this.bits.nextDouble()
  }

  /** Integer in [low, high) (Lemire's method on 32-bit draws; ranges must fit in 32 bits). */
  integers(low: number, high: number): number {
    const range = high - 1 - low
    if (!(range >= 0)) throw new RangeError('low >= high')
    if (range === 0) return low
    if (range > MASK32) throw new RangeError('integers: ranges beyond 2^32 are not ported')
    if (range === MASK32) return low + this.bits.nextUint32()
    const excl = range + 1
    let r = this.bits.nextUint32()
    let leftover = mul32(r, excl)
    if (leftover < excl) {
      const threshold = (MASK32 - range) % excl
      while (leftover < threshold) {
        r = this.bits.nextUint32()
        leftover = mul32(r, excl)
      }
    }
    return low + mulHi32(r, excl)
  }

  /** One element drawn uniformly (rng.choice(items) with replacement and equal weights). */
  choice<T>(items: readonly T[]): T {
    return items[this.integers(0, items.length)]
  }

  /** Shuffle in place by Fisher–Yates from the end (rng.shuffle of a 1-d array). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.interval(i)
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  }

  /** A random ordering of 0 … n − 1 (rng.permutation(n)). */
  permutation(n: number): number[] {
    return this.shuffle(Array.from({ length: n }, (_, i) => i))
  }

  /** Uniform integer in [0, max] by masked rejection (numpy's random_interval). */
  private interval(max: number): number {
    if (max > MASK32) throw new RangeError('shuffle: lengths beyond 2^32 are not ported')
    let mask = max
    for (const s of [1, 2, 4, 8, 16]) mask |= mask >>> s
    mask >>>= 0
    for (;;) {
      const value = (this.bits.nextUint32() & mask) >>> 0
      if (value <= max) return value
    }
  }
}

/** np.random.default_rng(seed). */
export function defaultRng(seed?: number | bigint | SeedSequence): Generator {
  return new Generator(seed)
}
