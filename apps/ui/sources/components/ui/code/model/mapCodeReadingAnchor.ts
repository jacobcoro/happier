/** Length of the matching pattern prefix at each position in the text, in linear time. */
function prefixMatches(pattern: readonly string[], text: readonly string[]): number[] {
    const separator = Symbol();
    const size = pattern.length + 1 + text.length;
    const at = (index: number) => index < pattern.length ? pattern[index]
        : index === pattern.length ? separator : text[index - pattern.length - 1];
    const matches = new Array<number>(size).fill(0);
    let left = 0;
    let right = 0;
    for (let index = 1; index < size; index += 1) {
        if (index <= right) matches[index] = Math.min(right - index + 1, matches[index - left]);
        while (index + matches[index] < size && at(matches[index]) === at(index + matches[index])) matches[index] += 1;
        if (index + matches[index] - 1 > right) {
            left = index;
            right = index + matches[index] - 1;
        }
    }
    return matches.slice(pattern.length + 1);
}

/** Locate the same passage after a refresh without computing a whole-file edit script. */
export function mapCodeReadingAnchor(previous: readonly string[], next: readonly string[], previousIndex: number): number {
    if (next.length === 0) return -1;
    if (previous.length === 0) return 0;
    const index = Math.max(0, Math.min(previousIndex, previous.length - 1));
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
    if (index < prefix) return index;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < next.length - prefix
        && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;
    if (index >= previous.length - suffix) return next.length - (previous.length - index);

    if (previous[index] === next[index]) {
        let start = index;
        let end = index + 1;
        while (start > 0 && previous[start - 1] === next[start - 1]) start -= 1;
        while (end < previous.length && end < next.length && previous[end] === next[end]) end += 1;
        // If neither boundary survives anywhere, this aligned passage already has
        // the maximum possible context. Avoid allocating match tables for it.
        if ((start === 0 || !next.includes(previous[start - 1]))
            && (end === previous.length || !next.includes(previous[end]))) return index;
    }

    const candidates: number[] = [];
    for (let candidate = prefix; candidate < next.length - suffix; candidate += 1) {
        if (next[candidate] === previous[index]) candidates.push(candidate);
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
        // A deleted passage falls to its surviving successor. A wholly replaced
        // passage has no textual anchor, so retain the closest valid line position.
        return Math.min(prefix + suffix === next.length ? prefix : index, next.length - 1);
    }
    // Duplicate text is distinguished by its full contiguous surrounding passage.
    // Prefix matching in both directions keeps even reformatted/repeated files O(n).
    const forward = prefixMatches(previous.slice(index), next);
    const backward = prefixMatches(previous.slice(0, index).reverse(), [...next].reverse());
    let best = candidates[0];
    let bestScore = -1;
    for (const candidate of candidates) {
        const score = forward[candidate] + (backward[next.length - candidate] ?? 0);
        if (score > bestScore || (score === bestScore && Math.abs(candidate - index) < Math.abs(best - index))) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}


/** Map surviving lines in one batch; ambiguous or deleted anchors have no match. */
export function mapCodeReadingAnchors(
    previous: readonly string[],
    next: readonly string[],
    previousIndices: readonly number[],
): (number | null)[] {
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < next.length - prefix
        && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;

    const uniquePositions = (lines: readonly string[]) => {
        const positions = new Map<string, number | null>();
        for (let index = 0; index < lines.length; index += 1) {
            const text = lines[index]!;
            positions.set(text, positions.has(text) ? null : index);
        }
        return positions;
    };
    const previousPositions = uniquePositions(previous);
    const nextPositions = uniquePositions(next);
    const mapped = previous.map((text, index): number | null => {
        if (index < prefix) return index;
        if (index >= previous.length - suffix) return next.length - (previous.length - index);
        return previousPositions.get(text) === index ? nextPositions.get(text) ?? null : null;
    });
    // Extend known matches through adjacent repeated lines. Each old line is
    // visited at most once successfully, keeping a many-anchor refresh linear.
    const claimed = new Set(mapped.filter((index): index is number => index !== null));
    for (let index = 0; index < mapped.length; index += 1) {
        const match = mapped[index];
        if (match === null || match === undefined) continue;
        for (const direction of [-1, 1]) {
            let oldIndex = index + direction;
            let newIndex = match + direction;
            while (oldIndex >= 0 && oldIndex < previous.length && newIndex >= 0 && newIndex < next.length
                && mapped[oldIndex] === null && !claimed.has(newIndex) && previous[oldIndex] === next[newIndex]) {
                mapped[oldIndex] = newIndex;
                claimed.add(newIndex);
                oldIndex += direction;
                newIndex += direction;
            }
        }
    }
    return previousIndices.map((index) => mapped[index] ?? null);
}
