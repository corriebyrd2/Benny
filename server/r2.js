const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'benny';

// Photos are streamed back through the app (see getObject), so the bucket can
// stay private — no "Public access" toggle or public r2.dev URL is required.
function isConfigured() {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadFile(key, filePath, contentType) {
  const body = await fs.promises.readFile(filePath);
  await getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

async function deleteFile(key) {
  await getClient().send(new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

// Read an object back so the app can stream it to the browser. Returns the raw
// S3 response: `.Body` is a Readable stream, plus `.ContentType`/`.ContentLength`.
async function getObject(key) {
  return getClient().send(new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

module.exports = { isConfigured, uploadFile, deleteFile, getObject };
