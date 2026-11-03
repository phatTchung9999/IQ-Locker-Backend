import 'reflect-metadata';
import { ExtractionWorkerService } from './extraction-worker.service.js';
afterEach(() => vi.unstubAllEnvs());
it('does not claim jobs while processing is disabled', async () => {
    vi.stubEnv('EXTRACTION_PROCESSING_ENABLED', 'false');
    const jobs = { findOneAndUpdate: vi.fn() };
    const service = new ExtractionWorkerService(jobs as any, {} as any, {} as any, {} as any, {} as any);
    service.onModuleInit();
    expect(await service.runOnce()).toBe(false);
    expect(jobs.findOneAndUpdate).not.toHaveBeenCalled();
    await service.onModuleDestroy();
});
it('refuses automatic processing without a result writer even when enabled', () => {
    vi.stubEnv('EXTRACTION_PROCESSING_ENABLED', 'true');
    const service = new ExtractionWorkerService({} as any, {} as any, {} as any, {} as any, {} as any);
    expect(() => service.onModuleInit()).toThrow('requires a source-text result writer');
});
