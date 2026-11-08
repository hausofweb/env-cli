/**
 * Runs `task` over `items` one at a time, in order, for work that must not
 * fan out (shared transactions, provider rate limits, oldest-first queues,
 * interactive prompts). The first rejection stops the run and is rethrown,
 * like a `for...of` loop.
 */
export const mapSequentially = <Item, Result>(
  items: Iterable<Item>,
  task: (item: Item) => Promise<Result>
): Promise<Result[]> => {
  const iterator = items[Symbol.iterator]();
  const results: Result[] = [];

  const runNext = async (): Promise<Result[]> => {
    const step = iterator.next();

    if (step.done) {
      return results;
    }

    results.push(await task(step.value));

    return runNext();
  };

  return runNext();
};
