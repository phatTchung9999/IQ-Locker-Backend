import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ExtractionParserService } from './extraction-parser.service.js';
const terminate = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter { terminate = terminate; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks(); });
it('terminates a stuck parser after the configured deadline', async () => {
    vi.stubEnv('EXTRACTION_TIMEOUT_MS', '100'); vi.useFakeTimers();
    const parser = new ExtractionParserService();
    const result = parser.extract(Buffer.from('notes'), 'text/plain');
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(terminate).toHaveBeenCalledOnce();
});
it('terminates parsing when canceled', async () => {
    const parser = new ExtractionParserService(), controller = new AbortController();
    const result = parser.extract(Buffer.from('notes'), 'text/plain', controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
    controller.abort(); await assertion;
    expect(terminate).toHaveBeenCalledOnce();
});
