import { sourceChunks } from './source-chunks.js';
const result = (text: string) => ({ extractorVersion: 1, pages: [{ page: null, text }], textChars: text.length });
afterEach(() => vi.unstubAllEnvs());
it('preserves TXT exactly with Unicode, CRLF and source offsets across chunk boundaries', () => {
    const text = 'a'.repeat(3999) + '😀\r\n' + 'b'.repeat(3995) + '\r\nlast';
    const chunks = sourceChunks(result(text), 'text/plain');
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(chunks[0].charEnd).toBe(3999);
    for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(4000);
        expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
        expect(chunk.lineStart).toBe(1 + (text.slice(0, chunk.charStart).match(/\r\n|\r|\n/g) ?? []).length);
        expect(/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(false);
    }
    expect(chunks.at(-1)!.lineEnd).toBe(3);
});
it('keeps PDF offsets relative to the source page and skips pages without text', () => {
    const pages = [{ page: 1, text: 'Page one' }, { page: 2, text: '' }, { page: 3, text: 'z'.repeat(4001) }];
    const chunks = sourceChunks({ extractorVersion: 1, pages, textChars: 4009 }, 'application/pdf');
    expect(chunks.map(c => [c.page, c.charStart, c.charEnd])).toEqual([[1, 0, 8], [3, 0, 4000], [3, 4000, 4001]]);
    expect(chunks.every(c => c.lineStart === null && c.lineEnd === null)).toBe(true);
});
it('rejects corrupt references, incorrect totals, unreadable output and oversized results', () => {
    expect(() => sourceChunks({ ...result('abc'), textChars: 2 }, 'text/plain')).toThrow('parser_failed');
    expect(() => sourceChunks({ extractorVersion: 1, pages: [{ page: 7, text: 'abc' }], textChars: 3 }, 'application/pdf')).toThrow('parser_failed');
    expect(() => sourceChunks(result('  '), 'text/plain')).toThrow('no_readable_text');
    vi.stubEnv('EXTRACTION_MAX_TEXT_CHARS', '2');
    expect(() => sourceChunks(result('abc'), 'text/plain')).toThrow('output_limit');
});
