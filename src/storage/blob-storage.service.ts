import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { Readable } from 'node:stream';

export type StorageContainer = 'materials' | 'avatars';

@Injectable()
export class BlobStorageService {
    private service?: BlobServiceClient;
    private readonly containers = new Map<StorageContainer, ContainerClient>();
    private readonly checkedUntil = new Map<StorageContainer, number>();
    private getContainer(kind: StorageContainer) {
        const cached = this.containers.get(kind);
        if (cached) return cached;
        const materials = process.env.AZURE_STORAGE_MATERIALS_CONTAINER ?? process.env.AZURE_STORAGE_CONTAINER;
        const name = kind === 'materials' ? materials : process.env.AZURE_STORAGE_AVATARS_CONTAINER;
        if (kind === 'avatars' && name === materials) throw this.unavailable(kind);
        const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
        if (!name || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(name)) throw this.unavailable(kind);
        // A connection string is an opt-in local Azurite/developer option only.
        const local = ['development', 'test'].includes(process.env.NODE_ENV ?? '') && process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!local && (!url || !/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/?$/.test(url))) throw this.unavailable(kind);
        this.service ??= local ? BlobServiceClient.fromConnectionString(local, { retryOptions: { maxTries: 2 } })
            : new BlobServiceClient(url!, new DefaultAzureCredential(), { retryOptions: { maxTries: 2 } });
        const container = this.service.getContainerClient(name);
        this.containers.set(kind, container);
        return container;
    }
    private unavailable(kind: StorageContainer) { return new ServiceUnavailableException(`Private ${kind === 'avatars' ? 'avatar' : 'document'} storage is unavailable. Please try again or contact the administrator.`); }
    async ensureReady(kind: StorageContainer = 'materials') {
        try {
            const container = this.getContainer(kind);
            if (Date.now() >= (this.checkedUntil.get(kind) ?? 0)) {
                const properties = await container.getProperties({ abortSignal: AbortSignal.timeout(15000) });
                if (properties.blobPublicAccess) throw this.unavailable(kind);
                this.checkedUntil.set(kind, Date.now() + 60000);
            }
        } catch { throw this.unavailable(kind); }
    }
    async upload(key: string, buffer: Buffer, mediaType: string, signal?: AbortSignal, kind: StorageContainer = 'materials') {
        await this.ensureReady(kind);
        try {
            await this.getContainer(kind).getBlockBlobClient(key).uploadData(buffer, {
                conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: mediaType },
                abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
                concurrency: 2,
            });
        } catch { throw this.unavailable(kind); }
    }
    async download(key: string, signal?: AbortSignal, kind: StorageContainer = 'materials'): Promise<Readable> {
        await this.ensureReady(kind);
        try {
            const response = await this.getContainer(kind).getBlobClient(key).download(0, undefined, { abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
            if (!response.readableStreamBody) throw this.unavailable(kind);
            return response.readableStreamBody as Readable;
        } catch { throw this.unavailable(kind); }
    }
    async remove(key: string, kind: StorageContainer = 'materials') {
        await this.ensureReady(kind);
        try { await this.getContainer(kind).getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include', abortSignal: AbortSignal.timeout(60000) }); }
        catch { throw this.unavailable(kind); }
    }
}
