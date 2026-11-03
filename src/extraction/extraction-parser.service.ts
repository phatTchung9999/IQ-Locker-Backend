import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { extractionLimits, ExtractionFailure } from './extraction.types.js';
import type { ExtractionResult } from './extraction.types.js';
@Injectable()
export class ExtractionParserService implements OnModuleDestroy {
    private active = new Set<Worker>();
    async extract(buffer: Buffer, mediaType: string, signal?: AbortSignal): Promise<ExtractionResult> {
        const limits = extractionLimits();
        if (!buffer.length || buffer.length > limits.maxInputBytes) throw new ExtractionFailure('output_limit');
        if (signal?.aborted) throw new ExtractionFailure('timeout');
        const bytes = Uint8Array.from(buffer);
        const worker = new Worker(new URL('./parser-worker.mjs', import.meta.url), {
            workerData: { bytes, mediaType, ...limits }, transferList: [bytes.buffer],
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
            // Do not pass database/Azure credentials into the parsing thread.
            env: {}, execArgv: [], stdout: true, stderr: true,
        });
        this.active.add(worker);
        // Drain parser diagnostics without printing private document contents.
        worker.stdout?.resume(); worker.stderr?.resume();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: ExtractionFailure, result?: ExtractionResult) => {
                if (settled) return;
                settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
                void worker.terminate().then(() => {
                    this.active.delete(worker);
                    if (error) reject(error); else resolve(result!);
                }, () => { this.active.delete(worker); reject(error ?? new ExtractionFailure('parser_failed')); });
            };
            const abort = () => finish(new ExtractionFailure('timeout'));
            const timer = setTimeout(abort, limits.timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            worker.once('message', (message) => {
                if (message.errorCode) finish(new ExtractionFailure(message.errorCode));
                else if (message.result?.extractorVersion === 1 && Array.isArray(message.result.pages) && Number.isSafeInteger(message.result.textChars) && message.result.textChars <= limits.maxTextChars) finish(undefined, message.result);
                else finish(new ExtractionFailure('parser_failed'));
            });
            worker.once('error', () => finish(new ExtractionFailure('parser_failed')));
            worker.once('exit', () => { if (!settled) finish(new ExtractionFailure('parser_failed')); });
        });
    }
    async onModuleDestroy() { await Promise.all([...this.active].map(worker => worker.terminate())); this.active.clear(); }
}
