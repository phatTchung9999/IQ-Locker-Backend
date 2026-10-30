import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { Readable } from 'node:stream';

@Injectable()
export class BlobStorageService {
    private container?: ContainerClient;
    private checkedUntil = 0;
    private getContainer() {
        if (this.container) return this.container;
        const name = process.env.AZURE_STORAGE_CONTAINER;
        const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
        if (!name || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(name)) throw this.unavailable();
        // A connection string is an opt-in local Azurite/developer option only.
        const local = ['development', 'test'].includes(process.env.NODE_ENV ?? '') && process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!local && (!url || !/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/?$/.test(url))) throw this.unavailable();
        const service = local ? BlobServiceClient.fromConnectionString(local, { retryOptions: { maxTries: 2 } })
            : new BlobServiceClient(url!, new DefaultAzureCredential(), { retryOptions: { maxTries: 2 } });
        this.container = service.getContainerClient(name);
        return this.container;
    }
    private unavailable() { return new ServiceUnavailableException('Private document storage is unavailable. Please try again or contact the administrator.'); }
    async ensureReady() {
        try {
            const container = this.getContainer();
            if (Date.now() >= this.checkedUntil) {
                const properties = await container.getProperties({ abortSignal: AbortSignal.timeout(15000) });
                if (properties.blobPublicAccess) throw this.unavailable();
                this.checkedUntil = Date.now() + 60000;
            }
        } catch { throw this.unavailable(); }
    }
    async upload(key: string, buffer: Buffer, mediaType: string, signal?: AbortSignal) {
        await this.ensureReady();
        try {
            await this.getContainer().getBlockBlobClient(key).uploadData(buffer, {
                conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: mediaType },
                abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
                concurrency: 2,
            });
        } catch { throw this.unavailable(); }
    }
    async download(key: string): Promise<Readable> {
        await this.ensureReady();
        try {
            const response = await this.getContainer().getBlobClient(key).download(0, undefined, { abortSignal: AbortSignal.timeout(120000) });
            if (!response.readableStreamBody) throw this.unavailable();
            return response.readableStreamBody as Readable;
        } catch { throw this.unavailable(); }
    }
    async remove(key: string) {
        await this.ensureReady();
        try { await this.getContainer().getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include', abortSignal: AbortSignal.timeout(60000) }); }
        catch { throw this.unavailable(); }
    }
}
