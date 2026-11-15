import { ExtractionFailure, extractionLimits } from './extraction.types.js';
import type { ExtractionResult, PdfTextSpan } from './extraction.types.js';

export function sourceChunks(result: ExtractionResult, mediaType: string) {
    const limits = extractionLimits();
    if (result.extractorVersion !== 1 || !Array.isArray(result.pages) || !result.pages.length) throw new ExtractionFailure('parser_failed');
    if (result.pages.length > limits.maxPages) throw new ExtractionFailure('output_limit');
    if (mediaType === 'text/plain' && result.pages.length !== 1) throw new ExtractionFailure('parser_failed');
    if (!['text/plain', 'application/pdf'].includes(mediaType)) throw new ExtractionFailure('parser_failed');
    const chunks: { index: number; text: string; page: number | null; charStart: number; charEnd: number; lineStart: number | null; lineEnd: number | null; spans?: PdfTextSpan[] }[] = [];
    let total = 0, readable = false;
    for (const [position, page] of result.pages.entries()) {
        if (typeof page?.text !== 'string' || page.page !== (mediaType === 'application/pdf' ? position + 1 : null)) throw new ExtractionFailure('parser_failed');
        total += page.text.length;
        if (total > limits.maxTextChars) throw new ExtractionFailure('output_limit');
        if (/\S/u.test(page.text)) readable = true;
        const spans = page.spans;
        if (spans !== undefined) {
            if (page.page === null || !Array.isArray(spans) || spans.length > page.text.length) throw new ExtractionFailure('parser_failed');
            let previousEnd = 0;
            for (const span of spans) {
                if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
                    span.start < previousEnd || span.end <= span.start || span.end > page.text.length ||
                    !Array.isArray(span.transform) || span.transform.length !== 6 ||
                    ![...span.transform, span.width, span.height].every(Number.isFinite)) throw new ExtractionFailure('parser_failed');
                previousEnd = span.end;
            }
        }
        let spanIndex = 0;
        let start = 0, line = 1;
        while (start < page.text.length) {
            let end = Math.min(start + 4000, page.text.length);
            // Preserve Unicode surrogate pairs and CRLF line endings across chunks.
            if (end < page.text.length && (/[\uD800-\uDBFF]/.test(page.text[end - 1]) && /[\uDC00-\uDFFF]/.test(page.text[end]) || page.text[end - 1] === '\r' && page.text[end] === '\n')) end--;
            const text = page.text.slice(start, end);
            const breaks = (text.match(/\r\n|\r|\n/g) ?? []).length;
            const lineEnd = line + breaks - (/[\r\n]$/.test(text) ? 1 : 0);
            const firstSpan = spanIndex;
            while (spans && spanIndex < spans.length && spans[spanIndex].start < end) spanIndex++;
            chunks.push({ index: chunks.length, text, page: page.page, charStart: start, charEnd: end,
                lineStart: page.page === null ? line : null, lineEnd: page.page === null ? Math.max(line, lineEnd) : null,
                ...(spans ? { spans: spans.slice(firstSpan, spanIndex) } : {}) });
            if (chunks.length > 2000) throw new ExtractionFailure('output_limit');
            line += breaks; start = end;
        }
    }
    if (total !== result.textChars || !Number.isSafeInteger(result.textChars)) throw new ExtractionFailure('parser_failed');
    if (!readable) throw new ExtractionFailure('no_readable_text');
    return chunks;
}
