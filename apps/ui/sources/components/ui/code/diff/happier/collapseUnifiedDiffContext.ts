import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

export type UnifiedDiffFoldRegion = Readonly<{
    hiddenStartIndex: number;
    afterLineId: string;
    hiddenCount: number;
}>;

export function collapseUnifiedDiffContext(params: Readonly<{
    lines: readonly CodeLine[];
    contextThreshold: number;
    contextRadius: number;
    expandedLineIndices: ReadonlySet<number>;
}>): Readonly<{ lines: CodeLine[]; regions: UnifiedDiffFoldRegion[] }> {
    const threshold = Math.max(0, Math.floor(params.contextThreshold));
    const radius = Math.max(0, Math.floor(params.contextRadius));

    if (threshold <= 0) return { lines: [...params.lines], regions: [] };
    if (radius <= 0) return { lines: [...params.lines], regions: [] };

    const out: CodeLine[] = [];
    const regions: UnifiedDiffFoldRegion[] = [];

    const raw = params.lines;

    // Walk hunks and collapse long runs of context lines.
    let i = 0;
    while (i < raw.length) {
        const line = raw[i]!;

        const isHunkHeader = line.kind === 'header' && line.renderCodeText.startsWith('@@');
        if (isHunkHeader) {
            out.push(line);
            i += 1;
            continue;
        }

        if (line.kind !== 'context' || line.renderPrefixText !== ' ') {
            out.push(line);
            i += 1;
            continue;
        }

        // Context run.
        const runStart = i;
        let runEnd = i;
        while (runEnd < raw.length) {
            const next = raw[runEnd]!;
            if (next.kind !== 'context' || next.renderPrefixText !== ' ') break;
            runEnd += 1;
        }

        const runLength = runEnd - runStart;
        if (runLength <= threshold || radius * 2 >= runLength) {
            for (let j = runStart; j < runEnd; j++) out.push(raw[j]!);
            i = runEnd;
            continue;
        }

        let hasExpandedLine = false;
        for (let j = runStart; j < runEnd; j++) {
            if (params.expandedLineIndices.has(j)) {
                hasExpandedLine = true;
                break;
            }
        }
        if (hasExpandedLine) {
            for (let j = runStart; j < runEnd; j++) out.push(raw[j]!);
            i = runEnd;
            continue;
        }

        const keepStartEnd = runStart + radius;
        const keepEndStart = runEnd - radius;

        for (let j = runStart; j < keepStartEnd; j++) out.push(raw[j]!);

        const hiddenCount = keepEndStart - keepStartEnd;
        const afterLineId = raw[keepStartEnd - 1]!.id;
        regions.push({ hiddenStartIndex: keepStartEnd, afterLineId, hiddenCount });

        for (let j = keepEndStart; j < runEnd; j++) out.push(raw[j]!);

        i = runEnd;
    }

    return { lines: out, regions };
}
