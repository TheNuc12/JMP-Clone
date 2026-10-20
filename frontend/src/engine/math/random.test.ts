import { describe, expect, it } from 'vitest'
import { defaultRng, SeedSequence } from './random'
import { reference } from './testing'

const ref = reference.random

describe('random vs numpy.random', () => {
  it('SeedSequence pools and generated state', () => {
    for (const { entropy, spawn_key, pool, state } of ref.seeds) {
      const seq = new SeedSequence(BigInt(entropy), spawn_key)
      expect(seq.pool).toEqual(pool)
      expect(seq.generateState(8)).toEqual(state)
    }
  })

  it('default_rng streams match draw for draw', () => {
    for (const s of ref.streams) {
      const rng = defaultRng(s.seed)
      expect(s.uniform.map(() => rng.uniform(-1, 1))).toEqual(s.uniform)
      expect(s.integers.map(() => rng.integers(0, 7))).toEqual(s.integers)
      expect(s.wide_integers.map(() => rng.integers(-5, 3_000_000_000))).toEqual(s.wide_integers)
      expect(s.choice.map(() => rng.choice([0.5, 1.5, 2.5]))).toEqual(s.choice)
      expect(rng.permutation(37)).toEqual(s.permutation)
      expect(s.random.map(() => rng.random())).toEqual(s.random)
    }
  })

  it('spawned generators (the DOE seeding pattern)', () => {
    const [designRng, orderRng] = new SeedSequence(ref.doe.seed).spawn(2).map(defaultRng)
    expect(ref.doe.design_uniform.map(() => designRng.uniform(-1, 1))).toEqual(ref.doe.design_uniform)
    expect(orderRng.permutation(16)).toEqual(ref.doe.order)
  })

  it('is fast enough for design searches', () => {
    const rng = defaultRng(0)
    const start = performance.now()
    for (let i = 0; i < 100_000; i++) rng.uniform(-1, 1)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
