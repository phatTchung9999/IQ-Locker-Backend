import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function extract() {
    const { bytes, mediaType, maxInputBytes, maxTextChars, maxPages } = workerData;
    if (!bytes?.length || bytes.length > maxInputBytes) fail('output_limit');
    if (mediaType === 'text/plain') {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail('parser_failed'); }
        if (text.length > maxTextChars) fail('output_limit');
        if (!text.trim()) fail('no_readable_text');
        return { extractorVersion: 1, pages: [{ page: null, text }], textChars: text.length };
    }
    if (mediaType !== 'application/pdf') fail('parser_failed');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const folder = name => pathToFileURL(join(root, name) + '/').href;
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false,
        useSystemFonts: false, useWorkerFetch: false, isOffscreenCanvasSupported: false,
        standardFontDataUrl: folder('standard_fonts'), cMapUrl: folder('cmaps'), cMapPacked: true,
        wasmUrl: folder('wasm'), verbosity: 0 });
    try {
        const pdf = await task.promise;
        if (pdf.numPages > maxPages) fail('output_limit');
        const pages = [];
        let textChars = 0, readable = false;
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number);
            try {
                const content = await page.getTextContent();
                const pieces = [];
                for (const item of content.items) {
                    if (typeof item.str !== 'string') continue;
                    const piece = item.str + (item.hasEOL ? '\n' : ' ');
                    textChars += piece.length;
                    if (textChars > maxTextChars) fail('output_limit');
                    if (item.str.trim()) readable = true;
                    pieces.push(piece);
                }
                pages.push({ page: number, text: pieces.join('') });
            } finally { page.cleanup(); }
        }
        if (!readable) fail('no_readable_text');
        return { extractorVersion: 1, pages, textChars };
    } finally { await task.destroy(); }
}
try { parentPort.postMessage({ result: await extract() }); }
catch (error) {
    const code = ['no_readable_text', 'output_limit'].includes(error?.code) ? error.code : 'parser_failed';
    parentPort.postMessage({ errorCode: code });
}
