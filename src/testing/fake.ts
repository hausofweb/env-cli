/** Any function: a `vi.fn()` spy, or a plain implementation. */
type AnyFunction = (...args: never[]) => void;

/**
 * A partial, structurally-checked stand-in for `Real`: any subset of its
 * members, where each method may be any function (typically a `vi.fn()` with
 * the fixture signature the test needs) and each nested object recurses.
 */
export type FakeOf<Real> = {
  [Key in keyof Real]?: Real[Key] extends AnyFunction
    ? AnyFunction
    : FakeOf<Real[Key]>;
};

/** Rejects keys `Real` does not have, so a typo'd member fails to compile instead of silently going unused. */
type NoExtraKeys<Real, Fake> = Fake &
  Record<Exclude<keyof Fake, keyof Real>, never>;

/**
 * Builds a fake typed as both itself (so tests keep the `vi.fn()` mock API)
 * and `Real` (so it can be injected where the real collaborator is expected).
 * Curried so `Real` is given explicitly while `Fake` is inferred:
 * `fakeOf<ClerkClient>()({ users: { getUserList: vi.fn() } })`.
 *
 * Members the fake leaves out are `undefined` at runtime: a code path that
 * reaches one throws a TypeError naming it, so a fake that is too small fails
 * loudly rather than returning a plausible default.
 */
export const fakeOf =
  <Real>() =>
  <Fake extends FakeOf<Real>>(fake: NoExtraKeys<Real, Fake>): Fake & Real =>
    // SAFETY: the code under test reaches only the members the fake provides;
    // FakeOf checks each provided member against Real's shape, and any member it
    // leaves out throws on first use (see above).
    fake as Fake & Real;
