import 'dotenv/config';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { randomUUID } from 'node:crypto';
const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
const name = process.env.AZURE_STORAGE_CONTAINER;
if (!url || !name) throw new Error('Set AZURE_STORAGE_ACCOUNT_URL and AZURE_STORAGE_CONTAINER first.');
const container = new BlobServiceClient(url, new DefaultAzureCredential()).getContainerClient(name);
const properties = await container.getProperties();
if (properties.blobPublicAccess) throw new Error('The materials container must be private.');
console.log('Private container access verified.');
if (process.argv.includes('--roundtrip')) {
    const blob = container.getBlockBlobClient(`phase14-check/${randomUUID()}.txt`);
    try {
        const buffer = Buffer.from('IQLocker private storage verification');
        await blob.uploadData(buffer, { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'text/plain' } });
        if (!(await blob.downloadToBuffer()).equals(buffer)) throw new Error('Stored content did not match.');
        console.log('Upload/download round trip verified.');
    } finally { await blob.deleteIfExists(); console.log('Disposable test blob removed.'); }
}
