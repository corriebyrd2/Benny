const { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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

// One-shot startup probe so misconfigured R2 (wrong bucket name, wrong account
// id, token missing Object Read) shows up immediately in deploy logs instead
// of silently breaking every homepage photo. Returns `{ ok }` so the caller
// can decide whether to log a warning — never throws.
async function checkBucket() {
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: R2_BUCKET_NAME }));
    return { ok: true, bucket: R2_BUCKET_NAME };
  } catch (err) {
    return {
      ok: false,
      bucket: R2_BUCKET_NAME,
      errorName: err.name,
      message: err.message,
      httpStatus: err.$metadata && err.$metadata.httpStatusCode,
    };
  }
}

module.exports = { isConfigured, uploadFile, deleteFile, getObject, checkBucket };
