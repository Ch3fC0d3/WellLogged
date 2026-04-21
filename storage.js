// Unified storage helper: uses Google Cloud Storage if configured, else falls back to local disk.
const fs = require('fs');
const path = require('path');

const BUCKET_NAME = process.env.GCS_BUCKET;
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID;
const GCS_KEY_JSON = process.env.GCS_KEY_JSON; // full service account JSON (string) OR base64
const GCS_KEY_FILE = process.env.GCS_KEY_FILE; // path to key file (dev)

let bucket = null;

if (BUCKET_NAME) {
    try {
        const { Storage } = require('@google-cloud/storage');
        const opts = { projectId: GCS_PROJECT_ID };
        if (GCS_KEY_JSON) {
            const raw = GCS_KEY_JSON.trim().startsWith('{')
                ? GCS_KEY_JSON
                : Buffer.from(GCS_KEY_JSON, 'base64').toString('utf-8');
            opts.credentials = JSON.parse(raw);
        } else if (GCS_KEY_FILE) {
            opts.keyFilename = GCS_KEY_FILE;
        }
        const storage = new Storage(opts);
        bucket = storage.bucket(BUCKET_NAME);
        console.log(`[storage] Using Google Cloud Storage bucket: ${BUCKET_NAME}`);
    } catch (err) {
        console.error('[storage] Failed to initialize GCS, falling back to local disk:', err.message);
        bucket = null;
    }
} else {
    console.log('[storage] GCS_BUCKET not set. Using local disk storage at /uploads');
}

/**
 * Upload a file buffer/path to storage.
 * @param {Object} file multer file object (has path, originalname, mimetype)
 * @returns {Promise<{url: string, key: string}>} URL (publicly accessible or signed) and storage key
 */
async function uploadFile(file) {
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;

    if (bucket) {
        const gcsFile = bucket.file(`logs/${safeName}`);
        await gcsFile.save(fs.readFileSync(file.path), {
            resumable: false,
            contentType: file.mimetype,
            metadata: { cacheControl: 'private, max-age=0' }
        });
        // Remove local temp file
        try { fs.unlinkSync(file.path); } catch (e) {}
        return { url: `gs://${BUCKET_NAME}/logs/${safeName}`, key: `logs/${safeName}` };
    }

    // Local disk fallback — multer already wrote to uploads/
    return { url: `/uploads/${path.basename(file.path)}`, key: path.basename(file.path) };
}

/**
 * Get a signed URL for a stored file, valid for 1 hour. Local files return their path directly.
 */
async function getDownloadUrl(key) {
    if (!key) return null;
    if (bucket && key.startsWith('logs/')) {
        const [signed] = await bucket.file(key).getSignedUrl({
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000 // 1 hour
        });
        return signed;
    }
    return key.startsWith('/') ? key : `/uploads/${key}`;
}

/**
 * Delete a file from storage.
 */
async function deleteFile(key) {
    if (!key) return;
    if (bucket && key.startsWith('logs/')) {
        try { await bucket.file(key).delete(); } catch (e) { /* ignore */ }
    } else {
        try { fs.unlinkSync(path.join(__dirname, 'uploads', key)); } catch (e) { /* ignore */ }
    }
}

module.exports = { uploadFile, getDownloadUrl, deleteFile, isUsingCloud: !!bucket };
