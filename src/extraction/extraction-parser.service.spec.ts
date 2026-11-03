import 'reflect-metadata';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ExtractionParserService } from './extraction-parser.service.js';
import { extractionLimits } from './extraction.types.js';
const parser = new ExtractionParserService();
afterEach(async () => { vi.unstubAllEnvs(); await parser.onModuleDestroy(); });
async function pdf(text?: string) {
    const document = await PDFDocument.create();
    const page = document.addPage();
    if (text) page.drawText(text, { font: await document.embedFont(StandardFonts.Helvetica) });
    return Buffer.from(await document.save());
}
it('extracts UTF-8 text without changing line/character references', async () => {
    const text = 'Lecture one\nCafé\nSecond line';
    expect(await parser.extract(Buffer.from(text), 'text/plain')).toEqual({ extractorVersion: 1, pages: [{ page: null, text }], textChars: text.length });
});
it('extracts a real text PDF with page references in a separate thread', async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage().drawText('Syllabus source page one', { font });
    document.addPage().drawText('Lecture source page two', { font });
    const result = await parser.extract(Buffer.from(await document.save()), 'application/pdf');
    expect(result.pages).toEqual([{ page: 1, text: expect.stringContaining('Syllabus source page one') }, { page: 2, text: expect.stringContaining('Lecture source page two') }]);
});
it('reports no readable text for image-only/empty PDF pages rather than empty success', async () => {
    await expect(parser.extract(await pdf(), 'application/pdf')).rejects.toMatchObject({ code: 'no_readable_text' });
    const imageOnly = await PDFDocument.create();
    const image = await imageOnly.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    imageOnly.addPage().drawImage(image, { x: 20, y: 20, width: 100, height: 100 });
    await expect(parser.extract(Buffer.from(await imageOnly.save()), 'application/pdf')).rejects.toMatchObject({ code: 'no_readable_text' });
});
it.each([['application/pdf', Buffer.from('not a PDF')], ['text/plain', Buffer.from([0xc3, 0x28])]])('rejects invalid %s', async (type, bytes) => {
    await expect(parser.extract(bytes, type)).rejects.toMatchObject({ code: 'parser_failed' });
});
it('bounds output and input size and rejects empty readable text', async () => {
    vi.stubEnv('EXTRACTION_MAX_TEXT_CHARS', '3');
    await expect(parser.extract(Buffer.from('1234'), 'text/plain')).rejects.toMatchObject({ code: 'output_limit' });
    await expect(parser.extract(Buffer.from('   '), 'text/plain')).rejects.toMatchObject({ code: 'no_readable_text' });
    vi.stubEnv('EXTRACTION_MAX_INPUT_BYTES', '2');
    await expect(parser.extract(Buffer.from('123'), 'text/plain')).rejects.toMatchObject({ code: 'output_limit' });
});
it('does not start an already canceled task and rejects invalid limits', async () => {
    await expect(parser.extract(Buffer.from('notes'), 'text/plain', AbortSignal.abort())).rejects.toMatchObject({ code: 'timeout' });
    vi.stubEnv('EXTRACTION_TIMEOUT_MS', '0');
    expect(extractionLimits).toThrow('Invalid EXTRACTION_TIMEOUT_MS');
});
